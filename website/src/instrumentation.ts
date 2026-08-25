/**
 * Server-side observability. Next.js calls register() once per server instance
 * and onRequestError whenever it captures a server error.
 *
 * IMPORTANT LIMIT, and the reason src/lib/monitoring.ts also reports to Sentry:
 * onRequestError only fires for errors Next.js SEES. Our webhook and cron route
 * handlers catch their own errors and return a JSON response — deliberately, so
 * a processor retries rather than sees a 500. Those never reach here. They call
 * recordSystemAlert instead, which is where they get forwarded.
 */
import type { Instrumentation } from "next";

export async function register() {
  const { sentryEnabled, baseSentryOptions } = await import("@/lib/sentry-init");
  if (!sentryEnabled()) return;

  // register() must COMPLETE before the server accepts requests, so nothing in
  // here may throw. A malformed DSN makes Sentry.init throw — production has
  // already seen it, when the DSN variable briefly held its own name as its
  // value ("Invalid Sentry Dsn: SENTRY_DSN", eight routes, one deployment).
  // The browser side has always been wrapped; this is the same guarantee for
  // the server. The failure is not swallowed silently: it is logged, and
  // /admin/status reports the DSN as unusable via sentryDsnState().
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init(baseSentryOptions());
  } catch (error) {
    console.error("[sentry] server init failed — server-side error reporting is OFF", error);
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { sentryEnabled } = await import("@/lib/sentry-init");
  if (!sentryEnabled()) return;

  const Sentry = await import("@sentry/nextjs");
  // captureRequestError applies Sentry's own Next.js request handling; our
  // beforeSend still runs afterwards and strips the request payload.
  Sentry.captureRequestError(err, request, context);
};
