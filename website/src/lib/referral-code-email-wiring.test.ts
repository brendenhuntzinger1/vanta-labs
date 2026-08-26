import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE TEST THAT WOULD HAVE CAUGHT IT.
//
// referral-code-email-rate.test.ts proves the template and the resolution rule.
// Neither would have caught the actual bug, because the bug was in what the
// ADMIN ACTION passed to the sender:
//
//     commissionPercent: input.commissionPercent ?? 0
//
// The template rendered exactly what it was handed. So this drives the real
// updatePartnerStatus — the function the admin screen calls — and reads the
// commission percentage out of the email that comes back.
//
// The store's own data is the scenario: MIZZY, approved, 15.00 stored on both
// tables, a referral code assigned in a request that set no rate.
// ---------------------------------------------------------------------------

const PARTNER_ID = "amb-mizzy";

const state = {
  name: "Jaeley Reynolds",
  email: "ambassador@example.test",
  status: "approved",
  referralCode: "OLDCODE",
  /** numeric(5,2) arrives from postgres as a string. */
  storedCommission: "15.00" as string | number | null,
  programDefaultCommission: 10,
  /** Every row written to ambassadors / partners, to prove the DB is untouched. */
  writes: [] as Array<{ table: string; payload: Record<string, unknown> }>,
};

const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (message: { to: string; subject: string; html: string; text?: string }) => {
    sent.push(message);
    return { success: true, id: "msg-1" };
  }),
}));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "support@example.test" }),
  getReferralProgramConfig: async () => ({
    enabled: true,
    commissionsPaused: false,
    defaultCommissionPercent: state.programDefaultCommission,
    discountPercent: 10,
    personalDiscountPercent: 10,
  }),
}));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: 0,
    minimumPayoutThreshold: 25,
    commissionHoldDays: 14,
  }),
  getAmbassadorMarketingResources: async () => [],
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "partners") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq(column: string, _v: unknown) {
              // The referral-code uniqueness probe filters on referral_code and
              // must find nothing, or the update is refused as a conflict.
              (b as { _byCode?: boolean })._byCode = column === "referral_code";
              return b;
            },
            neq() { return b; },
            limit() { return b; },
            async maybeSingle() {
              if ((b as { _byCode?: boolean })._byCode) return { data: null, error: null };
              return {
                data: {
                  id: PARTNER_ID,
                  name: state.name,
                  email: state.email,
                  referral_code: state.referralCode,
                  commission_percent: state.storedCommission,
                  status: state.status,
                  approved_at: "2026-08-25T00:00:00.000Z",
                },
                error: null,
              };
            },
            then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data: [], error: null })); },
          };
          return b;
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async () => { state.writes.push({ table: "partners", payload }); return { error: null }; },
        }),
      };
    }
    if (table === "ambassadors") {
      return {
        select: () => ({
          eq: () => ({
            neq: () => ({ limit: async () => ({ data: [], error: null }) }),
            // The AUTHORITATIVE row, and it really holds the stored rate.
            //
            // This used to answer `null`, so the scenario in this file's header
            // -- "15.00 stored on BOTH tables" -- was only ever half modelled.
            // The approval email reads this table (it is what checkout and
            // accrual read), and against a null it silently fell through to the
            // program default. A fake that cannot represent the authoritative
            // rate cannot catch an email quoting the wrong one.
            async maybeSingle() {
              return {
                data: { id: PARTNER_ID, commission_percent: state.storedCommission },
                error: null,
              };
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            state.writes.push({ table: "ambassadors", payload });
            // And the write lands, so a read AFTER the update sees the new rate
            // -- which is the whole point of reading it after the update.
            if ("commission_percent" in payload) {
              state.storedCommission = payload.commission_percent as string | number | null;
            }
            return { error: null };
          },
        }),
      };
    }
    const noop: Record<string, unknown> = {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          limit: async () => ({ data: [], error: null }),
        }),
      }),
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: "queue-1" }, error: null }) }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
    return noop;
  };
  return { supabaseAdmin: { from } };
});

