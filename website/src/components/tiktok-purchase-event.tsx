"use client";

import { useCallback, useEffect, useRef } from "react";
import { browserFiredStore, emitEvent, type TikTokEvent } from "@/lib/ads/tiktok-events";
import { emitSnapEvent, type SnapEvent } from "@/lib/ads/snap-events";

/**
 * Purchase — the only event that represents money.
 *
 * It fires on one condition: the server said the order is paid. This component
 * knows nothing about payment state and cannot decide it; it asks
 * `/api/ads/purchase-event/[orderId]`, which reads `payment_status` and
 * `amount_paid` from the order itself, and emits whatever it is handed. Landing
 * on this page proves navigation, not payment, so the URL is never the trigger.
 *
 * Card payments confirm slightly after the customer arrives, while the webhook
 * lands. The confirmation UI already polls for that and announces it, so this
 * waits for that announcement rather than opening a second polling loop against
 * the same order.
 *
 * Idempotency is keyed on the order id in localStorage, so a refresh, a back
 * button, a re-render or re-opening a forwarded confirmation link all produce
 * nothing further. The event id is derived from the order too, so a future
 * server-side Events API call for the same purchase collapses into one
 * conversion rather than doubling it.
 */
export function TikTokPurchaseEvent({
  orderId,
  advancedMatching,
}: {
  orderId: string;
  /** SHA-256 digests only — hashed server-side, never the raw address. */
  advancedMatching?: { email?: string; phone_number?: string; external_id?: string } | null;
}) {
  const settled = useRef(false);

  const attempt = useCallback(async () => {
    if (settled.current || !orderId) return;
    // Gate on consent itself, not on whether the SDK loaded.
    //
    // Checking `window.ttq` conflated the two: an ad blocker that stops
    // analytics.tiktok.com leaves consent granted but ttq absent, and the
    // server-side event — the whole reason the Events API exists — would never
    // be requested. The inline stub defines ttq before the remote script
    // loads, so this also stays correct when the SDK is merely slow.
    try {
      if (window.localStorage.getItem("vl_cookie_consent") !== "accepted") return;
    } catch {
      return;
    }

    try {
      const response = await fetch(`/api/ads/purchase-event/${encodeURIComponent(orderId)}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as {
        event?: TikTokEvent | null;
        snapPurchase?: SnapEvent | null;
      };
      if (!body?.event) return; // not paid — nothing to report, and that is correct

      settled.current = true;
      // The browser leg is best-effort: if the SDK was blocked, ttq?.track is
      // a no-op and the server leg above already reported the conversion.
      // Identify before tracking, so the conversion carries the match keys.
      // Only ever digests, and only on a confirmed paid order — the one moment
      // this customer's identity is both known and relevant.
      if (advancedMatching) window.ttq?.identify(advancedMatching);
      emitEvent(
        body.event,
        (name, properties, options) => window.ttq?.track(name, properties, options),
        browserFiredStore(),
      );

      // Snapchat, from the SAME server-confirmed paid order. Built from the
      // response rather than re-deciding anything: there is exactly one paid
      // gate on this page and both platforms sit behind it.
      if (body.snapPurchase) {
        emitSnapEvent(
          body.snapPurchase,
          (eventName, properties) => window.snaptr?.("track", eventName, properties),
          browserFiredStore(),
        );
      }
    } catch {
      // A failed check must never invent a conversion. Staying silent loses at
      // most one browser-side event; the server-side Events API is the durable
      // path for that gap.
    }
  }, [orderId, advancedMatching]);

  useEffect(() => {
    void attempt();
    const onPaid = () => void attempt();
    window.addEventListener("vanta:order-paid", onPaid);
    return () => window.removeEventListener("vanta:order-paid", onPaid);
  }, [attempt]);

  return null;
}
