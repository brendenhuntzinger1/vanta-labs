import { Client } from "pg";

// Per-suite Postgres databases.
//
// Two database-backed suites that share one database share its tables. Both of
// Block F's create an `orders` table, and vitest runs files in parallel — so
// run together they drop each other's data mid-test. The failure is not a clean
// error either: one suite sees a table that another is halfway through
// rebuilding, and reports a wrong number rather than a crash.
//
// AUDIT-PARALLEL-ASSIGNMENTS.md Rule 5 names this file for exactly that reason:
// "A suite that silently shares state produces false passes."
//
// Each suite gets its own database, dropped and recreated at the start of the
// run so it never inherits anything from a previous one.

/** Postgres identifiers cap at 63 bytes; the prefix leaves room for the name. */
function databaseNameFor(suite: string): string {
  const slug = suite.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `vanta_suite_${slug}`.slice(0, 63);
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Create (or recreate) a database for one suite and return its URL.
 *
 * `baseUrl` must point at a throwaway cluster — this DROPS the suite's database
 * if it already exists. It never touches any database it did not name itself.
 */
export async function createSuiteDatabase(baseUrl: string, suite: string): Promise<string> {
  const database = databaseNameFor(suite);
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    // WITH (FORCE) terminates connections a previous aborted run left behind;
    // without it a leaked client makes the drop hang rather than fail.
    await admin.query(`drop database if exists "${database}" with (force)`);
    await admin.query(`create database "${database}"`);
  } finally {
    await admin.end();
  }
  return withDatabase(baseUrl, database);
}
