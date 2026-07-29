import { Client } from "pg";

/**
 * Runs before any test module is imported, so config.ts reads these values
 * instead of the developer's .env. dotenv does not overwrite existing keys,
 * which is what makes this ordering work.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:password@localhost:5433/kauth_test?schema=public";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET ??= "test-jwt-secret-not-used-outside-of-tests";
process.env.COOKIE_SECRET ??= "test-cookie-secret-not-used-outside-of-tests";

function adminUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);

  url.pathname = "/postgres";
  url.search = "";

  return { adminConnectionString: url.toString(), database };
}

async function ensureDatabaseExists() {
  const { adminConnectionString, database } = adminUrl(TEST_DATABASE_URL);
  const client = new Client({ connectionString: adminConnectionString });

  await client.connect();

  try {
    const existing = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );

    if (existing.rowCount === 0) {
      // Identifier cannot be parameterised; the name comes from our own URL.
      await client.query(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await client.end();
  }
}

async function applyMigrations() {
  const proc = Bun.spawn(["bunx", "--bun", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const output = await new Response(proc.stderr).text();
    throw new Error(`prisma migrate deploy failed:\n${output}`);
  }
}

await ensureDatabaseExists();
await applyMigrations();

// Imported dynamically so the environment above is in place before config.ts
// reads it. Keeps the default transport from printing every test's mail.
const { createMemoryMailer, setMailer } = await import("../lib/mail");
setMailer(createMemoryMailer());
