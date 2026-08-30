import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { brandedConfirmUrl, gotrueVerifyUrl } from "@/lib/auth-confirm-link";

// ---------------------------------------------------------------------------
// THE LAST SPAM SIGNAL THE BRANDING FIX DID NOT REMOVE.
//
// The 2026-08-29 confirmation was moved onto our own template, our own provider
// and our own From address — and its single button still pointed at
// https://<project>.supabase.co/auth/v1/verify. A link whose domain does not
// match the sender's is one of the oldest phishing signals there is, and Gmail
// had already filed the previous version as spam and stripped its links.
//
// Every auth email now points at /auth/confirm on our own host, which rebuilds
// the GoTrue URL and redirects. GoTrue still does the verifying.
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://www.vantalabsresearch.com";
});

const ACTION_LINK = "https://mlpimwgkwuqpsvsrlpqv.supabase.co/auth/v1/verify?token=abc&type=signup&redirect_to=https://www.vantalabsresearch.com/account";

describe("brandedConfirmUrl", () => {
  it("puts the link on our own domain, not the Supabase project's", () => {
    const url = brandedConfirmUrl({
      hashedToken: "abc123",
      type: "signup",
      next: "/account",
      fallbackActionLink: ACTION_LINK,
    });
    expect(url.startsWith("https://www.vantalabsresearch.com/auth/confirm?")).toBe(true);
    expect(url).not.toContain("supabase.co");
  });

  it("carries the token and type through", () => {
    const url = new URL(brandedConfirmUrl({
      hashedToken: "abc123", type: "signup", next: "/account", fallbackActionLink: ACTION_LINK,
    }));
    expect(url.searchParams.get("token")).toBe("abc123");
    expect(url.searchParams.get("type")).toBe("signup");
    expect(url.searchParams.get("next")).toBe("/account");
  });

  it("forwards each link type GoTrue can send", () => {
    for (const type of ["signup", "magiclink", "invite", "recovery", "email_change"]) {
      const url = brandedConfirmUrl({ hashedToken: "t", type, next: "/account", fallbackActionLink: ACTION_LINK });
      expect(url, `${type} should be forwarded`).toContain("/auth/confirm?");
    }
  });

  it("falls back to the raw Supabase link rather than minting a broken one", () => {
    // An ugly link that works beats a tidy one that does not — this is the only
    // way a customer gets into their account.
    expect(brandedConfirmUrl({ hashedToken: "", type: "signup", next: "/account", fallbackActionLink: ACTION_LINK }))
      .toBe(ACTION_LINK);
    expect(brandedConfirmUrl({ hashedToken: "t", type: "unknown_type", next: "/account", fallbackActionLink: ACTION_LINK }))
      .toBe(ACTION_LINK);
    expect(brandedConfirmUrl({ hashedToken: null, type: null, next: "/account", fallbackActionLink: ACTION_LINK }))
      .toBe(ACTION_LINK);
  });

  it("refuses an off-site next", () => {
    // `next` rides in a URL anyone can hand-build. "//evil.example" is
    // protocol-relative and would leave the site entirely.
    const offsite = new URL(brandedConfirmUrl({
      hashedToken: "t", type: "signup", next: "//evil.example/steal", fallbackActionLink: ACTION_LINK,
    }));
    expect(offsite.searchParams.get("next")).toBe("/account");

    const absolute = new URL(brandedConfirmUrl({
      hashedToken: "t", type: "signup", next: "https://evil.example", fallbackActionLink: ACTION_LINK,
    }));
    expect(absolute.searchParams.get("next")).toBe("/account");
  });
});

describe("gotrueVerifyUrl", () => {
  it("rebuilds the verify URL GoTrue expects", () => {
    const url = new URL(gotrueVerifyUrl({
      supabaseUrl: "https://mlpimwgkwuqpsvsrlpqv.supabase.co",
      token: "abc123",
      type: "signup",
      redirectTo: "https://www.vantalabsresearch.com/account",
    }));
    expect(url.pathname).toBe("/auth/v1/verify");
    expect(url.searchParams.get("token")).toBe("abc123");
    expect(url.searchParams.get("type")).toBe("signup");
    expect(url.searchParams.get("redirect_to")).toBe("https://www.vantalabsresearch.com/account");
  });

  it("tolerates a trailing slash on the project URL", () => {
    expect(gotrueVerifyUrl({
      supabaseUrl: "https://x.supabase.co/", token: "t", type: "signup", redirectTo: "https://s/",
    })).toContain("https://x.supabase.co/auth/v1/verify?");
  });
});

// ---------------------------------------------------------------------------
// The route and its callers. Source-level: exercising the hop for real needs a
// live GoTrue, and what regresses here is the wiring.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ROUTE = read("src/app/auth/confirm/route.ts");

describe("GET /auth/confirm", () => {
  it("never logs the token", () => {
    // A token in a log is a token an attacker can spend. It is read off the
    // query string, put into a redirect, and forgotten.
    const logs = ROUTE.match(/console\.(log|error|warn)\([^)]*\)/g) ?? [];
    for (const call of logs) expect(call).not.toContain("token");
  });

  it("guards the open redirect on next", () => {
    expect(ROUTE).toContain('rawNext.startsWith("//")');
  });

  it("sends a dead link somewhere that says so", () => {
    // The failure this whole change exists to fix was a customer staring at a
    // page that told them nothing.
    expect(ROUTE).toContain("deadLink");
    expect(ROUTE).toContain("/account/login?link=");
  });

  it("sends recovery and invite to the password form, not to next", () => {
    // An invited ambassador has no password yet, and a recovery link exists to
    // set one; landing either on /account would be a dead end.
    expect(ROUTE).toContain('type === "recovery" || type === "invite"');
    expect(ROUTE).toContain("/account/reset-password");
  });
});

describe("every auth email uses the branded hop", () => {
  const callers = [
    ["signup confirmation", "src/app/api/auth/signup/route.ts"],
    ["resend / magic link", "src/lib/auth-confirmation-email.ts"],
    ["ambassador invite", "src/lib/partner-portal.ts"],
    ["password reset", "src/app/api/auth/password-reset/route.ts"],
  ];

  for (const [name, path] of callers) {
    it(`${name} does not hand the raw Supabase link to its template`, () => {
      const src = read(path);
      expect(src, `${path} should call brandedConfirmUrl`).toContain("brandedConfirmUrl");
      // The raw action_link may only appear as the fallback argument.
      const rawUses = (src.match(/action_link/g) ?? []).length;
      const asFallback = (src.match(/fallbackActionLink:/g) ?? []).length;
      const asGuard = (src.match(/!\w*\.?(data)?\??\.?properties\?\.action_link|properties\?\.action_link\)/g) ?? []).length;
      expect(rawUses).toBeGreaterThan(0);
      expect(asFallback).toBeGreaterThan(0);
      // Every remaining mention is either the fallback or a null-guard.
      expect(rawUses).toBeLessThanOrEqual(asFallback + asGuard + 1);
    });
  }
});

describe("where a confirmed customer is put down", () => {
  it("routes a signup through the ?verified=1 contract, not straight to next", () => {
    // GoTrue appends the session as a URL FRAGMENT, which is never sent to the
    // server. Landing straight on /account means the layout sees no cookie and
    // bounces to the sign-in form — the customer confirms successfully and is
    // then asked to log in anyway. Caught in the browser, not in review.
    expect(ROUTE).toContain("/account/login?verified=1&next=");
  });

  it("still sends recovery and invite to the password form", () => {
    expect(ROUTE).toContain("/account/reset-password");
  });
});
