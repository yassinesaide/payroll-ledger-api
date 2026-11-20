import express, { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { pool, withTransaction } from "./lib/db";
import { HttpError } from "./lib/errors";
import { issueToken, requireAuth } from "./lib/auth";
import { runIdempotent } from "./lib/idempotency";
import { postTransaction, reconcile, systemAccount } from "./lib/ledger";

// Amounts travel as integer strings or numbers in minor units (cents); stored as BIGINT.
const amount = z
  .union([z.string().regex(/^\d+$/), z.number().int()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n && v <= 10_000_000_000n, "amount must be between 1 and 10,000,000,000 minor units");
const uuid = z.string().uuid();

const schemas = {
  token: z.object({ userId: z.string().min(1).max(64) }),
  account: z.object({ currency: z.string().regex(/^[A-Z]{3}$/) }),
  deposit: z.object({ amount }),
  transfer: z.object({ fromAccountId: uuid, toAccountId: uuid, amount }).refine((t) => t.fromAccountId !== t.toAccountId, {
    message: "fromAccountId and toAccountId must differ",
  }),
  payout: z.object({ accountId: uuid, amount }),
};

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new HttpError(400, "validation_error", result.error.issues.map((i) => i.message).join("; "));
  return result.data;
}

function idempotencyKey(req: Request): string {
  const key = req.header("idempotency-key");
  if (!key || key.length > 128) throw new HttpError(400, "idempotency_key_required", "Idempotency-Key header (1-128 chars) is required");
  return key;
}

async function ownedAccount(client: { query: typeof pool.query }, accountId: string, userId: string) {
  const { rows } = await client.query(`SELECT id, currency FROM accounts WHERE id = $1 AND owner = $2 AND kind = 'customer'`, [
    accountId,
    userId,
  ]);
  if (!rows[0]) throw new HttpError(404, "account_not_found", "Account not found");
  return rows[0] as { id: string; currency: string };
}

function sendStored(res: Response, stored: { status: number; body: unknown; replayed: boolean }) {
  if (stored.replayed) res.setHeader("Idempotent-Replayed", "true");
  res.status(stored.status).json(stored.body);
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Demo-only token endpoint so the API can be tried without an identity provider.
  app.post("/auth/token", (req, res) => {
    const { userId } = parse(schemas.token, req.body);
    res.json({ token: issueToken(userId) });
  });

  app.use(requireAuth);

  app.post("/accounts", async (req, res) => {
    const { currency } = parse(schemas.account, req.body);
    const account = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO accounts (owner, currency) VALUES ($1, $2) RETURNING id, owner, currency, created_at`,
        [req.userId, currency],
      );
      await client.query(`INSERT INTO account_balances (account_id) VALUES ($1)`, [rows[0].id]);
      return rows[0];
    });
    res.status(201).json({ ...account, balance: "0" });
  });

  app.get("/accounts/:id", async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await pool.query(
      `SELECT a.id, a.owner, a.currency, b.balance::text AS balance
         FROM accounts a JOIN account_balances b ON b.account_id = a.id
        WHERE a.id = $1 AND a.owner = $2`,
      [id, req.userId],
    );
    if (!rows[0]) throw new HttpError(404, "account_not_found", "Account not found");
    res.json(rows[0]);
  });

  // Funds an account from the treasury (stands in for an incoming bank transfer).
  app.post("/accounts/:id/deposits", async (req, res) => {
    const key = idempotencyKey(req);
    const accountId = parse(uuid, req.params.id);
    const body = parse(schemas.deposit, req.body);
    const stored = await runIdempotent(req.userId!, key, `POST /accounts/${accountId}/deposits`, req.body, async (client) => {
      const account = await ownedAccount(client, accountId, req.userId!);
      const treasury = await systemAccount(client, "treasury", account.currency);
      const transactionId = await postTransaction(client, "deposit", [
        { accountId: treasury, amount: -body.amount },
        { accountId: account.id, amount: body.amount },
      ]);
      return { status: 201, body: { transactionId, accountId, amount: body.amount.toString() } };
    });
    sendStored(res, stored);
  });

  app.post("/transfers", async (req, res) => {
    const key = idempotencyKey(req);
    const body = parse(schemas.transfer, req.body);
    const stored = await runIdempotent(req.userId!, key, "POST /transfers", req.body, async (client) => {
      await ownedAccount(client, body.fromAccountId, req.userId!);
      const transactionId = await postTransaction(client, "transfer", [
        { accountId: body.fromAccountId, amount: -body.amount },
        { accountId: body.toAccountId, amount: body.amount },
      ]);
      return { status: 201, body: { transactionId, ...req.body } };
    });
    sendStored(res, stored);
  });

  // Holds the money in a clearing account and queues the payout for the worker.
  app.post("/payouts", async (req, res) => {
    const key = idempotencyKey(req);
    const body = parse(schemas.payout, req.body);
    const stored = await runIdempotent(req.userId!, key, "POST /payouts", req.body, async (client) => {
      const account = await ownedAccount(client, body.accountId, req.userId!);
      const clearing = await systemAccount(client, "payout_clearing", account.currency);
      await postTransaction(client, "payout_hold", [
        { accountId: account.id, amount: -body.amount },
        { accountId: clearing, amount: body.amount },
      ]);
      const { rows } = await client.query(
        `INSERT INTO payouts (account_id, amount) VALUES ($1, $2) RETURNING id, status, amount::text AS amount`,
        [account.id, body.amount.toString()],
      );
      return { status: 202, body: { payoutId: rows[0].id, status: rows[0].status, amount: rows[0].amount } };
    });
    sendStored(res, stored);
  });

  app.get("/payouts/:id", async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { rows } = await pool.query(
      `SELECT p.id, p.account_id, p.amount::text AS amount, p.status, p.attempts, p.last_error
         FROM payouts p JOIN accounts a ON a.id = p.account_id
        WHERE p.id = $1 AND a.owner = $2`,
      [id, req.userId],
    );
    if (!rows[0]) throw new HttpError(404, "payout_not_found", "Payout not found");
    res.json(rows[0]);
  });

  app.get("/reconciliation", async (_req, res) => {
    const client = await pool.connect();
    try {
      res.json(await reconcile(client));
    } finally {
      client.release();
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error", message: "Unexpected error" });
  });

  return app;
}
