import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE BUSINESS SETTINGS STORE, ACTUALLY EXECUTED.
//
// admin-control is not roles or permissions -- it is where every
// owner-editable business number lives: commission and referral percentages,
// the welcome offer, shipping config, profit floors, card processing fees,
// coupon policy. These values feed the money math directly.
//
// It is globally mocked in vitest.setup.ts with fixed literals, so the real
// readers -- the defaults, the clamps, the failure fallbacks -- had never run.
//
// The invariants that matter for launch:
//
//   1. A MISSING setting yields the documented default, never 0 and never NaN.
//      A silently-zeroed commission percent pays ambassadors nothing; a
//      silently-zeroed profit floor removes the guard entirely.
//   2. A HOSTILE or corrupt stored value cannot become a live business number.
//   3. A DATABASE FAILURE yields defaults rather than throwing, because these
//      readers sit in the checkout path.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/admin-control");

const state: { rows: Array<Record<string, unknown>>; throwOnRead: boolean } = {
  rows: [],
  throwOnRead: false,
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  const from = () => {
    const filters: Array<[string, unknown]> = [];
    const b: Record<string, unknown> = {
      select() { return b; },
      eq(c: string, v: unknown) { filters.push([c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      insert: async () => ({ error: null }),
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
        if (state.throwOnRead) {
          return Promise.resolve({ data: null, error: { message: "connection lost" } }).then(resolve);
        }
        const rows = state.rows.filter((r) =>
          filters.every(([c, v]) => (c === "action" ? true : r[c] === v)),
        );
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

/** A stored control value, in the shape getControlSnapshot reads. */
function control(section: string, key: string, value: unknown) {
  return {
    id: `${section}-${key}`,
    target_table: section,
    target_id: key,
    metadata: { value },
    created_at: new Date().toISOString(),
  };
}

async function mod() {
  return import("@/lib/admin-control");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  state.rows = [];
  state.throwOnRead = false;
});

describe("referral and commission percentages", () => {
  it("returns the documented defaults when nothing is stored", async () => {
    const {
      getReferralProgramConfig,
      DEFAULT_REFERRAL_DISCOUNT_PERCENT,
      DEFAULT_AMBASSADOR_COMMISSION_PERCENT,
      DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT,
    } = await mod();

    const config = await getReferralProgramConfig();

    expect(config.discountPercent).toBe(DEFAULT_REFERRAL_DISCOUNT_PERCENT);
    expect(config.defaultCommissionPercent).toBe(DEFAULT_AMBASSADOR_COMMISSION_PERCENT);
    expect(config.personalDiscountPercent).toBe(DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT);
    expect(config.enabled).toBe(true);
    expect(config.commissionsPaused).toBe(false);
  });

  it("reads a stored percentage", async () => {
    state.rows = [control("referral", "default_commission_percent", 22)];
    const { getReferralProgramConfig } = await mod();
    expect((await getReferralProgramConfig()).defaultCommissionPercent).toBe(22);
  });

  describe("refuses a value that cannot be a real percentage", () => {
    const hostile: Array<[string, unknown]> = [
      ["a blank string", ""],
      ["null", null],
      ["a negative percent", -10],
      ["over 100 percent", 150],
      ["a non-numeric string", "twenty"],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["an object", { percent: 20 }],
    ];

    for (const [label, value] of hostile) {
      it(`falls back to the default for ${label}`, async () => {
        state.rows = [control("referral", "default_commission_percent", value)];
        const { getReferralProgramConfig, DEFAULT_AMBASSADOR_COMMISSION_PERCENT } = await mod();
        // A blank field must not silently zero the commission: that pays every
        // ambassador nothing while the admin screen still shows a program.
        expect((await getReferralProgramConfig()).defaultCommissionPercent).toBe(
          DEFAULT_AMBASSADOR_COMMISSION_PERCENT,
        );
      });
    }

    it("accepts the boundary values 0 and 100", async () => {
      state.rows = [control("referral", "default_commission_percent", 0)];
      const { getReferralProgramConfig } = await mod();
      // An explicit 0 IS a legitimate choice -- it is only blank/absent that
      // means "keep the default".
      expect((await getReferralProgramConfig()).defaultCommissionPercent).toBe(0);

      vi.resetModules();
      state.rows = [control("referral", "default_commission_percent", 100)];
      const again = await mod();
      expect((await again.getReferralProgramConfig()).defaultCommissionPercent).toBe(100);
    });
  });

  it("treats commissions as paused only on an explicit true", async () => {
    state.rows = [control("referral", "commissions_paused", "yes")];
    const { getReferralProgramConfig } = await mod();
    // A truthy-but-not-true value must not pause every ambassador's earnings.
    expect((await getReferralProgramConfig()).commissionsPaused).toBe(false);
  });

  it("falls back to defaults when the database read fails", async () => {
    state.throwOnRead = true;
    const { getReferralProgramConfig, DEFAULT_AMBASSADOR_COMMISSION_PERCENT } = await mod();
    // This reader sits in the checkout path; throwing would break the sale.
    const config = await getReferralProgramConfig();
    expect(config.defaultCommissionPercent).toBe(DEFAULT_AMBASSADOR_COMMISSION_PERCENT);
  });
});

describe("the welcome offer", () => {
  it("is OFF unless explicitly enabled", async () => {
    const { getWelcomeOffer } = await mod();
    expect((await getWelcomeOffer()).enabled).toBe(false);
  });

  for (const truthy of ["true", 1, "yes"]) {
    it(`is not enabled by a truthy-but-not-true ${JSON.stringify(truthy)}`, async () => {
      state.rows = [control("welcome_offer", "enabled", truthy)];
      const { getWelcomeOffer } = await mod();
      // A discount that switches itself on from a stray string is money out.
      expect((await getWelcomeOffer()).enabled).toBe(false);
    });
  }

  it("is enabled by an explicit true", async () => {
    state.rows = [control("welcome_offer", "enabled", true)];
    const { getWelcomeOffer } = await mod();
    expect((await getWelcomeOffer()).enabled).toBe(true);
  });

  it("normalises the code to upper case", async () => {
    state.rows = [control("welcome_offer", "code", "  welcome20  ")];
    const { getWelcomeOffer } = await mod();
    expect((await getWelcomeOffer()).code).toBe("WELCOME20");
  });

  it("falls back to the default code when the stored one is blank", async () => {
    state.rows = [control("welcome_offer", "code", "   ")];
    const { getWelcomeOffer, DEFAULT_WELCOME_OFFER } = await mod();
    expect((await getWelcomeOffer()).code).toBe(DEFAULT_WELCOME_OFFER.code);
  });

  it("falls back to the default percent for an unparseable value", async () => {
    state.rows = [control("welcome_offer", "percent", "abc")];
    const { getWelcomeOffer, DEFAULT_WELCOME_OFFER } = await mod();
    expect((await getWelcomeOffer()).percent).toBe(DEFAULT_WELCOME_OFFER.percent);
  });

  it("returns defaults rather than throwing when the read fails", async () => {
    state.throwOnRead = true;
    const { getWelcomeOffer, DEFAULT_WELCOME_OFFER } = await mod();
    expect(await getWelcomeOffer()).toEqual(DEFAULT_WELCOME_OFFER);
  });
});

describe("the control snapshot itself", () => {
  it("keeps the NEWEST value when a key was set more than once", async () => {
    // Settings are append-only audit rows read newest-first, so the most recent
    // write is the live value. Reading the oldest would silently revert every
    // change the owner has ever made.
    state.rows = [
      control("referral", "default_commission_percent", 30),
      control("referral", "default_commission_percent", 10),
    ];
    const { getReferralProgramConfig } = await mod();
    expect((await getReferralProgramConfig()).defaultCommissionPercent).toBe(30);
  });

  it("ignores rows with no section or key", async () => {
    state.rows = [
      { id: "x", target_table: "", target_id: "", metadata: { value: 99 }, created_at: new Date().toISOString() },
      control("referral", "default_commission_percent", 25),
    ];
    const { getReferralProgramConfig } = await mod();
    expect((await getReferralProgramConfig()).defaultCommissionPercent).toBe(25);
  });
});

describe("profit protection settings", () => {
  it("returns an active guard by default, not a disabled one", async () => {
    const { getProfitSettings, DEFAULT_PROFIT_CONFIG } = await mod();
    const config = await getProfitSettings();
    // A default of 0 would silently remove the floor that stops an order
    // finalizing below break-even.
    expect(config.minProfitPercent).toBe(DEFAULT_PROFIT_CONFIG.minProfitPercent);
  });

  it("falls back to defaults when the read fails", async () => {
    state.throwOnRead = true;
    const { getProfitSettings, DEFAULT_PROFIT_CONFIG } = await mod();
    expect((await getProfitSettings()).minProfitPercent).toBe(DEFAULT_PROFIT_CONFIG.minProfitPercent);
  });

  // FIX WAVE 3 — THE PROCESSOR FEE IS A FREE-TEXT FIELD WITH NO ROUTE-LEVEL
  // VALIDATION, and its resolver had a lower bound but no upper one. "800" was
  // accepted verbatim: an 800% modelled fee puts every order below the profit
  // floor and blocks all checkout, and reports every historical order at a
  // loss. It is also the exact figure the Control Center displays back, so the
  // display and the applied value must come from ONE rule.
  describe("the processor fee", () => {
    it("applies an explicit rate inside the legitimate range", async () => {
      state.rows = [control("profit", "processing_fee_percent", "2.9")];
      const { getProfitSettings } = await mod();
      expect((await getProfitSettings()).processingFeePercent).toBe(2.9);
    });

    it("treats an explicit zero as a real choice", async () => {
      state.rows = [control("profit", "processing_fee_percent", "0")];
      const { getProfitSettings } = await mod();
      expect((await getProfitSettings()).processingFeePercent).toBe(0);
    });

    describe("falls back to the coded default rather than applying a value a text box can produce", () => {
      for (const stored of ["-5", "8%", "800", "abc", "", "   ", "100.01"]) {
        it(JSON.stringify(stored), async () => {
          state.rows = [control("profit", "processing_fee_percent", stored)];
          const { getProfitSettings, DEFAULT_PROFIT_CONFIG, describeEffectiveRate } = await mod();
          const applied = (await getProfitSettings()).processingFeePercent;
          expect(applied).toBe(DEFAULT_PROFIT_CONFIG.processingFeePercent);
          // And the label the owner reads must agree with what is applied.
          expect(describeEffectiveRate(stored, DEFAULT_PROFIT_CONFIG.processingFeePercent))
            .toContain(`${DEFAULT_PROFIT_CONFIG.processingFeePercent}%`);
        });
      }
    });
  });
});

describe("coupon policy", () => {
  it("does not enable stacking by default", async () => {
    const { getCouponPolicyConfig } = await mod();
    // Stacking multiplies discounts; it must be an explicit choice.
    expect((await getCouponPolicyConfig()).allowStacking).toBe(false);
  });
});
