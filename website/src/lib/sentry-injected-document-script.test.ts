import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { baseSentryOptions, isInjectedDocumentScriptError } from "@/lib/sentry-init";

// ---------------------------------------------------------------------------
// ERRORS THAT LOOK LIKE OURS BECAUSE THEY HAPPEN INSIDE OUR DOCUMENT.
//
// An inline script has no URL, so window.onerror blames the document and
// RewriteFrames turns that into `app:///account/login` — byte for byte the
// filename a real bug of ours would carry. Four such issues were open against
// /account/login on 2026-09-09, all with zero users impacted, and one of them
// paged by email.
//
// What settled it, rather than assuming:
//   - the served document is complete and byte-identical across five fetches,
//     and all 31 of its script tags parse in a real engine;
//   - `toLowerCase` and `domInteractive` appear ZERO times in that HTML;
//   - the JSON-LD reader is reported at exactly 3:362 on TWO different pages
//     across TWO releases, which no code we serve could manage, and our own
//     line 3 is 45 characters long so column 362 does not exist on it.
//
// THE RISK IN FILTERING IS DROPPING A REAL BUG. So the predicate needs BOTH a
// known signature and a stack with no frame of ours, and the last two tests
// here are the ones that matter most.
// ---------------------------------------------------------------------------

const event = (value: string, ...filenames: string[]) => ({
  exception: {
    values: [{ value, stacktrace: { frames: filenames.map((filename) => ({ filename })) } }],
  },
});

describe("injected document-script noise", () => {
  it("drops the truncated inline script exactly as production sent it", () => {
    // VANTA-LABS-W, Mobile Safari 26.5.2 / iOS, one frame, no column.
    expect(
      isInjectedDocumentScriptError(
        event("Unexpected end of script", "app:///account/login"),
      ),
    ).toBe(true);
  });

  it("drops the injected JSON-LD reader on both pages it reached", () => {
    // VANTA-LABS-P and VANTA-LABS-J: identical coordinates, different pages.
    const message = `undefined is not an object (evaluating 'r["@context"].toLowerCase')`;
    expect(
      isInjectedDocumentScriptError(event(message, "app:///account/login", "app:///account/login")),
    ).toBe(true);
    expect(
      isInjectedDocumentScriptError(
        event(message, "app:///account/auth/callback", "app:///account/auth/callback"),
      ),
    ).toBe(true);
  });

  it("still drops it when the extension renames its minified variable", () => {
    // Matched on the property access, not on the receiver being `r`.
    expect(
      isInjectedDocumentScriptError(
        event(`undefined is not an object (evaluating 'Q["@context"].toLowerCase')`, "app:///account/login"),
      ),
    ).toBe(true);
  });

  it("KEEPS the same message when a frame is our own bundle", () => {
    // The whole point. If a chunk we shipped can produce it, we must see it.
    expect(
      isInjectedDocumentScriptError(
        event(
          "Unexpected end of script",
          "app:///_next/static/chunks/10z9urhdbhlq3.js",
          "app:///account/login",
        ),
      ),
    ).toBe(false);
  });

  it("KEEPS the Next.js currentScript invariant, which is not one of these", () => {
    // VANTA-LABS-T: a real framework interaction in an Android WebView, whose
    // frames are all turbopack chunks. Nothing here should touch it.
    expect(
      isInjectedDocumentScriptError(
        event(
          "Invariant: Expected document.currentScript to be a <script> element. Received null instead. This is a bug in Next.js.",
          "app:///_next/static/chunks/turbopack-3raax84g4yvib.js",
          "app:///_next/static/chunks/10z9urhdbhlq3.js",
        ),
      ),
    ).toBe(false);
  });

  it("keeps an ordinary error of ours that happens to be on the same page", () => {
    expect(
      isInjectedDocumentScriptError(
        event("Cannot read properties of undefined (reading 'email')", "app:///account/login"),
      ),
    ).toBe(false);
  });

  it("keeps an event with no stack, and one with no exception, rather than guessing", () => {
    expect(isInjectedDocumentScriptError(event("Unexpected end of script"))).toBe(false);
    expect(isInjectedDocumentScriptError({})).toBe(false);
    expect(isInjectedDocumentScriptError({ exception: { values: [] } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AND THE ONE ON THAT PAGE THAT IS NOT NOISE.
//
// VANTA-LABS-T sits on /account/login alongside the four above, reads like more
// third-party breakage, and is the opposite: it breaks the page.
//
// next/dist/client/app-bootstrap.js:
//
//     export function appBootstrap(hydrate) {
//       const assetPrefix = getAssetPrefix();     // <- throws here
//       loadScriptsInSequence(self.__next_s, () => { ... hydrate(assetPrefix) })
//     }
//
// getAssetPrefix() reads document.currentScript and throws an InvariantError if
// it is not a <script>. It is called BEFORE hydrate, synchronously, so when it
// throws React never attaches and the sign-in form is inert — a dead page, not
// a logged warning. It reached us three times on 2026-09-09 from Chrome Mobile
// WebView, MiuiBrowser and one implausible Chrome/Mac OS X 10.14.5 UA.
//
// There is no config escape: getAssetPrefix consults nothing but
// document.currentScript, so setting assetPrefix in next.config cannot avoid
// it, and 16.2.12 — the newest 16.2 patch as of 2026-09-10 — ships the function
// byte-identical to the 16.2.10 we run. Next.js names itself in the message.
//
// DO NOT ADD THIS TO ignoreErrors. It is on the same page as four filtered
// signatures, its stack is all framework chunks, and Sentry reports "0 users
// impacted" for it — which in this project means nothing at all, because
// scrubEvent deletes event.user from every event (see sentry-privacy.test.ts).
// Every cue points at noise and every one of them is misleading.
// ---------------------------------------------------------------------------

describe("the Next.js hydration invariant stays visible", () => {
  const CURRENT_SCRIPT = "Expected document.currentScript to be a <script> element";

  it("is not filtered by either frame predicate", () => {
    const framework = event(
      `Invariant: ${CURRENT_SCRIPT}. Received null instead. This is a bug in Next.js.`,
      "app:///_next/static/chunks/turbopack-2e70y2-91xhpb.js",
      "app:///_next/static/chunks/2kg5-k8lbktue.js",
    );
    expect(isInjectedDocumentScriptError(framework)).toBe(false);
  });

  it("is not silenced by ignoreErrors, where it would look like it belonged", () => {
    // baseSentryOptions refuses to build without a DSN, which is correct — see
    // the same dance in auth-alert-accuracy.test.ts.
    const previous = process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://abc123@o1.ingest.sentry.io/42";
    const patterns = (baseSentryOptions().ignoreErrors ?? []) as Array<string | RegExp>;
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = previous;
    const message = `Invariant: ${CURRENT_SCRIPT}. Received null instead. This is a bug in Next.js.`;

    const silencedBy = patterns.find((pattern) =>
      typeof pattern === "string" ? message.includes(pattern) : pattern.test(message),
    );

    expect(silencedBy,
      "a pattern now swallows the hydration invariant — that is a dead login form "
      + "reported as nothing").toBeUndefined();
  });
});
