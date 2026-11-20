import { createHash } from "node:crypto";
import { PoolClient } from "pg";
import { withTransaction } from "./db";
import { HttpError } from "./errors";

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Executes `handler` at most once per (user, Idempotency-Key).
 *
 * The key row is inserted in the SAME database transaction as the money movement:
 * - first request: the INSERT succeeds, the handler runs, the response is stored, all commit together;
 * - a concurrent request with the same key blocks on the unique index until the first commits,
 *   then finds the stored response and returns it (no double spend, no "in progress" state);
 * - same key with a different body or endpoint: 422, the key cannot be reused for another operation;
 * - business errors (4xx HttpError) are stored too, so a retry gets the same answer;
 * - unexpected errors roll everything back, including the key, so the client can safely retry.
 */
export async function runIdempotent(
  userId: string,
  key: string,
  methodPath: string,
  requestBody: unknown,
  handler: (client: PoolClient) => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  const requestHash = createHash("sha256").update(JSON.stringify(requestBody ?? null)).digest("hex");

  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (user_id, key, method_path, request_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING key`,
      [userId, key, methodPath, requestHash],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await client.query(
        `SELECT method_path, request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [userId, key],
      );
      const prev = rows[0];
      if (prev.method_path !== methodPath || prev.request_hash !== requestHash) {
        throw new HttpError(422, "idempotency_key_reused", "Idempotency-Key was already used with a different request");
      }
      return { status: prev.status_code, body: prev.response, replayed: true };
    }

    let result: { status: number; body: unknown };
    await client.query("SAVEPOINT handler");
    try {
      result = await handler(client);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      await client.query("ROLLBACK TO SAVEPOINT handler");
      result = { status: err.status, body: { error: err.code, message: err.message } };
    }

    await client.query(
      `UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2`,
      [userId, key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  });
}
