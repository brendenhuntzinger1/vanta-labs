import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

const form = code(read("src/components/account-auth-form.tsx"));
const referralRoute = code(read("src/app/r/[code]/route.ts"));
const middleware = code(read("middleware.ts"));

// ---------------------------------------------------------------------------
// A REFERRED SIGNUP WAS ATTRIBUTED TO NOBODY.
//
// `?ref=` was the only source of a referral at signup, and two changes between
// them removed every way for it to arrive:
//
//   * The link an ambassador actually shares is /r/<code>. That route puts the
//     code in the vl_referral_code COOKIE and redirects to /products; it never
//     puts ?ref on a URL.
//   * The wall then rewrites even a hand-made ?ref out of the top level:
//       GET /products?ref=EXPLICIT15&ttclid=abc
//       -> /account/login?next=%2Fproducts%3Fref%3DEXPLICIT15%26ttclid%3Dabc
//     the whole query buried inside `next`, where nothing reads it.
//
// So a customer following an ambassador's link and being made to create an
// account signed up with no referred_by_code: awardReferralSignupBonus never
// fired, the customer never got the 100-point welcome bonus (real money at
// checkout), and the ambassador never got their referral bonus. Both are
// attempted at this one moment and guarded by a points_ledger lookup, so
// nothing backfills them.
//
// ORDER-LEVEL attribution was never affected — quote-order re-resolves the code
// from the cookie — which is exactly why this was invisible: commissions kept
// landing while the signup bonuses silently did not.
// ---------------------------------------------------------------------------

describe("the shared ambassador link puts the code in a cookie, not the URL", () => {
  it("/r/[code] sets vl_referral_code and redirects", () => {
    expect(referralRoute).toContain("vl_referral_code");
    expect(referralRoute).toContain("NextResponse.redirect");
  });

  it("the wall buries any hand-made ?ref inside ?next=", () => {
    // This is the behaviour, not a complaint about it: carrying the query into
    // next= is what makes a campaign link resolve after sign-in.
    expect(middleware).toContain('login.search = ""');
    expect(middleware).toContain('login.searchParams.set("next"');
  });
});

describe("signup attributes to the cookie when the URL has no ref", () => {
  it("reads vl_referral_code in the form", () => {
    expect(form).toContain('const REFERRAL_COOKIE_KEY = "vl_referral_code"');
    expect(form).toContain("entry.startsWith(`${REFERRAL_COOKIE_KEY}=`)");
  });

  it("reads it as a browser fact, not with a setState in an effect", () => {
    // The cookie cannot exist during SSR and never changes within a page load,
    // so it is read the way useApplePayOffered reads platform support. Setting
    // state from an effect instead is a cascading render the compiler refuses.
    expect(form).toContain("useSyncExternalStore(");
    expect(form).toContain("readReferralCookie");
  });

  it("prefers ?ref= and falls back to the cookie", () => {
    expect(form).toContain("const referralCodeForSignup = referralCodeFromUrl || referralCodeFromCookie");
  });

  it.each([
    ["the email signup POST", "referredByCode: referralCodeForSignup"],
    ["the Supabase user metadata", "referred_by_code: referralCodeForSignup"],
    ["the Google round trip", 'window.sessionStorage.setItem("vl-oauth-referral", referralCodeForSignup)'],
  ])("%s carries the resolved code", (_label, snippet) => {
    expect(form).toContain(snippet);
  });

  it("does NOT let a thirty-day cookie choose the form's mode", () => {
    // An explicit ?ref in the address bar is an invitation to JOIN and opens
    // the signup form. A cookie is not: a returning customer who followed an
    // ambassador link last week asked for sign-in, and must get sign-in.
    expect(form).toContain('if (referralCodeFromUrl) return "signup"');
    expect(form).not.toContain('if (referralCodeForSignup) return "signup"');
  });
});
