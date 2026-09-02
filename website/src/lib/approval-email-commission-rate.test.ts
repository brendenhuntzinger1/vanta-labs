import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK C / C-01 — historical defect #3: the 0% (and stale-%) approval email.
//
// referral-code-email-wiring.test.ts fixed and covers the SECOND email sent by
// updatePartnerStatus — the referral-code-assigned one. The FIRST email sent by
// the same function, the approval email, was never given the same treatment,
// despite the comment at partner-portal.ts:251 asserting that it "resolves it
// inside sendPartnerStatusEmail ... the same reason". It does not. It is handed:
//
//     commissionPercent: existingPartner.commission_percent
//
// which is (a) read from `partners`, the table the same function calls "the
// mirror" / "a display copy" while ambassadors is what checkout and commission
// accrual read, and (b) read BEFORE the update, so `input.commissionPercent` —
// the rate the admin typed in this very submission — is ignored entirely.
//
// This file drives the real updatePartnerStatus and reads the percentage out of
// the approval email that comes back. It is written to FAIL against the current
// code; the fix lives in partner-portal.ts, which block A+B owns, so it is
// recorded as CROSS-BLOCK in website/docs/findings/BLOCK-C.md.
//
// No real email is sent: sendEmail is mocked and every message is captured.
// ---------------------------------------------------------------------------

const PARTNER_ID = "amb-drift";

const state = {
  name: "Drift Case",
  email: "ambassador@example.test",
  /** Pending, so approving is a real status TRANSITION and the email fires. */
  status: "pending",
  referralCode: "DRIFT",
  /** partners.commission_percent — the mirror. The stale side of the drift. */
  partnersCommission: "10.00" as string | number | null,
  /** ambassadors.commission_percent — authoritative; what checkout pays. */
  ambassadorsCommission: "25.00" as string | number | null,
  programDefaultCommission: 10,
  /** F-018: an update that matches no `ambassadors` row must not report success. */
  ambassadorsRowExists: true,
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
    personalDiscountPercent: 20,
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

/**
 * A writable update builder.
 *
 * updatePartnerStatus writes the new rate and then reads it back from the
 * AUTHORITATIVE table before composing the email (block A+B, F-017), and it
 * treats an update that matched zero rows as a hard failure (F-018), which is
 * why the chain has to support `.eq(...).select(...)` and why the write has to
 * actually land in `state`. A fake that swallowed writes would let this file
 * pass while the email quoted a number nobody was ever paid.
 */
function updateBuilder(apply: (payload: Record<string, unknown>) => void) {
  return (payload: Record<string, unknown>) => {
    let applied = false;
    const run = () => {
      if (!applied) {
        applied = true;
        apply(payload);
      }
    };
    const chain: Record<string, unknown> = {
      eq() { return chain; },
      select() {
        run();
        return Promise.resolve({
          data: state.ambassadorsRowExists ? [{ id: PARTNER_ID }] : [],
          error: null,
        });
      },
      then(resolve: (v: unknown) => unknown) {
        run();
        return Promise.resolve(resolve({ error: null }));
      },
    };
    return chain;
  };
}

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "partners") {
      return {
        select: () => {
          const b: Record<string, unknown> = {
            eq(column: string) {
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
                  commission_percent: state.partnersCommission,
                  status: state.status,
                  approved_at: null,
                },
                error: null,
              };
            },
            then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve({ data: [], error: null })); },
          };
          return b;
        },
        update: updateBuilder((payload) => {
          if (payload.commission_percent !== undefined) {
            state.partnersCommission = payload.commission_percent as string | number | null;
          }
          if (payload.status !== undefined) state.status = payload.status as string;
        }),
      };
    }
    if (table === "ambassadors") {
      return {
        select: () => ({
          eq: () => ({
            neq: () => ({ limit: async () => ({ data: [], error: null }) }),
            async maybeSingle() {
              return {
                data: { id: PARTNER_ID, commission_percent: state.ambassadorsCommission },
                error: null,
              };
            },
          }),
        }),
        update: updateBuilder((payload) => {
          if (payload.commission_percent !== undefined) {
            state.ambassadorsCommission = payload.commission_percent as string | number | null;
          }
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
      update: () => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          select: () => Promise.resolve({ data: [], error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
        };
        return chain;
      },
    };
    return noop;
  };
  return { supabaseAdmin: { from } };
});

