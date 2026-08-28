import type { init as SentryInit } from "@sentry/nextjs";

import {
  scrubBreadcrumb,
  scrubEvent,
  sentryDsn,
  sentryEnvironment,
  sentryRelease,
} from "@/lib/sentry-privacy";

type SentryInitOptions = Parameters<typeof SentryInit>[0];

/**
 * One Sentry configuration, shared by the browser, Node and Edge runtimes.
 *
 * Three separate init calls that drift apart is how a privacy rule ends up
 * applied on the server and not in the browser, so the options live here and
 * each runtime passes only what is genuinely runtime-specific.
 *
 * Deliberate omissions, each of which Sentry offers and we decline:
 *
 *   SESSION REPLAY — records the DOM. On a checkout page that is a video of
 *   somebody typing their address. Not enabled.
 *
 *   sendDefaultPii — attaches IP address, cookies and user identity. Off, and
 *   scrubEvent deletes those sections anyway so a future accidental `true`
 *   cannot leak them.
 *
 *   TRACING — sampled at 0. Spans carry URLs and request metadata for every
 *   request, not just failing ones, which multiplies the PII surface and the
 *   bill in exchange for performance data we are not asking for yet. Raise
 *   deliberately if performance becomes the question.
 */
/**
 * Scripts that in-app browsers INJECT into every page they render.
 *
 * These are not ours and we cannot fix them. Instagram's Android WebView
 * injects `navigation_performance_logger_android`, which posts timing data over
 * a Java bridge; when the user navigates away the bridge is torn down first, so
 * its own `beforeunload` handler throws "Error invoking postMessage: Java
 * object is gone". Sentry sees it only because its automatic instrumentation
 * wraps addEventListener callbacks and reports a throw from ANY handler,
 * including one injected by the host app.
 */
const IN_APP_BROWSER_INJECTED_SCRIPTS = [
  "navigation_performance_logger_android",
  "navigation_performance_logger_ios",
];

/**
 * Is this an error thrown by an in-app browser's own injected instrumentation?
 *
 * NARROW ON PURPOSE, and keyed on the SCRIPT rather than on the browser. A real
 * bug that happens to occur in the Instagram or TikTok webview is exactly the
 * kind this project cares most about — the working agreement calls out in-app
 * browser behaviour by name — so "the user agent is Instagram" must never be
 * the reason an event is dropped. What is dropped is an error whose own stack
 * frames are the host app's injected logger and none of which are ours.
 *
 * Why drop rather than sample: this scales with paid social traffic, which is
 * about to start. One customer in Brazil produced two of these on 2026-08-26
 * with zero users impacted; a launch campaign produces them by the thousand,
 * and they would bury the errors that do matter.
 */
export function isInAppBrowserInjectedScriptError(event: {
  exception?: { values?: Array<{ stacktrace?: { frames?: Array<{ filename?: string }> } }> };
}): boolean {
  const frames = (event.exception?.values ?? [])
    .flatMap((value) => value.stacktrace?.frames ?? []);
  if (frames.length === 0) return false;

  const filenames = frames.map((frame) => String(frame.filename ?? ""));
  const fromInjectedScript = filenames.some((name) =>
    IN_APP_BROWSER_INJECTED_SCRIPTS.some((script) => name.includes(script)),
  );
  if (!fromInjectedScript) return false;

  // If any frame is OUR bundle, the injected script may merely be in the path
  // of a real bug of ours. Keep it.
  const touchesOurCode = filenames.some((name) => name.includes("/_next/"));
  return !touchesOurCode;
}

