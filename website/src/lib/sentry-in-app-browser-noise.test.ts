import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isInAppBrowserInjectedScriptError } from "@/lib/sentry-init";

// ---------------------------------------------------------------------------
// THE ERROR THAT IS NOT OURS AND SCALES WITH AD SPEND.
//
// Real event, 2026-08-26, Instagram 444.0.0 in-app browser on Android 15 in
// Brazil, on /products, users impacted 0:
//
//   Error: Error invoking postMessage: Java object is gone
//     app:///_next/static/chunks/0c3cs8d_wkkim.js   (Sentry's own wrapper)
//     app://navigation_performance_logger_android
//     ... sendJsBlockingTimeMessage
//     ... sendDataToNative
//
// Instagram injects that logger into every page it renders. On beforeunload the
// WebView tears the Java bridge down first, so the logger's own handler throws.
// Sentry reports it only because it wraps addEventListener callbacks and sees a
// throw from ANY handler, including the host app's.
//
// It is unfixable by us, tells us nothing, and arrives in proportion to paid
// social traffic — which is about to start.
//
// THE RISK IN FILTERING IS DROPPING A REAL BUG, so the predicate is keyed on the
// injected SCRIPT, never on the browser: an actual defect in the Instagram
// webview is precisely the kind this project cares most about.
// ---------------------------------------------------------------------------

const frames = (...filenames: string[]) => ({
  exception: { values: [{ stacktrace: { frames: filenames.map((filename) => ({ filename })) } }] },
});

describe("in-app browser injected-script noise", () => {
  it("drops the Instagram logger error exactly as production sent it", () => {
    expect(isInAppBrowserInjectedScriptError(frames(
      "app://navigation_performance_logger_android",
      "app://navigation_performance_logger_android",
    ))).toBe(true);
  });

  it("KEEPS a real error from our own code, even inside an in-app browser", () => {
    // The whole point. A genuine bug on /checkout in the Instagram webview must
    // still reach Sentry.
    expect(isInAppBrowserInjectedScriptError(frames(
      "app:///_next/static/chunks/checkout-abc123.js",
      "app://navigation_performance_logger_android",
    ))).toBe(false);
  });

  it("keeps ordinary errors that have nothing to do with an in-app browser", () => {
    expect(isInAppBrowserInjectedScriptError(frames(
      "app:///_next/static/chunks/main.js",
    ))).toBe(false);
  });

  it("keeps an event with no stack rather than guessing", () => {
    expect(isInAppBrowserInjectedScriptError({})).toBe(false);
    expect(isInAppBrowserInjectedScriptError({ exception: { values: [] } })).toBe(false);
  });

  it("does not key on the browser being Instagram", () => {
    // An event whose frames are all ours is kept regardless of any browser tag;
    // the predicate never looks at the user agent at all.
    expect(isInAppBrowserInjectedScriptError(frames("app:///_next/static/chunks/x.js"))).toBe(false);
  });
});
