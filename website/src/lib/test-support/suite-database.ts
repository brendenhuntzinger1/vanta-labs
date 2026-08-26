import { Client } from "pg";

// ---------------------------------------------------------------------------
// One throwaway DATABASE per database-backed suite.
//
// Vitest runs test FILES in parallel workers. Every database-backed suite here
// drops and recreates the same `public` tables in beforeEach, so pointing them
// all at one database makes them destroy each other's fixtures mid-run — which
// surfaces as unique-constraint errors from a *different* suite's seed data and
// looks exactly like a real defect.
//
// The SQL under test names `public.` explicitly, so a shared database with
// separate schemas is not an option. A separate database per suite is.
// ---------------------------------------------------------------------------

/**
 * Ensure a dedicated database exists for `suite` alongside the one in
 * `baseUrl`, and return a connection string pointing at it.
 */
export async function suiteDatabaseUrl(baseUrl: string, suite: string) {
  const name = `vanta_test_${suite.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } catch (error) {
    // 42P04 = duplicate_database. Two workers can reach this at once; whichever
    // loses simply uses the database the winner created.
    if ((error as { code?: string }).code !== "42P04") throw error;
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
