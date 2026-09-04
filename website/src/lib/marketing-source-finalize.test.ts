import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE PAID-TIME DECISION IS WRITTEN ONCE, SO IT IS WRITTEN ONLY ON EVIDENCE.
//
// supabase-js resolves a PostgREST error rather than throwing it. A lookup
// that reads "data or nothing" turns an un-migrated column, a permissions
// problem or a passing outage into "no gift, no coupon, no ad touch" — and
// the resulting "organic" stamp can never be moved. So a read that failed is
// a reason to abstain. And a gift minted before automation_key existed still
// belongs to the automation whose configuration carries that offer.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  order: null as Row | null,
  offers: [] as Row[],
  offersError: null as null | { message: string; code?: string },
  automations: [] as Row[],
  updates: [] as Array<{ patch: Row; filters: Array<[string, string, unknown]> }>,
  updatedRows: 1,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let op: "select" | "update" = "select";
    let patch: Row = {};
    const b: Record<string, unknown> = {
      select: () => b,
      limit: () => b,
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b; },
      is: (c: string, v: unknown) => { filters.push(["is", c, v]); return b; },
      update: (p: Row) => { op = "update"; patch = p; return b; },
      maybeSingle: async () => {
        if (table === "orders") return { data: state.order, error: null };
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let out: { data: unknown; error: unknown };
        if (op === "update") {
          state.updates.push({ patch, filters });
          out = { data: Array.from({ length: state.updatedRows }, () => ({ order_id: "o-1" })), error: null };
        } else if (table === "customer_offers") {
          out = state.offersError ? { data: null, error: state.offersError } : { data: state.offers, error: null };
        } else if (table === "email_automations") {
          out = { data: state.automations.filter((a) => filters.every(([, c, v]) => a[c] === v)), error: null };
        } else {
          out = { data: [], error: null };
        }
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

import { finalizeMarketingSource } from "@/lib/marketing-source";

const UNSTAMPED: Row = {
  ambassador_id: null, coupon_code: null,
  attributed_campaign_id: null, attributed_at: null,
  attributed_automation_key: null, attributed_automation_at: null,
  marketing_source_kind: null, marketing_source_ref: null, marketing_source_basis: null,
};

beforeEach(() => {
  state.order = { ...UNSTAMPED };
  state.offers = [];
  state.offersError = null;
  state.automations = [];
  state.updates = [];
  state.updatedRows = 1;
});

describe("finalizeMarketingSource", () => {
  it("ABSTAINS when the gift lookup fails, rather than stamping the order organic for ever", async () => {
    state.offersError = { message: 'column customer_offers.automation_key does not exist', code: "42703" };
    const decision = await finalizeMarketingSource({ orderId: "o-1" });
    expect(decision).toBeNull();
    expect(state.updates).toHaveLength(0);
  });

  it("credits a gift minted before automation_key existed to the automation whose configuration carries that offer", async () => {
    state.offers = [{ automation_key: null, offer_key: "winback_60_free_ghkcu" }];
    state.automations = [{ key: "winback_60", offer_key: "winback_60_free_ghkcu" }];
    const decision = await finalizeMarketingSource({ orderId: "o-1" });
    expect(decision).toEqual({ kind: "automation", ref: "winback_60", basis: "offer_redeemed" });
    expect(state.updates[0].patch).toMatchObject({ marketing_source_kind: "automation", marketing_source_ref: "winback_60", marketing_source_basis: "offer_redeemed" });
  });

  it("uses the gift's own automation_key when it has one, without consulting the configuration", async () => {
    state.offers = [{ automation_key: "winback_30", offer_key: "winback_60_bac_water_10" }];
    const decision = await finalizeMarketingSource({ orderId: "o-1" });
    expect(decision).toEqual({ kind: "automation", ref: "winback_30", basis: "offer_redeemed" });
  });

  it("reports nothing written when the write-once guard matched no row", async () => {
    state.updatedRows = 0;
    const decision = await finalizeMarketingSource({ orderId: "o-1" });
    expect(decision).toBeNull();
    expect(state.updates).toHaveLength(1);
    // The guard: an unstamped order is only stamped while it is still unstamped.
    expect(state.updates[0].filters).toContainEqual(["is", "marketing_source_kind", null]);
  });

  it("stamps an unstamped order organic when every signal was read and none was found", async () => {
    const decision = await finalizeMarketingSource({ orderId: "o-1" });
    expect(decision).toEqual({ kind: "organic", ref: null, basis: "none" });
    expect(state.updates).toHaveLength(1);
  });
});
