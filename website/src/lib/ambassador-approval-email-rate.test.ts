import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// HISTORICAL DEFECT #3 — the approval email quotes the wrong commission.
//
// The referral-code-assigned email was repaired: it resolves the rate through
// firstFinitePercent([rate set in this request, stored rate, program default])
// and its header says, in capitals, that telling an ambassador they earn 0% is
// worse than not writing. The comment 30 lines above it claims the APPROVAL
// email "resolves it inside sendPartnerStatusEmail ... a caller that forgets
// cannot reintroduce a hole".
//
// It does not, and a caller did. updatePartnerStatus passes:
//
//     commissionPercent: existingPartner.commission_percent
//
// which is:
//   1. read from `partners` — the table this same function calls "the mirror"
//      and "a display copy", because `ambassadors` is what checkout and
//      commission accrual actually read; and
//   2. read BEFORE the update, so the rate the admin typed into this very
//      submission (`input.commissionPercent`) never reaches the email at all.
//
// So approving an ambassador and setting their rate in one action — the normal
// way an owner does it — emails them the OLD number. And whenever the two
// tables have drifted, it emails the number that does not govern their money.
//
// No database needed: this defect is entirely in which value the application
// hands to the template, so an in-memory fake is honest here. (Contrast
// partner-identity-convergence and partner-invite-atomicity, where the defect
// lives in a UNIQUE constraint and a fake would report a false pass.)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db = {
  partners: [] as Row[],
  ambassadors: [] as Row[],
};
let approvalEmail: Row | null = null;

function match(row: Row, filters: Array<[string, string, unknown]>) {
  return filters.every(([op, col, val]) =>
    op === "eq" ? row[col] === val : row[col] !== val);
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/templates", () => ({
  ambassadorApprovedTemplate: (args: Row) => {
    approvalEmail = args;
    return { subject: "approved", html: "h" };
  },
  ambassadorApplicationReceivedTemplate: () => ({ subject: "s", html: "h" }),
  ambassadorDeniedTemplate: () => ({ subject: "s", html: "h" }),
  ambassadorPayoutSentTemplate: () => ({ subject: "s", html: "h" }),
  newAmbassadorApplicationTemplate: () => ({ subject: "s", html: "h" }),
  referralCodeAssignedTemplate: () => ({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "owner@example.test" }),
  getReferralProgramConfig: async () => ({
    enabled: true, commissionsPaused: false, defaultCommissionPercent: 11,
    discountPercent: 10, personalDiscountPercent: 20,
  }),
}));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: 100, minimumPayoutThreshold: 100, commissionHoldDays: 14,
  }),
  getAmbassadorMarketingResources: async () => [],
}));
vi.mock("@/lib/supabase-server", () => {
  function from(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    const rows = () => (db as Record<string, Row[]>)[table] ?? [];
    let pendingUpdate: Row | null = null;
    // The filters arrive AFTER .update(payload), so the write can only be
    // applied when the chain is finally awaited — same as PostgREST.
    const settle = () => {
      const matched = rows().filter((r) => match(r, filters));
      if (pendingUpdate) for (const row of matched) Object.assign(row, pendingUpdate);
      // SNAPSHOTS, not live references. PostgREST returns JSON over HTTP, so a
      // row a caller read earlier does NOT change when the table is updated
      // later. Handing back the stored object instead made two of these tests
      // pass against the unfixed code — the caller's `existingPartner` appeared
      // to pick up the new rate by itself. That is the exact class of false
      // pass this audit exists to find; do not "simplify" this back.
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filters.push(["eq", col, val]); return builder; },
      neq: (col: string, val: unknown) => { filters.push(["neq", col, val]); return builder; },
      in: () => builder,
      update: (payload: Row) => { pendingUpdate = payload; return builder; },
      insert: (row: Row) => {
        const store = (db as Record<string, Row[]>)[table] ?? ((db as Record<string, Row[]>)[table] = []);
        store.push(row);
        return {
          select: () => ({ single: async () => ({ data: { id: "queue-1" }, error: null }) }),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
        };
      },
      maybeSingle: async () => {
        const { data } = settle();
        return { data: data[0] ?? null, error: null };
      },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(settle()).then(ok),
    };
    return builder;
  }
  return { supabaseAdmin: { from, rpc: async () => ({ data: null, error: null }) } };
});

const { updatePartnerStatus } = await import("@/lib/partner-portal");

const PARTNER_ID = "11111111-1111-1111-1111-111111111111";

/** `storedRate` goes on BOTH tables unless `authoritativeRate` overrides ambassadors. */
function seed(storedRate: number | null, authoritativeRate?: number | null) {
  db.partners = [{
    id: PARTNER_ID, name: "Mizzy", email: "mizzy@example.test",
    referral_code: "MIZZY", status: "pending", commission_percent: storedRate,
  }];
  db.ambassadors = [{
    id: PARTNER_ID, name: "Mizzy", email: "mizzy@example.test",
    referral_code: "MIZZY", status: "pending",
    commission_percent: authoritativeRate === undefined ? storedRate : authoritativeRate,
  }];
}

const approve = (commissionPercent?: number) => updatePartnerStatus({
  partnerId: PARTNER_ID, status: "approved", actorUserId: "admin-1",
  commissionPercent, actorUsername: "owner",
});

beforeEach(() => {
  approvalEmail = null;
  db.partners = [];
  db.ambassadors = [];
  (db as Record<string, Row[]>).notification_queue = [];
  (db as Record<string, Row[]>).admin_audit_logs = [];
});

describe("the commission an approved ambassador is told they earn", () => {
  it("is the rate the admin set in the same submission", async () => {
    // The ordinary way an owner approves someone: tick approve, type the rate.
    seed(10);

    await approve(20);

    expect(approvalEmail?.commissionPercent).toBe(20);
  });

  it("is the rate that actually governs their money, not the display copy", async () => {
    // partners is called "the mirror" and "a display copy" by this same
    // function; ambassadors is what checkout and accrual read.
    seed(10, 25);

    await approve();

    expect(approvalEmail?.commissionPercent).toBe(25);
  });

  it("matches what the database holds after the approval completes", async () => {
    seed(10);

    await approve(20);

    // Whatever the email said, it must be what they will actually be paid.
    expect(approvalEmail?.commissionPercent)
      .toBe(Number(db.ambassadors[0].commission_percent));
  });

  // -- Guard rails: behaviour the repair must not break ---------------------

  it("honours an explicit 0 rather than treating it as unset", async () => {
    // An owner may genuinely run a 0% ambassador. Silence means "look it up";
    // an explicit zero means zero.
    seed(15);

    await approve(0);

    expect(approvalEmail?.commissionPercent).toBe(0);
  });

  it("falls back to the program default when no rate is configured anywhere", async () => {
    seed(null);

    await approve();

    expect(approvalEmail?.commissionPercent).toBe(11);
  });

  it("still quotes the stored rate when this request sets none", async () => {
    seed(15);

    await approve();

    expect(approvalEmail?.commissionPercent).toBe(15);
  });
});
