import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE GRANT INVARIANT.
//
// Production revoked every anon/authenticated privilege on `orders`,
// `order_items`, `referrals`, `partner_clicks` and `website_analytics_events`,
// and every write privilege on `ambassadors`
// (sql/migrations-applied/20260827233116_phase1_order_and_event_table_lockdown.sql).
//
// That revoke is safe for exactly one reason: every one of those tables is
// reached only through the service-role client, which bypasses grants. The
// moment somebody reaches one of them from `@/lib/supabase` — the browser
// client, carrying the publishable key that ships to every visitor — the call
// starts returning 42501 in production and nowhere else. It will pass review,
// pass the harness, pass a Vercel preview, and fail for customers.
//
// These tests are the tripwire. If one fails, the fix is to move the call
// server-side, NOT to re-grant the table.
//
// Why this is a source scan and not a database test: the local harness carries
// its own grants and has already drifted from production, so asserting against
// it would prove nothing about the database this protects.
// ---------------------------------------------------------------------------

const SRC = resolve(process.cwd(), "src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });

const sourceFiles = walk(SRC).map((path) => ({
  path: path.slice(resolve(process.cwd()).length + 1),
  text: readFileSync(path, "utf8"),
}));

// The browser client. `@/lib/supabase-server` is the service-role client and is
// deliberately not matched.
const BROWSER_CLIENT_IMPORT = /from\s+["']@\/lib\/supabase["']/;

const LOCKED_TABLES = [
  "orders",
  "order_items",
  "referrals",
  "partner_clicks",
  "website_analytics_events",
] as const;

describe("tables the publishable key can no longer reach", () => {
  const browserFiles = sourceFiles.filter((file) => BROWSER_CLIENT_IMPORT.test(file.text));

  it("finds the browser-client files, so an empty list cannot fake a pass", () => {
    expect(browserFiles.length).toBeGreaterThan(0);
  });

  for (const table of LOCKED_TABLES) {
    it(`no browser-client file touches ${table}`, () => {
      const offenders = browserFiles
        .filter((file) => file.text.includes(`.from("${table}")`))
        .map((file) => file.path);

      expect(offenders).toEqual([]);
    });
  }

  it("ambassadors stays readable from the browser, and unwritable", () => {
    // referral-client.ts falls back to a narrow browser read when the
    // validate_referral_code RPC is missing, and throws on any error — which is
    // why the SELECT grant was kept. A write from the same client would 42501.
    const readers = browserFiles.filter((file) => file.text.includes('.from("ambassadors")'));

    expect(readers.map((file) => file.path)).toEqual(["src/lib/referral-client.ts"]);

    for (const file of readers) {
      const writes = file.text.match(/\.from\("ambassadors"\)\s*\n?\s*\.(insert|update|upsert|delete)\b/g);
      expect(writes).toBeNull();
    }
  });
});

describe("the locked tables are still written, server-side", () => {
  // A revoke that silently orphaned a write path would look identical to a
  // clean pass above. These assert the writes still exist and are server-side.
  const writePaths: Array<[string, string]> = [
    ["src/app/r/[code]/route.ts", "partner_clicks"],
    ["src/app/r/[code]/route.ts", "referrals"],
    ["src/app/api/analytics/track/route.ts", "website_analytics_events"],
  ];

  for (const [path, table] of writePaths) {
    it(`${path} still writes ${table} through the service-role client`, () => {
      const file = sourceFiles.find((candidate) => candidate.path === path);

      expect(file, `${path} not found — was it moved?`).toBeDefined();
      expect(file!.text).toContain(`supabaseAdmin.from("${table}").insert(`);
      expect(BROWSER_CLIENT_IMPORT.test(file!.text)).toBe(false);
    });
  }

  it("every orders / order_items caller uses the service-role client", () => {
    const callers = sourceFiles.filter(
      (file) =>
        (file.text.includes('.from("orders")') || file.text.includes('.from("order_items")')) &&
        !file.path.includes("test-support"),
    );

    expect(callers.length).toBeGreaterThan(20);
    expect(callers.filter((file) => BROWSER_CLIENT_IMPORT.test(file.text)).map((f) => f.path)).toEqual([]);
    expect(
      callers.filter((file) => !file.text.includes('from "@/lib/supabase-server"')).map((f) => f.path),
    ).toEqual([]);
  });
});
