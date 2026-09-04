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
}));

vi.mock("@/lib/cart-recovery", () => ({
  getAbandonedCartById: async () => state.cart,
  liveRecoveryCouponForCart: async (cartId: string) => { state.lookups.push(cartId); return state.coupon; },
}));

import { GET } from "./route";

const request = (id: string | null) =>
  new NextRequest(`https://www.vantalabsresearch.com/api/cart/restore${id === null ? "" : `?id=${encodeURIComponent(id)}`}`);

beforeEach(() => {
  state.cart = { id: "cart-1", items: [{ slug: "bpc-157-10mg", name: "BPC-157", quantity: 1, unitPrice: 69 }], email: "shopper@example.test", customerName: "Sam", sessionId: "sess-desktop", status: "active" };
  state.coupon = null;
  state.lookups = [];
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