const { updatePartnerStatus } = await import("@/lib/partner-portal");

/** The referral-code email, identified by its subject. */
function referralEmail() {
  return sent.find((m) => m.subject === "Your Vanta Labs Referral Code Is Ready");
}

/** The percentage the ambassador is actually told they earn. */
function quotedPercent(): number | null {
  const html = referralEmail()?.html ?? "";
  const match = html.match(/earn ([\d.]+)% commission/);
  return match ? Number(match[1]) : null;
}

beforeEach(() => {
  state.name = "Jaeley Reynolds";
  state.status = "approved";
  state.referralCode = "OLDCODE";
  state.storedCommission = "15.00";
  state.programDefaultCommission = 10;
  state.writes = [];
  sent.length = 0;
  vi.clearAllMocks();
});

describe("assigning a code without re-entering the rate", () => {
  /** THE BUG, exactly as it reached Jaeley Reynolds. */
  it("quotes the ambassador's stored 15%, not 0%", async () => {
    await updatePartnerStatus({
      partnerId: PARTNER_ID,
      status: "approved",
      referralCode: "MIZZY",
      // commissionPercent deliberately absent — the admin only set a code.
    });

    expect(referralEmail()).toBeDefined();
    expect(quotedPercent()).toBe(15);
    expect(referralEmail()!.html).not.toContain("earn 0% commission");
  });

  it("links them to their own code", async () => {
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", referralCode: "MIZZY" });
    expect(referralEmail()!.html).toContain("https://www.vantalabsresearch.com/r/MIZZY");
  });

  /**
   * The email is a notification. It must not be able to change what the
   * ambassador is paid — that lives in ambassadors.commission_percent, which
   * checkout reads.
   */
  it("writes no commission rate to either table", async () => {
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", referralCode: "MIZZY" });

    expect(state.writes.length).toBeGreaterThan(0);
    for (const write of state.writes) {
      expect(write.payload).not.toHaveProperty("commission_percent");
    }
  });
});

describe("the other ways the rate can be known", () => {
  it("prefers a rate the admin typed in this same request", async () => {
    await updatePartnerStatus({
      partnerId: PARTNER_ID,
      status: "approved",
      referralCode: "MIZZY",
      commissionPercent: 20,
    });
    expect(quotedPercent()).toBe(20);
    // And that one IS written, because the admin set it.
    expect(state.writes.some((w) => w.payload.commission_percent === 20)).toBe(true);
  });

  it("falls back to the program default for an ambassador with no rate yet", async () => {
    state.storedCommission = null;
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", referralCode: "MIZZY" });
    expect(quotedPercent()).toBe(10);
  });

  it("treats a blanked column as absent rather than as zero", async () => {
    state.storedCommission = "";
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", referralCode: "MIZZY" });
    expect(quotedPercent()).toBe(10);
  });

  it("still honours a deliberate 0%", async () => {
    await updatePartnerStatus({
      partnerId: PARTNER_ID,
      status: "approved",
      referralCode: "MIZZY",
      commissionPercent: 0,
    });
    expect(quotedPercent()).toBe(0);
  });
});

describe("when the email is sent at all", () => {
  it("is not sent when the code did not change", async () => {
    state.referralCode = "MIZZY";
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", referralCode: "MIZZY" });
    expect(referralEmail()).toBeUndefined();
  });

  it("is not sent for a rate edit that touches no code", async () => {
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", commissionPercent: 20 });
    expect(referralEmail()).toBeUndefined();
  });
});

describe("the approval email agrees with the referral email", () => {
  /**
   * Both are sent from one admin action. They quoted different numbers: the
   * approval email already resolved the stored rate while the referral email
   * printed 0. Two emails from one click must not disagree.
   */
  it("both quote the same rate on a genuine approval", async () => {
    state.status = "pending";
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", referralCode: "MIZZY" });

    const approval = sent.find((m) => m.subject !== "Your Vanta Labs Referral Code Is Ready");
    expect(approval).toBeDefined();
    expect(approval!.html).toContain("15%");
    expect(quotedPercent()).toBe(15);
  });
});
