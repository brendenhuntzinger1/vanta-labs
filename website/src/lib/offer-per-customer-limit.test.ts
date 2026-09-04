import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// A PROMOTION SOMEBODY HAS ALREADY SPENT IS NOT ADVERTISED TO THEM.
//
// The till has always honoured `perCustomerLimit`: quote-order.ts passes the
// order's email into getApplicableBxgyPromotions, and getPromotionUsage counts
// that customer's redemptions against it. The DISPLAY side passed `{}` — no
// email — so a one-per-customer promotion went on being advertised to somebody
// who had already used it, and they found out at the checkout.
//
// The fix is a context argument, not a rule. Nothing here re-implements
// eligibility: the same function the pricing pass calls is called with the same
// shape of context, so the two cannot drift into disagreement. What these tests
// pin is the wiring and the direction of failure.
//
// WHY THE SIGNED-IN ACCOUNT'S EMAIL IS EXACT RATHER THAN A GUESS: checkout
// locks the email field to the account for any signed-in customer who has one
// — read-only, captioned "Using your account email" — so the address counted
// here is the address the order will carry.
//
// The whole module is mocked at its edges because resolveStorefrontOffers is a
// server function that reads four systems; what is under test is which context
// it hands to the promotion layer and what it does with the answer.
// ---------------------------------------------------------------------------

const PROMOTION = {
  id: "buy-2-get-1-half-off",
  name: "Buy 2 Get 1 50% Off",
  enabled: true,
  hidden: false,
  buyQuantity: 2,
  getQuantity: 1,
  rewardPercent: 50,
  // Empty include list means store-wide, which is what the live promotion is.
  eligibility: { includeSlugs: [], excludeSlugs: [] },
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  perCustomerLimit: 1,
  maxRewardUnitsPerOrder: null,
  stackWithCoupon: false,
  stackWithBundlePricing: false,
  priority: 0,
};

/** Every call the promotion layer received, so the context can be inspected. */
const calls: Array<{ context: unknown; promotions: unknown }> = [];
/** What the promotion layer answers — i.e. who it considers still eligible. */
let eligible: unknown[] = [PROMOTION];
/** Who is signed in, as the auth layer would report them. */
let signedIn: { email?: string } | null = null;
/** What the admin console has configured. */
let configured: unknown[] = [PROMOTION];

vi.mock("@/lib/bxgy-promotions", () => ({
  getApplicableBxgyPromotions: vi.fn(async (context: unknown, options: { promotions?: unknown }) => {
    calls.push({ context, promotions: options?.promotions });
    return eligible;
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: vi.fn(async () => signedIn),
}));

vi.mock("@/lib/admin-control", () => ({
  getHomepageControlConfig: vi.fn(async () => ({ bxgyPromotions: configured })),
  getWelcomeOffer: vi.fn(async () => null),
  getShippingConfig: vi.fn(async () => null),
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            or: () => ({
              or: () => ({
                order: () => ({ limit: async () => ({ data: [], error: null }) }),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

const { resolveStorefrontOffers } = await import("@/lib/storefront-offers");

const headlines = async (viewerEmail?: string | null) =>
  (await resolveStorefrontOffers(viewerEmail === undefined ? {} : { viewerEmail }))
    .filter((o) => !o.standing)
    .map((o) => o.headline);

beforeEach(() => {
  calls.length = 0;
  eligible = [PROMOTION];
  signedIn = null;
  configured = [PROMOTION];
});

describe("a limited promotion is advertised only to someone who can still use it", () => {
  it("counts the limit against the signed-in customer", async () => {
    signedIn = { email: "Shopper@Example.com" };
    await headlines();
    expect(calls).toHaveLength(1);
    // Lower-cased before it is counted, because that is how redemptions are
    // recorded — an address is not case-sensitive and a limit keyed on one
    // would be trivially side-stepped by shifting a capital.
    expect(calls[0].context).toEqual({ customerEmail: "shopper@example.com" });
  });

  it("shows the promotion to a customer who has not used it", async () => {
    signedIn = { email: "eligible@example.com" };
    eligible = [PROMOTION];
    expect(await headlines()).toContain("Buy 2 Get 1 50% Off");
  });

  it("withholds it from a customer who has", async () => {
    // The promotion layer answering with an empty list IS the exhaustion — this
    // file does not decide it, and must not.
    signedIn = { email: "spent@example.com" };
    eligible = [];
    expect(await headlines()).not.toContain("Buy 2 Get 1 50% Off");
  });

  it("advertises it when nobody can be identified", async () => {
    // A guest, a phone-only account, or an auth backend having a bad minute.
    // The till still refuses an ineligible order, so the cost of being wrong
    // here is a customer who reads about an offer they cannot use — never a
    // customer denied one they can.
    signedIn = null;
    expect(await headlines()).toContain("Buy 2 Get 1 50% Off");
    expect(calls[0].context, "no email means no per-customer count").toEqual({});
  });

  it("advertises it when the session read throws", async () => {
    const { getAuthenticatedUser } = await import("@/lib/auth-session");
    vi.mocked(getAuthenticatedUser).mockRejectedValueOnce(new Error("gotrue is down"));
    expect(await headlines()).toContain("Buy 2 Get 1 50% Off");
    expect(calls[0].context).toEqual({});
  });

  it("does not read a session at all when no promotion carries a per-customer limit", async () => {
    // The cost control. Resolving a viewer means a session read, so it happens
    // only on the days the store is actually running a one-per-customer
    // promotion. Every other day the layout costs exactly what it did before.
    const { getAuthenticatedUser } = await import("@/lib/auth-session");
    vi.mocked(getAuthenticatedUser).mockClear();
    configured = [{ ...PROMOTION, perCustomerLimit: null }];
    eligible = [{ ...PROMOTION, perCustomerLimit: null }];
    signedIn = { email: "someone@example.com" };
    await headlines();
    expect(vi.mocked(getAuthenticatedUser)).not.toHaveBeenCalled();
    expect(calls[0].context).toEqual({});
  });

  it("still lets a caller inject the viewer, for a test or a job", async () => {
    await headlines("injected@example.com");
    expect(calls[0].context).toEqual({ customerEmail: "injected@example.com" });
  });
});

describe("eligibility is borrowed, never re-implemented", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/storefront-offers.ts"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  it("asks the same function the pricing pass asks", () => {
    // quote-order.ts calls getApplicableBxgyPromotions with the order's email;
    // this calls it with the viewer's. One implementation, two callers.
    expect(code).toContain("getApplicableBxgyPromotions(");
    expect(code).toMatch(/viewerEmail \? \{ customerEmail: viewerEmail \} : \{\}/);
  });

  it("counts nothing itself", () => {
    // The moment this file starts reading orders or comparing counts, the
    // display has its own opinion about eligibility and the two can disagree.
    for (const forbidden of ["countRedemptions", "perCustomerLimit >", "redemptions_count >="]) {
      expect(code, `${forbidden} would be a second eligibility rule`).not.toContain(forbidden);
    }
  });

  it("fails towards showing the offer, never towards hiding it", () => {
    // Both guards return null, and null means "advertise it".
    expect(code).toMatch(/catch \{\s*return null;\s*\}/);
    expect(code).toMatch(/return email \|\| null;/);
  });
});
