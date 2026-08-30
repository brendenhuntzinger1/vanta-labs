import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendEmail } from "@/lib/email/send";

// ---------------------------------------------------------------------------
// TWO TABLES THAT MUST NEVER DISAGREE, AND ONE NUMBER THAT MUST NEVER BE SHORT.
//
// Both defects here were found in live data, not imagined.
//
// BRUTUS — approved in `partners` since 2026-08-02, absent from `ambassadors`.
// Every referral read uses ambassadors, so validate_referral_code returns
// {"valid": false} and their link has been dead for four weeks while the admin
// showed them as an approved partner. Cause: createPartnerApplication did two
// sequential inserts, and the first commits on its own.
//
// ELIJAH-AB78AE — partners says info_requested, ambassadors says approved. The
// code still resolves for shoppers and the commission gate still passes, so an
// ambassador the owner put on hold stayed live. Cause: `statusChanged` compares
// against partners alone and then gates whether status is written to BOTH
// tables, so once they diverge every later save is a no-op and they can never
// re-converge. Three admin saves failed to fix it.
//
// TRUNCATION — the payout queue summed every approved_for_payout row fetched
// over PostgREST. Above the project's db-max-rows that page comes back short,
// with no error, and the owner is shown less than they owe.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const state = {
  partners: new Map<string, Row>(),
  ambassadors: new Map<string, Row>(),
  /** Set to make the ambassadors insert fail, as it did for BRUTUS. */
  breakAmbassadorInsert: false,
  /** Rows the fake PostgREST will return before truncating, like db-max-rows. */
  rowCap: null as number | null,
  referralOrders: [] as Row[],
  rpcCalls: [] as string[],
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock("@/lib/email/templates", () => ({
  ambassadorApplicationReceivedTemplate: () => ({ subject: "applied", html: "h" }),
  ambassadorApprovedTemplate: () => ({ subject: "approved", html: "h" }),
  ambassadorDeniedTemplate: () => ({ subject: "denied", html: "h" }),
  ambassadorInfoRequestedTemplate: () => ({ subject: "one more thing", html: "h", text: "t" }),
  ambassadorPayoutSentTemplate: () => ({ subject: "payout", html: "h" }),
  newAmbassadorApplicationTemplate: () => ({ subject: "new", html: "h" }),
  referralCodeAssignedTemplate: () => ({ subject: "Your Vanta Labs Referral Code Is Ready", html: "h" }),
}));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "support@example.test" }),
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
  /**
   * The atomic RPC, modelled on the real plpgsql: idempotent by auth user, and
   * BOTH inserts or NEITHER. `breakAmbassadorInsert` forces the second to fail,
   * which is the exact scenario that produced BRUTUS.
   */
  async function createPartnerApplicationRpc(args: Record<string, unknown>) {
    state.rpcCalls.push("create_partner_application");
    const authUserId = String(args.p_auth_user_id);

    for (const row of state.partners.values()) {
      if (row.auth_user_id === authUserId) {
        return { data: {
          partner_id: row.id, status: row.status,
          referral_code: row.referral_code, created: false,
        }, error: null };
      }
    }

    const id = String(args.p_id);
    const row = {
      id, auth_user_id: authUserId, name: args.p_name, email: args.p_email,
      referral_code: args.p_referral_code, status: "pending",
      commission_percent: args.p_commission_percent,
    };

    // One transaction: stage both, commit both, or commit neither.
    if (state.breakAmbassadorInsert) {
      return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    }
    state.partners.set(id, { ...row });
    state.ambassadors.set(id, { ...row });
    return { data: { partner_id: id, status: "pending", referral_code: args.p_referral_code, created: true }, error: null };
  }

  /** Server-side aggregate: ONE row per partner, whatever the cap. */
  async function affiliateBalancesRpc() {
    state.rpcCalls.push("affiliate_balances");
    const byPartner = new Map<string, { approved: number; count: number; earliest: string | null }>();
    for (const row of state.referralOrders) {
      if (row.payment_status !== "approved_for_payout") continue;
      const id = String(row.ambassador_id);
      const agg = byPartner.get(id) ?? { approved: 0, count: 0, earliest: null };
      agg.approved += Number(row.commission_amount ?? 0);
      agg.count += 1;
      const at = row.approved_for_payout_at ? String(row.approved_for_payout_at) : null;
      if (at && (!agg.earliest || at < agg.earliest)) agg.earliest = at;
      byPartner.set(id, agg);
    }
    // The cap applies to ROWS RETURNED. One row per partner, so it only bites
    // above the number of partners — which is the whole point of aggregating.
    let rows = [...byPartner.entries()].map(([id, a]) => ({
      ambassador_id: id, approved_amount: a.approved, approved_count: a.count,
      earliest_approved_at: a.earliest, pending_amount: 0, paid_amount: 0, lifetime_earned: a.approved,
    }));
    if (state.rowCap !== null) rows = rows.slice(0, state.rowCap);
    return { data: rows, error: null };
  }

  const from = (table: string) => {
    const store = table === "partners" ? state.partners
      : table === "ambassadors" ? state.ambassadors : null;

    if (store) {
      return {
        select: () => {
          const f: Record<string, unknown> = {};
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { f[c] = v; return b; },
            neq() { return b; }, limit() { return b; }, in() { return b; },
            async maybeSingle() {
              const hit = [...store.values()].find((r) => Object.entries(f).every(([k, v]) => r[k] === v));
              return { data: hit ?? null, error: null };
            },
            then(res: (v: unknown) => unknown) { return Promise.resolve(res({ data: [], error: null })); },
          };
          return b;
        },
        update: (payload: Row) => ({
          // .eq() stays awaitable AND accepts a trailing .select(), because a
          // caller that needs to know whether the write matched ANY row has to
          // ask for the rows back — a zero-row update is not an error.
          eq: (c: string, v: unknown) => {
            const matched: Row[] = [];
            for (const [k, r] of store) {
              if (r[c] === v) { const next = { ...r, ...payload }; store.set(k, next); matched.push(next); }
            }
            return {
              select: async () => ({ data: matched, error: null }),
              then: (res: (v: unknown) => unknown) => Promise.resolve(res({ data: matched, error: null })),
            };
          },
        }),
      };
    }

    if (table === "referral_orders") {
      return {
        select: () => {
          const f: Record<string, unknown> = {};
          const b: Record<string, unknown> = {
            eq(c: string, v: unknown) { f[c] = v; return b; },
            in(c: string, v: unknown[]) { f[`in:${c}`] = v; return b; },
            then(res: (v: unknown) => unknown) {
              let rows = state.referralOrders.filter((r) => Object.entries(f).every(([k, v]) =>
                k.startsWith("in:") ? (v as unknown[]).includes(r[k.slice(3)]) : r[k] === v));
              // THE TRUNCATION, as PostgREST does it: short page, no error.
              if (state.rowCap !== null) rows = rows.slice(0, state.rowCap);
              return Promise.resolve(res({ data: rows, error: null }));
            },
          };
          return b;
        },
      };
    }

    const noop: Record<string, unknown> = {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), limit: async () => ({ data: [], error: null }), in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })) }) }), in: () => ({ then: (r: (v: unknown) => unknown) => Promise.resolve(r({ data: [], error: null })) }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "x" }, error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })) }),
      update: () => ({
        eq: () => ({ select: async () => ({ data: [], error: null }), then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })) }),
        in: () => ({ select: async () => ({ data: [], error: null }), then: (r: (v: unknown) => unknown) => Promise.resolve(r({ error: null })) }),
      }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
    return noop;
  };

  return {
    supabaseAdmin: {
      from,
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "create_partner_application") return createPartnerApplicationRpc(args);
        if (name === "affiliate_balances") return affiliateBalancesRpc();
        return { data: null, error: null };
      },
    },
  };
});

