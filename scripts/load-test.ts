/**
 * Load test: starts the API in-process, funds 100 accounts, then fires random transfers
 * between them for 10 seconds with autocannon (every request has its own Idempotency-Key).
 * At the end it checks that the ledger still reconciles.
 * Run: docker compose up -d db && npm run load
 */
import autocannon from "autocannon";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { issueToken } from "../src/lib/auth";
import { pool } from "../src/lib/db";
import { migrate } from "../src/migrate";

const ACCOUNTS = 100;
const DURATION = Number(process.env.LOAD_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 20);

async function main() {
  await migrate();
  await pool.query(`TRUNCATE ledger_entries, transactions, idempotency_keys, payouts, account_balances, accounts CASCADE`);

  const server = createApp().listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${issueToken("load")}`, "content-type": "application/json" };

  const ids: string[] = [];
  for (let i = 0; i < ACCOUNTS; i++) {
    const acc = await (await fetch(`${base}/accounts`, { method: "POST", headers, body: JSON.stringify({ currency: "EUR" }) })).json();
    await fetch(`${base}/accounts/${acc.id}/deposits`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ amount: 1_000_000 }),
    });
    ids.push(acc.id);
  }

  const result = await autocannon({
    url: base,
    connections: CONNECTIONS,
    duration: DURATION,
    requests: [
      {
        method: "POST",
        path: "/transfers",
        setupRequest: (req) => {
          const from = ids[Math.floor(Math.random() * ACCOUNTS)];
          let to = ids[Math.floor(Math.random() * ACCOUNTS)];
          while (to === from) to = ids[Math.floor(Math.random() * ACCOUNTS)];
          return {
            ...req,
            headers: { ...headers, "Idempotency-Key": randomUUID() },
            body: JSON.stringify({ fromAccountId: from, toAccountId: to, amount: 1 + Math.floor(Math.random() * 100) }),
          };
        },
      },
    ],
  });

  const recon = await (await fetch(`${base}/reconciliation`, { headers })).json();
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE kind = 'transfer'`);
  const summary = {
    durationSeconds: DURATION,
    connections: CONNECTIONS,
    requests: result.requests.total,
    requestsPerSecondAvg: result.requests.average,
    latencyMsP50: result.latency.p50,
    latencyMsP99: result.latency.p99,
    non2xx: result.non2xx,
    errors: result.errors,
    transfersCommitted: rows[0].n,
    ledgerBalancedAfterRun: recon.balanced,
  };
  console.log(JSON.stringify(summary, null, 2));
  server.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
