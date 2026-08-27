import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { shouldClearPurchasedCart } from "@/lib/cart-purchase-clear";

// ---------------------------------------------------------------------------
// A PURCHASED CART MUST ACTUALLY EMPTY, AND STAY EMPTY.
//
// Reproduced in the browser. One CJC-1295 in the cart, then a full page load of
// /order-confirmation/<id>:
//
//     0.0s  cart = [cjc-1295-2mg:1]
//     0.5s  cart = [cjc-1295-2mg:1]
//     1.0s  cart = [cjc-1295-2mg:1]
//     2.0s  cart = [cjc-1295-2mg:1]     badge: "Open cart with 1 items"
//
// ClearCartOnMount is mounted unconditionally on that page and exists solely to
// fix this. It did not work, and the reason is effect ordering:
//
//   1. ClearCartOnMount is a CHILD of CartProvider, so its effect runs FIRST.
//      It calls clearCart(), emptying React state.
//   2. CartProvider's hydration effect then runs, reads localStorage — which
//      still holds the pre-purchase cart — and calls setItems(stored).
//   3. The persistence effect is gated on `isHydrated`, so the clear in step 1
//      never reached localStorage to begin with.
//
// Net effect: the clear is silently undone a tick after it happens, and the
// shopper is left holding the items they just paid for.
//
// The fix is to wait for hydration and then clear, so the clear lands on top of
// the restore instead of underneath it, and the persistence effect (now
// unblocked) writes the empty cart to storage where a refresh will find it.
// ---------------------------------------------------------------------------

const read = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), "utf8");

describe("when the purchased cart may be cleared", () => {
  it("does NOT clear before hydration — the bug that made the clear a no-op", () => {
    expect(shouldClearPurchasedCart({ isHydrated: false, alreadyCleared: false })).toBe(false);
  });

  it("clears once hydration has finished restoring from storage", () => {
    expect(shouldClearPurchasedCart({ isHydrated: true, alreadyCleared: false })).toBe(true);
  });

  it("clears exactly once, so a cart rebuilt on the confirmation page is not wiped", () => {
    expect(shouldClearPurchasedCart({ isHydrated: true, alreadyCleared: true })).toBe(false);
  });

  it("never clears before hydration even on a repeat render", () => {
    expect(shouldClearPurchasedCart({ isHydrated: false, alreadyCleared: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EFFECT-ORDERING SIMULATION.
//
// There is no DOM in this suite (environment: "node", and adding jsdom +
// testing-library for one component is a dependency change this fix does not
// warrant). So the provider's three moving parts are modelled directly:
// hydration, the isHydrated-gated persistence write, and the clear. The model
// is small enough to read against cart-context.tsx line by line.
// ---------------------------------------------------------------------------
type Store = { items: string[] } | null;

function simulate(order: "clear-before-hydrate" | "clear-after-hydrate") {
  const storage: { value: Store } = { value: { items: ["cjc-1295-2mg"] } };
  let items: string[] = [];
  let isHydrated = false;

  // CartProvider's hydration effect.
  const hydrate = () => {
    if (storage.value && Array.isArray(storage.value.items)) items = [...storage.value.items];
    isHydrated = true;
  };
  // CartProvider's persistence effect — gated on isHydrated, exactly as in
  // cart-context.tsx. This gate is why a pre-hydration clear never persists.
  const persist = () => {
    if (!isHydrated) return;
    storage.value = { items: [...items] };
  };
  const clear = () => {
    items = [];
  };

  if (order === "clear-before-hydrate") {
    clear();
    persist();
    hydrate();
    persist();
  } else {
    hydrate();
    persist();
    clear();
    persist();
  }

  return { items, storage: storage.value };
}

describe("effect-ordering simulation of the provider", () => {
  it("clearing before hydration leaves the purchased items in the cart AND in storage", () => {
    const result = simulate("clear-before-hydrate");

    // This is the reproduced defect, in miniature.
    expect(result.items).toEqual(["cjc-1295-2mg"]);
    expect(result.storage).toEqual({ items: ["cjc-1295-2mg"] });
  });

  it("clearing after hydration empties both, so a refresh stays empty", () => {
    const result = simulate("clear-after-hydrate");

    expect(result.items).toEqual([]);
    // The empty cart reached storage. A refresh (a fresh hydrate) reads this.
    expect(result.storage).toEqual({ items: [] });
  });

  it("a refresh after a post-hydration clear does not resurrect the cart", () => {
    const { storage } = simulate("clear-after-hydrate");
    // Second page load: hydrate from what the first load persisted.
    const restored = storage && Array.isArray(storage.items) ? [...storage.items] : [];

    expect(restored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SOURCE CONTRACT.
//
// Coarse by design, matching the convention in inventory-visibility.test.ts.
// Their job is to fail loudly if a future edit reintroduces the bare-mount
// clear or removes the cross-tab sync that keeps a second tab from resurrecting
// a purchased cart.
// ---------------------------------------------------------------------------
describe("source contract", () => {
  const component = read("src/components/clear-cart-on-mount.tsx");
  const context = read("src/components/cart-context.tsx");

  it("the clear component waits for hydration rather than firing on mount", () => {
    expect(component).toMatch(/isHydrated/);
    expect(component).toMatch(/shouldClearPurchasedCart/);
  });

  it("the clear component does not use a bare mount-once effect any more", () => {
    // `useEffect(() => { clearCart(); }, [])` is precisely the defect.
    expect(component).not.toMatch(/clearCart\(\);\s*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\}, \[\]\)/);
    expect(component).not.toMatch(/\}\s*,\s*\[\]\s*\)/);
  });

  it("the provider still gates persistence on hydration", () => {
    // If this gate were removed the fix would still work, but the reason the
    // ordering matters would silently change. Pin it.
    expect(context).toMatch(/if \(typeof window === "undefined" \|\| !isHydrated\)/);
  });

  it("the provider still syncs the cleared cart across tabs", () => {
    expect(context).toMatch(/addEventListener\("storage", handleStorage\)/);
    expect(context).toMatch(/if \(!event\.newValue\) \{\s*\n\s*setItems\(\[\]\);/);
  });

  it("the provider still exposes isHydrated for the clear to wait on", () => {
    expect(context).toMatch(/isHydrated,/);
  });
});
