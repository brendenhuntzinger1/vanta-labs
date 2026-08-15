import { describe, expect, it } from "vitest";
import { buildOrderOwnershipFilter, normalizeOwnershipEmail } from "@/lib/order-ownership";

// ---------------------------------------------------------------------------
// "Is this order mine?" — the question a customer's account page asks.
//
// The previous implementation asked it with ILIKE against an allow-list-
// sanitised address, which got it wrong in both directions at once:
//
//   TOO PERMISSIVE: `_` survived the allow-list and reached SQL as a
//   single-character wildcard, so a customer with an underscore in their
//   address was shown orders belonging to anyone whose address differed by one
//   character. Another person's order history, totals and tracking.
//
//   TOO STRICT: `+` was stripped, so `name+shop@gmail.com` became
//   `nameshop@gmail.com` and matched nothing — that customer's own orders
//   disappeared from their account.
//
// Both are pinned below, on values, because both were invisible to any test
// that only looked at the shape of the code.
// ---------------------------------------------------------------------------

const USER = "11111111-2222-3333-4444-555555555555";

describe("normalizeOwnershipEmail", () => {
  it("lowercases and trims without altering the address", () => {
    expect(normalizeOwnershipEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
  });

  it("preserves + — plus-addressing is a real address, not a typo", () => {
    expect(normalizeOwnershipEmail("name+shop@gmail.com")).toBe("name+shop@gmail.com");
  });

  it("preserves _ rather than deleting it", () => {
    expect(normalizeOwnershipEmail("john_doe@example.com")).toBe("john_doe@example.com");
  });

  it("refuses anything that could break out of the filter clause", () => {
    for (const bad of ['a,b@x.com', 'a(b)@x.com', 'a"b@x.com', "a\\b@x.com", "a b@x.com", "no-at-sign", "a@b", ""]) {
      expect(normalizeOwnershipEmail(bad), bad).toBeNull();
    }
  });

  it("refuses an absurdly long address", () => {
    expect(normalizeOwnershipEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("buildOrderOwnershipFilter", () => {
  it("matches the email exactly — no LIKE operator anywhere", () => {
    const filter = buildOrderOwnershipFilter(USER, "john@example.com");
    expect(filter).toContain("customer_email.eq.");
    expect(filter).not.toContain("ilike");
    expect(filter).not.toContain("like");
  });

  it("an underscore is a literal character, not a wildcard", () => {
    // The regression: with `ilike`, this clause matched johnXdoe@example.com
    // for every X. With `eq` it matches exactly one address.
    const filter = buildOrderOwnershipFilter(USER, "john_doe@example.com");
    expect(filter).toContain('customer_email.eq."john_doe@example.com"');
    expect(filter).not.toContain("ilike");
  });

  it("keeps plus-addressing intact so the customer sees their own orders", () => {
    expect(buildOrderOwnershipFilter(USER, "name+shop@gmail.com"))
      .toContain('customer_email.eq."name+shop@gmail.com"');
  });

  it("always matches on the account id", () => {
    expect(buildOrderOwnershipFilter(USER, null)).toBe(`customer_user_id.eq.${USER}`);
    expect(buildOrderOwnershipFilter(USER, "john@example.com")).toContain(`customer_user_id.eq.${USER}`);
  });

  it("falls back to the account id alone when the email is unusable", () => {
    // Refusing to match is the safe direction: fewer of your own orders, never
    // somebody else's.
    expect(buildOrderOwnershipFilter(USER, 'evil",customer_email.neq.x@x.com'))
      .toBe(`customer_user_id.eq.${USER}`);
  });

  it("strips anything non-uuid from the account id", () => {
    expect(buildOrderOwnershipFilter("abc,customer_email.neq.zzz", null))
      .toBe("customer_user_id.eq.abccustomeremailneqzzz");
  });
});
