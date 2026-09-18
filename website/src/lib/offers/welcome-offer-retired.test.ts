import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE WELCOME DISCOUNT IS RETIRED, AND ONLY THE WELCOME DISCOUNT.
//
// The spin wheel is the acquisition offer now. The risk in retiring an
// incentive is never the incentive itself — it is the blast radius:
//
//   * winback is ALSO 15% and is a different offer that must carry on;
//   * recovery is 10% and has nothing to do with any of this;
//   * a customer who already holds a live welcome code has done nothing wrong,
//     and their code must keep working to its own expiry.
//
// So these tests are mostly about what did NOT change.
// ---------------------------------------------------------------------------

const minted = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; email: string }> }));
const live = vi.hoisted(() => ({ code: null as null | { code: string; endsAt: string; percent: number } }));
const consent = vi.hoisted(() => ({ recorded: [] as string[], accept: true }));
const purchased = vi.hoisted(() => ({ value: false }));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/marketing/omnisend/codes", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/marketing/omnisend/codes");
  return {
    ...actual,
    ensureContactCode: async (kind: string, email: string) => {
      minted.calls.push({ kind, email });
      return { code: `${kind.toUpperCase()}-1`, endsAt: "2026-10-01T00:00:00.000Z", percent: 15 };
    },
    findLiveContactCode: async (kind: string) => (kind === "welcome" ? live.code : null),
  };
});

vi.mock("@/lib/sms-consent", () => ({
  recordSmsConsent: async ({ email }: { email: string }) => {
    if (!consent.accept) return false;
    consent.recorded.push(email);
    return true;
  },
}));

const { claimWelcomeOffer, grantWelcomeOfferForConsent, WELCOME_OFFER_RETIRED } =
  await import("@/lib/offers/welcome-offer");
const { CONTACT_CODE_OFFERS } = await import("@/lib/marketing/omnisend/codes");

beforeEach(() => {
  minted.calls = [];
  live.code = null;
  consent.recorded = [];
  consent.accept = true;
  purchased.value = false;
});

describe("retiring the welcome discount", () => {
  it("is retired", () => {
    expect(WELCOME_OFFER_RETIRED).toBe(true);
  });

  it("still records the consent — the subscriber is the point, not the coupon", async () => {
    const result = await claimWelcomeOffer({
      email: "New@Example.test", phone: "+1 555 123 4567", source: "storefront",
    });

    expect(consent.recorded, "they are on the text list").toEqual(["new@example.test"]);
    expect(result).toEqual({ ok: true, subscribedOnly: true });
  });

  it("mints NO welcome code for a new subscriber", async () => {
    await claimWelcomeOffer({ email: "new@example.test", phone: "+15551234567", source: "storefront" });
    expect(minted.calls, "nothing was minted").toEqual([]);
  });

  it("mints nothing from the other consent paths either", async () => {
    // account settings and the sign-up page call this one rather than claim.
    await grantWelcomeOfferForConsent("new@example.test");
    expect(minted.calls).toEqual([]);
  });

  it("STILL HANDS BACK a code the customer already holds", async () => {
    // Retiring an incentive is not confiscating what it already bought. The
    // live-code read happens before the retirement gate for exactly this
    // reason, and this is the test that stops someone "simplifying" it away.
    live.code = { code: "VLWELCOME-OLD", endsAt: "2026-10-01T00:00:00.000Z", percent: 15 };

    const result = await claimWelcomeOffer({
      email: "holder@example.test", phone: "+15551234567", source: "storefront",
    });

    expect(result).toEqual({ ok: true, code: "VLWELCOME-OLD", endsAt: "2026-10-01T00:00:00.000Z", percent: 15 });
    expect(minted.calls, "handed back, not re-minted").toEqual([]);
  });

  it("refuses an unusable number before anything else, as it always did", async () => {
    const result = await claimWelcomeOffer({ email: "new@example.test", phone: "nope", source: "storefront" });
    expect(result).toEqual({ ok: false, reason: "phone" });
    expect(consent.recorded, "no consent row for a number we cannot text").toEqual([]);
  });

  it("reports a refused consent as a failure, not as a silent subscribe", async () => {
    consent.accept = false;
    const result = await claimWelcomeOffer({ email: "new@example.test", phone: "+15551234567", source: "storefront" });
    expect(result).toEqual({ ok: false, reason: "consent" });
  });
});

describe("what retirement must NOT touch", () => {
  it("leaves winback at 15% — a different offer that shares the number", () => {
    expect(CONTACT_CODE_OFFERS.winback.percent).toBe(15);
    expect(CONTACT_CODE_OFFERS.winback.prefix).toBe("VLBACK");
  });

  it("leaves cart recovery at 10%", () => {
    expect(CONTACT_CODE_OFFERS.recovery.percent).toBe(10);
  });

  it("keeps the welcome kind defined, because live codes still redeem against it", () => {
    // Deleting the entry would orphan every unexpired code already issued.
    expect(CONTACT_CODE_OFFERS.welcome.percent).toBe(15);
    expect(CONTACT_CODE_OFFERS.welcome.prefix).toBe("VLWELCOME");
  });
});
