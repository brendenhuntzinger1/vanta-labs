/**
 * Browser observability. Runs after the document loads and BEFORE React
 * hydrates, so a hydration failure is itself captured.
 *
 * onRouterTransitionStart is the reason this file matters for us specifically.
 * The launch-blocking bug we hit — "Continue to secure payment" landing on the
 * age gate — was a NAVIGATION seam: a full-document load reset in-memory state.
 * A breadcrumb per client-side transition is what makes the difference between
 * "an error on /checkout/pay" and "an error on /checkout/pay reached by a hard
 * navigation from /checkout", which is the sentence that identifies that class
 * of bug.
 */
import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, sentryEnabled } from "@/lib/sentry-init";

if (sentryEnabled()) {
  try {
    Sentry.init({
      ...baseSentryOptions(),
      integrations: [
        // Navigation and click breadcrumbs, with DOM text left out: a breadcrumb
        // naming the button is useful, one quoting a typed value is not.
        Sentry.breadcrumbsIntegration({ dom: { serializeAttribute: [] } }),
        Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: true }),
      ],
    });
  } catch {
    // Instrumentation must never be the reason a page fails to load.
  }
}

export function onRouterTransitionStart(url: string, navigationType: string) {
  if (!sentryEnabled()) return;
  try {
    Sentry.addBreadcrumb({
      category: "navigation",
      level: "info",
      // The URL is scrubbed by beforeBreadcrumb; only the path survives.
      message: `router ${navigationType}`,
      data: { to: url, navigationType },
    });
  } catch {
    /* never block a navigation */
  }
}
