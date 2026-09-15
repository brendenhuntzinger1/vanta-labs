"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    /**
     * Defined by the inline snippet in components/omnisend-snippet.tsx before
     * any React code runs, so it exists wherever the snippet is permitted. An
     * array until the launcher loads (the snippet queues commands into it),
     * then the SDK's own object, whose `push` runs them directly. Both accept
     * the same command tuples, which is all this component ever sends.
     */
    omnisend?: { push: (command: unknown[]) => unknown };
  }
}

/**
 * $pageViewed on client-side navigation.
 *
 * The inline snippet fires it once on load. This is a single-page app, so
 * after that navigation never reloads the document, and without this every
 * visit would report exactly one page view however much of the site someone
 * read. The first run is skipped so the landing page is not counted twice.
 * Optional-chained so a blocked or not-yet-loaded SDK is a no-op.
 */
export function OmnisendRouteViews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialPageSent = useRef(false);

  useEffect(() => {
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.omnisend?.push(["track", "$pageViewed"]);
  }, [pathname, searchParams]);

  return null;
}
