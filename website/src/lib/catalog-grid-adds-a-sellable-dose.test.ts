import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE GRID MUST ADD THE DOSE THE CARD WAS TALKING ABOUT.
//
// catalog.ts:290 reports a product as In Stock when ANY enabled dose is
// sellable. That rule exists for a good reason — a product whose default dose
// sold out while another strength still had units should not vanish from the
// catalogue or from Google — and 31 of the 36 live products are dose-stocked,
// so it is the normal shape rather than an edge case.
//
// addToCart from the grid then resolved the dose with:
//
//     product.doses?.find(d => d.isDefault) ?? product.doses?.[0]
//
// which ignores stock entirely. So the card said In Stock, offered Add to Cart,
// and added the SOLD-OUT default. The shopper was refused at checkout — after
// the entire address form, the worst possible place — by a message naming the
// whole product as sold out when only one strength was.
//
// The two rules now agree: prefer the default when it is sellable, otherwise
// the first enabled dose that is. "Limited" is buyable and counts; "Reserved"
// and "Out of Stock" do not. When nothing is sellable the default is still
// chosen deliberately, so the refusal comes from the one place that owns it
// rather than from a quietly different cart line here.
//
// This exercises the resolution rule itself rather than the React provider: the
// rule is the thing that was wrong, and it is pure.
// ---------------------------------------------------------------------------

type TestDose = { id: string; isDefault?: boolean; isEnabled?: boolean; stockStatus?: string };

/** The rule as it now stands in cart-context.tsx's addToCart. */
const sellable = (dose: TestDose) =>
  dose.isEnabled !== false && (dose.stockStatus === "In Stock" || dose.stockStatus === "Limited");

function resolveGridDose(doses: TestDose[]): TestDose | undefined {
  const defaultDose = doses.find((dose) => dose.isDefault) ?? doses[0];
  return defaultDose && sellable(defaultDose) ? defaultDose : doses.find(sellable) ?? defaultDose;
}

describe("which dose a catalogue-grid Add to Cart resolves", () => {
  it("keeps the default dose when it is sellable", () => {
    const doses: TestDose[] = [
      { id: "5mg", isDefault: true, stockStatus: "In Stock" },
      { id: "10mg", stockStatus: "In Stock" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("5mg");
  });

  it("skips a sold-out default for the strength that is actually sellable", () => {
    // The exact shape that made the card say In Stock in the first place.
    const doses: TestDose[] = [
      { id: "5mg", isDefault: true, stockStatus: "Out of Stock" },
      { id: "10mg", stockStatus: "In Stock" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("10mg");
  });

  it("treats a fully reserved default as not sellable", () => {
    // Every unit held by in-flight checkouts. Buyable later, not now.
    const doses: TestDose[] = [
      { id: "5mg", isDefault: true, stockStatus: "Reserved" },
      { id: "10mg", stockStatus: "In Stock" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("10mg");
  });

  it("counts Limited as buyable", () => {
    const doses: TestDose[] = [
      { id: "5mg", isDefault: true, stockStatus: "Out of Stock" },
      { id: "10mg", stockStatus: "Limited" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("10mg");
  });

  it("never picks a disabled dose, however well stocked", () => {
    const doses: TestDose[] = [
      { id: "5mg", isDefault: true, stockStatus: "Out of Stock" },
      { id: "hidden", isEnabled: false, stockStatus: "In Stock" },
      { id: "10mg", stockStatus: "In Stock" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("10mg");
  });

  it("falls back to the default when nothing is sellable, so one place owns the refusal", () => {
    const doses: TestDose[] = [
      { id: "5mg", isDefault: true, stockStatus: "Out of Stock" },
      { id: "10mg", stockStatus: "Out of Stock" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("5mg");
  });

  it("uses the first dose when none is flagged default", () => {
    const doses: TestDose[] = [
      { id: "5mg", stockStatus: "In Stock" },
      { id: "10mg", stockStatus: "In Stock" },
    ];
    expect(resolveGridDose(doses)?.id).toBe("5mg");
  });

  it("survives a product with no doses at all", () => {
    expect(resolveGridDose([])).toBeUndefined();
  });
});

describe("the shipped rule matches the one asserted above", () => {
  it("resolves the sellable dose rather than the default unconditionally", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/components/cart-context.tsx"), "utf8");

    // The line that shipped the bug.
    expect(source).not.toContain(
      "? product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0]\n      : undefined;",
    );
    expect(source).toContain('dose.stockStatus === "In Stock" || dose.stockStatus === "Limited"');
    expect(source).toContain("product.doses?.find(sellable) ?? defaultDose");
  });
});
