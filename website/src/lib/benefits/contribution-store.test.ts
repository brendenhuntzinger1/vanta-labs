import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// M5b — PERSISTING THE SNAPSHOT.
//
// One rule outranks everything else in this file: A SALE IS NEVER UNDONE BY A
// REPORTING FAILURE. The order row is already committed by the time the writer
// runs, so every failure mode below has exactly one correct outcome — the write
// is lost, an alert is raised, and the order is untouched.
//
// The other four guarantees (one row per order, integer cents, NULL attribution,
// no duplicate on retry) are enforced by the DDL and proven against a real
// Postgres in src/lib/sql/order-contribution-sql.test.ts. This file proves what
// the application SENDS; that one proves what the database ACCEPTS.
// ---------------------------------------------------------------------------

const BREAKDOWN = {
  formulaVersion: 1,
  basis: "quote" as const,
  paidMerchandiseCents: 13998,
  shippingCollectedCents: 1500,
  handlingCollectedCents: 0,
  revenueCents: 15498,
  productCostCents: 2636,
  giftCogsCents: 0,
  processingFeeCents: 1240,
  shippingCostCents: 600,
  storeCreditRedeemedCents: 0,
  pointsRedeemedValueCents: 0,
  pointsEarnedValueCents: 0,
  deductionsCents: 4476,
  contributionBeforeCommissionCents: 11022,
  bindingConstraint: "productCost" as const,
  discountAmountCents: 0,
  costIsEstimated: false,
};

type Upsert = { table: string; row: Record<string, unknown>; options: Record<string, unknown> };

function mockSupabase(behaviour: { error?: { message: string; code?: string } | null; throws?: boolean } = {}) {
  const upserts: Upsert[] = [];
  vi.doMock("@/lib/supabase-server", () => ({
    supabaseAdmin: {
      from: (table: string) => ({
        upsert: async (row: Record<string, unknown>, options: Record<string, unknown>) => {
          if (behaviour.throws) throw new Error("connection reset");
          upserts.push({ table, row, options });
          return { error: behaviour.error ?? null };
        },
      }),
    },
  }));
  return upserts;
}

const alerts: Array<Record<string, unknown>> = [];
function mockMonitoring() {
  alerts.length = 0;
  vi.doMock("@/lib/monitoring", () => ({
    recordSystemAlert: async (alert: Record<string, unknown>) => { alerts.push(alert); },
  }));
}

async function loadStore() {
  return import("@/lib/benefits/contribution-store");
}

beforeEach(() => {
  vi.resetModules();
  mockMonitoring();
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/supabase-server");
  vi.doUnmock("@/lib/monitoring");
});

describe("the snapshot it writes", () => {
  it("maps every breakdown field onto its column, in cents", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();

    await recordContributionSnapshot("ord-1", BREAKDOWN);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe("order_contribution");
    expect(upserts[0].row).toEqual({
      order_id: "ord-1",
      formula_version: 1,
      basis: "quote",
      cost_is_estimated: false,
      paid_merchandise_cents: 13998,
      shipping_collected_cents: 1500,
      handling_collected_cents: 0,
      product_cost_cents: 2636,
      gift_cogs_cents: 0,
      processing_fee_cents: 1240,
      shipping_cost_cents: 600,
      store_credit_redeemed_cents: 0,
      points_redeemed_value_cents: 0,
      points_earned_value_cents: 0,
      contribution_before_commission_cents: 11022,
      binding_constraint: "productCost",
      gift_channel: null,
      offer_id: null,
      offer_key: null,
      campaign_key: null,
      send_reference_id: null,
    });
  });

  it("sends only integers for every cents column", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN);

    for (const [column, value] of Object.entries(upserts[0].row)) {
      if (!column.endsWith("_cents")) continue;
      expect(Number.isInteger(value), `${column} sent as ${String(value)}`).toBe(true);
    }
  });

  it("writes a negative contribution rather than clamping it", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", { ...BREAKDOWN, contributionBeforeCommissionCents: -1158 });
    expect(upserts[0].row.contribution_before_commission_cents).toBe(-1158);
  });

  it("asks for a conflict-ignoring upsert, so a retry cannot overwrite the first snapshot", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN);
    expect(upserts[0].options).toEqual({ onConflict: "order_id", ignoreDuplicates: true });
  });
});

describe("attribution is NULL when unknown, never a guess", () => {
  it("writes NULL for every field no caller supplied", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN, {});

    for (const column of ["gift_channel", "offer_id", "offer_key", "campaign_key", "send_reference_id"]) {
      expect(upserts[0].row[column], `${column} must be null`).toBeNull();
    }
  });

  it("writes what a caller actually supplies", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN, {
      giftChannel: "sms", offerId: "offer-9", offerKey: "sms_welcome_bac_water",
      campaignKey: "winback_60", sendReferenceId: "send-42",
    });
    expect(upserts[0].row).toMatchObject({
      gift_channel: "sms", offer_id: "offer-9", offer_key: "sms_welcome_bac_water",
      campaign_key: "winback_60", send_reference_id: "send-42",
    });
  });

  it("treats a blank or whitespace value as unknown rather than as a value", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN, {
      offerId: "", offerKey: "   ", campaignKey: null, sendReferenceId: undefined,
    });
    for (const column of ["offer_id", "offer_key", "campaign_key", "send_reference_id"]) {
      expect(upserts[0].row[column], `${column} must be null`).toBeNull();
    }
  });

  it("trims a real value rather than storing its padding", async () => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN, { offerKey: "  winback_60_free_ghkcu  " });
    expect(upserts[0].row.offer_key).toBe("winback_60_free_ghkcu");
  });
});

