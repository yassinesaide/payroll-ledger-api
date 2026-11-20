import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app";
import { issueToken } from "../src/lib/auth";
import { pool } from "../src/lib/db";
import { migrate } from "../src/migrate";

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await migrate();
  await pool.query(
    `TRUNCATE ledger_entries, transactions, idempotency_keys, payouts, account_balances, accounts RESTART IDENTITY CASCADE`,
  );
}

export function auth(userId = "alice") {
  return { Authorization: `Bearer ${issueToken(userId)}` };
}

export async function createAccount(userId = "alice", currency = "EUR"): Promise<string> {
  const res = await api().post("/accounts").set(auth(userId)).send({ currency });
  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function deposit(accountId: string, amount: number, userId = "alice") {
  return api()
    .post(`/accounts/${accountId}/deposits`)
    .set(auth(userId))
    .set("Idempotency-Key", randomUUID())
    .send({ amount });
}

export async function balance(accountId: string, userId = "alice"): Promise<string> {
  const res = await api().get(`/accounts/${accountId}`).set(auth(userId));
  return res.body.balance;
}

export async function reconciliation() {
  const res = await api().get("/reconciliation").set(auth());
  return res.body;
}
