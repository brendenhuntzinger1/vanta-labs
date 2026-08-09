"use client";

import { useEffect } from "react";
import { browserFiredStore, emitEvent, mapAnalyticsDetail, type AnalyticsDetail, type Emitter } from "@/lib/ads/tiktok-events";
import { LISTENER_FLAG } from "@/lib/ads/tracking-health-browser";

/**
 * AddToCart and InitiateCheckout, forwarded to the TikTok pixel.
 *
 * The store already broadcasts both on a `vanta:analytics` window event, with
 * the price and quantity attached, at the exact moment the action happens. So
 * this listens rather than instrumenting anything: no change to the cart, the
 * checkout page, or any commerce path. The dispatch sites are already guarded —
 * the checkout page fires begin_checkout once per mount behind a ref — so one
 * user action arrives here exactly once.
 *
 * Nothing is sent unless `window.ttq` exists, and it only exists after the
 * visitor accepted cookies. Consent is therefore enforced by absence rather
 * than by a second check that could drift out of step with the first.
 *
 * The mount flag is for the admin health board. Whether this listener is
 * actually attached in the deployed bundle is the difference between a funnel
 * that reports and one that does not, and the only alternative way to check it
 * is to fire a fake event onto a bus that three other components also read.
 */
export function TikTokCommerceEvents() {
  useEffect(() => {
    const store = browserFiredStore();
    const emit: Emitter = (name, properties, options) => {
      window.ttq?.track(name, properties, options);
    };

    const handler = (event: Event) => {
      // If the pixel has not loaded, consent was declined or not yet given.
      if (!window.ttq) return;
      emitEvent(mapAnalyticsDetail((event as CustomEvent<AnalyticsDetail>).detail), emit, store);
    };

    window.addEventListener("vanta:analytics", handler);
    (window as unknown as Record<string, unknown>)[LISTENER_FLAG] = true;
    return () => {
      window.removeEventListener("vanta:analytics", handler);
      delete (window as unknown as Record<string, unknown>)[LISTENER_FLAG];
    };
  }, []);

  return null;
}
