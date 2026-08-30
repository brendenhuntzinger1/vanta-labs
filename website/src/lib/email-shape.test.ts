import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { looksLikeEmail } from "@/lib/email-shape";

// ---------------------------------------------------------------------------
// "a@" WAS AN EMAIL ADDRESS, AS FAR AS FOUR AUTH ROUTES WERE CONCERNED.
//
// Each carried `!email.includes("@") || email.length > 320`, which accepts "a@",
// "@", "a@b" and "@." — none of which can receive mail. The route then answers
// its deliberately generic "check your email", so the customer is sent to look
// in a mailbox that does not exist.
//
// It also became an operational problem once mint failures were taken
// seriously: /api/auth/signup raises `signup_mint_failed` at severity CRITICAL
// when a link cannot be minted for an address with no account, and GoTrue
// refuses "a@" exactly that way. So every typo paged the operator — and an
// alert that fires on typos is one people stop reading, which buries the
// failures it exists for.
// ---------------------------------------------------------------------------

describe("looksLikeEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const good of [
      "customer@example.com",
      "first.last@example.co.uk",
      "name+shop@gmail.com",
      "UPPER@Example.COM",
      "  padded@example.com  ",
      "a@b.co",
      "x_y-z@sub.domain.example.org",
    ]) {
      expect(looksLikeEmail(good), good).toBe(true);
    }
  });

  it("rejects the ones that used to get through", () => {
    // Every one of these passed `includes("@")`.
    for (const bad of ["a@", "@", "a@b", "@.", "@example.com", "a@.com", "a@b."]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  it("rejects nothing-at-all without a separate empty check", () => {
    for (const bad of ["", "   ", null, undefined, 0, {}, []]) {
      expect(looksLikeEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects addresses with no @ and addresses with several", () => {
    expect(looksLikeEmail("noatsign")).toBe(false);
    expect(looksLikeEmail("two@at@example.com")).toBe(false);
  });

  it("rejects whitespace and the characters that escape a filter clause", () => {
    for (const bad of [
      "with space@example.com",
      "tab\t@example.com",
      'quote"@example.com',
      "comma,@example.com",
      "paren()@example.com",
      "back\\slash@example.com",
    ]) {
      expect(looksLikeEmail(bad), bad).toBe(false);
    }
  });

  it("caps the length", () => {
    expect(looksLikeEmail(`${"x".repeat(310)}@example.com`)).toBe(false);
    expect(looksLikeEmail(`${"x".repeat(300)}@example.com`)).toBe(true);
  });

  it("plus-addressing survives, because it is a real and common address", () => {
    // The bug this repo already fixed once, in order-ownership.ts: a sanitiser
    // that stripped "+" rewrote name+shop@gmail.com into something that matched
    // nothing, and the customer's own orders vanished.
    expect(looksLikeEmail("name+tag+more@example.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every route that takes an address from an anonymous caller must use it, or
// the weak check simply survives in the one place nobody looked.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the auth routes all use it", () => {
  const routes = [
    "src/app/api/auth/signup/route.ts",
    "src/app/api/auth/password-reset/route.ts",
    "src/app/api/auth/resend-confirmation/route.ts",
    "src/app/api/account/email-change/route.ts",
  ];

  for (const path of routes) {
    it(`${path} checks the shape`, () => {
      const src = read(path);
      expect(src, `${path} does not import looksLikeEmail`).toContain("looksLikeEmail");
      expect(src, `${path} still carries the includes("@") check`)
        .not.toContain('.includes("@")');
    });
  }
});
