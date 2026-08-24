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
