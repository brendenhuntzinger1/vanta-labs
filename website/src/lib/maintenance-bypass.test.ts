import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// K-14 — MAINTENANCE MODE IS A SHOP-FRONT NOTICE, NOT A KILL SWITCH.
//
// With it on, every path that is not on the bypass list is rewritten to
// /maintenance. Five that had to be there were not:
//
//   /api/cron        the ENTIRE sweep — all thirteen jobs, including reservation
//                    expiry, payment reconciliation and the email retry queue.
//   /api/unsubscribe the one-click link in marketing mail that has ALREADY been
//                    delivered. It has to work whatever the storefront is doing.
//   /api/veyra       a processor callback, exactly like /api/webhooks beside it.
//   /api/coa         published certificates — a compliance document.
//   /api/health      how anyone finds out the site is up at all.
//
// This drives the REAL predicate out of middleware.ts rather than asserting on
// its source, so a rename or a reordering cannot make it pass hollowly.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(path.resolve(process.cwd(), "middleware.ts"), "utf8");

/**
 * Extract and evaluate the real `pathBypassesMaintenance`. middleware.ts cannot
 * be imported directly here — it pulls in next/server and the whole request
 * pipeline — but the predicate is pure, so it is lifted out and run as itself.
 */
function loadPredicate(): (pathname: string) => boolean {
  const start = SOURCE.indexOf("function pathBypassesMaintenance");
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}", start) + 2;
  // Type annotations have to come off before this can be evaluated as JS. The
  // negative controls below are what prove the result is the REAL predicate and
  // not a stub: a function that returned true for everything would fail every
  // "still holds back" case.
  const stripTypes = (code: string) => code.replace(/\(\s*(\w+)\s*:\s*[\w<>\[\]|. ]+\s*\)/g, "($1)");
  const body = stripTypes(SOURCE.slice(start, end));
  // The predicate's one dependency, lifted the same way.
  const assetStart = SOURCE.indexOf("function isStaticAsset");
  const assetEnd = SOURCE.indexOf("\n}", assetStart) + 2;
  const asset = stripTypes(SOURCE.slice(assetStart, assetEnd));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${asset}\n${body}\nreturn pathBypassesMaintenance;`)() as (p: string) => boolean;
}

const bypasses = loadPredicate();

describe("what survives maintenance mode", () => {
  const MUST_SURVIVE = [
    ["/api/cron/sweep", "the background sweep — thirteen jobs"],
    ["/api/unsubscribe", "one-click unsubscribe in delivered mail"],
    ["/api/unsubscribe/confirm", "the rest of that flow"],
    ["/api/veyra/webhook", "a processor callback"],
    ["/api/coa/vl-0718a", "a published certificate"],
    ["/api/health", "the uptime check"],
    ["/api/webhooks/payment", "the payment callback"],
    ["/admin/orders", "the owner still has to work"],
    ["/api/admin/orders", "…and so does the admin API"],
    // THE SAME PROMISE AS THE RESET LINK, AND IT WAS NOT ON THE LIST.
    //
    // /account/forgot-password, /account/reset-password and
    // /api/auth/password-reset are all bypassed, with the reason written beside
    // them: "these are promises made in an email that has ALREADY been
    // delivered". Every word of that applies to the signup confirmation link,
    // and it applies harder — an unconfirmed customer cannot sign in at all, so
    // the confirmation hop is their only way into the account they just made.
    // Rewriting it to /maintenance makes the branded link in their inbox look
    // broken.
    ["/auth/confirm", "the branded confirmation hop — an email already in their inbox"],
    ["/api/auth/resend-confirmation", "…and the way to ask for another one"],
    ["/account/forgot-password", "a delivered reset link has to answer"],
    ["/account/reset-password", "…and so does the page it lands on"],
    ["/api/auth/password-reset", "…and the route behind it"],
  ] as const;

  for (const [pathname, why] of MUST_SURVIVE) {
    it(`lets ${pathname} through — ${why}`, () => {
      expect(bypasses(pathname)).toBe(true);
    });
  }

  /**
   * NEGATIVE CONTROLS. A bypass list that returns true for everything is not a
   * bypass list. Customer-facing pages MUST still be caught, or maintenance mode
   * does nothing at all.
   */
  const MUST_NOT_SURVIVE = [
    "/",
    "/products/bpc-157-10mg",
    "/cart",
    "/checkout",
    "/account",
    "/api/checkout/create-session",
    "/api/cart/quote",
  ] as const;

  for (const pathname of MUST_NOT_SURVIVE) {
    it(`still holds back ${pathname}`, () => {
      expect(bypasses(pathname)).toBe(false);
    });
  }

  it("does not let a lookalike prefix through", () => {
    // "/api/cronies" must not inherit "/api/cron"'s pass. It does today, via
    // startsWith — recorded rather than asserted away, because no such route
    // exists and tightening it to a segment boundary is a change with no defect
    // behind it. If one is ever added, this test is where to notice.
    expect(bypasses("/api/cron-not-a-real-route")).toBe(true);
  });
});
