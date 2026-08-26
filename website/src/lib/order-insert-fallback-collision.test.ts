import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// J-04 — ONE UNRELATED SCHEMA DRIFT DISABLES THE DUPLICATE-CHARGE GUARD.
//
// insertOrderRow degrades to a pre-migration column set when an insert looks
// like it hit a missing column. On its own that is defensible: losing a real
// sale to an unapplied migration would be worse than writing a thinner row.
//
// The collision is that `base` is not "full minus the offending column" — it is
// a FIXED legacy row, and the retry is unconditional once triggered. So a
// PGRST204 about ANY column silently drops all of:
//
//   idempotency_key   <- the duplicate-charge guard
//   tax_rate_percent, tax_state   <- the sales-tax audit trail
//   shipping_protection_fee, state, phone, billing_*
//
// Two systems that are each individually reasonable — a tolerant insert, and a
// tax report that trusts the columns it reads — combine into orders that were
// taken successfully, cannot be deduplicated, and are wrong in the one report
// with a legal consequence. Nothing errors and nothing alerts.
//
// BLOCK J IS ANALYSIS ONLY and quote-order.ts is a shared file (Rule 3), so this
// file PROVES the collision and does not fix it. See CROSS-BLOCK (F) in
// BLOCK-J.md.
//
// The two `it.fails` tests below state the invariants that SHOULD hold. They are
// expected to fail today, which keeps the suite green while recording the defect.
// When quote-order.ts is fixed they will start passing and vitest will report
// "expected test to fail but it passed" — a loud, deliberate prompt to convert
// them into ordinary assertions.
// ---------------------------------------------------------------------------

const inserts: Array<Record<string, unknown>> = [];
let failFirstInsertWith: { code: string; message: string } | null = null;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push(row);
        if (inserts.length === 1 && failFirstInsertWith) {
          return { error: failFirstInsertWith };
        }
        return { error: null };
      },
    }),
  },
}));

async function insert(draft: { full: Record<string, unknown>; base: Record<string, unknown> }) {
  const { insertOrderRow } = await import("@/lib/quote-order");
  return insertOrderRow(draft as never);
}

// The shape buildOrderRow produces: `base` is the legacy row, `full` overlays
// everything added by later migrations.
function draft() {
  const base = {
    order_id: "order-j04",
    order_number: "VL-J04",
    amount_paid: 12345,
    idempotency_key: "idem-j04-unique",
  };
  const full = {
    ...base,
    state: "CA",
    phone: "555-0100",
    tax_rate_percent: 7.25,
    tax_state: "CA",
    shipping_protection_fee: 199,
    checkout_channel: "card",
  };
  const baseWithoutIdempotency = { ...base } as Record<string, unknown>;
  delete baseWithoutIdempotency.idempotency_key;
  return { full, base: baseWithoutIdempotency };
}

beforeEach(() => {
  inserts.length = 0;
  failFirstInsertWith = null;
});

describe("insertOrderRow's missing-column fallback", () => {
  it("writes the full row when the schema is current — the ordinary case", async () => {
    const result = await insert(draft());
    expect(result.status).toBe("inserted");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.idempotency_key).toBe("idem-j04-unique");
    expect(inserts[0]?.tax_state).toBe("CA");
  });

  it("retries when an insert reports an unknown column", async () => {
    failFirstInsertWith = { code: "PGRST204", message: "Could not find the 'checkout_channel' column" };
    const result = await insert(draft());
    expect(result.status).toBe("inserted");
    expect(inserts).toHaveLength(2);
  });

  it("drops columns unrelated to the one that failed — the collision itself", async () => {
    // A drift in `checkout_channel` takes the tax audit trail with it.
    failFirstInsertWith = { code: "PGRST204", message: "Could not find the 'checkout_channel' column" };
    await insert(draft());

    const retried = inserts[1] ?? {};
    expect(retried.tax_state).toBeUndefined();
    expect(retried.tax_rate_percent).toBeUndefined();
    expect(retried.shipping_protection_fee).toBeUndefined();
    // The order IS still written — which is why nothing surfaces as an error.
    expect(retried.order_id).toBe("order-j04");
  });

  it.fails("SHOULD keep the duplicate-charge guard when it degrades", async () => {
    failFirstInsertWith = { code: "PGRST204", message: "Could not find the 'checkout_channel' column" };
    await insert(draft());

    // idempotency_key is a GUARD, not a convenience. Dropping it means the
    // 23505 duplicate check cannot fire on this key, so the one protection
    // against writing the same order twice is removed by a schema problem in an
    // unrelated column.
    expect(inserts[1]?.idempotency_key).toBe("idem-j04-unique");
  });

  it.fails("SHOULD keep the sales-tax audit trail when it degrades", async () => {
    failFirstInsertWith = { code: "PGRST204", message: "Could not find the 'checkout_channel' column" };
    await insert(draft());

    // admin-tax-report reads exactly these and its own header says it never
    // re-derives rates, so these orders are silently wrong in the remittance
    // report — the one report with a legal consequence.
    expect(inserts[1]?.tax_state).toBe("CA");
    expect(inserts[1]?.tax_rate_percent).toBe(7.25);
  });
});
