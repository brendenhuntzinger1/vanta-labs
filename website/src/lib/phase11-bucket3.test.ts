import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";
import { DEFAULT_BULK_SAVINGS_CONFIG } from "@/lib/bulk-savings";
import { buildFaqItems } from "@/components/membership-landing";
import type { MembershipTier } from "@/lib/membership";

// ---------------------------------------------------------------------------
// Phase 11, bucket 3. Every assertion below fails against the code as it stood
// before this batch; each one pins a specific piece of customer-facing copy or
// webhook behaviour to the single source of truth it drifted away from.
//
// The source-level assertions (the JSX and page wiring) follow the precedent in
// handoff-invariants.test.ts: the behaviour lives inside a server component's
// data-loading or inside JSX that a node-environment suite cannot render, and a
// re-hard-coded literal is exactly the regression worth catching.
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");

function tier(overrides: Partial<MembershipTier> & { slug: string; pointsPerDollar: number }): MembershipTier {
  return {
    id: overrides.slug,
    name: overrides.slug,
    monthlyPriceCents: 1000,
    annualPriceCents: 10000,
    freeShipping: false,
    priorityShipping: false,
    earlyAccess: false,
    exclusivePricing: false,
    referralBonusPoints: 100,
    benefits: [],
    position: 1,
    isActive: true,
    introPriceCents: 0,
    introDurationDays: 0,
    introOfferEnabled: false,
    memberDiscountPercent: 5,
    monthlyStoreCreditCents: 500,
    storeCreditMinOrderCents: 0,
    compareMonthlyPriceCents: 0,
    ...overrides,
  };
}

// The four seeded tiers, points_per_dollar 2 / 3 / 4 / 5
// (sql/membership-tiers-seed.sql). Essential has neither free shipping nor
// priority processing.
const SEEDED_TIERS: MembershipTier[] = [
  tier({ slug: "essential", pointsPerDollar: 2, freeShipping: false, priorityShipping: false }),
  tier({ slug: "pro", pointsPerDollar: 3, freeShipping: true, priorityShipping: true }),
  tier({ slug: "elite", pointsPerDollar: 4, freeShipping: true, priorityShipping: true }),
  tier({ slug: "black", pointsPerDollar: 5, freeShipping: true, priorityShipping: true }),
];

const faqAnswer = (tiers: MembershipTier[], question: string) => {
  const item = buildFaqItems(tiers).find((entry) => entry.q === question);
  if (!item) throw new Error(`no FAQ item for "${question}"`);
  return item.a;
};

describe("CFG-10 / SOT-11 — the membership FAQ reads its numbers off the tiers", () => {
  const QUESTION = "How do reward points work?";

  it("names the strongest AND the weakest multiplier the tiers actually carry", () => {
    // The hard-coded answer said "2x, 3x, or 5x" while Elite is seeded at 4x,
    // so the one tier in the middle of the range was simply not mentioned.
    const answer = faqAnswer(SEEDED_TIERS, QUESTION);

    expect(answer).toContain("2x to 5x points per $1");
    expect(answer).not.toMatch(/2x, 3x, or 5x/);
  });

  it("tracks an admin edit to a tier's points_per_dollar", () => {
    const retuned = SEEDED_TIERS.map((t) => (t.slug === "black" ? { ...t, pointsPerDollar: 8 } : t));

    expect(faqAnswer(retuned, QUESTION)).toContain("2x to 8x points per $1");
  });

  it("quotes the redemption rate the math actually uses", () => {
    expect(faqAnswer(SEEDED_TIERS, QUESTION)).toContain(`${POINTS_PER_DOLLAR_REDEMPTION} points equals $1`);
  });

  it("still reads sensibly when no tiers loaded", () => {
    expect(() => faqAnswer([], QUESTION)).not.toThrow();
    expect(faqAnswer([], QUESTION)).toContain("points per $1");
  });
});

describe("SOT-11 — the benefit-start answer promises only what every tier has", () => {
  const QUESTION = "When do my benefits start?";

  it("does not promise free shipping or priority processing to everyone who joins", () => {
    // Essential is seeded free_shipping = false, priority_shipping = false, and
    // the comparison table on the same page prints an em-dash for both — so the
    // FAQ was contradicting the card next to it.
    const answer = faqAnswer(SEEDED_TIERS, QUESTION);

    expect(answer).not.toMatch(/free shipping/i);
    expect(answer).not.toMatch(/priority processing/i);
  });

  it("still says benefits are immediate", () => {
    expect(faqAnswer(SEEDED_TIERS, QUESTION)).toMatch(/^Immediately\./);
  });

  it("does not promise priority handling in the 'how membership works' summary either", () => {
    // Same claim, second location on the same page.
    const howItWorks = read("components/membership-landing.tsx")
      .split("How membership works")[1]
      .split("Cancel Anytime")[0];

    expect(howItWorks).toContain("points on every order");
    expect(howItWorks).not.toContain("and priority handling.");
  });
});

