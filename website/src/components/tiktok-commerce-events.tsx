"use client";

import { useEffect } from "react";
import {
  browserFiredStore,
  buildAddToCart,
  buildInitiateCheckout,
  emitEvent,
  type Emitter,
} from "@/lib/ads/tiktok-events";

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
 */

type AnalyticsDetail = {
  eventType?: string;
  productSlug?: string;
  variantId?: string | null;
  quantity?: number;
  price?: number;
  itemCount?: number;
  total?: number;
};

export function TikTokCommerceEvents() {
  useEffect(() => {
    const store = browserFiredStore();
    const emit: Emitter = (name, properties, options) => {
      window.ttq?.track(name, properties, options);
    };

    const handler = (event: Event) => {
      // If the pixel has not loaded, consent was declined or not yet given.
      if (!window.ttq) return;
      const detail = (event as CustomEvent<AnalyticsDetail>).detail;
      if (!detail?.eventType) return;

      if (detail.eventType === "add_to_cart") {
        emitEvent(
          buildAddToCart({
            slug: String(detail.productSlug ?? ""),
            variantId: detail.variantId ?? null,
            quantity: Number(detail.quantity ?? 1),
            price: Number(detail.price ?? 0),
          }),
          emit,
          store,
        );
        return;
      }

      if (detail.eventType === "begin_checkout") {
        emitEvent(
          buildInitiateCheckout({
            itemCount: Number(detail.itemCount ?? 0),
            total: Number(detail.total ?? 0),
          }),
          emit,
          store,
        );
      }
    };

    window.addEventListener("vanta:analytics", handler);
    return () => window.removeEventListener("vanta:analytics", handler);
  }, []);

  return null;
}
