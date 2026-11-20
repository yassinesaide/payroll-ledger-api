import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../src/lib/db";
import { claimJobs, MAX_ATTEMPTS, processJob, PayoutProvider } from "../src/payouts";
import { api, auth, balance, createAccount, deposit, reconciliation, resetDb } from "./helpers";

beforeEach(resetDb);
after(() => pool.end());

const ok: PayoutProvider = async () => {};
const failing: PayoutProvider = async () => {
  throw new Error("bank unavailable");
};

async function requestPayout(accountId: string, amount: number) {
  return api().post("/payouts").set(auth()).set("Idempotency-Key", randomUUID()).send({ accountId, amount });
}

async function makeDue(payoutId: string) {
  await pool.query(`UPDATE payouts SET next_run_at = now() WHERE id = $1`, [payoutId]);
}

describe("payout queue", () => {
  test("a payout holds the money, then settles when the provider succeeds", async () => {
    const id = await createAccount();
    await deposit(id, 5000);
    const res = await requestPayout(id, 2000);
    assert.equal(res.status, 202);
    assert.equal(await balance(id), "3000"); // held immediately

    const jobs = await claimJobs(10);
    assert.equal(jobs.length, 1);
    assert.equal(await processJob(jobs[0], ok), "paid");

    const payout = await api().get(`/payouts/${res.body.payoutId}`).set(auth());
    assert.equal(payout.body.status, "paid");
    assert.equal((await reconciliation()).balanced, true);
  });

  test("a failed payout is retried with backoff and then succeeds", async () => {
    const id = await createAccount();
    await deposit(id, 1000);
    const { body } = await requestPayout(id, 400);

    const [first] = await claimJobs(10);
    assert.equal(await processJob(first, failing), "retry");
    assert.equal((await claimJobs(10)).length, 0, "not due yet because of backoff");

    await makeDue(body.payoutId);
    const [second] = await claimJobs(10);
    assert.equal(second.attempts, 2);
    assert.equal(await processJob(second, ok), "paid");
    assert.equal(await balance(id), "600");
  });

  test(`after ${MAX_ATTEMPTS} failures the payout is dead-lettered and the money is refunded`, async () => {
    const id = await createAccount();
    await deposit(id, 1000);
    const { body } = await requestPayout(id, 300);

    let outcome = "";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await makeDue(body.payoutId);
      const [job] = await claimJobs(10);
      outcome = await processJob(job, failing);
    }
    assert.equal(outcome, "dead");
    const payout = await api().get(`/payouts/${body.payoutId}`).set(auth());
    assert.equal(payout.body.status, "dead");
    assert.equal(payout.body.last_error, "bank unavailable");
    assert.equal(await balance(id), "1000");
    assert.equal((await reconciliation()).balanced, true);
  });

  test("parallel workers never claim the same job (FOR UPDATE SKIP LOCKED)", async () => {
    const id = await createAccount();
    await deposit(id, 100_000);
    for (let i = 0; i < 40; i++) await requestPayout(id, 100);

    const batches = await Promise.all(Array.from({ length: 8 }, () => claimJobs(10)));
    const claimed = batches.flat().map((j) => j.id);
    assert.equal(claimed.length, 40);
    assert.equal(new Set(claimed).size, 40, "every job claimed exactly once");
  });
});