const { createPartnerApplication, getPayoutQueue, updatePartnerStatus } = await import("@/lib/partner-portal");

beforeEach(() => {
  state.partners.clear();
  state.ambassadors.clear();
  state.breakAmbassadorInsert = false;
  state.rowCap = null;
  state.referralOrders = [];
  state.rpcCalls = [];
  vi.clearAllMocks();
});

const apply = (authUserId = "auth-1", name = "New Applicant") =>
  createPartnerApplication({ authUserId, name, email: `${authUserId}@example.test` });

describe("a partner is created in both tables or in neither", () => {
  it("both rows appear together", async () => {
    const result = await apply();
    expect(state.partners.size).toBe(1);
    expect(state.ambassadors.size).toBe(1);
    expect(state.partners.get(result.partnerId)).toBeDefined();
    expect(state.ambassadors.get(result.partnerId)).toBeDefined();
    expect(state.rpcCalls).toContain("create_partner_application");
  });

  /** THE BRUTUS SCENARIO. The second write fails; no orphan may survive. */
  it("a failed second write leaves NO valid-looking orphan partner", async () => {
    state.breakAmbassadorInsert = true;
    await expect(apply()).rejects.toBeTruthy();

    expect(state.partners.size).toBe(0);
    expect(state.ambassadors.size).toBe(0);
  });

  it("and the applicant can simply try again afterwards", async () => {
    state.breakAmbassadorInsert = true;
    await expect(apply()).rejects.toBeTruthy();

    state.breakAmbassadorInsert = false;
    const result = await apply();
    expect(state.partners.size).toBe(1);
    expect(state.ambassadors.size).toBe(1);
    expect(state.ambassadors.get(result.partnerId)).toBeDefined();
  });
});

