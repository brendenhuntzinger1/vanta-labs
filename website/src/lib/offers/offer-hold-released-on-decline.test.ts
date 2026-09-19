import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A DEAD CHECKOUT HOLDS THREE THINGS, AND THE GIFT WAS THE ONE LEFT BEHIND.
//
// Stock, store credit and the offer token are all reserved when an order is
// created. The webhook's decline/cancel branch hands the first two back. The
// third was not, and unlike the other two it does not simply age out of
// everything: chooseSpinDose guards its write on `reserved_order_id is null`
// and deliberately FAILS CLOSED on a hold that has gone stale, so the lock is
// permanent.
//
// What that cost a customer: a winner of one of the four laddered prizes
// (glp_1, glp_2, glp_3, hgh — a quarter of the wheel) whose card was declined
// could never change their dose again, and was told to "finish or cancel" an
// order that had already died — while the panel beside the picker says "You
// can change this until the prize expires".
//
// Asserted against the source because this branch of the webhook needs a
// signed processor event, an order row and a reservation to reach; the SQL it
// calls is proved separately (customer_offer_release refuses a redeemed
// offer), and the end-to-end decline journey is driven by
// scripts/qa-wheel-campaign.mjs.
// ---------------------------------------------------------------------------

const WEBHOOK = readFileSync(join(process.cwd(), "src", "lib", "payment-webhook.ts"), "utf8");
const SQL = readFileSync(join(process.cwd(), "src", "lib", "sql", "customer-offers.sql"), "utf8");

describe("the decline and cancel branch", () => {
  it("releases the offer hold", () => {
    expect(WEBHOOK).toContain("await releaseCustomerOffer(orderId);");
  });

  it("does it in the same branch that releases the tender hold, and only for an order that never paid", () => {
    // Being inside this guard is the whole safety argument: a refund is not in
    // scope (that redemption is real money already spent) and a paid order
    // never reaches here.
    const guard = WEBHOOK.indexOf('if ((nextStatus === "payment_failed" || nextStatus === "canceled") && !wasPaid) {');
    expect(guard).toBeGreaterThan(-1);
    const release = WEBHOOK.indexOf("await releaseCustomerOffer(orderId);", guard);
    expect(release).toBeGreaterThan(guard);
    // Still inside the same block: the next branch opens at the restock latch.
    const nextBlock = WEBHOOK.indexOf('const stockCommitted = Boolean(orderRecord?.inventory_committed_at);', guard);
    expect(release).toBeLessThan(nextBlock);
  });

  it("cannot take a redeemed gift back, whatever the event says", () => {
    // The guarantee is in the function, not in the caller: a replayed decline
    // for an order that later paid matches no row.
    const fn = SQL.slice(SQL.indexOf("create or replace function public.customer_offer_release"));
    expect(fn.slice(0, 600)).toContain("and redeemed_at is null");
  });

  it("survives its own failure rather than taking the decline down with it", () => {
    const at = WEBHOOK.indexOf("await releaseCustomerOffer(orderId);");
    const after = WEBHOOK.slice(at, at + 400);
    expect(after).toContain("catch (offerReleaseError)");
    expect(after).toContain('unsafeEffectAlert("offer_hold_release"');
  });
});

describe("why the hold had to be released rather than ignored", () => {
  it("the dose picker really does refuse a held offer, and fails closed on a stale one", () => {
    const dose = readFileSync(join(process.cwd(), "src", "lib", "spin", "spin-dose.ts"), "utf8");
    expect(dose).toContain('.is("reserved_order_id", null)');
  });
});
