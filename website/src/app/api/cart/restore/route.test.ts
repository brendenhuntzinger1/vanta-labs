import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// THE RESTORE LINK ARMS THE CODE THE EMAIL PROMISED.
//
// The last recovery email carries a single-use SAVE- code bound to the
// shopper's address, and its button restores the cart — but nothing applied
// the code, so the shopper had to retype it from the email. The restore
// endpoint now looks the cart's own live code up SERVER-SIDE (never a code
// from the URL), returns it only while it is live and assigned to this cart's
// address, and the page applies it. Checkout validates it again with the
// address the shopper enters, so the code stays as safe as it was: one use,
// one address.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  cart: null as null | { id: string; items: Array<Record<string, unknown>>; email: string; customerName: string | null; sessionId?: string | null; status?: string },
  coupon: null as null | { code: string; discountType: "percent" | "fixed"; discountValue: number; expiresAt: string; email: string },
  lookups: [] as string[],
  restored: [] as string[],
  /** The live catalogue this restore reconciles against. */
  catalogue: [] as Array<Record<string, unknown>>,
  /** Set to make the catalogue read fail, to exercise the fall-open path. */
  catalogueThrows: false,
  catalogueAsked: [] as string[],
}));

vi.mock("@/lib/cart-recovery", () => ({
  getAbandonedCartById: async () => state.cart,
  liveRecoveryCouponForCart: async (cartId: string) => { state.lookups.push(cartId); return state.coupon; },
  markCartRestored: async (cartId: string) => { state.restored.push(cartId); },
}));

// THIS MOCK IS LOAD-BEARING, AND ITS ABSENCE MADE EVERY TEST BELOW PASS FOR THE
// WRONG REASON. The route reconciles the stored snapshot against the catalogue
// now; unmocked, that read reached supabaseAdmin, threw, and landed in the
// route's deliberate fall-open path — so the suite proved the fallback worked
// and never once exercised the reconciliation it was meant to cover.
vi.mock("@/lib/catalog", () => ({
  getCatalogProductsBySlugs: async (slugs: string[]) => {
    state.catalogueAsked = [...slugs];
    if (state.catalogueThrows) throw new Error("catalogue unavailable");
    return state.catalogue.filter((product) => slugs.includes(String(product.slug)));
  },
}));

import { GET } from "./route";

const request = (id: string | null) =>
  new NextRequest(`https://www.vantalabsresearch.com/api/cart/restore${id === null ? "" : `?id=${encodeURIComponent(id)}`}`);

beforeEach(() => {
  state.cart = { id: "cart-1", items: [{ slug: "bpc-157-10mg", name: "BPC-157", quantity: 1, unitPrice: 69 }], email: "shopper@example.test", customerName: "Sam", sessionId: "sess-desktop", status: "active" };
  state.coupon = null;
  state.lookups = [];
  state.catalogue = [
    { slug: "bpc-157-10mg", name: "BPC-157", price: "$69.00", image: "/images/bpc.jpg", doses: [] },
    { slug: "bac-water", name: "BAC Water (0.9% Benzyl Alcohol)", price: "$14.99", image: "/images/bac.jpg", doses: [] },
  ];
  state.catalogueThrows = false;
  state.catalogueAsked = [];
  state.restored = [];
});