export function baseSentryOptions(): SentryInitOptions & { dsn: string } {
  const dsn = sentryDsn();
  if (!dsn) throw new Error("baseSentryOptions called without a DSN");

  return {
    dsn,
    release: sentryRelease(),
    environment: sentryEnvironment(),

    // Errors only. See the note above before raising this.
    tracesSampleRate: 0,

    // Never attach IP, cookies or user identity.
    sendDefaultPii: false,

    // Every error, while volume is low. Worth revisiting only if a noisy
    // third-party error starts drowning the signal.
    sampleRate: 1,

    // Breadcrumbs are the reason a bug like the age-gate/payment one is
    // diagnosable — they show the navigation that preceded the error. They are
    // also the likeliest accidental PII carrier, hence the scrub below.
    maxBreadcrumbs: 30,

    /**
     * The last gate before anything leaves the process.
     *
     * If scrubbing throws we DROP the event. Returning the unscrubbed event
     * would be the one failure mode this whole module exists to prevent.
     */
    beforeSend(event) {
      try {
        // Dropped BEFORE scrubbing: there is nothing to learn from it, and it
        // arrives in proportion to paid social traffic.
        if (isInAppBrowserInjectedScriptError(event)) return null;
        return scrubEvent(event);
      } catch {
        return null;
      }
    },

    beforeSendTransaction(event) {
      try {
        return scrubEvent(event);
      } catch {
        return null;
      }
    },

    beforeBreadcrumb(crumb) {
      try {
        return scrubBreadcrumb(crumb);
      } catch {
        return null;
      }
    },

    /**
     * Noise that is not a Vanta Labs defect: browser extensions, in-app webview
     * quirks, and network interruptions a shopper on mobile data will generate
     * routinely. Filtering these at the source keeps the issue list readable,
     * which is what makes a real defect visible in it.
     */
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured",
      /^AbortError/,
      /Failed to fetch/i,
      /NetworkError when attempting to fetch/i,
      /Load failed/i,
      // Injected by extensions and in-app browsers, not by us.
      /chrome-extension:\/\//,
      /safari-extension:\/\//,
      /moz-extension:\/\//,
    ],

    denyUrls: [/chrome-extension:\/\//, /safari-extension:\/\//, /moz-extension:\/\//],
  };
}

/** True when a DSN is configured. Local dev and the test suite stay silent. */
export function sentryEnabled(): boolean {
  return Boolean(sentryDsn());
}

export type SentryDsnState =
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "ok"; host: string; projectId: string; browser: boolean };

/**
 * Is the BROWSER reporting, or only the server?
 *
 * `sentryDsn()` accepts either variable, which is right for the server and a
 * trap for the client: only `NEXT_PUBLIC_`-prefixed variables are inlined into
 * client bundles, so with `SENTRY_DSN` alone `sentryEnabled()` is true on the
 * server, false in the browser, and instrumentation-client.ts silently never
 * calls init. Nothing errors. Sentry simply receives nothing from any browser,
 * and "no browser errors" reads exactly like "no browser problems".
 *
 * That distinction is not academic. After the second real production purchase
 * the question was whether the shopper's phone had reported anything, and the
 * answer — Sentry held nothing from that session — is only reassuring if the
 * browser leg was actually armed. This makes it answerable from a status
 * screen instead of from a browser we may not be able to reach.
 */
export function browserSentryConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN?.trim());
}

/**
 * Whether the configured DSN is one Sentry will actually accept — decided
 * WITHOUT calling Sentry.init, so this can be asked from a status screen
 * without arming a second client.
 *
 * This exists because of a real production failure. Vercel briefly held the
 * literal string "SENTRY_DSN" as the value of the DSN variable — the variable's
 * own NAME pasted into its value box. Sentry.init threw `Invalid Sentry Dsn:
 * SENTRY_DSN` on eight routes, server-side reporting was off for that whole
 * deployment, and the only trace was a line in the platform log. Sentry itself
 * cannot report that Sentry is down, so something else has to be able to say so.
 *
 * Never returns the public key, only the parts that identify WHICH project is
 * configured.
 */
export function sentryDsnState(): SentryDsnState {
  const dsn = sentryDsn();
  if (!dsn) return { state: "missing" };

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return { state: "invalid", reason: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { state: "invalid", reason: "not an http(s) URL" };
  }
  // Sentry's own shape: https://<publicKey>@<host>/<projectId>
  if (!url.username) return { state: "invalid", reason: "no public key" };
  const projectId = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!/^\d+$/.test(projectId)) return { state: "invalid", reason: "no project id" };

  return { state: "ok", host: url.host, projectId, browser: browserSentryConfigured() };
}
