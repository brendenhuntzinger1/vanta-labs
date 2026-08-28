import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// THE RATE AN AMBASSADOR IS ACTUALLY PAID.
//
// getEffectiveCommissionPercent decides the percentage on every referred order.
// Before this file, it had NO behavioural coverage anywhere in the suite: it is
// vi.mock()'d in all six suites that reach it, e2e/commission-eligibility never
// seeds a commission_tiers row so the tier loop is dead there, and the only
// thing defending the historical bug was four readFileSync greps in
// elijah-referral-scenario.test.ts — two of them whitespace-exact multi-line
// string matches.
//
// THE HISTORICAL BUG: `matched` was seeded with tiers[0] before the loop, so an
// ambassador who qualified for nothing was still paid the lowest tier, and the
// rate the owner typed into the admin was never used.
//
// The greps cannot detect it. Both of these reproduce the bug exactly while
// leaving every literal those tests assert on intact, and the FULL 3,620-test
// suite stayed green for both:
//
//   let matched: (typeof tiers)[number] | null = null;
//   matched = tiers.at(0) ?? null;                     // <- inserted below it
//
//   if (ambassador) ambassador.commission_percent_locked = false;   // <- above
//   if (ambassador?.commission_percent_locked) { ... }              // untouched
//
// So the rule is exercised here instead: real function, real tier rows, real
// referral history, against a stateful fake database.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return db.current.client; },
  createServerClient: () => db.current.client,
}));

const AMB = "22222222-2222-2222-2222-222222222222";

interface Setup {
  /** The rate the owner typed into the admin. */
  configuredPercent?: number;
  locked?: boolean;
  /** Active tiers, as {threshold in monthly qualifying sales} → {percent}. */
  tiers?: Array<{ name: string; minMonthlySales: number; percent: number; isActive?: boolean }>;
  /** Referral orders THIS calendar month, each described by why it may not count. */
  history?: Array<{
    paymentStatus?: string;
    commissionAmount?: number;
    ineligibleReason?: string | null;
    fraudFlag?: boolean;
    lastMonth?: boolean;
  }>;
}

/** This month and last month, relative to the real clock the code reads. */
const now = new Date();
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();

function seed(setup: Setup) {
  db.current = createFakeDb();
  db.current.table("ambassadors").push({
    id: AMB, name: "Jaeley Reynolds", email: "amb@example.test", referral_code: "JAELEY",
    commission_percent: setup.configuredPercent ?? 10,
    commission_percent_locked: setup.locked === true,
    status: "approved",
  });
  (setup.tiers ?? []).forEach((tier, index) => {
    db.current.table("commission_tier_rules").push({
      id: `tier-${index}`, name: tier.name,
      min_monthly_sales: tier.minMonthlySales,
      commission_percent: tier.percent,
      position: index,
      is_active: tier.isActive !== false,
    });
  });
  (setup.history ?? []).forEach((row, index) => {
    db.current.table("referral_orders").push({
      id: `ro-${index}`, order_id: `order-${index}`, ambassador_id: AMB,
      created_at: row.lastMonth ? lastMonth : thisMonth,
      payment_status: row.paymentStatus ?? "pending",
      commission_amount: row.commissionAmount ?? 12,
      ineligible_reason: row.ineligibleReason ?? null,
      fraud_flag: row.fraudFlag === true,
    });
  });
}

async function effective(fallbackPercent = 10) {
  const { getEffectiveCommissionPercent } = await import("@/lib/ambassador-commission");
  return getEffectiveCommissionPercent({ ambassadorId: AMB, fallbackPercent });
}

/** Thresholds 0 / 5 / 20 at 10 / 15 / 20 percent. */
const LADDER = [
  { name: "Starter", minMonthlySales: 0, percent: 10 },
  { name: "Silver", minMonthlySales: 5, percent: 15 },
  { name: "Gold", minMonthlySales: 20, percent: 20 },
];

/** Ladder with no zero-threshold rung — nothing applies until 5 sales. */
const EARNED_LADDER = LADDER.slice(1);

beforeEach(() => {
  vi.resetModules();
});

