"use client";

import { useEffect, useRef } from "react";
import { browserFiredStore, buildViewContent, emitEvent, type Emitter } from "@/lib/ads/tiktok-events";
import { whenPixelReady } from "@/lib/ads/pixel-ready";

/**
 * ViewContent for a product page.
 *
 * Rendered as a sibling of the product detail component rather than inside it,
 * so the shopping UI needs no change at all. The price comes from the
 * catalogue's own default-dose figure, resolved server-side — never parsed back
 * out of a rendered string.
 *
 * Waiting for the pixel instead of checking for it once is the whole point.
 * Someone arriving from an ad lands on a product page and meets the cookie
 * banner *there*, so when this first runs the pixel legitimately does not
 * exist — and an effect keyed only on the product would never run again. That
 * silently dropped ViewContent for exactly the visitors it matters most for.
 * If consent is never given the wait simply expires and nothing is sent, which
 * is the correct outcome.
 *
 * The ref keyed on slug is what makes a re-render, a dose selection or a
 * StrictMode double-mount produce one event instead of several, while a genuine
 * navigation to a different product still reports.
 */
export function TikTokViewContent({ slug, name, price }: { slug: string; name?: string; price?: number }) {
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    if (!slug || lastReported.current === slug) return;

    return whenPixelReady(() => {
      if (lastReported.current === slug) return;
      lastReported.current = slug;
      const emit: Emitter = (eventName, properties, options) => {
        window.ttq?.track(eventName, properties, options);
      };
      emitEvent(buildViewContent({ slug, name, price }), emit, browserFiredStore());
    });
  }, [slug, name, price]);

  return null;
}
