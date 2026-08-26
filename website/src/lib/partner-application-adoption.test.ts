import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ADOPTION IS A FIRST APPLICATION, NOT A RE-SUBMISSION.
//
// create_partner_application returns created:false in two very different
// situations:
//
//   1. this auth user already applied  -- a genuine re-submit, must stay quiet
//   2. an ADMIN pre-added this person, and the function has just claimed that
//      row for their new account (adopted:true) -- their FIRST application
//
// Treating (2) like (1) would let someone submit the form, see success, and
// never receive a confirmation, while the owner is never told the person they
// pre-added has finally signed up.
//
// It would also answer with the WRONG identity: this module generates a
// candidate partner id and referral code before calling the RPC, and on
// adoption the surviving row is the admin's -- with the referral code the admin
// already issued, which may be in circulation.
//
// The database half of this defect (F-009) is covered by
// partner-identity-convergence.test.ts against a real Postgres. This file
// covers the TypeScript half and needs no database, so it runs everywhere.
// ---------------------------------------------------------------------------

type RpcResult = Record<string, unknown>;

const state = {
  rpcResult: null as RpcResult | null,
  partnersByAuthUser: new Map<string, Record<string, unknown>>(),
  emails: [] as { to: string; subject: string }[],
  notifications: [] as { kind: string; payload: Record<string, unknown> }[],
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async ({ to, subject }: { to: string; subject: string }) => {
    state.emails.push({ to, subject });
    return { success: true };
  }),
}));
vi.mock("@/lib/email/templates", () => ({
  ambassadorApplicationReceivedTemplate: () => ({ subject: "APPLICANT_CONFIRMATION", html: "h" }),
  ambassadorApprovedTemplate: () => ({ subject: "approved", html: "h" }),
  ambassadorDeniedTemplate: () => ({ subject: "denied", html: "h" }),
  ambassadorPayoutSentTemplate: () => ({ subject: "payout", html: "h" }),
  newAmbassadorApplicationTemplate: () => ({ subject: "OWNER_ALERT", html: "h" }),
  referralCodeAssignedTemplate: () => ({ subject: "code", html: "h" }),
}));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "owner@example.test" }),
  getReferralProgramConfig: async () => ({
    enabled: true, commissionsPaused: false, defaultCommissionPercent: 10,
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
  // enqueueNotification is a private function inside partner-portal that writes
  // through supabaseAdmin, so the only way to observe it is to model the real
  // call chain: .insert(...).select("id").single().
  function from(table: string) {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      insert: (row: Record<string, unknown>) => {
        if (table === "notification_queue") {
          state.notifications.push({
            kind: String(row.kind),
            payload: (row.payload ?? {}) as Record<string, unknown>,
          });
        }
        return builder;
      },
      single: async () => ({ data: { id: "queue-row-1" }, error: null }),
      maybeSingle: async () => {
        if (table === "partners") {
          // Only the "already applied" lookup uses this path in these tests.
          const row = state.partnersByAuthUser.get("auth-existing") ?? null;
          return { data: row, error: null };
        }
        return { data: null, error: null };
      },
      then: undefined,
    };
    return builder;
  }
  return {
    supabaseAdmin: {
      from,
      rpc: async () => ({ data: state.rpcResult, error: null }),
    },
  };
});

const { createPartnerApplication } = await import("@/lib/partner-portal");

const APPLICANT = {
  authUserId: "auth-new",
  name: "Paula Tester",
  email: "paula@example.test",
  firstName: "Paula",
  lastName: "Tester",
  phone: "555-0100",
  preferredReferralCode: "PAULA2",
};

beforeEach(() => {
  state.rpcResult = null;
  state.partnersByAuthUser.clear();
  state.emails = [];
  state.notifications = [];
});

describe("an adopted pre-added ambassador", () => {
  const ADOPTED = {
    partner_id: "11111111-1111-1111-1111-111111111111",
    status: "pending",
    referral_code: "PAULA",     // the code the ADMIN issued
    created: false,
    adopted: true,
  };

  it("is answered with the admin's identity, not the locally generated one", async () => {
    state.rpcResult = ADOPTED;
    const result = await createPartnerApplication(APPLICANT);

    expect(result.partnerId).toBe("11111111-1111-1111-1111-111111111111");
    // NOT "PAULA2" -- the applicant's preference loses to the issued code.
    expect(result.referralCode).toBe("PAULA");
  });

  it("sends the applicant their confirmation", async () => {
    state.rpcResult = ADOPTED;
    await createPartnerApplication(APPLICANT);

    const confirmations = state.emails.filter((e) => e.subject === "APPLICANT_CONFIRMATION");
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].to).toBe("paula@example.test");
  });

  it("tells the owner the person they pre-added has now applied", async () => {
    state.rpcResult = ADOPTED;
    await createPartnerApplication(APPLICANT);

    expect(state.emails.filter((e) => e.subject === "OWNER_ALERT")).toHaveLength(1);
    expect(state.notifications.map((n) => n.kind)).toContain("partner_application_received");
  });

  it("queues the notification against the adopted partner id", async () => {
    state.rpcResult = ADOPTED;
    await createPartnerApplication(APPLICANT);

    const queued = state.notifications.find((n) => n.kind === "partner_application_received");
    expect(queued?.payload.partnerId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("a genuine re-submission", () => {
  it("stays silent and notifies nobody", async () => {
    // created:false with NO adopted flag -- this auth user already applied.
    state.rpcResult = {
      partner_id: "55555555-5555-5555-5555-555555555555",
      status: "approved",
      referral_code: "PAULA",
      created: false,
    };

    const result = await createPartnerApplication(APPLICANT);

    expect(result.partnerId).toBe("55555555-5555-5555-5555-555555555555");
    expect(result.status).toBe("approved");
    expect(state.emails).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });
});

describe("a brand-new applicant", () => {
  it("still notifies, and keeps the identity the function created", async () => {
    state.rpcResult = {
      partner_id: "66666666-6666-6666-6666-666666666666",
      status: "pending",
      referral_code: "PAULA2",
      created: true,
    };

    const result = await createPartnerApplication(APPLICANT);

    expect(result.partnerId).toBe("66666666-6666-6666-6666-666666666666");
    expect(result.referralCode).toBe("PAULA2");
    expect(state.emails.filter((e) => e.subject === "APPLICANT_CONFIRMATION")).toHaveLength(1);
    expect(state.emails.filter((e) => e.subject === "OWNER_ALERT")).toHaveLength(1);
  });
});
