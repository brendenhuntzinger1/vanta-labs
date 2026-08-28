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

/** The .sql files, where a table's existence is declared. */
const walkSql = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walkSql(full);
    return entry.endsWith(".sql") ? [full] : [];
  });

const sqlFiles = walkSql(SRC).map((path) => ({
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

/**
 * RLS-05, applied 2026-08-28: SELECT was revoked from anon and authenticated on
 * every table in `public` that has RLS enabled and ZERO policies —
 * migrations-applied/20260828T0245_rls05_revoke_select_policyless_rls_tables.sql.
 *
 * Those tables already returned nothing to the publishable key (RLS on with no
 * policy denies every row), so the revoke changed no answer. What it changed is
 * the failure mode of a future mistake: before, a browser-client read of one of
 * these returned an empty array, which reads as "no rows" and can sit in a
 * feature for weeks. Now it returns 42501 in production and only in production
 * — passing review, the harness and a Vercel preview, then failing for
 * customers. Exactly the shape the list above exists to catch, so it is caught
 * the same way.
 *
 * Enumerated deliberately rather than derived: this list is the production
 * grant state as applied, and a test that recomputed it from the same source it
 * is checking would assert nothing. If a table gains a policy and a deliberate
 * column-enumerated grant, remove it from here in the same change.
 *
 * As with the list above: if one of these fails, move the call server-side. Do
 * NOT re-grant the table.
 */
const POLICYLESS_RLS_TABLES = [
  "abandoned_cart_emails", "abandoned_carts", "ad_purchase_events_sent",
  "back_in_stock_requests", "coa_records", "email_automations",
  "email_campaign_clicks", "email_campaign_recipients", "email_campaigns",
  "email_send_log", "email_suppressions", "express_checkout_intents",
  "express_shipping_quotes", "fulfillment_batch_orders", "fulfillment_batches",
  "fulfillment_events", "fulfillment_orders", "fulfillment_payouts",
  "inventory_reservations", "inventory_transactions", "marketing_subscribers",
  "membership_billing_events", "order_amount_backfills", "order_attribution",
  "order_email_log", "order_shipping_cost_audit", "order_status_history",
  "pending_emails", "product_cost_changes", "product_subscriptions",
  "rate_limit_hits", "referral_code_aliases", "referral_code_changes",
  "shipping_package_presets", "shippo_webhook_events", "system_alerts",
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

  it("no browser-client file reads any policy-less RLS table (RLS-05)", () => {
    // One case over all 36 rather than 36 cases: the per-table loop above earns
    // its granularity because those five are individually load-bearing. These
    // are one revoke with one remedy, and a failure names the offenders anyway.
    const offenders = browserFiles.flatMap((file) =>
      POLICYLESS_RLS_TABLES
        .filter((table) => file.text.includes(`.from("${table}")`))
        .map((table) => `${file.path} -> ${table}`),
    );

    expect(offenders).toEqual([]);
  });

  it("the RLS-05 list is real, so the assertion above cannot pass on a typo", () => {
    // If every name in that array were misspelled the scan would find nothing
    // and report a clean pass. So each name has to be traceable to something
    // in the repository.
    //
    // The corpus is TypeScript AND the .sql files, which is the correction this
    // assertion made when first written: it scanned only TypeScript and failed
    // on fulfillment_events, fulfillment_orders, fulfillment_payouts and
    // order_amount_backfills. Those are not typos and not dead schema — they
    // carry live production rows (194 / 2 / 2 / 3 at the time of the revoke)
    // and are declared in phase2-financial-remediation.sql,
    // schema-complete-sync.sql and shipping-protection-persistence.sql. They
    // simply have no TypeScript reader at all, which is precisely why revoking
    // their client-key SELECT could not break anything.
    const corpus = [
      ...sourceFiles.map((file) => file.text),
      ...sqlFiles.map((file) => file.text),
    ].join("\n");
    const unknown = POLICYLESS_RLS_TABLES.filter((table) => !corpus.includes(table));

    expect(unknown).toEqual([]);
    expect(POLICYLESS_RLS_TABLES).toHaveLength(36);
  });

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
