import { vi } from "vitest";

// Intentionally almost empty. See src/test-support/payment-suite-fakes.ts.
//
// This file used to apply vi.mock() to ELEVEN modules for every suite in the
// repository: @/lib/email/send, @/lib/coupons, @/lib/membership,
// @/lib/cart-recovery, @/lib/admin-control, @/lib/tax-provider,
// @/lib/membership-billing, @/lib/fulfillment/service, @/lib/ambassador-settings,
// @/lib/catalog and @/lib/supabase-server.
//
// A global stub is not free. It silently replaces the module for suites that
// never asked for it, so a test can exercise a stub, assert on the stub's return
// value, and pass while the real code is broken or never runs at all. That is not
// hypothetical here: a cart-recovery regression test written during this audit
// passed green while calling `runAbandonedCartSweep: async () => ({ t30mSent: 0,
// ... })` — a stub that touches no database and cannot fail. The @/lib/email/send
// stub returned `{ success: true }` unconditionally, so NO suite in this repo
// could observe a failed send, which is exactly what three separate email defects
// live behind.
//
// Each of the eleven was removed in isolation and the full suite re-run. NINE
// changed the result by zero tests — every suite that needed one already
// re-mocked it locally — so they were deleted. The remaining two were needed by
// exactly two suites, which now apply them explicitly.
//
// THE RULE: mock in the suite that needs the mock. If something genuinely belongs
// to every suite, it needs a comment here saying why, and a demonstration that a
// suite fails without it.
//
// (`server-only` is aliased to an empty module in vitest.config.ts rather than
// mocked here — that is a resolution concern, not a behavioural one.)

// ---------------------------------------------------------------------------
// WHAT THE ELEVEN WERE, AND WHERE EACH MODULE IS REALLY EXERCISED.
//
// Two sessions audited this file independently. One measured each stub by
// deleting it and re-running the whole suite; nine changed the result by zero
// tests and were removed (above). The other kept all eleven and catalogued
// where the real module is covered. The deletions won — a stub nothing needs is
// pure invisible coverage loss — but the catalogue is the more valuable half of
// the second session's work and is kept here, because it is the map of which
// modules had no behavioural coverage at all until this audit.
//
//   @/lib/email/send          Always succeeded, so NO suite in the repo could
//                             observe a failed send — which is where three
//                             separate email defects live. Real coverage:
//                             order-email-once.test.ts and the journey
//                             harness's emailFailures counter.
//   @/lib/membership-billing  Stubbed to two no-ops, leaving
//                             startMembershipSignup — the function that takes
//                             membership money — with ZERO behavioural
//                             coverage. Restoring the historical defect (a
//                             FAILED first charge still writing a membership
//                             row) left all 3,660 tests green. Real coverage:
//                             membership-signup-behaviour.test.ts.
//   @/lib/coupons             calculateCouponDiscount returned 0, so three
//                             fuzz suites asserted 0 >= 0 across 40,000+
//                             "cases". Real coverage: coupons.test.ts,
//                             coupon-validation.test.ts.
//   @/lib/membership          Real coverage: the e2e suites, reconciliation-drift.
//   @/lib/catalog             Real coverage: the e2e suites.
//   @/lib/admin-control       Real coverage: the e2e suites, plus per-file
//                             overrides where real tax/bulk config matters.
//   @/lib/ambassador-settings Real coverage: payout-authority.test.ts.
//   @/lib/tax-provider        Ran the REAL resolveSalesTax against mocked
//                             settings, so tax maths was always genuine.
//   @/lib/cart-recovery       Real coverage: cart-recovery-coupon-leak.test.ts,
//                             cart-recovery-last-chance.test.ts.
//   @/lib/supabase-server     Replaced per file by fake-db, the journey
//                             harness, or a real Postgres.
//   @/lib/fulfillment/service Targeted a module that DOES NOT EXIST in src.
//                             The stub was inert; it is gone with the rest.
// ---------------------------------------------------------------------------

void vi;

// ---------------------------------------------------------------------------
// THE ONE THING THAT DOES BELONG TO EVERY SUITE: refuse to run the DB-backed
// tests against the BROWSER HARNESS database.
//
// This is not a mock, so the rule above is intact — it is a precondition, and
// it is here rather than in the thirteen suites that read
// VANTA_TEST_DATABASE_URL because the fourteenth is the one that will forget.
//
// WHY. Those suites build their own minimal fixtures, so pointing them at the
// harness database REBUILDS `orders` — 107 columns down to 39. What makes that
// worth a hard stop rather than a warning is how it fails afterwards:
//
//   - setup-local-harness.sh does `createdb || true` and deploy-run-once.sql
//     does `create table if not exists`, so re-running setup CANNOT repair the
//     damaged table. The base schema is a no-op once the table exists.
//   - The parity self-check kept reporting every row green, because it only
//     covered columns harness-prod-parity-columns.sql re-adds.
//
// So the harness went on serving a wrong database while insisting it was
// correct, and the browser evidence taken from it was wrong in a way nothing
// surfaced. A launch audit lost a headline finding to exactly this: a product
// whose doses had been wiped read as Out of Stock, and that was reported as 15
// unsellable products in production. Failing loudly here is much cheaper.
//
// Use a throwaway: `createdb vanta_scratch` and point the variable at that.
// ---------------------------------------------------------------------------
const HARNESS_DATABASES = new Set(["storefront"]);

const testDatabaseUrl = process.env.VANTA_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  let databaseName: string | undefined;
  try {
    databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\//, ""));
  } catch {
    // An unparseable value is the suites' own problem to report, not ours.
  }

  if (databaseName && HARNESS_DATABASES.has(databaseName)) {
    throw new Error(
      `VANTA_TEST_DATABASE_URL points at "${databaseName}", which is the browser harness database.\n`
        + "The DB-backed suites rebuild `orders` with their own minimal schema, which would silently\n"
        + "destroy the harness — and setup-local-harness.sh cannot repair it, because its `createdb`\n"
        + "and `create table if not exists` are both no-ops once the table exists.\n\n"
        + "Use a throwaway database instead:\n"
        + "  createdb -h /tmp -p 55432 -U postgres vanta_scratch\n"
        + "  VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/vanta_scratch npm test",
    );
  }
}

export {};
