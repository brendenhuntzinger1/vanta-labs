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
// Age verification is no longer persisted anywhere. These rules exist so it
// cannot quietly come back.
// ---------------------------------------------------------------------------

describe("age verification is never remembered", () => {
  const gate = read("src/components/age-gate.tsx");
  const layout = read("src/app/layout.tsx");

  it("never READS a stored answer from anywhere", () => {
    // The whole class of bypass: any read of a previous session's answer.
    expect(gate).not.toMatch(/localStorage\.getItem/);
    expect(gate).not.toMatch(/sessionStorage/);
    // The only permitted cookie reference is the removal on exit, below.
    expect(gate).not.toMatch(/document\.cookie\.split/);
    expect(gate).not.toMatch(/useSyncExternalStore/);
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

  it("holds the answer only in component state for this document", () => {
    // The answer is component state plus the staff-area exemption below —
    // never a stored value.
    expect(gate).toMatch(/const isVerified = localVerified \|\| isStaffArea;/);
    expect(gate).toMatch(/useState\(false\)/);
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

  it("still requires all four attestations before entry", () => {
    expect(gate).toContain("const agreed = ATTESTATIONS.every((a) => confirmed[a.id]);");
    expect(gate).toMatch(/disabled=\{!agreed\}/);
    const ids = gate.match(/\{\s*id:\s*"/g) ?? [];
    expect(ids.length).toBe(4);
  });

  it("exempts the staff areas, and ONLY the staff areas", () => {
    // /admin and /vault are behind authentication and are not customer facing.
    // Since confirmation is no longer remembered for anyone, gating them would
    // mean re-attesting on every admin page load during order and inventory
    // work, for no protective benefit.
    expect(gate).toContain('const STAFF_ONLY = ["/admin", "/vault"];');
    expect(gate).toMatch(/const isVerified = localVerified \|\| isStaffArea;/);
    // Nothing a shopper can reach may appear in that list.
    for (const shopper of ["/products", "/cart", "/checkout", "/account", "/membership", "/ambassador"]) {
      expect(gate, `${shopper} must never be exempt from the gate`)
        .not.toMatch(new RegExp(`STAFF_ONLY[^\\]]*${shopper}`));
    }
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
    // 0.82 is the designed blend with the hero gradient — visible, not hidden.
    expect(css).toMatch(/\.vl2-hero-video\s*\{[^}]*opacity:\s*0\.8/);
    expect(css).not.toMatch(/\.vl2-hero-video\s*\{[^}]*opacity:\s*0;/);
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
//   * so all four boxes could never be held ticked at once, and the sign-in
//     buttons stayed disabled.
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

  it("gives all four rows real text now that none carries markup", () => {
    expect(gate).not.toMatch(/text:\s*null/);
    const ids = gate.match(/\{\s*id:\s*"/g) ?? [];
    expect(ids.length).toBe(4);
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
    // Social traffic is sent to the catalog, and ONLY from the home page — a
    // visitor who asked for a specific page keeps it.
    expect(gate).toMatch(/const SOCIAL_DESTINATION = "\/products";/);
    expect(gate).toMatch(/if \(pathname === POST_GATE_DESTINATION && cameFromSocial\(\)\) \{/);
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
    // social traffic is fine and is what cameFromSocial does. Using it to build
    // a destination would not be: the referrer is attacker-controlled, so a
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