describe("a tier has to be earned", () => {
  it("pays the configured rate when the ambassador qualifies for no tier", async () => {
    // THE HISTORICAL BUG, as behaviour: zero qualifying sales, a 5-sale tier on
    // the books, and an agreed rate of 22%. Seeding `matched` with tiers[0]
    // pays 15% here and silently replaces the agreed rate.
    seed({ configuredPercent: 22, tiers: EARNED_LADDER, history: [] });
    expect(await effective()).toEqual({ percent: 22, tierName: null });
  });

  it("still pays the configured rate with sales that fall short of the lowest tier", async () => {
    seed({
      configuredPercent: 22, tiers: EARNED_LADDER,
      history: [{}, {}, {}, {}], // four — the lowest rung needs five
    });
    expect(await effective()).toEqual({ percent: 22, tierName: null });
  });

  it("applies a tier the moment it is genuinely reached", async () => {
    // 12% agreed, and Silver pays 15% at five sales: reaching it is a RAISE,
    // which is the only direction a tier is allowed to move the rate (see
    // "a tier can only ever raise the rate" below).
    seed({
      configuredPercent: 12, tiers: EARNED_LADDER,
      history: [{}, {}, {}, {}, {}], // exactly five
    });
    expect(await effective()).toEqual({ percent: 15, tierName: "Silver" });
  });

  it("climbs to the highest tier the ambassador has actually earned", async () => {
    seed({
      configuredPercent: 10, tiers: EARNED_LADDER,
      history: Array.from({ length: 20 }, () => ({})),
    });
    expect(await effective()).toEqual({ percent: 20, tierName: "Gold" });
  });

  it("honours a zero-threshold tier, which is a deliberate owner choice", async () => {
    // "A tier with a threshold of 0 still applies to everyone" — the fix must
    // not have broken that, which is the difference between this and the bug.
    seed({ configuredPercent: 22, tiers: LADDER, history: [] });
    expect(await effective()).toEqual({ percent: 10, tierName: "Starter" });
  });
});

describe("only genuinely qualifying orders advance a tier", () => {
  /** Four real sales plus one of whatever is under test = five, the Silver rung. */
  const fourReal = [{}, {}, {}, {}];

  /** Agreed rate BELOW Silver, so reaching the rung visibly changes the rate. */
  const AGREED = 12;

  it("counts five real sales as five", async () => {
    // The control. Without this, every test below passes for the wrong reason:
    // "the fifth did not count" is indistinguishable from "five never counts".
    seed({ configuredPercent: AGREED, tiers: EARNED_LADDER, history: [...fourReal, {}] });
    expect((await effective()).tierName).toBe("Silver");
  });

  for (const [label, row] of [
    ["a reversed commission", { paymentStatus: "reversed" }],
    ["a voided commission", { paymentStatus: "voided" }],
    ["one held for manual review", { paymentStatus: "manual_review" }],
    ["one that earned $0", { commissionAmount: 0 }],
    ["one marked ineligible", { ineligibleReason: "below_minimum" }],
    ["a fraud-flagged order", { fraudFlag: true }],
    ["one from last month", { lastMonth: true }],
  ] as const) {
    it(`does not let ${label} push the ambassador up a tier`, async () => {
      seed({ configuredPercent: AGREED, tiers: EARNED_LADDER, history: [...fourReal, row] });
      expect(await effective()).toEqual({ percent: AGREED, tierName: null });
    });
  }

  it("a self-dealing ambassador cannot flag-farm their way to the top rung", async () => {
    // Twenty orders, every one of them fraud-flagged. The Gold rung must stay
    // out of reach and the agreed rate must stand.
    seed({
      configuredPercent: AGREED, tiers: EARNED_LADDER,
      history: Array.from({ length: 20 }, () => ({ fraudFlag: true })),
    });
    expect(await effective()).toEqual({ percent: AGREED, tierName: null });
  });
});

describe("an explicitly locked rate is not a suggestion", () => {
  it("pins the rate even when a higher tier has been earned", async () => {
    seed({
      configuredPercent: 30, locked: true, tiers: EARNED_LADDER,
      history: Array.from({ length: 50 }, () => ({})),
    });
    expect(await effective()).toEqual({ percent: 30, tierName: null });
  });

  it("pins a rate LOWER than a tier the ambassador qualifies for", async () => {
    // The direction that costs the ambassador money, so it must be deliberate
    // rather than incidental.
    seed({
      configuredPercent: 5, locked: true, tiers: EARNED_LADDER,
      history: Array.from({ length: 50 }, () => ({})),
    });
    expect(await effective()).toEqual({ percent: 5, tierName: null });
  });

  it("without the lock, that same ambassador gets the tier", async () => {
    // The negative control for both tests above.
    seed({
      configuredPercent: 5, locked: false, tiers: EARNED_LADDER,
      history: Array.from({ length: 50 }, () => ({})),
    });
    expect(await effective()).toEqual({ percent: 20, tierName: "Gold" });
  });
});

