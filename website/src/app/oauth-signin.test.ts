import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const form = read("src/components/account-auth-form.tsx");
const callback = read("src/app/account/auth/callback/page.tsx");
const sessionRoute = read("src/app/api/auth/session/route.ts");
const middleware = read("middleware.ts");
const signupRoute = read("src/app/api/auth/signup/route.ts");

/** Strip comments so prose ABOUT a rule is not mistaken for the rule. */
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

// ---------------------------------------------------------------------------
// GOOGLE AND APPLE ARE A DIFFERENT DOOR, NOT A DIFFERENT LEVEL OF TRUST.
//
// Three things have to stay true, and each has been a real bug in some other
// codebase for a reason worth remembering:
//
//   1. All three sign-in methods must produce the SAME session, verified the
//      same way. The moment a provider gets its own code path, that path is
//      where the authorisation check gets forgotten.
//   2. A provider hands back an identity and nothing else. It does not hand
//      back consent to be emailed, and it does not hand back the two
//      representations this store is legally required to collect.
//   3. A redirect target that survives a round trip through two external
//      services is attacker-supplied. It must be laundered, not trusted.
// ---------------------------------------------------------------------------

describe("all three sign-in methods end at one verified session", () => {
  it("the callback posts to the same endpoint email sign-in uses", () => {
    expect(code(callback)).toContain('"/api/auth/session"');
  });

  it("the session endpoint verifies the token against GoTrue before writing a cookie", () => {
    const body = code(sessionRoute);
    const verifyAt = body.indexOf("auth.getUser(accessToken)");
    expect(verifyAt).toBeGreaterThan(-1);
    // Nothing may be written before the token is proven good. Measured on the
    // CALL rather than the import, which naturally sits at the top of the file.
    const cookieAt = body.indexOf("buildAuthCookieValue(", verifyAt);
    expect(cookieAt).toBeGreaterThan(verifyAt);
    // And the handler bails out when verification fails.
    expect(body).toMatch(/if \(error \|\| !data\.user\)/);
  });

  it("introduces no provider-specific session or authorization path", () => {
    // A provider must not mint its own cookie, its own claim, or its own role.
    const body = code(callback);
    expect(body).not.toContain("document.cookie");
    expect(body).not.toContain("vl_session_token");
    expect(body).not.toMatch(/role\s*[:=]\s*["']admin["']/);
  });

  it("keeps email sign-in available alongside the providers", () => {
    // Requiring a Google or Apple account to shop excludes buyers who have
    // neither, for no security gain: all three prove the same thing to the
    // same endpoint.
    expect(code(form)).toContain("signInWithPassword");
    expect(code(form)).toContain('startOAuth("google")');
    expect(code(form)).toContain('startOAuth("apple")');
  });
});

describe("a provider identity is not consent to send marketing", () => {
  it("the callback never asks for a marketing opt-in", () => {
    const body = code(callback);
    expect(body).not.toContain("marketingOptIn");
    expect(body).not.toContain("marketing_emails");
  });

  it("the session endpoint never writes a marketing flag", () => {
    // Email signup records consent through /api/auth/signup, which the OAuth
    // path does not touch. An OAuth account therefore has no marketing_emails
    // row at all, which reads as opted out.
    const body = code(sessionRoute);
    expect(body).not.toContain("marketing_emails");
    expect(body).not.toContain("recordMarketingOptIn");
  });

  it("email signup still records consent explicitly, so the two stay distinct", () => {
    expect(code(signupRoute)).toContain("marketingOptIn");
    expect(code(signupRoute)).toContain("marketing_emails");
  });

  it("tells the visitor what a provider sign-in does and does not do", () => {
    expect(form).toContain("does not subscribe you to marketing email");
  });
});

describe("an OAuth account still makes the two required representations", () => {
  it("email signup writes both flags, which is the bar OAuth has to meet", () => {
    expect(code(signupRoute)).toContain("age_confirmed_21");
    expect(code(signupRoute)).toContain("research_use_only_agreed");
  });

  it("the form refuses to hand a visitor to a provider without both ticks", () => {
    const body = code(form);
    expect(body).toMatch(/if \(!ageConfirmed \|\| !researchUseAgreed\) \{/);
    // And the buttons are visibly unavailable, so the refusal is not a surprise
    // that only appears after the tap.
    expect(body).toContain("disabled={oauthPending !== null || !ageConfirmed || !researchUseAgreed}");
  });

  it("shows those checkboxes in login mode too, beside the buttons that need them", () => {
    // Signup mode already renders them above the submit button. Login mode had
    // none, so the guard above would have cited controls that were not on screen.
    const oauthBlock = form.slice(form.indexOf("or continue with") - 2000, form.indexOf('startOAuth("google")'));
    expect(oauthBlock).toContain('mode === "login"');
    expect(oauthBlock).toContain("setAgeConfirmed");
    expect(oauthBlock).toContain("setResearchUseAgreed");
  });

  it("records the attestation server-side, not on the client's say-so alone", () => {
    expect(code(sessionRoute)).toContain("oauthAttested");
    expect(code(sessionRoute)).toContain("age_confirmed_21");
    expect(code(sessionRoute)).toContain("research_use_only_agreed");
  });

  it("never overwrites an attestation the account already carries", () => {
    // Re-stamping on every sign-in would replace a real first-time attestation
    // with today's date and destroy the only record of when it was made.
    const body = code(sessionRoute);
    expect(body).toContain("alreadyAttested");
    expect(body).toMatch(/if \(!alreadyAttested\)/);
  });

  it("does not lock anyone out if the attestation write fails", () => {
    const guard = sessionRoute.slice(sessionRoute.indexOf("if (oauthAttested)"));
    expect(guard.slice(0, 1600)).toContain("catch");
    expect(guard.slice(0, 1600)).toContain("console.error");
  });
});

describe("the redirect target is laundered, never trusted", () => {
  it("the callback resolves next through safeInternalPath", () => {
    const body = code(callback);
    expect(body).toContain("safeInternalPath");
    expect(body).toMatch(/safeInternalPath\(params\.get\("next"\)/);
  });

  it("builds the provider return URL from the real origin, not from input", () => {
    const body = code(form);
    expect(body).toContain("window.location.origin");
    expect(body).toContain("/account/auth/callback");
    // The next it sends is already validated on the way out as well.
    expect(body).toContain('safeInternalPath(nextPath, "/account")');
  });

  it("the error path also launders the link it offers back", () => {
    expect(code(callback)).toMatch(/href=\{`\/account\/login\?next=\$\{encodeURIComponent\(safeInternalPath/);
  });
});

describe("the callback is reachable while signed out, and only it", () => {
  it("is exempt from the account gate, because that is where a sign-in lands", () => {
    // Gating it would bounce every OAuth sign-in back to the login form it just
    // came from: an infinite round trip that looks like a broken provider.
    expect(code(middleware)).toContain('"/account/auth/callback"');
    // Bound to the Set literal itself, so unrelated code below cannot satisfy
    // or break these assertions.
    const mwCode = code(middleware);
    const start = mwCode.indexOf("const PUBLIC_ACCOUNT_PATHS");
    const set = mwCode.slice(start, mwCode.indexOf("]);", start) + 3);
    expect(set).toContain("/account/login");
    expect(set).toContain("/account/auth/callback");
    // It must not have opened anything else.
    expect(set).not.toContain("/account/orders");
    expect(set).not.toContain("/products");
  });

  it("the callback page holds no catalog or account data of its own", () => {
    const body = code(callback);
    expect(body).not.toContain("getCatalogProducts");
    expect(body).not.toContain("supabaseAdmin");
    expect(body).not.toContain("from(");
  });
});

describe("the provider handoff carries no crawler or client logic", () => {
  // Same invariant the catalog gate is held to: nothing here may vary by who
  // is asking. A sign-in flow that inspected the user-agent would be the exact
  // shape of the cloaking this project refused to build.
  for (const [label, src] of [["auth form", form], ["callback", callback], ["session route", sessionRoute]] as const) {
    it(`${label} never inspects the user-agent`, () => {
      const body = code(src);
      expect(body).not.toMatch(/user-?agent/i);
      expect(body).not.toMatch(/googlebot|bytespider|crawler/i);
    });
  }
});
