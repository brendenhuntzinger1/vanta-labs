import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE OWNER CONTROL, NOT JUST THE COLUMN.
//
// The discount column and the checkout resolver already exist. What these guard
// is the only path an owner actually touches: editing one ambassador's rates in
// the admin. Three ways that path can betray the requirement --
//
//   1. Saving a discount also writes the commission (or vice versa). The rates
//      would appear independent and behave otherwise.
//   2. Clearing the field saves 0% instead of clearing the override. The code
//      keeps working and quietly stops discounting.
//   3. A fat-fingered 100 (or 500) is accepted, and a referred order totals $0.
// ---------------------------------------------------------------------------

const route = readFileSync(join(process.cwd(), "src/app/api/admin/partners/[partnerId]/route.ts"), "utf8");
const portal = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");
const card = readFileSync(join(process.cwd(), "src/components/admin-ambassador-rates-card.tsx"), "utf8");

describe("the admin can set the two rates independently", () => {
  // The structural guarantee: the discount is written in its own branch, so no
  // commission edit can reach it and no discount edit can reach the commission.
  it("writes the discount outside the commission branch", () => {
    const discountWrite = portal.indexOf("updatePayload.customer_discount_percent");
    const commissionBranch = portal.indexOf("updatePayload.commission_percent_locked = input.commissionPercentLocked;");

    expect(discountWrite).toBeGreaterThan(-1);
    expect(discountWrite).toBeGreaterThan(commissionBranch);
    // Setting a discount must not opt the ambassador out of automatic tiers --
    // that is a commission-side consequence of a discount-side edit.
    const block = portal.slice(discountWrite - 200, discountWrite + 200);
    expect(block).not.toContain("commission_percent_locked");
  });

  // Each rate has its own request, so a save cannot carry the other value along
  // as a stale copy of whatever was on screen.
  it("gives each rate its own save action in the UI", () => {
    expect(card).toContain('save("discount", { customerDiscountPercent');
    expect(card).toContain('save("commission", { commissionPercent: Number(commission) })');
  });
});

describe("clearing the field means inherit, not zero", () => {
  it("maps an emptied field to null rather than 0", () => {
    expect(route).toContain('body?.customerDiscountPercent === null || body?.customerDiscountPercent === ""');
    expect(route).toContain("customerDiscountPercent = null;");
  });

  // undefined is the third state: a request that never mentions the discount --
  // for instance approving an application -- must leave it exactly as it was.
  it("leaves the discount untouched when the request omits it", () => {
    expect(portal).toContain("if (input.customerDiscountPercent !== undefined) {");
  });

  it("persists a null so postgres stores an inheriting ambassador", () => {
    expect(portal).toContain("updatePayload.customer_discount_percent = input.customerDiscountPercent;");
  });
});

describe("an impossible discount is refused", () => {
  // 100 is excluded here but allowed for commission, and the asymmetry is the
  // point: a 100% commission is merely generous, a 100% discount is a free order.
  it("rejects 100 and above, and anything negative", () => {
    expect(route).toContain("customerDiscountPercent >= 100");
    expect(route).toContain("customerDiscountPercent < 0");
  });

  it("states the bound in the error the admin reads", () => {
    expect(route).toContain("Customer discount must be 0 or more and less than 100.");
  });

  it("still allows a deliberate 0", () => {
    // The guard fires on `< 0`, not on falsiness, so 0 passes through.
    expect(route).not.toContain("!customerDiscountPercent");
  });
});