describe("falling back when there is nothing to resolve against", () => {
  it("uses the ambassador's configured rate when no tier is active", async () => {
    seed({
      configuredPercent: 18,
      tiers: [{ name: "Retired", minMonthlySales: 0, percent: 25, isActive: false }],
      history: [],
    });
    expect(await effective()).toEqual({ percent: 18, tierName: null });
  });

  it("uses the caller's fallback when the ambassador row is missing entirely", async () => {
    db.current = createFakeDb();
    expect(await effective(7)).toEqual({ percent: 7, tierName: null });
  });
});

// ---------------------------------------------------------------------------
// VL-26 / SOT-01 / CFG-01 — THE LADDER DESCENDED, SO THE RATE DESCENDED.
//
// Production on 2026-08-27: the programme default is 15% (the owner's recorded
// decision — admin_control referral.default_commission_percent, "15% is the
// advertised base commission" — and what /ambassador and /partner promise),
// while commission_tier_rules reads Starter 10 sales -> 10%, Growth 25 ->
// 12.5%, Elite 50 -> 15%.
//
// The resolver took the highest THRESHOLD reached and paid that rung's rate, so
// the tenth qualifying sale of the month cut the ambassador from 15% to 10% and
// it stayed cut until the fiftieth. Every one of those tests would have passed
// on the old code by simply not existing: the suite's ladders all ascended past
// the configured rate, which is the one shape the bug cannot appear in.
// ---------------------------------------------------------------------------

/** Production's ladder, verbatim, on the day the defect was found. */
const LIVE_LADDER = [
  { name: "Starter", minMonthlySales: 10, percent: 10 },
  { name: "Growth", minMonthlySales: 25, percent: 12.5 },
  { name: "Elite", minMonthlySales: 50, percent: 15 },
];

/** The programme default those rungs sit under. */
const PROGRAMME_DEFAULT = 15;

function sales(count: number) {
  return Array.from({ length: count }, () => ({}));
}

describe("a tier can only ever raise the rate", () => {
  it("does not cut the rate on the tenth sale of the month", async () => {
    // Nine sales pay the promised 15%. The tenth must not pay 10%.
    seed({ configuredPercent: PROGRAMME_DEFAULT, tiers: LIVE_LADDER, history: sales(10) });
    expect(await effective()).toEqual({ percent: PROGRAMME_DEFAULT, tierName: null });
  });

  it("holds that rate across every rung that pays less than it", async () => {
    for (const count of [9, 10, 24, 25, 49]) {
      seed({ configuredPercent: PROGRAMME_DEFAULT, tiers: LIVE_LADDER, history: sales(count) });
      expect(await effective(), `${count} qualifying sales`).toEqual({
        percent: PROGRAMME_DEFAULT,
        tierName: null,
      });
    }
  });

  it("reports the top rung once it matches the rate, rather than undercutting it", async () => {
    seed({ configuredPercent: PROGRAMME_DEFAULT, tiers: LIVE_LADDER, history: sales(50) });
    expect(await effective()).toEqual({ percent: 15, tierName: "Elite" });
  });

  it("still promotes the moment a rung genuinely pays more", async () => {
    // The ladder is not disabled — only its descents are. A rung above the base
    // rate applies exactly as before, on the sale that earns it.
    seed({
      configuredPercent: PROGRAMME_DEFAULT,
      tiers: [{ name: "Volume", minMonthlySales: 10, percent: 20 }],
      history: sales(10),
    });
    expect(await effective()).toEqual({ percent: 20, tierName: "Volume" });
  });

  it("never drops an ambassador off a rung they already earned", async () => {
    // A ladder that descends within itself: Base pays 15% from the first order,
    // Volume pays 10% at ten. Ten sales must not undo the rung already held.
    seed({
      configuredPercent: 9,
      tiers: [
        { name: "Base", minMonthlySales: 0, percent: 15 },
        { name: "Volume", minMonthlySales: 10, percent: 10 },
      ],
      history: sales(12),
    });
    expect(await effective()).toEqual({ percent: 15, tierName: "Base" });
  });

  it("leaves an ascending ladder resolving exactly as it always did", async () => {
    // The negative control for the whole block: nothing above changes what a
    // correctly-ordered ladder pays at any point on it.
    for (const [count, expected] of [
      [0, { percent: 10, tierName: "Starter" }],
      [4, { percent: 10, tierName: "Starter" }],
      [5, { percent: 15, tierName: "Silver" }],
      [19, { percent: 15, tierName: "Silver" }],
      [20, { percent: 20, tierName: "Gold" }],
    ] as const) {
      seed({ configuredPercent: 10, tiers: LADDER, history: sales(count) });
      expect(await effective(), `${count} qualifying sales`).toEqual(expected);
    }
  });
});