describe("retrying or re-applying never duplicates or overwrites", () => {
  it("a retry returns the same partner, creating nothing new", async () => {
    const first = await apply();
    const second = await apply();

    expect(second.partnerId).toBe(first.partnerId);
    expect(state.partners.size).toBe(1);
    expect(state.ambassadors.size).toBe(1);
  });

  it("four simultaneous submits still yield one partner", async () => {
    const results = await Promise.all([apply(), apply(), apply(), apply()]);
    expect(new Set(results.map((r) => r.partnerId)).size).toBe(1);
    expect(state.partners.size).toBe(1);
  });

  /**
   * The configuration-corruption case: an admin has since set a real rate, and
   * a stray re-application must not reset it to the program default.
   */
  it("re-applying does not overwrite configuration an admin has set", async () => {
    const first = await apply();
    state.partners.set(first.partnerId, { ...state.partners.get(first.partnerId)!, commission_percent: 25, status: "approved" });
    state.ambassadors.set(first.partnerId, { ...state.ambassadors.get(first.partnerId)!, commission_percent: 25, status: "approved" });

    await apply();

    expect(state.partners.get(first.partnerId)!.commission_percent).toBe(25);
    expect(state.partners.get(first.partnerId)!.status).toBe("approved");
    expect(state.ambassadors.get(first.partnerId)!.commission_percent).toBe(25);
  });

  it("a different person applying gets their own partner", async () => {
    const a = await apply("auth-1");
    const b = await apply("auth-2");
    expect(a.partnerId).not.toBe(b.partnerId);
    expect(state.partners.size).toBe(2);
  });
});

describe("the two tables cannot drift on status", () => {
  /**
   * THE ELIJAH SCENARIO. partners and ambassadors already disagree; a save must
   * bring them back in line rather than reading "no change" off the mirror.
   */
  it("a save re-converges tables that had already diverged", async () => {
    const created = await apply();
    const id = created.partnerId;
    // The drifted state, exactly as production holds ELIJAH-AB78AE.
    state.partners.set(id, { ...state.partners.get(id)!, status: "info_requested", email: "e@example.test", name: "E" });
    state.ambassadors.set(id, { ...state.ambassadors.get(id)!, status: "approved" });

    await updatePartnerStatus({ partnerId: id, status: "info_requested" });

    expect(state.ambassadors.get(id)!.status).toBe("info_requested");
    expect(state.partners.get(id)!.status).toBe("info_requested");
  });

  /**
   * THE STATUS THAT TOLD NOBODY.
   *
   * /partner/pending renders, for info_requested: "Please reply to the email we
   * sent." No email was ever sent — updatePartnerStatus gated its notification
   * on approved/rejected only. An applicant moved to this state sat on a page
   * pointing at a message that did not exist.
   *
   * Reply-To is part of the fix, not decoration: the copy tells them to reply,
   * and a reply to noreply@ goes nowhere.
   */
  it("tells an applicant when the owner asks for more information", async () => {
    const created = await apply();
    const id = created.partnerId;
    state.partners.set(id, { ...state.partners.get(id)!, email: "e@example.test", name: "E" });

    await updatePartnerStatus({ partnerId: id, status: "info_requested" });

    const sent = vi.mocked(sendEmail).mock.calls.map(([message]) => message);
    const notice = sent.find((message) => message.subject === "one more thing");
    expect(notice, "info_requested sent no email").toBeDefined();
    expect(notice!.to).toBe("e@example.test");
    expect(notice!.replyTo).toBe("support@example.test");
  });

  it("an ordinary status change still writes both", async () => {
    const created = await apply();
    const id = created.partnerId;
    state.partners.set(id, { ...state.partners.get(id)!, email: "e@example.test", name: "E" });

    await updatePartnerStatus({ partnerId: id, status: "approved" });

    expect(state.partners.get(id)!.status).toBe("approved");
    expect(state.ambassadors.get(id)!.status).toBe("approved");
  });
});

