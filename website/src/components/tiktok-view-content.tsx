"use client";

import { useEffect, useRef } from "react";
import { browserFiredStore, buildViewContent, emitEvent, type Emitter } from "@/lib/ads/tiktok-events";
import { whenPixelReady } from "@/lib/ads/pixel-ready";
import { buildSnapViewContent, emitSnapEvent } from "@/lib/ads/snap-events";
import { buildRedditViewContent, emitRedditEvent, newConversionId } from "@/lib/ads/reddit-events";
import { relayToServer } from "@/lib/ads/relay-client";

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
export function TikTokViewContent({
  slug,
  name,
  price,
  /** Snap reports a category alongside the item; TikTok does not use one. */
  category,
}: {
  slug: string;
  name?: string;
  price?: number;
  category?: string | null;
}) {
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    if (!slug || lastReported.current === slug) return;

    return whenPixelReady(() => {
      if (lastReported.current === slug) return;
      lastReported.current = slug;
      const emit: Emitter = (eventName, properties, options) => {
        window.ttq?.track(eventName, properties, options);
        // Same event id, so TikTok collapses the two legs into one event. The
        // server leg is what survives an ad blocker eating the pixel.
        relayToServer({ event: "ViewContent", eventId: options.event_id, lines: [{ slug, quantity: 1 }] });
      };
      emitEvent(buildViewContent({ slug, name, price }), emit, browserFiredStore());

      // Snapchat, from the same data and the same gate. Emitted here rather
      // than from a parallel component so the two platforms cannot drift on
      // when a product view counts.
      emitSnapEvent(
        buildSnapViewContent({ slug, price, category }),
        (eventName, properties) => window.snaptr?.("track", eventName, properties),
        browserFiredStore(),
      );

      // Reddit, from the same data and the same gate, for the same reason: one
      // decision about when a product view counts, not three.
      emitRedditEvent(
        buildRedditViewContent({ slug, name, price, category, conversionId: newConversionId("vc") }),
        (eventName, properties) => window.rdt?.("track", eventName, properties),
      );
    });
  }, [slug, name, price, category]);

  return null;
}
