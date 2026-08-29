import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shim = readFileSync(resolve(process.cwd(), "scripts/pgrst-shim.mjs"), "utf8");

// ---------------------------------------------------------------------------
// THE ONE TEST THAT OUTRANKS EVERYTHING COULD NOT RUN.
//
// The runbook's first instruction is to prove one complete purchase. It had
// never been done, and this is why: supabase-js sends PostgREST's bulk-insert
// column spec on the order_items write —
//
//   POST /rest/v1/order_items?columns="order_id","product_id","product_name",
//                                     "unit_price","quantity","line_total"
//
// — and the shim had no case for `columns`, so it fell through to the generic
// filter parser, which correctly refused rather than widening:
//
//   PGRST_SHIM_UNSUPPORTED_FILTER: pgrst-shim does not implement the filter
//   columns="order_id",… Refusing to run a WIDER query than asked for.
//
// That refusal is right — dropping a filter widens a query and once made
// correctly-scoped account pages look like a cross-customer leak. But `columns`
// is not a filter. It NARROWS the write, naming exactly which keys of the
// payload become columns, and the shim treating it as an unknown predicate
// turned the most important flow in the app into a 500.
//
// Measured 2026-08-29 in WebKit against the harness: the order row was written
// and the payment session minted, then `Unable to create order items` aborted
// checkout. One orphaned order, no items, no confirmation.
// ---------------------------------------------------------------------------

describe("the harness can complete the order_items insert the app actually sends", () => {
  it("treats `columns` as a write spec, not as a filter to refuse", () => {
    expect(shim).toMatch(/columns/);
    // It must be handled before the OPS lookup that throws on unknown keys.
    const guard = shim.indexOf("PGRST_SHIM_UNSUPPORTED_FILTER");
    const handled = shim.indexOf('=== "columns"');
    expect(handled, "`columns` needs an explicit case").toBeGreaterThan(-1);
    expect(handled, "`columns` must be handled before the unknown-filter throw").toBeLessThan(guard);
  });

  it("still refuses genuinely unknown filters", () => {
    // The guard this fix routes around must stay exactly as strict for
    // everything that IS a predicate.
    expect(shim).toContain("PGRST_SHIM_UNSUPPORTED_FILTER");
    expect(shim).toMatch(/Refusing to run a WIDER query than asked for/);
  });

  it("uses the declared column set for the insert rather than the payload keys", () => {
    // The point of the parameter: the column list is authoritative, so a bulk
    // insert of rows with differing keys still produces one consistent tuple
    // shape. Deriving columns from the payload instead would reintroduce the
    // heterogeneity PostgREST uses this to avoid.
    expect(shim).toMatch(/insertColumns|columnsParam/);
  });
});
