import { PoolClient } from "pg";
import { HttpError } from "./errors";

export type TransactionKind = "deposit" | "transfer" | "payout_hold" | "payout_settle" | "payout_refund";
/** Positive amount = money into the account, negative = money out. Entries of a transaction sum to zero. */
export interface Entry {
  accountId: string;
  amount: bigint;
}

export type SystemAccount = "treasury" | "payout_clearing" | "payout_sink";

/** Returns the id of a system account for a currency, creating it once. */
export async function systemAccount(client: PoolClient, name: SystemAccount, currency: string): Promise<string> {
  const owner = `system:${name}`;
  await client.query(
    `INSERT INTO accounts (owner, currency, kind) VALUES ($1, $2, 'system')
     ON CONFLICT (owner, currency) WHERE kind = 'system' DO NOTHING`,
    [owner, currency],
  );
  const { rows } = await client.query(
    `SELECT id FROM accounts WHERE owner = $1 AND currency = $2 AND kind = 'system'`,
    [owner, currency],
  );
  await client.query(`INSERT INTO account_balances (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, [rows[0].id]);
  return rows[0].id;
}

/**
 * Posts a balanced transaction inside the caller's database transaction.
 * Locks every touched balance row with SELECT ... FOR UPDATE, always in account-id order,
 * so concurrent transfers cannot deadlock or spend the same money twice.
 */
export async function postTransaction(client: PoolClient, kind: TransactionKind, entries: Entry[]): Promise<string> {
  const total = entries.reduce((sum, e) => sum + e.amount, 0n);
  if (total !== 0n) throw new Error(`unbalanced transaction: entries sum to ${total}`);

  const ids = [...new Set(entries.map((e) => e.accountId))].sort();
  const { rows: accounts } = await client.query(
    `SELECT a.id, a.kind, a.currency, b.balance
       FROM accounts a JOIN account_balances b ON b.account_id = a.id
      WHERE a.id = ANY($1::uuid[])
      ORDER BY a.id
        FOR UPDATE OF b`,
    [ids],
  );
  if (accounts.length !== ids.length) throw new HttpError(404, "account_not_found", "Account not found");
  if (new Set(accounts.map((a) => a.currency)).size > 1) {
    throw new HttpError(422, "currency_mismatch", "All accounts in a transaction must use the same currency");
  }

  const delta = new Map<string, bigint>();
  for (const e of entries) delta.set(e.accountId, (delta.get(e.accountId) ?? 0n) + e.amount);
  for (const a of accounts) {
    const next = BigInt(a.balance) + (delta.get(a.id) ?? 0n);
    if (a.kind === "customer" && next < 0n) {
      throw new HttpError(422, "insufficient_funds", "Insufficient funds");
    }
  }

  const { rows } = await client.query(`INSERT INTO transactions (kind) VALUES ($1) RETURNING id`, [kind]);
  const txId: string = rows[0].id;
  for (const e of entries) {
    await client.query(`INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES ($1, $2, $3)`, [
      txId,
      e.accountId,
      e.amount.toString(),
    ]);
  }
  for (const [accountId, d] of delta) {
    await client.query(
      `UPDATE account_balances SET balance = balance + $2, updated_at = now() WHERE account_id = $1`,
      [accountId, d.toString()],
    );
  }
  return txId;
}

/** Checks that the whole ledger sums to zero and every cached balance equals the sum of its entries. */
export async function reconcile(client: PoolClient) {
  const { rows: total } = await client.query(`SELECT COALESCE(SUM(amount), 0)::text AS sum FROM ledger_entries`);
  const { rows: mismatches } = await client.query(
    `SELECT b.account_id, b.balance::text AS cached, COALESCE(SUM(e.amount), 0)::text AS from_entries
       FROM account_balances b LEFT JOIN ledger_entries e ON e.account_id = b.account_id
      GROUP BY b.account_id, b.balance
     HAVING b.balance <> COALESCE(SUM(e.amount), 0)`,
  );
  return {
    ledgerSum: total[0].sum,
    balanced: total[0].sum === "0" && mismatches.length === 0,
    mismatchedAccounts: mismatches,
  };
}
