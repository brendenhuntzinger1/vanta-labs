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
    // Asserted as a PROPERTY rather than as one inline expression: the
    // laundering is now hoisted into `destination` and reused by the redirect,
    // the re-ask and this link, which is the same guarantee written once
    // instead of three times. What must stay true is that nothing anywhere
    // builds a destination out of the raw query parameter.
    const body = code(callback);
    expect(body).toMatch(/const destination = safeInternalPath\(params\.get\("next"\), FALLBACK\)/);
    expect(body).toContain("`/account/login?next=${encodeURIComponent(destination)}`");

    // The only permitted reads of the raw parameter are the laundering itself
    // and the provider's error text; every other use would be a raw path.
    const rawReads = [...body.matchAll(/params\.get\("next"\)/g)];
    expect(rawReads.length, "next is read raw more than once").toBe(1);
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
    // The marker used to read "(optional)" in parentheses at the label's own
    // size. It is now a small uppercase tag, which is a presentation change and
    // nothing else: what this test exists to hold is that the word is IN the
    // label a visitor reads, not only in a class name or a heading somewhere
    // else on the card. That matters most now the box sits directly beneath the
    // two that genuinely gate entry.
    const marketingAt = code(portal).indexOf("I agree to receive Vanta Labs emails");
    expect(marketingAt).toBeGreaterThan(-1);
    expect(code(portal).slice(marketingAt, marketingAt + 400).toLowerCase()).toContain("optional");
    expect(portal).toContain("vl-portal-row-optional");
  });

  it("carries all three of the owner's statements verbatim", () => {
    expect(portal).toContain("I confirm I am 21 years of age or older");
    expect(portal).toContain("I understand products are offered exclusively for research use");
    expect(portal).toContain("I agree to receive Vanta Labs emails, product updates and offers");
  });

  // ASSERTED AGAINST THE STRIPPED SLICE, NOT THE RAW ONE.
  //
  // The comment above this heading quotes the copy it replaced, verbatim, to
  // record why it changed — and `portal` is the raw file, so a toContain() on
  // the old wording passed off that comment for one release. A rendered string
  // has to be asserted somewhere comments cannot reach.
  const renderedPortal = code(portal);

  it("names the destination, not the checkpoint, and says how long it takes", () => {
    // "Research Access Portal / Access is limited to verified account holders."
    // told a first-time visitor they were not on a list and there was a
    // process. The process is one tap of Google; they left before finding out.
    expect(renderedPortal).toContain("Access Vanta Labs");
    expect(renderedPortal).toContain("Sign in in seconds to continue.");
    expect(renderedPortal).not.toContain("Research Access Portal");
    expect(renderedPortal).not.toContain("Access is limited to verified account holders.");
  });

  it("shows the terms line", () => {
    expect(renderedPortal).toContain("By continuing, you agree to our");
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
    //
    // FOUR ROWS, NOT THREE. "Keep me signed in on this device" joined them: it
    // lived only on the email and create-account forms, so anyone taking the
    // provider door never saw it — and the callback sent `rememberMe: true`
    // regardless. A control the fastest door cannot reach is not a control.
    const rows = portal.match(/className="vl-portal-row/g) ?? [];
    expect(rows.length).toBe(4);
    const css = read("src/app/globals.css");
    expect(css).toContain(".vl-portal-row {");
    expect(css).toMatch(/\.vl-portal-row \{[^}]*min-height: 56px/);
    expect(css).toMatch(/\.vl-portal-row \{[^}]*cursor: pointer/);
  });

  it("asks about staying signed in, and does not assume the answer", () => {
    // Two conditions of entry, and two optional favours. The optional pair are
    // marked as such and neither may default to yes: nobody is harmed by being
    // asked, and someone on a shared bench is harmed by not being.
    expect(portal).toContain("Keep me signed in on this device");
    const optional = portal.match(/vl-portal-row vl-portal-row-optional/g) ?? [];
    expect(optional.length).toBe(2);

    const form = read("src/components/account-auth-form.tsx");
    expect(form).toContain("const [rememberMe, setRememberMe] = useState(false)");
    expect(form).toContain("const [marketingOptIn, setMarketingOptIn] = useState(false)");
    // The choice has to survive two external redirects to be worth making.
    expect(form).toContain('window.sessionStorage.setItem("vl-oauth-remember"');
  });

  it("lets the provider path carry the answer rather than inventing one", () => {
    const callback = read("src/app/account/auth/callback/page.tsx");
    // Was a hardcoded `rememberMe: true`, justified as the visitor "asking that
    // browser to remember them". They were asking to sign in with Google.
    expect(callback).toContain("rememberMe: signIn.rememberMe");
    expect(callback).not.toMatch(/rememberMe:\s*true/);
    expect(callback).toContain('window.sessionStorage.getItem("vl-oauth-remember") === "true"');
  });

  it("treats a missing rememberMe as a no, server-side", () => {
    // The route read `!== false`, so a caller that never mentioned it got
    // thirty days. Two callers did exactly that — the password-reset form and
    // the partner application — and neither had asked the visitor anything.
    const route = read("src/app/api/auth/session/route.ts");
    expect(route).toContain("const rememberMe = body?.rememberMe === true;");
    const lib = read("src/lib/auth-session.ts");
    expect(lib).toContain("buildAuthCookieValue(accessToken: string, rememberMe = false");
  });

  it("gives the provider buttons full width and a 56px target", () => {
    expect(portal).toContain("vl-oauth-btn-lg");
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.vl-oauth-btn-lg \{[^}]*width: 100%/);
    expect(css).toMatch(/\.vl-oauth-btn-lg \{[^}]*min-height: 56px/);
  });

  it("keeps a keyboard-visible focus state on the rows", () => {
    expect(read("src/app/globals.css")).toContain(".vl-portal-row:focus-within");
  });
});

