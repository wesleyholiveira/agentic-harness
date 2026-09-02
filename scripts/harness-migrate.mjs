import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = resolve(process.env.AGENT_HARNESS_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const url = process.env.AGENT_POSTGRES_URL || process.env.DATABASE_URL;
if (!url) throw new Error("AGENT_POSTGRES_URL required");
const dir = resolve(root, "infra", "postgres", "migrations");
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS harness_migrations(name text primary key, applied_at timestamptz not null default now())");
try {
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".sql")).sort()) {
    const seen = await client.query("SELECT 1 FROM harness_migrations WHERE name=$1", [name]);
    if (seen.rowCount) continue;
    const sql = await readFile(resolve(dir, name), "utf8");
    await client.query("BEGIN");
    try {
      for (const statement of sql.split(/-- statement-breakpoint/g).map((value) => value.trim()).filter(Boolean)) await client.query(statement);
      await client.query("INSERT INTO harness_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
