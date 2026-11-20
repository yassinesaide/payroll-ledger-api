import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/lib/db";
import { api, auth, balance, createAccount, deposit, reconciliation, resetDb } from "./helpers";

beforeEach(resetDb);
after(() => pool.end());

describe("auth and validation", () => {
  test("rejects requests without a valid token", async () => {
    const res = await api().post("/accounts").send({ currency: "EUR" });
    assert.equal(res.status, 401);
  });

  test("rejects invalid amounts and missing Idempotency-Key", async () => {
    const id = await createAccount();
    const bad = await api().post(`/accounts/${id}/deposits`).set(auth()).set("Idempotency-Key", "k1").send({ amount: -5 });
    assert.equal(bad.status, 400);
    const noKey = await api().post(`/accounts/${id}/deposits`).set(auth()).send({ amount: 100 });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error, "idempotency_key_required");
  });

  test("users cannot move money out of someone else's account", async () => {
    const alice = await createAccount("alice");
    const bob = await createAccount("bob");
    await deposit(alice, 1000);
    const res = await api()
      .post("/transfers")
      .set(auth("bob"))
      .set("Idempotency-Key", randomUUID())
      .send({ fromAccountId: alice, toAccountId: bob, amount: 500 });
    assert.equal(res.status, 404);
    assert.equal(await balance(alice), "1000");
  });
});

describe("idempotency", () => {
  test("a retried request returns the stored response and moves money once", async () => {
    const id = await createAccount();
    const send = () => api().post(`/accounts/${id}/deposits`).set(auth()).set("Idempotency-Key", "dep-1").send({ amount: 2500 });
    const first = await send();
    const second = await send();
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.headers["idempotent-replayed"], "true");
    assert.equal(second.body.transactionId, first.body.transactionId);
    assert.equal(await balance(id), "2500");
  });

  test("reusing a key with a different body is rejected", async () => {
    const id = await createAccount();
    await api().post(`/accounts/${id}/deposits`).set(auth()).set("Idempotency-Key", "dep-2").send({ amount: 100 });
    const res = await api().post(`/accounts/${id}/deposits`).set(auth()).set("Idempotency-Key", "dep-2").send({ amount: 999 });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, "idempotency_key_reused");
    assert.equal(await balance(id), "100");
  });

  test("30 concurrent requests with the same key create exactly one transaction", async () => {
    const id = await createAccount();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        api().post(`/accounts/${id}/deposits`).set(auth()).set("Idempotency-Key", "same-key").send({ amount: 700 }),
      ),
    );
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(new Set(results.map((r) => r.body.transactionId)).size, 1);
    assert.equal(await balance(id), "700");
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE kind = 'deposit'`);
    assert.equal(rows[0].n, 1);
  });

  test("a business error is stored: the retry gets the same 422", async () => {
    const from = await createAccount();
    const to = await createAccount();
    const send = () =>
      api().post("/transfers").set(auth()).set("Idempotency-Key", "t-1").send({ fromAccountId: from, toAccountId: to, amount: 50 });
    const first = await send();
    await deposit(from, 1000); // funds arrive after the first attempt
    const retry = await send();
    assert.equal(first.status, 422);
    assert.equal(retry.status, 422);
    assert.equal(retry.headers["idempotent-replayed"], "true");
  });
});

describe("concurrency", () => {
  test("50 concurrent transfers of 10 from a balance of 100: exactly 10 succeed, no double spend", async () => {
    const from = await createAccount();
    const to = await createAccount();
    await deposit(from, 100);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        api()
          .post("/transfers")
          .set(auth())
          .set("Idempotency-Key", randomUUID())
          .send({ fromAccountId: from, toAccountId: to, amount: 10 }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 10);
    assert.equal(results.filter((r) => r.status === 422).length, 40);
    assert.equal(await balance(from), "0");
    assert.equal(await balance(to), "100");
    assert.equal((await reconciliation()).balanced, true);
  });

  test("opposite transfers A->B and B->A in parallel do not deadlock", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await deposit(a, 10_000);
    await deposit(b, 10_000);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        api()
          .post("/transfers")
          .set(auth())
          .set("Idempotency-Key", randomUUID())
          .send(i % 2 ? { fromAccountId: a, toAccountId: b, amount: 25 } : { fromAccountId: b, toAccountId: a, amount: 25 }),
      ),
    );
    assert.ok(results.every((r) => r.status === 201), "no request should fail with a deadlock");
    assert.equal(await balance(a), "10000");
    assert.equal(await balance(b), "10000");
  });
});
