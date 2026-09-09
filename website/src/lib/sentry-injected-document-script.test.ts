import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isInjectedDocumentScriptError } from "@/lib/sentry-init";

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
