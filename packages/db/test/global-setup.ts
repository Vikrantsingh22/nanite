import postgres from "postgres";

/** Creates the separate `nanite_test` database (if missing) and exposes its URL to tests. */
export default async function setup() {
  const base = process.env.DATABASE_URL ?? "postgres://nanite:nanite@db:5432/nanite";
  const admin = new URL(base);
  const testUrl = new URL(base);
  testUrl.pathname = "/nanite_test";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = 'nanite_test'`;
    if (rows.length === 0) await sql.unsafe("CREATE DATABASE nanite_test");
  } finally {
    await sql.end();
  }
  process.env.TEST_DATABASE_URL = testUrl.toString();
}
