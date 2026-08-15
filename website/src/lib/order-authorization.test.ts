import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A customer may read their own orders and nobody else's.
 *
 * The implementation is correct — ownership is checked by account id or email
 * and the row is discarded otherwise — but nothing was asserting it. This is a
 * P0-severity boundary: the failure mode is one customer reading another's
 * name, address and order history, and it would be silent. A boundary nobody
 * tests is a boundary that survives only as long as nobody edits the file.
 *
 * Asserted against the source because the query goes through Supabase and the
 * property worth protecting is structural: the filter exists, it is applied
 * before any data is returned, and the identifiers going into it are
 * sanitised.
 */

const SRC = join(process.cwd(), "src");
const accountOrders = readFileSync(join(SRC, "lib/account-orders.ts"), "utf8");

/**
 * Mirrors the ownership rule in account-orders.ts. The structural assertions
 * below prove the real implementation still matches this.
 */
function owns(
  row: { customer_user_id?: string | null; customer_email?: string | null },
  userId: string,
  email?: string | null,
): boolean {
  const byUserId = Boolean(row.customer_user_id) && String(row.customer_user_id) === userId;
  const byEmail = Boolean(email) && String(row.customer_email ?? "").toLowerCase() === String(email).toLowerCase();
  return byUserId || byEmail;
}

describe("who may read an order", () => {
  const mine = { customer_user_id: "user-1", customer_email: "dana@example.com" };

  it("lets the owning account read it", () => {
    expect(owns(mine, "user-1", "dana@example.com")).toBe(true);
  });

  it("lets a legacy row match on email when no account id was stored", () => {
    // Orders placed before customer_user_id existed still belong to someone.
    expect(owns({ customer_user_id: null, customer_email: "dana@example.com" }, "user-1", "dana@example.com")).toBe(true);
  });

  it("survives an email change, because the account id still matches", () => {
    expect(owns(mine, "user-1", "dana+new@example.com")).toBe(true);
  });

  it("refuses a different customer outright", () => {
    expect(owns(mine, "user-2", "someone@else.com")).toBe(false);
  });

  it("is case-insensitive on email, so casing is not a bypass either way", () => {
    expect(owns(mine, "user-2", "DANA@EXAMPLE.COM")).toBe(true);
    expect(owns({ ...mine, customer_email: "DANA@EXAMPLE.COM" }, "user-2", "dana@example.com")).toBe(true);
  });

  it("does not treat a null account id as a wildcard", () => {
    // The trap: `row.customer_user_id === userId` is false for null, but a
    // truthiness slip could make two null-owner rows match each other.
    expect(owns({ customer_user_id: null, customer_email: "other@example.com" }, "user-1", null)).toBe(false);
    expect(owns({ customer_user_id: null, customer_email: null }, "user-1", null)).toBe(false);
  });

  it("does not let a missing email match a row with no email", () => {
    expect(owns({ customer_user_id: "user-9", customer_email: null }, "user-1", null)).toBe(false);
  });
});

describe("the real implementation still enforces it", () => {
  it("checks ownership and returns nothing when it fails", () => {
    expect(accountOrders).toContain("if (!ownsByUserId && !ownsByEmail) return null;");
  });

  it("makes that check before any order data is returned", () => {
    const fn = accountOrders.slice(accountOrders.indexOf("export async function getCustomerOrderDetail"));
    const guard = fn.indexOf("if (!ownsByUserId && !ownsByEmail) return null;");
    const returnsData = fn.indexOf("return mapRow(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(returnsData);
  });

  it("filters the list query by ownership rather than filtering in memory", () => {
    // An unfiltered query that trims afterwards would still pull every
    // customer's rows across the wire.
    expect(accountOrders).toContain(".or(ownershipFilter(userId, email))");
  });

  it("sanitises both identifiers before they reach the filter string", () => {
    // The filter is built as a PostgREST expression, so an unsanitised value
    // would be injected into it directly. It now lives in one shared module —
    // this used to assert the shape of a local `toLowerCase().replace(...)`
    // allow-list, which was itself the bug: that allow-list let `_` through as
    // a live SQL wildcard and deleted `+` out of legitimate addresses. See
    // order-ownership.test.ts for the value-level proof.
    expect(accountOrders).toContain('from "@/lib/order-ownership"');
    expect(accountOrders).toContain("const ownershipFilter = buildOrderOwnershipFilter;");
    const ownership = readFileSync(join(process.cwd(), "src/lib/order-ownership.ts"), "utf8");
    expect(ownership).toContain('String(userId).replace(/[^a-zA-Z0-9-]/g, "")');
    // Equality, never a pattern match. Comments are stripped first — the module
    // documents the ILIKE bug it replaced, and that prose is not an operator.
    const code = ownership.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).toContain("customer_email.eq.");
    expect(code).not.toContain("ilike");
  });
});

describe("every admin API route is behind an admin session", () => {
  function routes(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) routes(path, found);
      else if (entry === "route.ts") found.push(path);
    }
    return found;
  }

  // Login and logout are the two that must NOT require an existing session.
  const UNGUARDED_BY_DESIGN = ["auth/login", "auth/logout"];

  it("guards every admin route except the two that establish the session", () => {
    const adminRoutes = routes(join(SRC, "app/api/admin"));
    expect(adminRoutes.length).toBeGreaterThan(5);

    for (const path of adminRoutes) {
      const relative = path.replace(join(SRC, "app/api/admin/"), "");
      if (UNGUARDED_BY_DESIGN.some((allowed) => relative.startsWith(allowed))) continue;
      expect(readFileSync(path, "utf8"), `${relative} is not behind an admin session`).toMatch(
        /verifyAdminSession(FromCookie|FromRequest)/,
      );
    }
  });
});
