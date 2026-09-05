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
  // THE CONTRACT CHANGED WITH THE PORTAL, AND THE NEW ONE IS STRICTER THAN
  // "never". Consent is now collectable at the portal through an OPTIONAL third
  // box, so what these pin is that it can only ever travel as an explicit yes.
  it("reads consent as a strict true, so silence is never consent", () => {
    // A missing key, a null, or any other value must mean no. This value
    // crosses a network boundary and a browser-storage boundary, and both can
    // return something that is merely truthy.
    expect(code(callback)).toContain('getItem("vl-oauth-marketing") === "true"');
    expect(code(sessionRoute)).toContain("body?.oauthMarketingOptIn === true");
  });

  it("only ever writes an opt-IN, never an opt-out", () => {
    // Writing false here would silently overwrite a real opt-in from an earlier
    // signup the next time that person happened to sign in with Google.
    const body = code(sessionRoute);
    expect(body).toMatch(/if \(oauthMarketingOptIn && data\.user\.email\)/);
    expect(body).toContain("marketing_emails: true");
    expect(body).not.toContain("marketing_emails: false");
  });

  it("records consent through the same two places email signup uses", () => {
    // marketing_subscribers carries the opt-in TIME, which an unsubscribe
    // request and an audit both need; customer_preferences is the per-account
    // switch every send already reads. Using one and not the other produces a
    // customer who is on the list but shows as unsubscribed, or the reverse.
    const body = code(sessionRoute);
    expect(body).toContain("recordMarketingOptIn");
    expect(body).toContain("customer_preferences");
    expect(code(signupRoute)).toContain("recordMarketingOptIn");
  });

  it("never fails a sign-in over a mailing list", () => {
    const block = sessionRoute.slice(sessionRoute.indexOf("if (oauthMarketingOptIn"));
    expect(block.slice(0, 1200)).toContain("catch");
    expect(block.slice(0, 1200)).toContain("console.error");
  });

  it("email signup still records consent explicitly, so the two stay distinct", () => {
    expect(code(signupRoute)).toContain("marketingOptIn");
    expect(code(signupRoute)).toContain("marketing_emails");
  });

  it("tells the visitor what a provider sign-in does and does not do", () => {
    // Whitespace-normalised, because the sentence is JSX prose that reflows
    // whenever the surrounding markup is re-indented. Pinning the line breaks
    // makes this fail for a formatting change while the statement it is
    // actually guarding — that handing over a Google address is not consent to
    // be mailed — is still right there on the screen.
    const prose = form.replace(/\s+/g, " ");
    expect(prose).toContain("shares your name and email address with Vanta Labs");
    expect(prose).toContain("does not subscribe you to marketing email");
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

  it("shows those checkboxes wherever a provider button is offered", () => {
    // Three surfaces now carry provider buttons: the portal, and the login and
    // signup forms behind it. Every one of them must render the two boxes
    // startOAuth requires, or the guard cites controls that are not on screen.
    const portalBlock = form.slice(form.indexOf('if (mode === "portal")'), form.indexOf("const isSendCodeAction"));
    expect(portalBlock).toContain("setAgeConfirmed");
    expect(portalBlock).toContain("setResearchUseAgreed");

    // Anchored on the divider that opens the email forms' provider section,
    // then forward — the block sits just after it, not before.
    const dividerAt = form.indexOf("or continue with");
    const loginBlock = form.slice(dividerAt, form.indexOf('startOAuth("google")', dividerAt));
    expect(loginBlock).toContain('mode === "login"');
    expect(loginBlock).toContain("setAgeConfirmed");
    expect(loginBlock).toContain("setResearchUseAgreed");
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

// ---------------------------------------------------------------------------
// THE PORTAL. First screen, three questions, two doors.
//
// The load-bearing rule is that entry depends on the first two boxes and never
// on the third. Consent that is the price of admission is not consent, and the
// list it fills is worse than no list: people who had no way to decline are the
// ones who report mail as spam, and that is charged against the sending domain.
// ---------------------------------------------------------------------------
describe("the portal gates on the attestations, never on the marketing box", () => {
  const portal = form.slice(form.indexOf('if (mode === "portal")'), form.indexOf("const isSendCodeAction"));

  it("computes entry from the two required boxes only", () => {
    expect(code(form)).toContain("const canEnter = ageConfirmed && researchUseAgreed;");
    expect(code(form)).not.toMatch(/canEnter\s*=\s*[^;]*marketingOptIn/);
  });

  it("gates both provider buttons and Create an account on canEnter", () => {
    const body = code(portal);
    expect(body).toContain("disabled={oauthPending !== null || !canEnter}");
    expect(body).toContain("disabled={!canEnter}");
  });

  it("leaves Sign in reachable regardless of the boxes", () => {
    // A returning customer made these representations when they created the
    // account. Blocking them from their own orders over an unticked box would
    // be absurd, and it is the kind of thing that reads as a broken site.
    const signIn = portal.slice(portal.indexOf("Already have an account?"));
    expect(signIn).not.toContain("disabled");
  });

  it("starts the marketing box unticked", () => {
    expect(code(form)).toContain("const [marketingOptIn, setMarketingOptIn] = useState(false);");
  });

  it("labels the marketing box as optional, in the label itself", () => {
    expect(portal).toContain("(optional)");
    expect(portal).toContain("vl-portal-row-optional");
  });

  it("carries all three of the owner's statements verbatim", () => {
    expect(portal).toContain("I confirm I am 21 years of age or older");
    expect(portal).toContain("I understand products are offered exclusively for research use");
    expect(portal).toContain("I agree to receive Vanta Labs emails, product updates and offers");
  });

  it("shows the title, the access line and the terms line", () => {
    expect(portal).toContain("Research Access Portal");
    expect(portal).toContain("Access is limited to verified account holders.");
    expect(portal).toContain("By continuing, you agree to our");
    expect(portal).toContain("/legal/terms");
    expect(portal).toContain("/legal/privacy");
  });

  it("shows no email or password field on the first screen", () => {
    // The whole point: eight fields in front of someone who is going to press
    // "Continue with Google" is what made this read as paperwork.
    expect(portal).not.toContain('type="email"');
    expect(portal).not.toContain('type="password"');
    expect(portal).not.toContain("setPassword");
  });

  it("makes the whole row a tap target, not just the box", () => {
    // Each row is a <label> wrapping its input. A bare checkbox is a 16px
    // target in a 300px row, and two of these are required to enter at all.
    const rows = portal.match(/className="vl-portal-row/g) ?? [];
    expect(rows.length).toBe(3);
    const css = read("src/app/globals.css");
    expect(css).toContain(".vl-portal-row {");
    expect(css).toMatch(/\.vl-portal-row \{[^}]*min-height: 56px/);
    expect(css).toMatch(/\.vl-portal-row \{[^}]*cursor: pointer/);
  });

  it("gives the provider buttons full width and equal weight", () => {
    expect(portal).toContain("vl-oauth-btn-lg");
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.vl-oauth-btn-lg \{[^}]*width: 100%/);
    expect(css).toMatch(/\.vl-oauth-btn-lg \{[^}]*min-height: 56px/);
  });

  it("keeps a keyboard-visible focus state on the rows", () => {
    expect(read("src/app/globals.css")).toContain(".vl-portal-row:focus-within");
  });
});

describe("the portal is not a one-way door", () => {
  it("offers a route back from the email forms", () => {
    expect(form).toContain("All sign-in options");
    expect(code(form)).toMatch(/setMode\("portal"\)/);
  });

  it("steps aside for anyone returning from an emailed link", () => {
    // A confirmation or recovery return carries a message the sign-in form is
    // built to show. Parking that person behind an age gate buries it, and they
    // already have an account, so the gate has nothing left to ask.
    const init = code(form).slice(code(form).indexOf("const [mode, setMode]"));
    expect(init.slice(0, 900)).toContain("fromEmailLink");
    expect(init.slice(0, 900)).toContain('return "login"');
    expect(init.slice(0, 900)).toContain('referralCodeFromUrl) return "signup"');
  });
});

// ---------------------------------------------------------------------------
// A CALLBACK WITH NO SIGN-IN IN IT MUST NOT SIGN ANYONE IN.
//
// /account/auth/callback is an ordinary address: typed, shared, bookmarked,
// reached with the back button. On every one of those loads the fragment is
// empty — and getSession() does not fail on an empty fragment, it returns
// whatever supabase-js kept in localStorage. On a shared machine that is the
// previous person's session, and it is a perfectly valid token, so
// /api/auth/session verifies it and writes a cookie. The visitor lands signed
// in as whoever last used the browser.
//
// lib/auth-link-fragment.ts exists because this exact defect shipped once
// before, on /account/login?verified=1, and its header records the incident.
// It is worse here: that cookie lapsed hourly, this one asks the browser to
// remember for thirty days (rememberMe: true).
//
// So the fragment is classified FIRST, in a render-time initializer, before
// anything touches supabase.auth and lets the client consume it.
// ---------------------------------------------------------------------------

describe("the OAuth callback refuses to promote a session it was not given", () => {
  const body = code(callback);

  it("classifies the fragment with the shared guard rather than its own predicate", () => {
    expect(body).toContain("classifyAuthReturn(window.location.hash)");
    // A hand-rolled substring test is how the original bug was written.
    expect(body).not.toMatch(/hash\.includes\(\s*["']access_token/);
  });

  it("reads the fragment before anything can consume it", () => {
    const classifyAt = body.indexOf("classifyAuthReturn(window.location.hash)");
    const firstAuthAccess = body.indexOf("supabase.auth");
    expect(classifyAt).toBeGreaterThan(-1);
    expect(firstAuthAccess).toBeGreaterThan(-1);
    expect(
      classifyAt < firstAuthAccess,
      "the fragment must be classified before supabase.auth is first touched",
    ).toBe(true);
  });

  it("bails out before requesting a session when no session arrived", () => {
    const guardAt = body.indexOf('authReturn.kind !== "session"');
    expect(guardAt).toBeGreaterThan(-1);
    // The guard must come before the getSession call it is protecting...
    const getSessionAt = body.indexOf("supabase.auth.getSession()");
    expect(guardAt).toBeLessThan(getSessionAt);
    // ...and before the POST that would mint the cookie.
    const postAt = body.indexOf('"/api/auth/session"');
    expect(guardAt).toBeLessThan(postAt);
    // ...and it must actually stop, not merely warn.
    expect(body.slice(guardAt, guardAt + 260)).toContain("return;");
  });

  it("does not spend the stored attestation on a load that carries no sign-in", () => {
    // Consuming it on a stray load would silently strip the 21+ and
    // research-use representations from the real sign-in that follows.
    const guardAt = body.indexOf('authReturn.kind !== "session"');
    const storageAt = body.indexOf('sessionStorage.getItem("vl-oauth-attested")');
    // Assert both are PRESENT before comparing them. A missing guard makes
    // indexOf return -1, and -1 is less than every real offset, so an ordering
    // assertion on its own passes most loudly exactly when the guard is gone.
    expect(guardAt, "the no-session guard is missing entirely").toBeGreaterThan(-1);
    expect(storageAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(storageAt);
  });

  it("reports a GoTrue refusal from the fragment, which is a different channel from the query", () => {
    expect(body).toContain('authReturn.kind === "error"');
    const fragmentErrAt = body.indexOf('authReturn.kind === "error"');
    const queryErrAt = body.indexOf('params.get("error_description")');
    expect(queryErrAt).toBeGreaterThan(-1);
    expect(fragmentErrAt).toBeGreaterThan(-1);
    // Both are read; neither replaces the other.
    expect(fragmentErrAt).not.toBe(queryErrAt);
  });
});
