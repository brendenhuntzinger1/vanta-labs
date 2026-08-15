"use client";

import { useEffect } from "react";
import { browserFiredStore, emitEvent, mapAnalyticsDetail, type AnalyticsDetail, type Emitter } from "@/lib/ads/tiktok-events";
import { LISTENER_FLAG } from "@/lib/ads/tracking-health-browser";
import { relayToServer } from "@/lib/ads/relay-client";
import { buildSnapAddToCart, buildSnapCheckout, emitSnapEvent } from "@/lib/ads/snap-events";
import { buildRedditAddToCart, emitRedditEvent, newConversionId } from "@/lib/ads/reddit-events";

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
      const detail = (event as CustomEvent<AnalyticsDetail>).detail;
      const mapped = mapAnalyticsDetail(detail);
      if (!mapped) return;

      emitEvent(mapped, emit, store);

      // The same event, reported again from the server under the same id, so
      // TikTok counts one. Lines carry slugs and quantities only — the server
      // re-resolves prices from the catalogue rather than believing the page.
      const lines =
        mapped.name === "AddToCart"
          ? [{ slug: String(detail?.productSlug ?? ""), quantity: Number(detail?.quantity ?? 1) }]
          : (detail?.items ?? []).map((item) => ({
              slug: String(item.slug ?? ""),
              quantity: Number(item.quantity ?? 1),
            }));

      // Reddit, from the same broadcast. Gated on rdt's presence for the same
      // reason ttq is: the pixel only exists after consent.
      //
      // AddToCart only. Reddit has no InitiateCheckout in its standard set, and
      // a custom event there is one no campaign objective can optimise against,
      // so begin-checkout is deliberately not forwarded.
      if (window.rdt && mapped.name === "AddToCart") {
        emitRedditEvent(
          buildRedditAddToCart({
            slug: String(detail?.productSlug ?? ""),
            variantId: detail?.variantId ?? null,
            name: detail?.productName ?? null,
            category: detail?.productCategory ?? null,
            quantity: Number(detail?.quantity ?? 1),
            price: Number(detail?.price ?? 0),
            conversionId: newConversionId("atc"),
          }),
          (name, properties) => window.rdt?.("track", name, properties),
        );
      }

      // Snapchat, from the same broadcast. Gated on snaptr's presence for the
      // same reason ttq is: the pixel only exists after consent.
      if (window.snaptr) {
        const snapEmit = (eventName: "VIEW_CONTENT" | "ADD_CART" | "START_CHECKOUT" | "PURCHASE" | "PAGE_VIEW", properties: Record<string, unknown>) =>
          window.snaptr?.("track", eventName, properties);
        emitSnapEvent(
          mapped.name === "AddToCart"
            ? buildSnapAddToCart({
                slug: String(detail?.productSlug ?? ""),
                variantId: detail?.variantId ?? null,
                quantity: Number(detail?.quantity ?? 1),
                price: Number(detail?.price ?? 0),
                category: detail?.productCategory ?? null,
              })
            : buildSnapCheckout({
                itemCount: Number(detail?.itemCount ?? 0),
                total: Number(detail?.total ?? 0),
                // The cart's persisted lines carry no category — adding one
                // would mean migrating every shopper's stored cart, which is
                // not a trade worth making for one optional reporting field.
                // Snap omits it rather than receiving a guess.
                items: detail?.items ?? [],
              }),
          snapEmit,
          store,
        );
      }

      if (mapped.name === "AddToCart" || mapped.name === "InitiateCheckout") {
        relayToServer({
          event: mapped.name,
          eventId: mapped.eventId,
          lines: lines.filter((line) => line.slug),
          claimedTotal: mapped.properties.value,
        });
      }
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
