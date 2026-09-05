import { describe, expect, it } from "vitest";

import { safeInternalPath } from "@/lib/internal-path";

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