describe("what the owner is told they owe is never short", () => {
  /** More partners and more commissions than any plausible db-max-rows. */
  function seed(partners: number, commissionsEach: number, each = 12.34) {
    state.referralOrders = [];
    for (let p = 0; p < partners; p += 1) {
      for (let c = 0; c < commissionsEach; c += 1) {
        state.referralOrders.push({
          id: `ro-${p}-${c}`, ambassador_id: `amb-${p}`,
          commission_amount: each, payment_status: "approved_for_payout",
          approved_for_payout_at: new Date(Date.UTC(2026, 7, 1 + (c % 20))).toISOString(),
        });
      }
      state.partners.set(`amb-${p}`, { id: `amb-${p}`, name: `P${p}`, status: "approved" });
    }
    return Math.round(partners * commissionsEach * each * 100) / 100;
  }

  it("5,000 commissions across 50 partners total exactly, with a 1,000-row cap in force", async () => {
    const expected = seed(50, 100);
    state.rowCap = 1000; // the common PostgREST default, well below 5,000

    const queue = await getPayoutQueue();

    expect(queue.totalOwed).toBeCloseTo(expected, 2);
    expect(queue.rows).toHaveLength(50);
    // Proof it went through the aggregate rather than the raw row read.
    expect(state.rpcCalls).toContain("affiliate_balances");
  });

  it("the per-partner figures are right too, not just the total", async () => {
    seed(50, 100);
    state.rowCap = 1000;
    const queue = await getPayoutQueue();
    for (const row of queue.rows) {
      expect(row.amountOwed).toBeCloseTo(1234, 2); // 100 x 12.34
      expect(row.approvedOrderCount).toBe(100);
    }
  });

  /**
   * The demonstration that the cap was real. Summing the RAW rows under the
   * same cap gives a fifth of the truth — which is what the admin used to show.
   */
  it("a raw row read under the same cap would have under-reported by 80%", async () => {
    const expected = seed(50, 100);
    state.rowCap = 1000;

    const trunc = state.referralOrders.slice(0, 1000)
      .reduce((sum, r) => sum + Number(r.commission_amount ?? 0), 0);

    expect(trunc).toBeLessThan(expected);
    expect(trunc / expected).toBeCloseTo(0.2, 2);

    const queue = await getPayoutQueue();
    expect(queue.totalOwed).toBeCloseTo(expected, 2);
    expect(queue.totalOwed).not.toBeCloseTo(trunc, 2);
  });

  it("no cap, same answer — the aggregate is not doing something different", async () => {
    const expected = seed(20, 40);
    state.rowCap = null;
    const queue = await getPayoutQueue();
    expect(queue.totalOwed).toBeCloseTo(expected, 2);
  });

  it("a partner with nothing approved is not in the queue", async () => {
    seed(3, 5);
    state.referralOrders.push({
      id: "ro-x", ambassador_id: "amb-empty", commission_amount: 50,
      payment_status: "pending",
    });
    const queue = await getPayoutQueue();
    expect(queue.rows.map((r) => r.partnerId)).not.toContain("amb-empty");
  });
});