const { updatePartnerStatus } = await import("@/lib/partner-portal");

const APPROVAL_SUBJECT = "You're approved — Vanta Labs ambassador program";

function approvalEmail() {
  return sent.find((m) => m.subject === APPROVAL_SUBJECT);
}

/** The commission percentage the approval email actually quotes. */
function quotedPercent(): number | null {
  // Reads the "Your commission" row of the rate table. The email used to state
  // this as a "<strong>N% commission</strong>" bullet inside a promotional
  // benefits list; that list was removed when the approval email was trimmed
  // back to a transactional shape. The rate itself is unchanged and is now
  // stated against the label that names it, which is a stricter thing to
  // assert than a loose substring.
  const html = approvalEmail()?.html ?? "";
  const match = html.match(/Your commission<\/td>\s*<td[^>]*>([\d.]+)%/);
  return match ? Number(match[1]) : null;
}

beforeEach(() => {
  state.status = "pending";
  state.partnersCommission = "10.00";
  state.ambassadorsCommission = "25.00";
  state.programDefaultCommission = 10;
  state.ambassadorsRowExists = true;
  sent.length = 0;
  vi.clearAllMocks();
});

describe("approving and setting the rate in one submission", () => {
  /**
   * THE DEFECT. The admin approves and types 20 into the commission field in the
   * same action. 20 is written to both tables — and the email quotes 10, the
   * value read from the mirror table before the write.
   */
  it("quotes the rate the admin just typed", async () => {
    await updatePartnerStatus({
      partnerId: PARTNER_ID,
      status: "approved",
      commissionPercent: 20,
    });

    expect(approvalEmail()).toBeDefined();
    expect(quotedPercent()).toBe(20);
  });

  it("never quotes a rate that was overwritten by this same request", async () => {
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", commissionPercent: 20 });
    expect(quotedPercent()).not.toBe(10);
  });
});

describe("approving without setting a rate", () => {
  /**
   * With no rate in the request, the email must quote the AUTHORITATIVE stored
   * rate — ambassadors.commission_percent, what checkout pays — not the mirror.
   * The two drift in production (ELIJAH-AB78AE, MIZZY are the named cases).
   */
  it("quotes the authoritative ambassadors rate, not the partners mirror", async () => {
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved" });

    expect(approvalEmail()).toBeDefined();
    expect(quotedPercent()).toBe(25);
  });
});

describe("negative controls", () => {
  /** A deliberate 0% ambassador is legitimate and must survive as 0, not
   * become the template's hard-coded 10. */
  it("honours an explicit 0% instead of falling through to the template default", async () => {
    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", commissionPercent: 0 });

    expect(quotedPercent()).toBe(0);
  });

  /** With nothing stored anywhere, the PROGRAM default must be quoted — never
   * the 10 hard-coded inside ambassadorApprovedTemplate. */
  it("falls back to the program default, not the template's hard-coded 10", async () => {
    state.partnersCommission = null;
    state.ambassadorsCommission = null;
    state.programDefaultCommission = 12;

    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved" });

    expect(quotedPercent()).toBe(12);
  });

  /**
   * F-018 (block A+B). Approving someone with no `ambassadors` row used to
   * return 200, send them an approval email and write an audit row naming a
   * table it never touched. It must now refuse, and send nothing.
   */
  it("refuses, and sends nothing, when no ambassadors row was matched", async () => {
    state.ambassadorsRowExists = false;

    await expect(
      updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", commissionPercent: 20 }),
    ).rejects.toThrow(/no record in the ambassadors table/i);

    expect(approvalEmail()).toBeUndefined();
  });

  /** A rate edit that is not a transition must not re-send the approval email. */
  it("sends no approval email when the status did not change", async () => {
    state.status = "approved";

    await updatePartnerStatus({ partnerId: PARTNER_ID, status: "approved", commissionPercent: 20 });

    expect(approvalEmail()).toBeUndefined();
  });
});
