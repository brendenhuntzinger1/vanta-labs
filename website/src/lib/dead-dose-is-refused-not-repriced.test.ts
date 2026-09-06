import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A CART LINE NAMING A DOSE THAT NO LONGER EXISTS WAS SILENTLY RE-PRICED.
//
// quoteOrder resolves the dose from the `slug::<doseId>` cart id. The
// `?? default` fallback beside it applies only when the cart named NO dose at
// all; a cart that names one which no longer resolves produced
// `selectedDose === undefined`, and everything downstream treated that as the
// default dose:
//
//   price   fell back to baseProduct.price, which for a dosed product IS the
//           default dose's price — a 5mg line charged at the 10mg price under a
//           different SKU.
//   id      passed `slug::<dead dose id>` through into order_items.product_id,
//           which is what parseOrderItemRef splits to decide which row
//           inventory moves on — so the line took NO hold on any real row.
//
// Not an exotic state: getCatalogProducts filters product_doses on is_enabled,
// so an admin disabling a strength in the Control Center removes it from every
// cart already holding it. Those carts live in localStorage, so the shopper
// meets it on their next visit and is refused by the underpayment guard with
// "your total has been updated. Please refresh this page" — which changes
// nothing, because the stale line is still in their storage.
// ---------------------------------------------------------------------------

vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
vi.mock("@/lib/supabase-server", () => {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    is: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  const client = { from: () => chain, rpc: async () => ({ data: null, error: null }) };
  return { createServerClient: () => client, supabaseAdmin: client };
});

const quote = async (id: string) => {
  const { quoteOrder } = await import("@/lib/quote-order");
  return quoteOrder({
    mode: "full",
    items: [{ id, quantity: 1 }],
    customer: {
      email: "dose@example.com",
      fullName: "Alex Morgan",
      address: "88 Meridian Avenue",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "United States",
    },
  });
};

describe("a dose the catalogue no longer offers", () => {
  it("is refused by name rather than priced as the default dose", async () => {
    await expect(quote("bpc-157-10mg::a-dose-that-was-disabled")).rejects.toThrow(
      /no longer available|remove it from your cart/i,
    );
  });

  it("says what to do about it, which 'your total has been updated' did not", async () => {
    await expect(quote("bpc-157-10mg::gone")).rejects.toThrow(/choose another size/i);
  });

  it("still prices a line that names NO dose, using the default", async () => {
    // The `?? default` fallback is for exactly this case and must survive: a
    // cart line added from the catalogue grid carries a bare slug.
    const result = await quote("bpc-157-10mg");
    expect(result.subtotal).toBeGreaterThan(0);
  });

  it("refuses only the line naming a dead dose, never a bare slug", async () => {
    // The guard is keyed on `variantId && !selectedDose`, so a cart id with no
    // `::` suffix can never reach it. Pinned because widening this predicate is
    // the obvious way to break every grid-added cart line in the store.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src/lib/quote-order.ts"), "utf8");
    expect(source).toContain("if (variantId && !selectedDose) {");
  });
});
