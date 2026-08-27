import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// THE RATE THE OWNER TYPES IS THE RATE THAT GETS PAID.
//
// Two admin controls set an ambassador's commission, and BOTH tell the operator
// in their own words that doing so takes the ambassador off automatic tiers:
//
//   admin-ambassador-rates-card.tsx  "Automatic performance tiers are active.
//                                     Saving a rate here switches to manual."
//   admin-partners-client.tsx        "Set commission percentage (locks this
//                                     ambassador out of automatic performance
//                                     tiers)"
//
// Neither sends `commissionPercentLocked`. The promise is kept one layer down,
// by a single `?? true` in updatePartnerStatus:
//
//     updatePayload.commission_percent_locked = input.commissionPercentLocked ?? true;
//
// That default is the ONLY thing standing between "the owner agreed 20%" and
// the tier ladder quietly re-pricing them. And it had no coverage: flipping it
// to `?? false` — which unlocks every manually-set rate in the store — left the
// full suite (4,761 tests) completely green. Verified by mutation, not assumed.
//
// commission-tier-resolution.test.ts already covers the ENGINE thoroughly:
// given a locked row it pins the rate, given an unlocked one it applies the
// tier. What nothing covered is the WIRING — that the admin save actually
// produces the locked row the engine needs. So this file drives the real
// updatePartnerStatus with exactly the payload the two UIs send (a percent, no
// lock flag) and then asks the real getEffectiveCommissionPercent what the
// ambassador is paid.
//
// The failure this prevents is silent and gets WORSE with success: an unlocked
// 20% ambassador is paid 20% while they sell nothing, and drops to the tier
// rate the moment they start performing.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({
  getSiteUrl: () => "https://www.vantalabsresearch.com",
  getRequiredEnv: (name: string) => `env-${name}`,
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async () => ({ success: true, id: "msg-1" })),
}));

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return db.current.client; },
  createServerClient: () => db.current.client,
}));

const AMB = "33333333-3333-3333-3333-333333333333";

/** This calendar month, which is the window the tier count reads. */
const thisMonth = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
})();

/**
 * An ambassador on automatic tiers, with enough qualifying sales this month to
 * have genuinely EARNED the middle rung. That is the interesting state: if the
 * lock is lost, the tier is right there waiting to overwrite the agreed rate.
 */
function seed(options: { qualifyingSales: number }) {
  db.current = createFakeDb();

  db.current.table("ambassadors").push({
    id: AMB,
    name: "Rowan Vance",
    email: "rowan@example.test",
    referral_code: "ROWAN",
    status: "approved",
    commission_percent: 10,
    // The default for a new ambassador: automatic tiers on.
    commission_percent_locked: false,
    customer_discount_percent: null,
  });

  // The mirror table updatePartnerStatus also writes.
  db.current.table("partners").push({
    id: AMB,
    name: "Rowan Vance",
    email: "rowan@example.test",
    referral_code: "ROWAN",
    status: "approved",
    commission_percent: 10,
  });

  // Production's ladder, as of this audit: 10 / 12.5 / 15.
  [
    { name: "Starter", min: 0, percent: 10 },
    { name: "Growth", min: 5, percent: 12.5 },
    { name: "Elite", min: 20, percent: 15 },
  ].forEach((tier, index) => {
    db.current.table("commission_tier_rules").push({
      id: `tier-${index}`,
      name: tier.name,
      min_monthly_sales: tier.min,
      commission_percent: tier.percent,
      position: index,
      is_active: true,
    });
  });

  for (let index = 0; index < options.qualifyingSales; index += 1) {
    db.current.table("referral_orders").push({
      id: `ro-${index}`,
      order_id: `order-${index}`,
      ambassador_id: AMB,
      created_at: thisMonth,
      payment_status: "paid",
      commission_amount: 12,
      ineligible_reason: null,
      fraud_flag: false,
    });
  }
}

/** Exactly the payload both admin controls send: a percent, and no lock flag. */
async function ownerSetsRate(percent: number) {
  const { updatePartnerStatus } = await import("@/lib/partner-portal");
  await updatePartnerStatus({
    partnerId: AMB,
    status: "approved",
    commissionPercent: percent,
    actorUsername: "owner",
  });
}

async function paidRate() {
  const { getEffectiveCommissionPercent } = await import("@/lib/ambassador-commission");
  return getEffectiveCommissionPercent({ ambassadorId: AMB, fallbackPercent: 10 });
}

beforeEach(() => {
  vi.resetModules();
});

describe("a commission rate set in the admin survives the tier ladder", () => {
  it("locks the ambassador out of tiers, because that is what both controls promise", async () => {
    seed({ qualifyingSales: 0 });
    await ownerSetsRate(20);

    const row = db.current.table("ambassadors").find((r) => r.id === AMB);
    expect(row?.commission_percent).toBe(20);
    expect(row?.commission_percent_locked).toBe(true);
  });

  it("pays 20% to an ambassador who has earned a lower tier", async () => {
    // Five qualifying sales: the Growth rung (12.5%) is genuinely earned, so an
    // unlocked row would be re-priced down to it. This is the assertion that
    // dies if the `?? true` default is ever flipped.
    seed({ qualifyingSales: 5 });
    await ownerSetsRate(20);

    expect(await paidRate()).toEqual({ percent: 20, tierName: null });
  });

  it("still pays 20% once the ambassador has earned the TOP tier", async () => {
    // The worst version of the bug: the better they sell, the further the paid
    // rate falls below what was agreed. 20 qualifying sales earns Elite (15%),
    // and 15 is still five points short of the agreed 20.
    seed({ qualifyingSales: 20 });
    await ownerSetsRate(20);

    expect(await paidRate()).toEqual({ percent: 20, tierName: null });
  });

  it("pays a rate set BELOW the earned tier too — a lock is a lock in both directions", async () => {
    seed({ qualifyingSales: 20 });
    await ownerSetsRate(8);

    expect(await paidRate()).toEqual({ percent: 8, tierName: null });
  });

  it("re-enabling automatic tiers is still possible, and hands the rate back to the ladder", async () => {
    // The one caller that passes the flag explicitly is the admin's "back to
    // automatic tiers" action. An explicit false must beat the default, or that
    // button silently does nothing.
    seed({ qualifyingSales: 20 });
    await ownerSetsRate(20);

    const { updatePartnerStatus } = await import("@/lib/partner-portal");
    await updatePartnerStatus({
      partnerId: AMB,
      status: "approved",
      commissionPercentLocked: false,
      actorUsername: "owner",
    });

    expect(await paidRate()).toEqual({ percent: 15, tierName: "Elite" });
  });
});