describe("a reporting failure never becomes an order failure", () => {
  it("does not throw when the database rejects the write", async () => {
    mockSupabase({ error: { message: "relation \"order_contribution\" does not exist", code: "42P01" } });
    const { recordContributionSnapshot } = await loadStore();
    await expect(recordContributionSnapshot("ord-1", BREAKDOWN)).resolves.toBeUndefined();
  });

  it("alerts on that failure, and names the likely cause", async () => {
    mockSupabase({ error: { message: "relation \"order_contribution\" does not exist", code: "42P01" } });
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot("ord-1", BREAKDOWN);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("order_contribution_write_failed");
    // A missing table is a reporting gap on a deployment behind the migration —
    // never a "critical", because the order itself is fine.
    expect(alerts[0].severity).toBe("warning");
    expect(String(alerts[0].message)).toContain("order-contribution.sql");
    expect(String(alerts[0].message)).toContain("order is unaffected");
  });

  it("does not throw when the client itself throws", async () => {
    mockSupabase({ throws: true });
    const { recordContributionSnapshot } = await loadStore();
    await expect(recordContributionSnapshot("ord-1", BREAKDOWN)).resolves.toBeUndefined();
  });

  it("does not throw when the alert ALSO fails", async () => {
    mockSupabase({ error: { message: "boom" } });
    vi.doMock("@/lib/monitoring", () => ({
      recordSystemAlert: async () => { throw new Error("alerting is down too"); },
    }));
    const { recordContributionSnapshot } = await loadStore();
    await expect(recordContributionSnapshot("ord-1", BREAKDOWN)).resolves.toBeUndefined();
  });

  it("returns nothing a caller could branch on to refuse a sale", async () => {
    mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    expect(await recordContributionSnapshot("ord-1", BREAKDOWN)).toBeUndefined();
  });
});

describe("it declines to write what it cannot describe", () => {
  it.each([
    ["a missing contribution", "ord-1", null],
    ["an undefined contribution", "ord-1", undefined],
    ["a blank order id", "   ", BREAKDOWN],
    ["an empty order id", "", BREAKDOWN],
  ])("writes nothing for %s", async (_label, orderId, contribution) => {
    const upserts = mockSupabase();
    const { recordContributionSnapshot } = await loadStore();
    await recordContributionSnapshot(
      orderId as string,
      contribution as typeof BREAKDOWN | null,
    );
    expect(upserts).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });
});

describe("which orders can reach the writer at all", () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  /**
   * Source with comments removed.
   *
   * membership-billing.ts carries a comment explaining that a since-deleted
   * function BYPASSED insertOrderRow. A naive text search reads that as a call
   * and reports the opposite of the truth — so the prose is stripped before the
   * code is searched.
   */
  const codeOnly = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  const callsInsertOrderRow = (text: string) => /\binsertOrderRow\s*\(/.test(codeOnly(text));

  it("is called from insertOrderRow, after the insert succeeds", async () => {
    const quote = source("src/lib/quote-order.ts");
    expect(quote).toContain("await recordContributionSnapshot(");
    // Immediately after the below-floor alert, inside the `if (!error)` branch —
    // the same place, for the same reasons.
    const insertBody = quote.slice(quote.indexOf("export async function insertOrderRow"));
    const alertAt = insertBody.indexOf("alertIfBelowProfitFloor");
    const writeAt = insertBody.indexOf("recordContributionSnapshot");
    const duplicateAt = insertBody.indexOf('return { status: "duplicate" }');
    expect(alertAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(alertAt);
    // BEFORE the duplicate branch in source order, which is AFTER it in control
    // flow: a duplicate returns without ever reaching the writer.
    expect(writeAt).toBeLessThan(duplicateAt);
  });

  it.each([
    ["membership", "src/lib/membership-billing.ts", 'order_type: "membership"'],
    ["replacement", "src/lib/admin-replacements.ts", 'order_type: "replacement"'],
  ])("%s orders cannot reach it — that lane writes its own row", (_kind, path, marker) => {
    const text = source(path);
    // It really is the lane that writes this order type…
    expect(text).toContain(marker);
    // …and it neither imports nor calls the function that carries the snapshot.
    // Structural exclusion, not a condition anyone has to remember to keep.
    expect(callsInsertOrderRow(text)).toBe(false);
    expect(text).not.toMatch(/import[^;]*insertOrderRow/);
    expect(text).not.toContain("recordContributionSnapshot");
  });

  it("only the two live merchandise lanes call insertOrderRow", async () => {
    // If a third lane appears, it inherits the snapshot for free — and this
    // test is where somebody notices that it did.
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
      }
      return out;
    };
    const callers = walk(join(process.cwd(), "src"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) => callsInsertOrderRow(readFileSync(file, "utf8")))
      .map((file) => file.replace(`${process.cwd()}/`, ""))
      .sort();
    expect(callers).toEqual([
      "src/app/api/checkout/express/authorize/route.ts",
      "src/lib/quote-order.ts",
      "src/lib/payment-service.ts",
    ].sort());
  });
});