describe("GET /api/cart/restore", () => {
  it("returns the items and, when the cart holds a live recovery code, the code and the address it is bound to", async () => {
    state.coupon = { code: "SAVE-ABCDEF1234", discountType: "percent", discountValue: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "bound@example.test" };
    const response = await GET(request("cart-1"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.coupon).toEqual({ code: "SAVE-ABCDEF1234", discountType: "percent", discountValue: 5 });
    // The address the CODE is bound to — not the row's current address, which
    // the tracking beacon may since have overwritten.
    expect(body.email).toBe("bound@example.test");
    expect(state.lookups).toEqual(["cart-1"]);
  });

  it("returns no coupon when the cart has none live — the earlier reminders carry no code", async () => {
    const response = await GET(request("cart-1"));
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.coupon).toBeUndefined();
  });

  it("hands over the address only alongside a code: a link with no code discloses nothing new", async () => {
    const response = await GET(request("cart-1"));
    const body = await response.json();
    expect(body.email).toBeUndefined();
  });

  it("returns the cart's session id, so a restore on another device continues THIS cart rather than starting a second one", async () => {
    const response = await GET(request("cart-1"));
    const body = await response.json();
    expect(body.sessionId).toBe("sess-desktop");
  });

  it("does not arm a code for a cart that is no longer active", async () => {
    state.cart = { ...state.cart!, status: "recovered" };
    state.coupon = { code: "SAVE-ABCDEF1234", discountType: "percent", discountValue: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "shopper@example.test" };
    const response = await GET(request("cart-1"));
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.coupon).toBeUndefined();
    expect(state.lookups).toEqual([]);
  });

  it("looks the code up by the cart id only: a code in the URL is ignored", async () => {
    state.coupon = { code: "SAVE-REAL000000", discountType: "percent", discountValue: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), email: "shopper@example.test" };
    const response = await GET(new NextRequest("https://www.vantalabsresearch.com/api/cart/restore?id=cart-1&coupon=SAVE-FORGED0000"));
    const body = await response.json();
    expect(body.coupon.code).toBe("SAVE-REAL000000");
  });

  it("still refuses an unknown or empty cart", async () => {
    state.cart = null;
    expect((await GET(request("nope"))).status).toBe(404);
    expect((await GET(request(null))).status).toBe(400);
  });
});

