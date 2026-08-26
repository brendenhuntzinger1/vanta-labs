import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// J-04 — A DEGRADED INSERT MUST NEVER SILENTLY DROP AN ORDER-INTEGRITY FIELD.
//
// insertOrderRow degrades when an insert looks like it hit a missing column. On
// its own that is right: losing a real sale to an unapplied migration is worse
// than writing a thinner row.
//
// What was wrong is WHAT it degraded to. `base` was a FIXED pre-migration row,
// and the retry was unconditional once triggered, so a PGRST204 about ANY column
// silently dropped all of:
//
//   idempotency_key   <- the duplicate-charge guard
//   tax_rate_percent, tax_state   <- the sales-tax audit trail
//   shipping_protection_fee, state, phone, billing_*
//
// A stale PostgREST schema cache — an ordinary event in the minutes after a
// migration — could therefore take an order with its duplicate-charge guard
// removed, and nothing would error or alert.
//
// NOTE ON PROVENANCE: five Aug 2-3 production orders show exactly this column
// signature. They are NOT this code firing — see §J-07 in BLOCK-J.md; the
// decisive point is that buildOrderRow did not exist until three weeks after
// those orders. This mechanism has never been observed to fire. It is fixed
// because no error path should silently remove a guard, not because it did.
// ---------------------------------------------------------------------------

const inserts: Array<Record<string, unknown>> = [];
let errorQueue: Array<{ code?: string; message: string } | null> = [];

type SystemAlert = { type: string; severity: string; message: string; context?: Record<string, unknown> };
const alerts: SystemAlert[] = [];
const recordSystemAlert = vi.fn(async (alert: SystemAlert) => {
  alerts.push(alert);
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ ...row });
        const next = errorQueue.shift();
        return { error: next ?? null };
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

/** Exactly what PostgREST returns when its schema cache predates a migration. */
function pgrst204(column: string) {
  return {
    code: "PGRST204",
    message: `Could not find the '${column}' column of 'orders' in the schema cache`,
  };
}

/** Exactly what Postgres itself returns for a genuinely absent column. */
function pgUndefinedColumn(column: string) {
  return {
    code: "42703",
    message: `column "${column}" of relation "orders" does not exist`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  alerts.length = 0;
  errorQueue = [];
});

describe("the ordinary case", () => {
  it("writes the full row when the schema is current", async () => {
    const result = await insert(draft());
    expect(result.status).toBe("inserted");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.idempotency_key).toBe("idem-j04-unique");
    expect(inserts[0]?.tax_state).toBe("CA");
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("reports a unique-index violation as a duplicate, not an error", async () => {
    errorQueue = [{ code: "23505", message: "duplicate key value violates unique constraint" }];
    const result = await insert(draft());
    expect(result.status).toBe("duplicate");
  });
});

describe("degrading around a genuinely missing column", () => {
  it("drops ONLY the column the error names, and still writes the order", async () => {
    errorQueue = [pgrst204("checkout_channel")];
    const result = await insert(draft());

    expect(result.status).toBe("inserted");
    expect(inserts).toHaveLength(2);

    const retried = inserts[1] ?? {};
    expect(retried.checkout_channel).toBeUndefined();
    // Everything unrelated to the failure survives.
    expect(retried.idempotency_key).toBe("idem-j04-unique");
    expect(retried.tax_state).toBe("CA");
    expect(retried.tax_rate_percent).toBe(7.25);
    expect(retried.shipping_protection_fee).toBe(199);
    expect(retried.state).toBe("CA");
    expect(retried.phone).toBe("555-0100");
  });

  it("handles Postgres's own undefined-column error, not just PostgREST's", async () => {
    errorQueue = [pgUndefinedColumn("shipping_protection_fee")];
    const result = await insert(draft());

    expect(result.status).toBe("inserted");
    expect(inserts[1]?.shipping_protection_fee).toBeUndefined();
    expect(inserts[1]?.idempotency_key).toBe("idem-j04-unique");
  });

  it("peels off several missing columns in turn when a deploy is several migrations behind", async () => {
    errorQueue = [pgrst204("checkout_channel"), pgrst204("shipping_protection_fee"), pgrst204("phone")];
    const result = await insert(draft());

    expect(result.status).toBe("inserted");
    expect(inserts).toHaveLength(4);
    const final = inserts[3] ?? {};
    expect(final.checkout_channel).toBeUndefined();
    expect(final.shipping_protection_fee).toBeUndefined();
    expect(final.phone).toBeUndefined();
    expect(final.idempotency_key).toBe("idem-j04-unique");
  });
});

describe("the guard columns", () => {
  it("KEEPS the duplicate-charge guard when it degrades", async () => {
    errorQueue = [pgrst204("checkout_channel")];
    await insert(draft());

    // idempotency_key is a GUARD, not a convenience. Dropping it means the 23505
    // duplicate check cannot fire on this key, so the one protection against
    // writing the same order twice is removed by a schema problem in an
    // unrelated column.
    expect(inserts[1]?.idempotency_key).toBe("idem-j04-unique");
  });

  it("KEEPS the sales-tax audit trail when it degrades", async () => {
    errorQueue = [pgrst204("checkout_channel")];
    await insert(draft());

    // admin-tax-report reads exactly these and never re-derives rates.
    expect(inserts[1]?.tax_state).toBe("CA");
    expect(inserts[1]?.tax_rate_percent).toBe(7.25);
  });

  it("never drops a guard column SILENTLY, even when the guard is the missing one", async () => {
    // A deployment genuinely predating the idempotency migration must still be
    // able to take the order — refusing every checkout would be worse — but it
    // must not be quiet about it.
    errorQueue = [pgrst204("idempotency_key")];
    const result = await insert(draft());

    expect(result.status).toBe("inserted");
    expect(inserts[1]?.idempotency_key).toBeUndefined();
    expect(recordSystemAlert).toHaveBeenCalledTimes(1);

    const alert = alerts[0] as SystemAlert;
    expect(alert.severity).toBe("critical");
    expect(String(JSON.stringify(alert.context))).toContain("idempotency_key");
  });
});

describe("negative controls — the fix must not over-reach", () => {
  it("does NOT retry an error that is not about a missing column", async () => {
    // A check-constraint violation is a real failure. Retrying it, or degrading
    // the row to get around it, would write a corrupt order.
    errorQueue = [{ code: "23514", message: "new row violates check constraint orders_amount_positive" }];
    const result = await insert(draft());

    expect(result.status).toBe("error");
    expect(inserts).toHaveLength(1);
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("does NOT loop forever when the database keeps reporting the same column", async () => {
    errorQueue = Array.from({ length: 40 }, () => pgrst204("checkout_channel"));
    const result = await insert(draft());

    expect(result.status).toBe("error");
    // Bounded: one initial attempt plus a small number of retries, nowhere near 40.
    expect(inserts.length).toBeLessThan(12);
  });

  it("does NOT drop a column the error names but the row does not carry", async () => {
    errorQueue = [pgrst204("a_column_we_never_send"), null];
    const result = await insert(draft());

    // Nothing to remove, so it cannot make progress by peeling — it must stop
    // rather than silently degrade to the legacy row.
    expect(result.status).toBe("error");
    expect(inserts).toHaveLength(1);
  });

  it("still surfaces a duplicate discovered on a RETRY, not just the first attempt", async () => {
    errorQueue = [pgrst204("checkout_channel"), { code: "23505", message: "duplicate key value" }];
    const result = await insert(draft());
    expect(result.status).toBe("duplicate");
  });
});
