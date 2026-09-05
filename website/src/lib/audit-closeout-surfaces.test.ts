import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// SOURCE-LEVEL PINS FOR THE CLOSEOUT ROUND (2026-09-05).
//
// Each block names the audit finding it closes and asserts the exact shape of
// the fix in the file, in the same style as audit-round2-surfaces.test.ts.
// Behaviour that a unit test can hold is held elsewhere (see the file each
// block names); these pin the wiring a refactor could quietly undo.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("ADM-09 — cancelling a single order needs the manager role, like bulk cancel", () => {
  it("the order route refuses a cancel from a role without refund rights", () => {
    const route = read("app/api/admin/orders/[orderId]/route.ts");
    const branch = route.slice(route.indexOf('if (action === "cancel") {'));
    const gate = branch.indexOf("if (!canManageRefunds(session.role))");
    expect(gate).toBeGreaterThan(0);
    // The gate precedes the transition/pipeline work of the same branch.
    expect(gate).toBeLessThan(branch.indexOf("await setOrderFulfillmentStatus("));
    expect(branch.slice(gate, gate + 400)).toContain("status: 403");
  });
  it("the actions panel hides the Cancel button for that role", () => {
    const component = read("components/admin-order-actions.tsx");
    expect(component).toMatch(/\{canRefund \? \(\s*<button[^>]*onClick=\{\(\) => runAction\("cancel"/);
  });
});

describe("ADM-13 — a failed inventory re-read never replaces the table with an empty one", () => {
  it("the operations route answers rows: null on a failed re-read, never []", () => {
    const route = read("app/api/admin/inventory/operations/route.ts");
    expect(route).not.toContain("getInventoryRows().catch(() => [])");
    expect(route.split("getInventoryRows().catch(() => null)").length - 1).toBe(4);
  });
  it("the client only replaces its rows with a real list", () => {
    const client = read("components/admin-inventory-client.tsx");
    expect(client).toContain("if (json.rows) setRows(json.rows);");
    expect(client).toContain("if (next) setRows(next);");
  });
});

describe("CART-03 — the drawer says its total is not yet the card total", () => {
  it("names the card processing fee beside the drawer total", () => {
    const drawer = read("components/cart-drawer.tsx");
    expect(drawer).toContain("Card payments carry a small processing fee, shown at checkout.");
  });
});

describe("CART-05 — a code that displaces the other kind says so", () => {
  const context = read("components/cart-context.tsx");
  it("applying a referral names the promo code it removed", () => {
    expect(context).toContain("Promo code ${displacedCoupon} was removed — promo codes can't be combined with a referral code.");
  });
  it("applying a coupon (typed or restored) names the referral code it removed", () => {
    expect(context.split("Referral code ${displacedReferral} was removed — it can't be combined with a promo code.").length - 1).toBe(2);
  });
});

describe("CART-07 — an unknown referral code is not called 'not active'", () => {
  it("the validate route distinguishes unknown from inactive", () => {
    const route = read("app/api/catalog/referral/validate/route.ts");
    expect(route).toContain('reason: anyRow ? "inactive" : "unknown"');
  });
  it("the cart words the two refusals differently", () => {
    const context = read("components/cart-context.tsx");
    expect(context).toContain("We don't recognize that referral code. Check the spelling — promo codes are applied at checkout.");
    expect(context).toContain("That referral code is not active. Promo codes are applied at checkout.");
  });
});

describe("EMAIL-M-09 — the admin 'resend last note' reuses the cart's live code", () => {
  it("refuses a suppressed address before minting, and looks for a live code before minting a new one", () => {
    const whole = read("lib/admin-cart-recovery.ts");
    const code = whole.slice(whole.indexOf("export async function resendCartRecoveryEmail"));
    const suppressedAt = code.indexOf("await isMarketingSuppressed(cart.email)");
    const claimAt = code.indexOf("claimMarketingSend({");
    const liveAt = code.indexOf("findLiveCouponForCart(cart.id)");
    const mintAt = code.indexOf("mintCartRecoveryCoupon(");
    expect(suppressedAt).toBeGreaterThan(0);
    expect(suppressedAt).toBeLessThan(claimAt);
    expect(liveAt).toBeGreaterThan(claimAt);
    expect(liveAt).toBeLessThan(mintAt);
  });
});

describe("CQ-02 — no bare customer address in the marketing suppression log line", () => {
  it("redacts the address", () => {
    const marketing = read("lib/email/marketing.ts");
    expect(marketing).toContain('refusing to send", redactEmailForLog(email), suppressionError');
  });
});

describe("PRICE-06 — the quote reports gift lines by their flag", () => {
  it("filters on line.gift, not on id membership", () => {
    const route = read("app/api/checkout/quote/route.ts");
    expect(route).toContain(".filter((line) => line.gift === true)");
    expect(route).not.toContain("!requested.has(line.product.id)");
  });
});

describe("ADM-12 — admin mutations survive a network failure with a message, not a frozen button", () => {
  it("every products-page mutation goes through the guarded request helper", () => {
    const page = read("app/admin/products/page.tsx");
    expect(page).toContain("const requestJson = async <T,>(");
    expect(page.split("await requestJson<").length - 1).toBeGreaterThanOrEqual(6);
    // The two mutations that keep their own fetch (CSV import, image upload)
    // sit inside a try/catch of their own.
    expect(page).not.toMatch(/\n    const res = await fetch\([^)]*\{\s*method: "(PATCH|POST|DELETE)"/);
  });
  it("the order actions panel catches a thrown fetch and releases the busy flag", () => {
    const panel = read("components/admin-order-actions.tsx");
    const at = panel.indexOf("const runAction = async");
    const body = panel.slice(at, panel.indexOf("const handleRefund", at));
    expect(body).toContain("} catch {");
    expect(body).toContain("Network error — the change may not have been saved.");
    expect(body.slice(body.indexOf("} catch {"))).toContain("setSaving(false);");
  });
});