const source = (rel: string) =>
  readFileSync(path.resolve(__dirname, "../../../../", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the restore page applies what the endpoint armed", () => {
  it("the page hands the code and address to the cart before navigating", () => {
    const page = source("app/cart/restore/page.tsx");
    expect(page).toContain("restoreCoupon(");
    expect(page.indexOf("restoreCoupon(")).toBeLessThan(page.indexOf('router.push("/cart")'));
  });

  it("the cart context exposes restoreCoupon, which primes the address the code is bound to", () => {
    const context = source("components/cart-context.tsx");
    expect(context).toContain("restoreCoupon");
    expect(context).toContain("setKnownEmail(");
  });

  it("the cart context arms a restored code only once it knows who is signed in and which promotion is live", () => {
    const context = source("components/cart-context.tsx");
    // Parked, then applied by an effect that can see the account and the
    // promotion: a code bound to another address, or one a non-stacking
    // promotion would refuse, is reported rather than armed.
    expect(context).toContain("pendingRestoredCoupon");
    expect(context).toContain("accountChecked");
  });

  it("the page continues the cart's own session so the tracker does not open a second cart", () => {
    const page = source("app/cart/restore/page.tsx");
    expect(page).toMatch(/restoreItems\(result\.items, \{ sessionId: result\.sessionId/);
    const context = source("components/cart-context.tsx");
    const at = context.indexOf("const restoreItems =");
    expect(context.slice(at, at + 1500)).toContain("setCartSessionId(");
  });

  it("the checkout always lets the shopper remove a code, promotion or not", () => {
    const checkout = source("app/checkout/page.tsx");
    expect(checkout).not.toContain("couponCode && (!isBuy3Get1FreeActive || activePromotionAllowsCoupon) ?");
    expect(checkout).toMatch(/\{couponCode \? \([\s\S]{0,400}Remove code/);
  });
});

// ---------------------------------------------------------------------------
// THE RESTORE NEVER HANDS BACK A CART CHECKOUT WOULD REFUSE.
//
// quoteOrder throws `Invalid product id: <slug>` for a line whose slug has no
// products row, and that throw fails the WHOLE quote. /api/cart/validate does
// not save the shopper either — it checks inventory, not existence, and states
// that an unknown line is "a lookup gap, not a sold-out product".
//
// So the recovery email, whose entire job is to put a shopper back in their
// cart, delivered two live shoppers into a checkout that refused them: Eli
// ($59.98) and Eloa Rossetti ($227.46) both held `bacteriostatic-water`, which
// stopped being a products row when production moved to `bac-water`. Both carts
// had been repaired by hand the day before and BOTH REVERTED, because a row
// repair lasts only until the browser writes the stale slug again.
// ---------------------------------------------------------------------------

describe("reconciling the stored snapshot against the live catalogue", () => {
  it("follows the BAC Water rename instead of restoring a slug that cannot be bought", async () => {
    state.cart = { id: "cart-eli", items: [
      { slug: "bpc-157-10mg", name: "BPC-157", quantity: 1, unitPrice: 69 },
      { slug: "bacteriostatic-water", name: "Bacteriostatic Water", quantity: 1, unitPrice: 14.99 },
    ], email: "eli@example.test", customerName: "Eli", sessionId: "s", status: "active" };

    const body = await (await GET(request("cart-eli"))).json();
    expect(body.success).toBe(true);
    expect(body.items.map((line: { slug: string }) => line.slug)).toEqual(["bpc-157-10mg", "bac-water"]);
    // Nothing was lost, so the shopper is not told anything happened.
    expect(body.notice).toBeUndefined();
  });

  it("asks the catalogue about the rename candidates, not only the stored slug", async () => {
    state.cart = { id: "c", items: [{ slug: "bacteriostatic-water", name: "x", quantity: 1, unitPrice: 1 }], email: "e@e.test", customerName: null, status: "active" };
    await GET(request("c"));
    expect(state.catalogueAsked).toContain("bacteriostatic-water");
    expect(state.catalogueAsked).toContain("bac-water");
  });

  it("drops a line whose product is gone and says which one, keeping the rest buyable", async () => {
    state.cart = { id: "c", items: [
      { slug: "bpc-157-10mg", name: "BPC-157", quantity: 1, unitPrice: 69 },
      { slug: "discontinued-thing", name: "Discontinued Thing", quantity: 1, unitPrice: 40 },
    ], email: "e@e.test", customerName: null, status: "active" };

    const body = await (await GET(request("c"))).json();
    expect(body.success).toBe(true);
    expect(body.items.map((line: { slug: string }) => line.slug)).toEqual(["bpc-157-10mg"]);
    expect(body.notice).toContain("Discontinued Thing");
  });

  it("reprices a line from the catalogue rather than trusting the stored snapshot", async () => {
    state.cart = { id: "c", items: [{ slug: "bpc-157-10mg", name: "BPC-157", quantity: 1, unitPrice: 12 }], email: "e@e.test", customerName: null, status: "active" };
    const body = await (await GET(request("c"))).json();
    expect(body.items[0].unitPrice).toBe(69);
  });

  // An empty cart under a "we kept your cart" email reads as the store having
  // lost the order, so it is an explicit refusal with a reason rather than a
  // silent success carrying nothing.
  it("refuses with an explanation when every line is gone", async () => {
    state.cart = { id: "c", items: [{ slug: "all-gone", name: "All Gone", quantity: 1, unitPrice: 5 }], email: "e@e.test", customerName: null, status: "active" };
    const response = await GET(request("c"));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("All Gone");
  });

  // FALLS OPEN, DELIBERATELY. A cart that might not check out beats no cart at
  // all: the shopper can still remove the line by hand, and refusing the
  // restore over a transient catalogue read would lose the sale outright.
  it("restores the stored snapshot untouched when the catalogue cannot be read", async () => {
    state.catalogueThrows = true;
    state.cart = { id: "c", items: [{ slug: "bacteriostatic-water", name: "Bacteriostatic Water", quantity: 1, unitPrice: 14.99 }], email: "e@e.test", customerName: null, status: "active" };
    const body = await (await GET(request("c"))).json();
    expect(body.success).toBe(true);
    expect(body.items[0].slug).toBe("bacteriostatic-water");
  });
});

// ---------------------------------------------------------------------------
// THE MIDDLE OF THE FUNNEL.
//
// The programme could see a click and it could see an order, and nothing in
// between — so "the click produced a cart the shopper could actually buy" was
// an assumption, and it was a false one for every cart holding a dead slug.
// ---------------------------------------------------------------------------

describe("recording that a recovery link worked", () => {
  it("stamps the cart when a buyable cart is handed back", async () => {
    await GET(request("cart-1"));
    expect(state.restored).toEqual(["cart-1"]);
  });

  // Otherwise the restore count would say the link worked on exactly the carts
  // where it did not, which is worse than not counting at all.
  it("does not stamp one when every line is gone", async () => {
    state.cart = { id: "c", items: [{ slug: "all-gone", name: "All Gone", quantity: 1, unitPrice: 5 }], email: "e@e.test", customerName: null, status: "active" };
    expect((await GET(request("c"))).status).toBe(410);
    expect(state.restored).toEqual([]);
  });

  it("does not stamp one for a cart link that resolves to nothing", async () => {
    state.cart = null;
    await GET(request("missing"));
    expect(state.restored).toEqual([]);
  });
});