// ---------------------------------------------------------------------------
// THE FASTEST DOOR HAS TO LOOK LIKE THE FASTEST DOOR.
//
// The bounce this screen produces is not caused by the gate; it is caused by
// the gate LOOKING like paperwork. Measured on the local harness at 390x844,
// the version these tests replaced put "Continue with Google" at y=708 with
// its bottom edge at 764 — below the fold of any real handset once browser
// chrome and the in-flow consent bar are counted — behind four checkbox rows,
// and gave it exactly the same visual weight as the form button below it.
//
// What follows pins the three things that fixed it, because every one of them
// is the kind of detail a later tidy-up removes without noticing: the order of
// the card, the weight of the provider button against the email one, and the
// fact that only the two REQUIRED boxes stand in front of the door.
// ---------------------------------------------------------------------------
describe("the portal makes the fastest path the obvious one", () => {
  const portal = form.slice(form.indexOf('if (mode === "portal")'), form.indexOf("const isSendCodeAction"));
  const rendered = code(portal);
  const css = read("src/app/globals.css");

  const at = (needle: string) => {
    const i = rendered.indexOf(needle);
    expect(i, `expected the portal to render ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
    return i;
  };

  it("keeps the two entry conditions in front of the provider button", () => {
    const google = at('startOAuth("google")');
    expect(at("I confirm I am 21 years of age or older")).toBeLessThan(google);
    expect(at("I understand products are offered exclusively for research use")).toBeLessThan(google);
    // The session preference is a setting for this browser, not a statement or
    // a permission, so it stays below both doors.
    expect(at("Keep me signed in on this device")).toBeGreaterThan(google);
  });

  // ---------------------------------------------------------------------
  // THE THIRD BOX SITS WITH THE FIRST TWO. IT MUST NOT PASS FOR ONE.
  //
  // Its position in the stack is the owner's call and it has moved before. What
  // cannot move with it is the difference between a condition of entry and a
  // permission the visitor may withhold and still get in — because ticking this
  // box writes marketing_emails, the column marketing-broadcast.ts selects on
  // when it sends commercial email. A tick collected from someone who believed
  // it was required is not consent under UK/EU GDPR, and it is not even useful:
  // the people who had no way to decline are the ones who press the spam
  // button, and that is charged against the domain that also sends the order
  // confirmations.
  //
  // So this pins the three things that keep it honest wherever it sits: the
  // gate ignores it, it looks different from the boxes that do gate, and it
  // says so in words.
  // ---------------------------------------------------------------------
  it("keeps the marketing box distinguishable from the two that gate entry", () => {
    const marketing = at("I agree to receive Vanta Labs emails, product updates and offers");
    const rowStart = rendered.lastIndexOf("<label", marketing);
    const rowClass = rendered.slice(rowStart, marketing);

    // Dashed and quieter — the difference is legible before the label is read.
    expect(rowClass, "the marketing row is styled as a required one").toContain(
      "vl-portal-row vl-portal-row-optional",
    );

    // The two that DO gate carry the plain row class and no modifier.
    for (const required of [
      "I confirm I am 21 years of age or older",
      "I understand products are offered exclusively for research use",
    ]) {
      const at2 = at(required);
      const cls = rendered.slice(rendered.lastIndexOf("<label", at2), at2);
      expect(cls, `${required} should not be styled optional`).not.toContain("vl-portal-row-optional");
    }

    // And it is marked in words, close enough to the label to belong to it.
    const tag = rendered.slice(marketing, marketing + 400);
    expect(tag.toLowerCase(), "the marketing row carries no optional marker").toContain("optional");
  });

  it("never lets the marketing box become a condition of entry", () => {
    // The load-bearing rule, restated here because the box now sits directly
    // beneath the two that ARE conditions: entry is computed from those two
    // alone, and the controls it gates never consult the marketing state.
    expect(code(form)).toContain("const canEnter = ageConfirmed && researchUseAgreed;");
    expect(code(form)).not.toMatch(/canEnter\s*=\s*[^;]*marketingOptIn/);
    expect(rendered).toContain("disabled={oauthPending !== null || !canEnter}");
    expect(rendered).toContain("disabled={!canEnter}");
    expect(rendered).not.toMatch(/disabled=\{[^}]*marketingOptIn/);
    // And it is never pre-ticked, which is the other way a tick stops meaning
    // anything.
    expect(code(form)).toContain("const [marketingOptIn, setMarketingOptIn] = useState(false);");
  });

  it("orders the card: confirm, Google, or, create, sign in", () => {
    const confirm = at("Confirm to continue");
    const badge = at("Fastest option");
    const google = at('startOAuth("google")');
    const note = at("Fast, secure access");
    const create = at("Create an account");
    const signIn = at("Sign in with email");

    expect(confirm).toBeLessThan(badge);
    expect(badge).toBeLessThan(google);
    expect(google).toBeLessThan(note);
    expect(note).toBeLessThan(create);
    expect(create).toBeLessThan(signIn);
  });

  it("marks the provider button as the fastest option, and means it", () => {
    // The claim is allowed here only because it is literally true: two taps,
    // nothing typed, and the same session the email form produces.
    expect(rendered).toContain("Fastest option");
    expect(rendered).toContain("Fast, secure access — no lengthy signup.");
    expect(rendered).toContain('id="vl-fastest-label"');
    expect(rendered).toContain('id="vl-fastest-note"');
    // Both are wired to the button, so the marker is not purely decorative to
    // a screen reader that never sees the layout.
    expect(rendered).toContain('aria-describedby="vl-fastest-label vl-fastest-note"');
  });

  it("drops the marker and its promise with the button they describe", () => {
    // A "Fastest option" pill over an empty space, or a claim about Google on
    // a card with no Google button, is the same class of dead furniture the
    // provider guards already exist to prevent.
    for (const needle of ["Fastest option", "Fast, secure access", 'id="vl-fastest-note"']) {
      const guard = rendered.lastIndexOf("isGoogleSignInEnabled()", at(needle));
      expect(guard, `${needle} renders outside isGoogleSignInEnabled()`).toBeGreaterThan(-1);
    }
  });

  it("gives the provider button more weight than the email one", () => {
    // Two identical-looking doors is not a recommendation, it is a comparison
    // the visitor has to run themselves.
    expect(rendered).toContain("vl-oauth-btn-primary");
    expect(rendered).toContain("vl-auth-submit-quiet");
    expect(css).toContain(".vl-oauth-btn-primary {");
    expect(css).toContain(".vl-auth-submit-quiet {");
    // The lift must beat .vl-oauth-btn-lg's own hover, which it can only do on
    // source order at equal specificity.
    expect(css.indexOf(".vl-oauth-btn-primary")).toBeGreaterThan(css.indexOf(".vl-oauth-btn-lg:hover"));
    expect(css.indexOf(".vl-auth-submit-quiet")).toBeGreaterThan(css.indexOf(".vl-auth-submit:hover"));
  });

  it("keeps the Google mark unmodified inside the louder button", () => {
    // Brand guidelines require the four colours; a recoloured mark is what
    // fails a provider review.
    for (const hex of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
      expect(rendered).toContain(hex);
    }
  });

  it("draws the bolt rather than borrowing a font glyph", () => {
    // An emoji renders differently on every platform and reads as promotional
    // on a card whose whole value is looking considered. currentColor also
    // survives Windows high contrast, which drops background-image glyphs.
    expect(rendered).toContain('className="vl-fastest-badge"');
    expect(css).toContain(".vl-fastest-badge {");
    expect(portal).not.toContain("⚡");
  });

  it("keeps the instruction text above the WCAG AA floor for this card", () => {
    // Composited against the auth card (~rgb(19,20,24)) the muted whites are:
    //   white/30 2.69:1 · white/35 3.22:1 · white/40 3.83:1 · white/45 4.52:1
    //   white/50 5.30:1 · white/55 6.17:1
    // AA wants 4.5:1 and 11px uppercase is not large text, so /50 is the first
    // step with margin. The label this replaced was white/40 — a fail — which
    // is exactly the kind of thing a restyle carries forward by accident.
    const opacityOf = (label: string) => {
      const at = rendered.indexOf(label);
      expect(at, `expected the portal to render ${JSON.stringify(label)}`).toBeGreaterThan(-1);
      const tag = rendered.lastIndexOf("<p", at);
      const m = /text-white\/(\d+)/.exec(rendered.slice(tag, at));
      expect(m, `no text-white/NN on the element carrying ${JSON.stringify(label)}`).not.toBeNull();
      return Number(m![1]);
    };

    for (const label of ["Confirm to continue", "Fast, secure access"]) {
      expect(opacityOf(label), `${label} is below the contrast floor`).toBeGreaterThanOrEqual(50);
    }

    // The two "optional" tags are inline <span>s on their rows rather than
    // headings, and they are the smallest type on the card — 10px — so they are
    // exactly where an unreadable marker would hide. Same floor applies.
    const tags = [...rendered.matchAll(/text-\[0\.625rem\][^"]*text-white\/(\d+)"[^>]*>\s*optional/g)];
    expect(tags.length, "expected an inline optional tag on each optional row").toBe(2);
    for (const m of tags) {
      expect(Number(m[1]), "an optional tag is below the contrast floor").toBeGreaterThanOrEqual(50);
    }

    // The "or" rule is the one exemption, and only because it is decoration:
    // its container is aria-hidden and it states nothing the layout does not.
    const orAt = rendered.indexOf(">or<");
    expect(rendered.lastIndexOf('aria-hidden="true"', orAt)).toBeGreaterThan(-1);
  });

  it("names the door the sign-in link actually opens", () => {
    // "Sign in" beside a Google button that also signs you in sent returning
    // provider customers to a password form they never set a password for.
    expect(rendered).toContain("Sign in with email");
  });

  it("cites only controls that are on the screen in the refusal it cannot currently reach", () => {
    // HONEST ABOUT WHAT THIS COVERS. Both call-to-action buttons carry a real
    // `disabled` attribute, so a browser dispatches no click and this branch
    // never runs — verified in the harness: clicking either while unticked
    // produces no [role=alert]. The string is a fallback for the day the gate
    // becomes a click-time refusal instead of a disabled attribute, and this
    // asserts only that its wording still matches the card. It is NOT evidence
    // that a visitor is ever told why the button is dim; the label above the
    // rows is what does that job today.
    expect(rendered).toContain("Please confirm both statements above to continue.");
    // "the first two statements" was true of a card with four rows above the
    // button. There are two now, and a refusal that miscounts the screen is
    // how a gate starts feeling broken.
    expect(rendered).not.toContain("first two statements");
  });

  it("does not dim the only door on the card when no provider is configured", () => {
    // The quiet treatment ranks "Create an account" BELOW the provider button.
    // Switch every provider off — one env var away, which is the whole point of
    // lib/oauth-providers.ts — and the provider group disappears, leaving a
    // deliberately-dimmed sole call to action with nothing to be ranked below.
    const at = rendered.indexOf("vl-auth-submit-quiet");
    expect(at, "expected the demotion to still be applied").toBeGreaterThan(-1);
    const guard = rendered.lastIndexOf("hasAnyOAuthProvider()", at);
    expect(guard, "vl-auth-submit-quiet is applied unconditionally").toBeGreaterThan(-1);
    // and the guard is the ternary on the className itself, not the distant one
    // that opens the provider block
    expect(rendered.slice(guard, at)).toMatch(/^hasAnyOAuthProvider\(\)\s*\?\s*"$/);
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
// A CALLBACK WITH NO SIGN-IN IN IT MUST NOT SIGN ANYONE IN.
//
// /account/auth/callback is an ordinary address: typed, shared, bookmarked,
// reached with the back button. getSession() does not fail on such a load — it
// answers from localStorage, which on a shared machine is the previous
// customer's session, and it is a perfectly valid token, so the server verifies
// it and writes a thirty-day cookie. The visitor lands as somebody else.
//
// The first attempt at this guard asked whether the URL LOOKED like a callback.
// That was bypassable, because supabase-js asks a different question: it ignores
// refresh_token entirely, so `#refresh_token=x` read as a session here and as no
// callback at all there, and the fall-through restored storage anyway.
//
// So the page no longer asks a proxy question. It reads the tokens out of the
// fragment and uses THOSE — for the client session and for the server post —
// and never consults client storage. What follows pins that.
// ---------------------------------------------------------------------------

describe("the OAuth callback uses the tokens it was given, and no others", () => {
  const body = code(callback);

  it("reads the tokens from the fragment with the shared reader", () => {
    expect(body).toContain("readOAuthCallbackFragment(window.location.hash)");
    // A hand-rolled substring test is how the original bug was written.
    expect(body).not.toMatch(/hash\.includes\(\s*["']access_token/);
  });

  it("never asks client storage what the session is", () => {
    // getSession() is the whole defect: it answers from localStorage. The page
    // must not call it, nor wait on an auth-state event that could fire for a
    // restored session rather than this one.
    expect(body).not.toContain("supabase.auth.getSession()");
    expect(body).not.toContain("onAuthStateChange");
  });

  it("establishes the client session from the fragment's own token pair", () => {
    const at = body.indexOf("supabase.auth.setSession(");
    expect(at).toBeGreaterThan(-1);
    const call = body.slice(at, at + 240);
    expect(call).toContain("access_token: signIn.accessToken");
    expect(call).toContain("refresh_token: signIn.refreshToken");
  });

  it("posts the fragment's token, not a re-read of client state", () => {
    const postAt = body.indexOf('"/api/auth/session"');
    expect(postAt).toBeGreaterThan(-1);
    const post = body.slice(postAt, postAt + 800);
    expect(post).toContain("accessToken: signIn.accessToken");
    // Never a re-read of client state.
    expect(post).not.toContain("session.access_token");
  });

  it("bails out before any of that when no tokens arrived", () => {
    const guardAt = body.indexOf('callbackReturn.kind !== "session"');
    expect(guardAt, "the no-session guard is missing entirely").toBeGreaterThan(-1);
    // The guard lives in the effect; completeSignIn is declared above it, so
    // compare against the CALL that the guard protects, not the declaration.
    const completeAt = body.indexOf("await completeSignIn(", guardAt);
    expect(completeAt, "nothing is completed after the guard").toBeGreaterThan(guardAt);
    expect(body.slice(guardAt, guardAt + 200)).toContain("return;");
  });

  it("does not spend the stored attestation until the server has accepted it", () => {
    // Clearing it before the work that can fail left a retry with nothing to
    // send — and the retry then succeeded, recording no attestation at all.
    const clearAt = body.indexOf('sessionStorage.removeItem("vl-oauth-attested")');
    const postAt = body.indexOf('"/api/auth/session"');
    const okAt = body.indexOf("if (!response.ok)");
    expect(clearAt, "the attestation is never cleared").toBeGreaterThan(-1);
    expect(okAt).toBeGreaterThan(postAt);
    expect(clearAt, "the attestation is spent before the post can fail").toBeGreaterThan(okAt);
  });

  it("reports a GoTrue refusal from the fragment, a different channel from the query", () => {
    expect(body).toContain('callbackReturn.kind === "error"');
    expect(body).toContain('params.get("error_description")');
  });

  it("never prints provider-supplied text on our own sign-in surface", () => {
    // The query string comes from whoever wrote the link. Rendering it verbatim
    // publishes attacker-chosen prose under our domain and our styling, which is
    // a complete phishing message we would be hosting for them.
    expect(body).not.toContain("setError(providerError)");
    const at = body.indexOf("providerError");
    expect(body.slice(at, at + 400)).toContain("SIGN_IN_FAILED");
  });
});
