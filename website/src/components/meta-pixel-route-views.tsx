"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    /**
     * Defined by the inline base code in components/meta-pixel.tsx before any
     * React code runs, so it exists wherever the pixel is permitted. The
     * fourth argument of `track` carries `eventID`, which is how Meta collapses
     * a browser event and a Conversions API event describing the same action.
     */
    fbq?: (command: string, ...args: unknown[]) => void;
  }
}

/**
 * PageView on client-side navigation.
 *
 * The inline base code fires PageView once on load. This is a single-page
 * app, so after that navigation never reloads the document, and without this
 * every visit would report exactly one page view however much of the site
 * someone read. The first run is skipped so the landing page is not counted
 * twice. Unlike gtag.js, fbevents does not watch the History API itself.
 */
export function MetaPixelRouteViews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialPageSent = useRef(false);

  useEffect(() => {
    if (!initialPageSent.current) {
      initialPageSent.current = true;
      return;
    }
    window.fbq?.("track", "PageView");
  }, [pathname, searchParams]);

  return null;
}
