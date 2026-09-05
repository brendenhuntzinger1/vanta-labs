import { describe, expect, it } from "vitest";

import { loginHrefWithReturn, safeInternalPath } from "@/lib/internal-path";

// ---------------------------------------------------------------------------
// A `next` PARAMETER IS ATTACKER-CONTROLLED, AND "STARTS WITH ONE SLASH" IS
// NOT A SAME-ORIGIN TEST.
//
// Eight places accepted a post-login / post-confirmation / referral-landing
// destination with `startsWith("/") && !startsWith("//")`. The WHATWG URL
// parser treats a backslash as a slash for http(s), so `/\evil.example/x`
// passes that predicate and resolves to https://evil.example/x — an open
// redirect on the most-shared link the brand has (/r/<code>) and on the
// sign-in form. Verified: new URL("/\\evil.example/steal", origin).href is
// "https://evil.example/steal".
// ---------------------------------------------------------------------------

describe("safeInternalPath", () => {
  it("keeps ordinary internal paths, with their query and fragment", () => {
    expect(safeInternalPath("/account/orders?x=1#top", "/account")).toBe("/account/orders?x=1#top");
    expect(safeInternalPath("/products", "/account")).toBe("/products");
    expect(safeInternalPath("/", "/account")).toBe("/");
  });

  it.each([
    "//evil.example/steal",
    "/\\evil.example/steal",
    "/\\\\evil.example",
    "/\\/evil.example",
    "/ \\evil.example",
    "https://evil.example/",
    "http://evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/account\r\nSet-Cookie: x=y",
    "",
    "   ",
  ])("refuses %j and falls back", (value) => {
    expect(safeInternalPath(value, "/account")).toBe("/account");
  });

  it("refuses non-strings and arrays", () => {
    expect(safeInternalPath(null, "/account")).toBe("/account");
    expect(safeInternalPath(undefined, "/account")).toBe("/account");
    expect(safeInternalPath(["/x"] as unknown as string, "/account")).toBe("/account");
  });

  it("never returns a value that resolves off-origin, for any origin", () => {
    for (const origin of ["https://www.vantalabsresearch.com", "http://127.0.0.1:3000"]) {
      for (const candidate of ["/\\evil.example", "//evil.example", "/ok", "/\\\\a\\b"]) {
        const result = safeInternalPath(candidate, "/products");
        expect(new URL(result, origin).origin).toBe(origin);
      }
    }
  });
});

// SF-4: the guest wishlist click sent the shopper to /account/login with no way
// back to the product. Every sign-in-first hop carries `next=`; this is the one
// helper that builds it, through the same guard as the rest.
describe("loginHrefWithReturn", () => {
  it("carries the current path as an encoded next= parameter", () => {
    expect(loginHrefWithReturn("/products/ghk-cu")).toBe("/account/login?next=%2Fproducts%2Fghk-cu");
    expect(loginHrefWithReturn("/products/ghk-cu?dose=50mg")).toBe(
      "/account/login?next=%2Fproducts%2Fghk-cu%3Fdose%3D50mg",
    );
  });

  it("refuses anything that is not a same-origin path", () => {
    expect(loginHrefWithReturn("https://evil.example/steal")).toBe("/account/login");
    expect(loginHrefWithReturn("//evil.example/steal")).toBe("/account/login");
    expect(loginHrefWithReturn("/\\evil.example/steal")).toBe("/account/login");
    expect(loginHrefWithReturn("")).toBe("/account/login");
    expect(loginHrefWithReturn(undefined)).toBe("/account/login");
  });
});
