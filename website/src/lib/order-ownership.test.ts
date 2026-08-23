import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOrderOwnershipFilter, normalizeOwnershipEmail, ownershipEmail } from "@/lib/order-ownership";

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

// ---------------------------------------------------------------------------
// CLAIMING A GUEST ORDER BY NAMING ITS EMAIL ADDRESS.
//
// A guest checkout stores the buyer's address on the order and nothing else.
// The email arm of the ownership filter is what lets that buyer see the order
// after they later create an account — and it is, stated plainly, the rule
// "whoever signs up as this address owns these orders". Guest orders carry the
// buyer's name, full shipping address, phone, items, totals and live tracking.
//
// That rule was resting on a Supabase project setting. /api/auth/session
// establishes a session for any token Supabase issues; it reads
// email_confirmed_at only to decide whether to award signup points. With the
// project's "confirm email" toggle off — the default for a new project — an
// attacker signs up as someone else's address and is handed their order
// history. Nothing in this repository checked, and nothing here would have
// noticed the toggle being flipped.
//
// ownershipEmail() moves the precondition into the code, where it is visible
// and where these tests hold it.
// ---------------------------------------------------------------------------
describe("ownershipEmail", () => {
  const CONFIRMED = { email: "buyer@example.com", email_confirmed_at: "2026-08-01T00:00:00Z" };
  const UNCONFIRMED = { email: "buyer@example.com", email_confirmed_at: null };

  it("lets a CONFIRMED account claim orders addressed to it", () => {
    expect(ownershipEmail(CONFIRMED)).toBe("buyer@example.com");
  });

  it("refuses an UNCONFIRMED account — signing up as an address is not proof of it", () => {
    expect(ownershipEmail(UNCONFIRMED)).toBeNull();
    expect(ownershipEmail({ email: "buyer@example.com" })).toBeNull();
    expect(ownershipEmail({ email: "buyer@example.com", email_confirmed_at: "" })).toBeNull();
  });

  it("is null-safe — no user, no email, no claim", () => {
    expect(ownershipEmail(null)).toBeNull();
    expect(ownershipEmail(undefined)).toBeNull();
    expect(ownershipEmail({ email: null, email_confirmed_at: "2026-08-01T00:00:00Z" })).toBeNull();
  });

  it("degrades to account-id-only, never to no filter at all", () => {
    // The unconfirmed account still sees everything it placed while signed in.
    // What it loses is the ability to reach BACKWARDS to orders it only named.
    expect(buildOrderOwnershipFilter(USER, ownershipEmail(UNCONFIRMED)))
      .toBe(`customer_user_id.eq.${USER}`);
    expect(buildOrderOwnershipFilter(USER, ownershipEmail(CONFIRMED)))
      .toContain("customer_email.eq.");
  });
});

// ---------------------------------------------------------------------------
// THE CHOKEPOINT.
//
// Six call sites read a customer's orders, and one of them passing `user.email`
// straight through reopens the hole for every order that site can see. A unit
// test on ownershipEmail() cannot catch that — the function would still be
// correct and simply not called. So the call sites are asserted directly.
// ---------------------------------------------------------------------------
describe("every order-ownership call site goes through ownershipEmail", () => {
  const CALL_SITES = [
    "src/app/account/(dashboard)/orders/page.tsx",
    "src/app/account/(dashboard)/orders/[orderId]/page.tsx",
    "src/app/account/(dashboard)/orders/[orderId]/invoice/route.ts",
    "src/app/account/(dashboard)/page.tsx",
    "src/app/account/(dashboard)/notifications/page.tsx",
    "src/app/api/account/reorder/route.ts",
  ] as const;

  for (const file of CALL_SITES) {
    it(`${file} never passes the raw session email into an order lookup`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain("ownershipEmail");
      // The raw address may still be DISPLAYED (the invoice prints it); what it
      // must never be is an argument to a function that decides ownership.
      const lookups = source.match(/getCustomer\w*\([^)]*\)/g) ?? [];
      for (const call of lookups) {
        expect(call).not.toContain("user.email");
      }
      // reorder/ compares inline rather than calling a helper.
      expect(source).not.toMatch(/ownsByEmail\s*=\s*user\.email/);
    });
  }
});