describe("SOT-10 — the bulk-savings panel states the programme checkout enforces", () => {
  const landing = read("components/membership-landing.tsx");

  it("renders the thresholds and percentages from the config, not from literals", () => {
    expect(landing).toContain("{bulkSavings.tier1Percent}% OFF");
    expect(landing).toContain('{bulkSavings.tier1Threshold.toLocaleString("en-US")} or more');
    expect(landing).toContain("{bulkSavings.tier2Percent}% OFF");
    expect(landing).toContain('{bulkSavings.tier2Threshold.toLocaleString("en-US")} or more');

    expect(landing).not.toContain(">5% OFF<");
    expect(landing).not.toContain(">12% OFF<");
    expect(landing).not.toContain("Orders of $500 or more");
    expect(landing).not.toContain("Orders of $1,000 or more");
  });

  it("is handed the live config by /membership, with the coded default as the fallback", () => {
    const page = read("app/membership/page.tsx");

    expect(page).toContain("getBulkSavingsControlConfig()");
    expect(page).toContain("bulkSavings={bulkSavings}");
    expect(page).toContain("DEFAULT_BULK_SAVINGS_CONFIG");
    // The default the page falls back to is the one the discount math applies.
    expect(DEFAULT_BULK_SAVINGS_CONFIG.tier1Percent).toBe(5);
    expect(DEFAULT_BULK_SAVINGS_CONFIG.tier2Percent).toBe(12);
  });

  it("names both tiers that isEligibleForBulkSavings actually admits", () => {
    // membership.ts: `membership.tier.slug === "elite" || membership.tier.slug === "black"`.
    expect(landing).toContain("paying Elite and Black members");
    expect(landing).not.toContain("paying Elite Research members");
  });
});

describe("CFG-11 — the redemption rate is quoted from POINTS_PER_DOLLAR_REDEMPTION", () => {
  const PROSE_FILES = [
    "app/account/(dashboard)/rewards/page.tsx",
    "app/account/(dashboard)/page.tsx",
    "app/account/(dashboard)/support/page.tsx",
    "components/membership-landing.tsx",
  ];

  it.each(PROSE_FILES)("%s interpolates the constant instead of restating 100", (relative) => {
    const source = read(relative);

    expect(source).toContain("POINTS_PER_DOLLAR_REDEMPTION");
    expect(source).not.toMatch(/100 points = \$1/);
    expect(source).not.toMatch(/100 points equals \$1/);
    expect(source).not.toMatch(/>100 = \$1</);
  });
});

describe("F-A-11 — a points read that failed is not a balance of zero", () => {
  const PAGES = ["app/account/(dashboard)/rewards/page.tsx", "app/account/(dashboard)/page.tsx"];

  it.each(PAGES)("%s renders an unknown rather than a confident 0", (relative) => {
    const source = read(relative);

    expect(source).toContain("getPointsBalance(user.id).catch(() => null)");
    expect(source).not.toContain("getPointsBalance(user.id).catch(() => 0)");
    expect(source).toContain("pointsBalance === null");
  });
});

// ---------------------------------------------------------------------------
// P9-03 — the event id must come from bytes the signature covers.
// ---------------------------------------------------------------------------

const webhookMocks = vi.hoisted(() => ({ processPaymentWebhook: vi.fn() }));

class WebhookSignatureError extends Error {}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getRequiredEnv: () => "test-secret" }));
vi.mock("@/lib/payment-webhook", () => ({
  processPaymentWebhook: webhookMocks.processPaymentWebhook,
  WebhookSignatureError,
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

async function postWebhook(body: unknown, headers: Record<string, string>) {
  const { POST } = await import("@/app/api/webhooks/payment/route");
  return POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

const claimedEventId = () => String((webhookMocks.processPaymentWebhook.mock.calls[0] as unknown[])[3]);

describe("P9-03 — the payment webhook dedupes on the signed id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    webhookMocks.processPaymentWebhook.mockResolvedValue({ eventId: "evt_real", duplicate: false });
  });

  it("prefers the body's id over a conflicting x-event-id header", async () => {
    // Neither signature scheme covers request headers, so a replayed delivery
    // could carry a fresh x-event-id and walk past the payment_events dedupe.
    await postWebhook(
      { id: "evt_real", type: "payment.succeeded" },
      { "x-payment-signature": "sig", "x-event-id": "attacker-chosen" },
    );

    expect(claimedEventId()).toBe("evt_real");
  });

  it("still falls back to the header when the body carries no id", async () => {
    // The internal/mock gateway sends { type, data } with no top-level id; every
    // e2e journey in this repo relies on that path.
    await postWebhook(
      { type: "payment.succeeded", data: { object: { metadata: { order_id: "o1" }, amount: 10 } } },
      { "x-payment-signature": "sig", "x-event-id": "evt-from-header" },
    );

    expect(claimedEventId()).toBe("evt-from-header");
  });

  it("still refuses a delivery that identifies itself nowhere", async () => {
    const response = await postWebhook(
      { type: "payment.succeeded" },
      { "x-payment-signature": "sig" },
    );

    expect(response.status).toBe(400);
    expect(webhookMocks.processPaymentWebhook).not.toHaveBeenCalled();
  });
});
