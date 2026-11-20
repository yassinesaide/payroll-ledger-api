import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "./lib/db";

export async function migrate() {
  const sql = readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8");
  const client = await pool.connect();
  try {
    // API and worker may start together: serialize schema creation with an advisory lock.
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)");
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log("schema applied");
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
