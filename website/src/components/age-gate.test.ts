import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// The gate is the first thing every visitor meets and the one thing on the site
// that must never be weakened.
//
// It previously REMEMBERED confirmation for 30 days, in localStorage with a
// cookie mirror. A returning visitor reached the storefront without being asked
// again, and a shared or previously-used device carried one person's
// attestation to whoever picked it up next. The owner reported reaching the
// store with no gate at all, which is exactly that behaviour working as built.
//
// Age verification is scoped to ONE VISIT. These rules exist so it can never
// creep back to "for ever" (a 30-day token on a shared device) and never
// regress to "every document" (which put the gate in front of a customer
// pressing BACK from the payment page, mid-purchase).
// ---------------------------------------------------------------------------

describe("age verification lasts one visit — not for ever, not one page", () => {
  const gate = read("src/components/age-gate.tsx");
  const layout = read("src/app/layout.tsx");

  it("never reads an answer that could OUTLIVE the visit", () => {
    // The bypass that mattered: a previous visit's answer, on a device that may
    // have changed hands. sessionStorage cannot do that — it dies with the tab.
    expect(gate).not.toMatch(/localStorage\.getItem/);
    // The only permitted cookie reference is the removal on exit, below.
    expect(gate).not.toMatch(/document\.cookie\.split/);
  });

  it("remembers the answer for THIS visit, in session-scoped storage", () => {
    // The customer-found defect: confirmation held only in React state was lost
    // by any full-document navigation, so BACK from the payment page showed the
    // gate again. Behaviour is proven by the browser suite; this pins the
    // mechanism so it cannot silently revert to per-document state.
    expect(gate).toMatch(/sessionStorage\.getItem\(AGE_SESSION_KEY\)/);
    expect(gate).toMatch(/sessionStorage\.setItem\(AGE_SESSION_KEY/);
    expect(gate).toMatch(/useSyncExternalStore/);
  });

  it("never WRITES an answer that could outlive the page", () => {
    expect(gate).not.toMatch(/localStorage\.setItem/);
    // A cookie may only be CLEARED (max-age=0), never set to a live value.
    const cookieWrites = gate.match(/document\.cookie\s*=\s*"[^"]*"/g) ?? [];
    for (const w of cookieWrites) {
      expect(w, `a cookie is being set to a live value: ${w}`).toMatch(/max-age=0/);
    }
  });

  it("the root layout no longer reads storage before paint", () => {
    // The pre-paint script existed only to read the stored answer. With nothing
    // to read it is gone, and the attribute is a server-rendered constant.
    expect(layout).not.toMatch(/localStorage\.getItem\("vanta-labs-age-verified"\)/);
    expect(layout).toMatch(/data-age-verified="false"/);
  });

  it("still clears any flag left behind by the old persisted version", () => {
    // A visitor who confirmed under the previous implementation may still be
    // carrying a 30-day token. Exiting removes it rather than leaving it to
    // expire on its own.
    expect(gate).toContain('localStorage.removeItem("vanta-labs-age-verified")');
    expect(gate).toMatch(/vl_age_verified=; path=\/; max-age=0/);
  });

  it("resolves the answer through one shared rule, not a hand-rolled expression", () => {
    // The decision lives in isVerifiedForDocument, which the browser suite
    // drives directly across simulated document boundaries. Pinning the call
    // rather than an inline boolean is what let the old test pass while the
    // real behaviour was broken.
    expect(gate).toMatch(/const isVerified = isVerifiedForDocument\(/);
    expect(gate).toMatch(/confirmedInMemory: localVerified/);
    expect(gate).toMatch(/sessionConfirmed,/);
    // Nothing may write an answer that outlives the visit.
    expect(gate).not.toMatch(/localStorage\.setItem|indexedDB/);
    // The only cookie line clears the legacy value (max-age=0).
    for (const line of gate.split("\n").filter((l) => l.includes("document.cookie"))) {
      expect(line, `cookie write in the age gate: ${line.trim()}`).toMatch(/max-age=0/);
    }
  });
});

describe("the gate fails closed and locks the page behind it", () => {
  const css = read("src/app/globals.css");
  const layout = read("src/app/layout.tsx");
  const gate = read("src/components/age-gate.tsx");

  it("only an explicit \"true\" can hide the gate", () => {
    // Keyed off ="true", never off the ABSENCE of the attribute, so a thrown
    // error or disabled JavaScript shows the gate rather than hiding it.
    expect(css).toMatch(/html\[data-age-verified="true"\]\s*\[data-age-gate\]\s*\{\s*display:\s*none/);
    expect(css).not.toMatch(/html:not\(\[data-age-verified\]\)\s*\[data-age-gate\]/);
  });

  it("every document is served unverified", () => {
    expect(layout).toMatch(/data-age-verified="false"/);
    expect(layout).not.toMatch(/data-age-verified="true"/);
  });

  it("locks scrolling from the first paint, not from hydration", () => {
    // Both html AND body. `overflow: hidden` on body alone does not stop
    // WebKit scrolling the document under a fixed overlay, which let a tap
    // inside the gate drag the storefront up behind it.
    expect(css).toMatch(
      /html\[data-age-verified="false"\],\s*html\[data-age-verified="false"\] body\s*\{[^}]*overflow:\s*hidden/,
    );
    expect(css).toMatch(
      /html\[data-age-verified="false"\],\s*html\[data-age-verified="false"\] body\s*\{[^}]*height:\s*100%/,
    );
  });

  it("sends an age-confirmed visitor to sign-in WITHOUT reloading the document", () => {
    // A full page load would come up showing the gate again, because the
    // confirmation is not persisted — so the button appeared to do nothing.
    expect(gate).toMatch(/router\.push\("\/account\/login"\)/);
    expect(gate).not.toMatch(/window\.location\.assign\("\/account\/login"\)/);
  });

  it("keeps the attribute in step with React so the lock releases on accept", () => {
    expect(gate).toMatch(/setAttribute\("data-age-verified",\s*isVerified \? "true" : "false"\)/);
  });

  // TWO BOXES IS A PRESENTATION CHOICE. THE REPRESENTATIONS ARE NOT.
  //
  // The gate asked for four ticks and now asks for two, because four legal
  // sentences in a column made the first screen of the store read as a warning
  // notice. What may NOT change is what the visitor actually asserts: the four
  // representations are all still made, just grouped into who-is-asking and
  // what-is-being-agreed.
  //
  // So this pins both ends. Two is the floor as well as the ceiling: one box is
  // a single click standing for every representation at once, which is the
  // assent a regulator would question, and each required phrase is asserted
  // individually so a rewrite cannot quietly drop one while keeping the count.
  it("takes two ticks, and still carries every representation", () => {
    expect(gate).toContain("const agreed = ATTESTATIONS.every((a) => confirmed[a.id]);");
    expect(gate).toMatch(/disabled=\{!agreed\}/);
    const ids = gate.match(/\{\s*id:\s*"/g) ?? [];
    expect(ids.length).toBe(2);

    const start = gate.indexOf("const ATTESTATIONS = [");
    const copy = gate.slice(start, gate.indexOf("] as const;", start));
    for (const required of [
      /\b21 or older\b/,          // age
      /\blab\b/,                  // ... on behalf of an organisation
      /\bresearch organization\b/,
      /laboratory research only/,  // research use only
      /not for human consumption/,
      /\bTerms\b/,                // and the two policies
      /Research Use Policy/,
    ]) {
      expect(copy, `the attestations no longer assert ${required}`).toMatch(required);
    }
  });

  it("exempts the staff areas, and ONLY the staff areas", () => {
    // /admin and /vault are behind authentication and are not customer facing.
    // Gating them would mean re-attesting during order and inventory work for
    // no protective benefit — /admin is already behind authentication.
    expect(gate).toContain('const STAFF_ONLY = ["/admin", "/vault"];');
    expect(gate).toMatch(/matches\(STAFF_ONLY\)/);
    // Nothing a shopper can reach may appear in that list.
    for (const shopper of ["/products", "/cart", "/checkout", "/account", "/membership", "/ambassador"]) {
      expect(gate, `${shopper} must never be exempt from the gate`)
        .not.toMatch(new RegExp(`STAFF_ONLY[^\\]]*${shopper}`));
    }
    // There is exactly ONE other exemption, and it is the payment/receipt one.
    // Its own rules live in age-gate-payment-routes.test.ts; what matters here
    // is that a third list cannot appear unnoticed.
    const exemptionLists = gate.match(/^const [A-Z_]+ = \[[^\]]*\];$/gm) ?? [];
    const routeLists = exemptionLists.filter((line) => line.includes('"/'));
    expect(
      routeLists.length,
      `unexpected route list in age-gate.tsx:\n${routeLists.join("\n")}`,
    ).toBe(3); // STAFF_ONLY, PAYMENT_AND_RECEIPT, NEVER_A_DESTINATION
  });

  it("marks the overlay so the pre-paint CSS can find it", () => {
    expect(gate).toContain('data-age-gate="true"');
  });

  it("gates the storefront but never the APIs", () => {
    // The gate is a client overlay inside the root layout's body. API routes,
    // webhooks and payment callbacks live outside React entirely and must stay
    // that way — gating them would break the processor and Shippo.
    expect(layout).toContain("<AgeGate>");
    expect(layout).not.toMatch(/AgeGate[\s\S]{0,200}\/api\//);
  });
});

// ---------------------------------------------------------------------------
// The hero vial is the first thing anyone sees. It must be ON SCREEN.
//
// The video used to keep itself transparent until the "playing" event fired,
// so that a refused autoplay could not show a paused frame with iOS's play
// glyph on it. In an in-app browser, on a weak signal, or before the first
// frame decoded, that left the hero completely BLACK — no vial at all, which
// is a worse failure than the one it was avoiding.
// ---------------------------------------------------------------------------
describe("the hero vial is always visible", () => {
  const hero = readFileSync(join(process.cwd(), "src/components/hero-video.tsx"), "utf8");
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("never hides itself based on playback state", () => {
    expect(hero).not.toMatch(/opacity:\s*isPlaying/);
    expect(hero).not.toMatch(/setIsPlaying/);
    expect(hero).not.toMatch(/style=\{\{\s*opacity/);
  });

  it("keeps the element visible in CSS", () => {
    // WHAT MATTERS IS THAT IT IS NOT HIDDEN, not the exact number. This used
    // to pin 0.82, which is a design value that has since moved: the shot is
    // lit on a white studio backdrop, and blending it further into the hero is
    // what stops that backdrop reading as a bright hole in a near-black page.
    // Pinning the number turned a taste decision into a test failure while
    // saying nothing about the bug this guards — a hero with no vial in it.
    const opacities = [...css.matchAll(/\.vl2-hero-video\s*\{([\s\S]*?)\n\s*\}/g)]
      .flatMap((rule) => [...rule[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/opacity:\s*([0-9.]+)/g)])
      .map((m) => Number(m[1]));
    expect(opacities.length, "the media must declare an opacity somewhere").toBeGreaterThan(0);
    // Comfortably visible at every breakpoint. Below ~0.5 the vial stops
    // holding the eye, which is the failure this describe block is named for.
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.55);
  });

  it("still refuses taps, and is a canvas with no native player", () => {
    const rule = css.slice(css.indexOf(".vl2-hero-video"), css.indexOf(".vl2-hero-scrim"));
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(hero).toContain("<canvas");
    expect(hero).toContain("video.disablePictureInPicture = true;");
  });

  // REVERSED DELIBERATELY. This used to REQUIRE gesture listeners, so that a
  // deferred autoplay would start on the visitor's first tap. On an iPhone that
  // is indistinguishable from the visitor asking to watch the video, and iOS
  // answered it with the native fullscreen player. Playback now comes from the
  // autoplay attribute alone.
  it("never ties playback to a user gesture", () => {
    for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
      expect(hero, `a ${ev} listener would make a tap look like a play request`)
        .not.toContain(`"${ev}"`);
    }
    // Returning to the foreground is not a gesture, and browsers pause
    // background media, so this one recovery stays.
    expect(hero).toMatch(/visibilitychange/);
  });
});

// ---------------------------------------------------------------------------
// Reported from a phone opening the link from a TikTok bio, and none of it is
// reproducible in a desktop browser:
//
//   * tapping an attestation flashed the home page's hero vial out from behind
//     the gate, repeatedly;
//   * a tap aimed at the fourth row hit a policy link, and because an in-app
//     webview has no second tab it NAVIGATED there — landing on the Research
//     Disclaimer with the gate and every ticked box gone;
//   * so the boxes (four of them at the time) could never all be held ticked at
//     once, and the sign-in buttons stayed disabled.
// ---------------------------------------------------------------------------
describe("the gate survives an in-app browser", () => {
  const gate = read("src/components/age-gate.tsx");
  const css = read("src/app/globals.css");

  it("HIDES the storefront rather than merely covering it", () => {
    // A fixed overlay is enough on a desktop. It is not enough where the
    // toolbar resizes the visual viewport underneath you.
    // The diagnostics panel is exempt: it exists to be readable precisely when
    // the entry flow is misbehaving, so hiding it would defeat it.
    expect(css).toMatch(
      /html\[data-age-verified="false"\] body > \*:not\(\[data-age-gate\]\):not\(script\):not\(\[data-entry-diagnostics\]\)\s*\{\s*visibility:\s*hidden/,
    );
  });

  it("keeps the page in the document so crawlers still see it", () => {
    // visibility, not display — the server-rendered HTML must stay real.
    const rule = css.slice(css.indexOf('body > *:not([data-age-gate])'));
    expect(rule.slice(0, 120)).not.toMatch(/display:\s*none/);
  });

  it("puts no link inside a tappable attestation row", () => {
    // Everything between the ATTESTATIONS map and the end of the label must be
    // inert text. One <a> in there is the whole bug.
    const start = gate.indexOf("{ATTESTATIONS.map(");
    const end = gate.indexOf("</label>", start);
    expect(start).toBeGreaterThan(-1);
    expect(gate.slice(start, end)).not.toMatch(/<a\b/);
  });

  it("still offers both policies, just out of the way", () => {
    expect(gate).toContain('href="/legal/terms"');
    expect(gate).toContain('href="/legal/research-disclaimer"');
  });

  it("gives every row real text now that none carries markup", () => {
    expect(gate).not.toMatch(/text:\s*null/);
    const ids = gate.match(/\{\s*id:\s*"/g) ?? [];
    expect(ids.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The entry flow works in Safari and Chrome and misbehaves in the TikTok
// in-app browser. These guard the two things about that class of browser that
// no desktop engine reproduces.
// ---------------------------------------------------------------------------
describe("the gate survives an app's own toolbars", () => {
  const css = read("src/app/globals.css");
  const gate = read("src/components/age-gate.tsx");

  it("insets itself for the safe area at BOTH ends", () => {
    // Safari insets the page for its chrome; the TikTok and Instagram webviews
    // overlay theirs on the viewport. The entry buttons sit at the bottom of a
    // tall card, so with no inset they can sit under the app's own bar — where
    // the button is enabled, the tap lands on the toolbar, and it reads as
    // "it won't let me sign in".
    const rule = css.slice(css.indexOf("\n[data-age-gate] {\n  padding-top"));
    expect(rule.slice(0, 200)).toMatch(/padding-top:\s*calc\([^)]*env\(safe-area-inset-top\)/);
    expect(rule.slice(0, 200)).toMatch(/padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/);
  });

  it("sends everyone to the same place, computed from nothing", () => {
    // No pathname, referrer, history or redirect parameter may influence it —
    // that is what let a TikTok URL and a legal page choose the destination.
    expect(gate).toMatch(/const POST_GATE_DESTINATION = "\/";/);
    // Clearing the gate is not a navigation: the visitor stays on the page
    // they asked for, so an ad or bio link straight to a product still works.
    // The single exception is a legal page, which nobody chooses as a
    // destination and which an in-app browser can land you on by accident.
    expect(gate).toMatch(/const NEVER_A_DESTINATION = \["\/legal"\];/);
    expect(gate).toMatch(/if \(stranded\) return POST_GATE_DESTINATION;/);
    // The hero animation is skipped ONLY where it does not work, and the
    // bounce happens ONLY from the home page — a visitor who asked for a
    // specific page keeps it.
    expect(gate).toMatch(/const SOCIAL_DESTINATION = "\/products";/);
    expect(gate).toMatch(
      /if \(pathname === POST_GATE_DESTINATION && heroAnimationUnsupported\(\)\) \{/,
    );
    // Attribution must survive the redirect or paid traffic stops being
    // measurable, and the loss would be invisible until a report came back empty.
    expect(gate).toMatch(/return `\$\{SOCIAL_DESTINATION\}\$\{query\}`;/);
    // Judged on arrival, never on a destination a link asserts.
    expect(gate).not.toMatch(/params\.get\("(next|redirect|returnTo|redirectTo)"\)/);
    // Comments are allowed to NAME these; code is not allowed to call them.
    const code = gate
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of ["router.back(", "history.back(", "searchParams"]) {
      expect(code, `the destination must not be derived from ${forbidden}`).not.toContain(forbidden);
    }

    // document.referrer is a special case. Reading it to CLASSIFY a visitor as
    // an in-app browser is fine and is what heroAnimationUnsupported does. Using
    // it to build a destination would not be: the referrer is attacker-
    // controlled, so a
    // path derived from it is an open redirect. Allow the read, and require the
    // destination to remain one of the two hard-coded constants.
    // Bound the slice to this function alone: it is declared at the top level,
    // so the next line that is exactly "}" closes it.
    const fnStart = code.indexOf("function destinationAfterGate");
    const after = code.slice(fnStart);
    const destinationFn = after.slice(0, after.indexOf("\n}") + 2);
    expect(destinationFn, "the destination function must not read the referrer")
      .not.toContain("document.referrer");
    const returnedPaths = [...destinationFn.matchAll(/return ([^;]+);/g)].map((m) => m[1].trim());
    for (const returned of returnedPaths) {
      expect(
        ["POST_GATE_DESTINATION", "null", "`${SOCIAL_DESTINATION}${query}`"],
        `destinationAfterGate returned an unexpected expression: ${returned}`,
      ).toContain(returned);
    }
  });

  it("can report which build a browser was actually handed", () => {
    // An in-app webview cannot be attached to a debugger, so the page has to
    // answer for itself whether it is even the new deployment.
    const diag = read("src/components/entry-diagnostics.tsx");
    expect(diag).toContain('get("debug_entry") === "1"');
    expect(diag).toContain("NEXT_PUBLIC_BUILD_ID");
    expect(diag).toContain("navigator.userAgent");
    // Storage in an embedded webview can throw; probing it must not.
    expect(diag).toMatch(/THREW/);
  });
});

// ---------------------------------------------------------------------------
// THE TICK BOX IS DRAWN BY US NOW, WHICH MOVES THREE GUARANTEES ONTO US.
//
// It was the browser's own control with accent-color set. That paints the
// CHECKED state champagne and leaves the unchecked one a stock white square —
// the only piece of another design system on the panel, and the piece the eye
// lands on first, because it is the thing you came here to click.
//
// appearance:none buys the store's own materials and takes on what the native
// control was providing for free. All three below are invisible in a normal
// desktop browser, which is exactly why they need pinning.
// ---------------------------------------------------------------------------
describe("the restyled tick box keeps what the native control gave for free", () => {
  const gate = read("src/components/age-gate.tsx");
  const css = read("src/app/globals.css");
  const rules = css.slice(css.indexOf(".vl-gate-check {"));

  it("is still a real checkbox, only repainted", () => {
    // The moment this becomes a styled div, keyboard operation, the accessible
    // role and every QA harness that drives input[type=checkbox] go with it.
    expect(gate).toMatch(/<input\s+type="checkbox"/);
    expect(gate).toMatch(/className="vl-gate-check/);
    expect(gate).toMatch(/checked=\{Boolean\(confirmed\[attestation\.id\]\)\}/);
    expect(gate).toMatch(/onChange=\{\(event\) => toggle\(/);
  });

  it("hands the native control back under forced colours", () => {
    // Windows High Contrast replaces our colours with the user's, so an
    // appearance:none box would render as two empty squares with no way to
    // tell ticked from unticked.
    expect(rules).toMatch(/@media \(forced-colors: active\)/);
    const forced = rules.slice(rules.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/appearance:\s*auto/);
  });

  it("draws its own focus indicator, since it no longer inherits one", () => {
    expect(rules).toMatch(/\.vl-gate-check:focus-visible\s*\{[^}]*outline:/);
  });

  it("keeps a boundary strong enough to find (WCAG 1.4.11)", () => {
    // A control boundary needs 3:1 against its background. The unchecked
    // border is champagne at 0.62 over the row, which computes to about
    // 3.5:1; the softer values that look tidier fall under it, and a
    // low-vision visitor then cannot see where the box is.
    const border = rules.match(/\.vl-gate-check\s*\{[^}]*border:\s*1px solid rgba\(199,\s*174,\s*94,\s*([\d.]+)\)/);
    expect(border, "the unchecked border must stay a champagne rgba value").not.toBeNull();
    expect(Number(border![1])).toBeGreaterThanOrEqual(0.6);
  });
});

// The two policy links on the gate are the first links a visitor can tap, and
// they were 107x17 at 320px — under the 24px minimum in WCAG 2.2 AA 2.5.8.
// py-1 grows the box to 24px+ and -my-1 gives the layout back, so the
// sentence keeps its line box. Same treatment as the Cookie Policy link.
describe("the gate's policy links are tappable", () => {
  it("pads both policy links to a 24px tap target", () => {
    const code = readFileSync(
      join(process.cwd(), "src/components/age-gate.tsx"),
      "utf8",
    );
    const links = code.match(/<a\s[^>]*href="\/legal\/[^"]*"[\s\S]*?>/g) ?? [];
    expect(links.length).toBe(2);
    for (const link of links) {
      expect(link).toContain("py-1");
      expect(link).toContain("-my-1");
      expect(link).toContain("inline-block");
    }
  });
});

// ---------------------------------------------------------------------------
// THE HERO ANIMATION IS SKIPPED ONLY WHERE IT DOES NOT WORK.
//
// The spinning vial is the home page, and the owner wants it seen. It is
// skipped for exactly one reason: an app's embedded browser could not play it.
// Five rounds of fixes ended with an iPhone showing the vial alone on white, so
// those visitors are sent to the catalog instead and hero-video.tsx serves them
// a still.
//
// That skip used to be keyed on "came from social", which is a much wider net
// than the one platform that breaks. Measured on the harness, 2026-08-28,
// BEFORE this change — every one of these lost the home page:
//
//   Safari iOS        + ?ttclid=                        -> /products
//   Safari iOS        + ?fbclid=                        -> /products
//   Safari iOS        + utm_source=tiktok               -> /products
//   Desktop Chrome    + ?ttclid=                        -> /products
//   Desktop Chrome    + utm_source=google&utm_medium=paid -> /products
//
// The last one is the sharpest: a Google Ads click on a desktop, on a browser
// that renders the canvas hero perfectly, never saw it. None of these browsers
// has the bug the skip exists for. The owner's rule is "keep the vial, skip it
// where it doesn't work" — so the classifier is the in-app check and nothing
// else.
//
// A campaign marker must not decide this. It says where a visitor came FROM,
// not what their browser can render, and it is attacker-supplied besides.
// ---------------------------------------------------------------------------

describe("the home page is skipped only where the hero cannot play", () => {
  const gate = read("src/components/age-gate.tsx");

  it("decides on the browser, never on a campaign marker or referrer", () => {
    const fnStart = gate.indexOf("function heroAnimationUnsupported");
    expect(fnStart, "heroAnimationUnsupported must exist").toBeGreaterThan(-1);
    const after = gate.slice(fnStart);
    const fn = after.slice(0, after.indexOf("\n}") + 2);

    // The whole decision, and the only input it is allowed.
    expect(fn).toContain("detectInAppBrowser()");

    // The markers that used to drive it. A browser that renders the hero must
    // keep the home page no matter which link it arrived through.
    for (const marker of [
      "ttclid",
      "fbclid",
      "igshid",
      "sccid",
      "twclid",
      "utm_source",
      "utm_medium",
      "document.referrer",
      "location.search",
      "URLSearchParams",
    ]) {
      expect(
        fn,
        `${marker} says where a visitor came from, not whether their browser can play the hero`,
      ).not.toContain(marker);
    }
  });

  it("still carries attribution across the bounce it does make", () => {
    // Narrowing the trigger must not quietly drop the query on the visitors
    // who ARE still redirected, or in-app paid traffic stops being measurable.
    expect(gate).toMatch(/return `\$\{SOCIAL_DESTINATION\}\$\{query\}`;/);
  });

  it("keeps the in-app skip that the whole mechanism exists for", () => {
    // hero-video.tsx serves these visitors a still image; this sends them to
    // the catalog. Both halves are the same decision and must agree.
    expect(gate).toContain("detectInAppBrowser");
    expect(read("src/components/hero-video.tsx")).toContain("detectInAppBrowser");
  });
});

// ---------------------------------------------------------------------------
// The gate renders on all 111 public URLs, so its heading is on all of them.
// ---------------------------------------------------------------------------
describe("the age gate does not add a second H1 to every page", () => {
  const src = readFileSync(join(process.cwd(), "src/components/age-gate.tsx"), "utf8");

  it("titles the dialog with something other than an h1", () => {
    // Measured on production: every one of the 55 sitemap URLs carried two H1s
    // — the page's own, plus this one. A modal's title is not the document's
    // top-level heading, and the page underneath already has one.
    expect(src).not.toMatch(/<h1[^>]*id="age-gate-title"/);
    expect(src).toMatch(/<h2[^>]*id="age-gate-title"/);
  });

  it("still names the dialog through the same id", () => {
    // aria-labelledby resolves by id and does not care about the tag, so the
    // accessible name is unchanged. This is the whole reason the swap is safe;
    // if the id or the reference ever moves, the dialog goes unnamed.
    expect(src).toMatch(/aria-labelledby="age-gate-title"/);
    expect(src).toMatch(/id="age-gate-title"/);
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
  });

  it("keeps the heading's styling classes, so nothing moves", () => {
    const heading = src.match(/<h2[^>]*id="age-gate-title"[^>]*>/)?.[0] ?? "";
    for (const cls of ["vl2-serif", "mt-4", "text-4xl", "text-white", "sm:text-5xl"]) {
      expect(heading).toContain(cls);
    }
  });
});
