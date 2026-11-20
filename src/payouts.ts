import { pool, withTransaction } from "./lib/db";
import { postTransaction, systemAccount } from "./lib/ledger";

export interface PayoutJob {
  id: string;
  account_id: string;
  amount: string;
  attempts: number;
}

/** Sends money out. In production this calls a bank / payment provider, passing payout.id as its idempotency key. */
export type PayoutProvider = (job: PayoutJob) => Promise<void>;

export const MAX_ATTEMPTS = Number(process.env.PAYOUT_MAX_ATTEMPTS ?? 5);
const STALE_LOCK = "5 minutes";

/** Exponential backoff with a cap: 2s, 4s, 8s, ... up to 5 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, 300);
}

/**
 * Claims up to `limit` jobs. FOR UPDATE SKIP LOCKED lets many workers poll the same table
 * without taking the same job twice. Jobs stuck in 'processing' (crashed worker) are reclaimed.
 */
export async function claimJobs(limit: number): Promise<PayoutJob[]> {
  const { rows } = await pool.query(
    `UPDATE payouts SET status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM payouts
         WHERE (status = 'queued' AND next_run_at <= now())
            OR (status = 'processing' AND locked_at < now() - interval '${STALE_LOCK}')
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id, account_id, amount::text AS amount, attempts`,
    [limit],
  );
  return rows;
}

/** Runs one claimed job: settle on success, retry with backoff on failure, dead-letter + refund after MAX_ATTEMPTS. */
export async function processJob(job: PayoutJob, provider: PayoutProvider): Promise<"paid" | "retry" | "dead"> {
  try {
    await provider(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts >= MAX_ATTEMPTS) {
      await withTransaction(async (client) => {
        const { rows } = await client.query(`SELECT currency FROM accounts WHERE id = $1`, [job.account_id]);
        const clearing = await systemAccount(client, "payout_clearing", rows[0].currency);
        // Give the held money back to the customer: the ledger stays balanced.
        await postTransaction(client, "payout_refund", [
          { accountId: clearing, amount: -BigInt(job.amount) },
          { accountId: job.account_id, amount: BigInt(job.amount) },
        ]);
        await client.query(
          `UPDATE payouts SET status = 'dead', last_error = $2, locked_at = NULL, updated_at = now() WHERE id = $1`,
          [job.id, message],
        );
      });
      return "dead";
    }
    await pool.query(
      `UPDATE payouts SET status = 'queued', last_error = $2, locked_at = NULL,
              next_run_at = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $1`,
      [job.id, message, backoffSeconds(job.attempts)],
    );
    return "retry";
  }

  await withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT currency FROM accounts WHERE id = $1`, [job.account_id]);
    const clearing = await systemAccount(client, "payout_clearing", rows[0].currency);
    const sink = await systemAccount(client, "payout_sink", rows[0].currency);
    await postTransaction(client, "payout_settle", [
      { accountId: clearing, amount: -BigInt(job.amount) },
      { accountId: sink, amount: BigInt(job.amount) },
    ]);
    await client.query(
      `UPDATE payouts SET status = 'paid', last_error = NULL, locked_at = NULL, updated_at = now() WHERE id = $1`,
      [job.id],
    );
  });
  return "paid";
}

/** Simulated provider: fails a configurable share of calls to exercise the retry path. */
export function simulatedProvider(failureRate = Number(process.env.PAYOUT_FAILURE_RATE ?? 0.2)): PayoutProvider {
  return async () => {
    await new Promise((r) => setTimeout(r, 20));
    if (Math.random() < failureRate) throw new Error("provider timeout (simulated)");
  };
}
