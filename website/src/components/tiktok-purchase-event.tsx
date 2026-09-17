"use client";

import { useCallback, useEffect, useRef } from "react";
import { browserFiredStore, emitEvent, type TikTokEvent } from "@/lib/ads/tiktok-events";
import { emitSnapEvent, type SnapEvent } from "@/lib/ads/snap-events";
import { emitRedditEvent, type RedditEvent } from "@/lib/ads/reddit-events";
import { emitMetaEvent, type MetaEvent } from "@/lib/ads/meta-events";
import { emitGoogleAdsConversion, type GoogleAdsConversion } from "@/lib/ads/google-ads-events";
import { hasAcceptedConsent } from "@/lib/cookie-consent-client";

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
 *
 * THE GUARD HAS TO SIT BEFORE THE FETCH, NOT AFTER IT.
 *
 * It used to be a `useRef` alone, which survives a re-render but dies with the
 * component — and `/api/ads/purchase-event/[orderId]` is not a read. It sends
 * the server-side TikTok and Reddit conversions as a side effect of being
 * asked. So every fresh mount re-sent them, and a fresh mount is not exotic:
 * on the second real production order the shopper went to /account/login and
 * came back, and the conversions went out twice, 27 seconds apart (03:36:16
 * and 03:36:43). TikTok's own 48-hour dedup on the shared event id absorbed it
 * that time; a link reopened later would not be absorbed.
 *
 * So the localStorage key this doc comment always claimed is now checked here,
 * before the request, and marked as soon as the order comes back paid. The ref
 * stays as the in-flight guard for the case localStorage cannot answer for
 * (private mode, storage blocked) and for two mounts in the same tick.
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
  /**
   * THE ACTUAL IN-FLIGHT GUARD.
   *
   * `settled` is set AFTER the response comes back, so it has never guarded the
   * window that matters. `/api/ads/purchase-event/[orderId]` is not a read — it
   * sends the server-side TikTok and Reddit conversions as a side effect of
   * being asked — and two overlapping asks are two conversions for one sale.
   *
   * Overlapping is reachable without anything exotic. The page opens while the
   * order is still unpaid, so the first attempt returns "not paid" and marks
   * nothing (deliberately: an unpaid order has to stay askable). The
   * confirmation poll then announces `vanta:order-paid` three seconds later. If
   * the first request is still in flight at that moment — a cold function, a slow
   * network — the announcement starts a second one, both find the localStorage
   * key unset, and both report the purchase. It is also the whole of the "two
   * mounts in the same tick" case the comment above claims the ref covers.
   */
  const inFlight = useRef(false);

  const attempt = useCallback(async () => {
    if (settled.current || inFlight.current || !orderId) return;
    // Survives the unmount/remount a back button causes, which the ref does
    // not. Keyed on the order so a different order is unaffected.
    const store = browserFiredStore();
    const requestKey = `purchase-request:${orderId}`;
    if (store.has(requestKey)) {
      settled.current = true;
      return;
    }
    // Consent gates TikTok, Snap and Reddit — both their browser legs and the
    // server sends the route makes on their behalf. It does NOT gate Meta,
    // which is ungated by the owner's decision, so the request is made either
    // way and carries the answer: with consent=0 the route sends only Meta,
    // and only fbq fires below.
    //
    // Judged on consent itself, not on whether the SDK loaded: an ad blocker
    // leaves consent granted but ttq absent, and the server-side event is the
    // whole reason the Events API exists.
    let consented = false;
    try {
      consented = hasAcceptedConsent();
    } catch {
      consented = false;
    }

    // Claimed BEFORE the request and released in the finally below, so an
    // unpaid answer leaves the order askable for the `vanta:order-paid`
    // announcement that follows, while an overlapping ask is refused outright.
    inFlight.current = true;
    try {
      const response = await fetch(`/api/ads/purchase-event/${encodeURIComponent(orderId)}?consent=${consented ? "1" : "0"}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as {
        event?: TikTokEvent | null;
        snapPurchase?: SnapEvent | null;
        redditPurchase?: RedditEvent | null;
        metaPurchase?: MetaEvent | null;
        googleAdsPurchase?: GoogleAdsConversion | null;
      };
      if (!body?.event) return; // not paid — nothing to report, and that is correct

      settled.current = true;
      // Marked only once the order came back PAID. An unpaid order must stay
      // askable: the confirmation page opens while the webhook is still
      // landing, and marking here on a "not yet" would permanently suppress
      // the conversion for a purchase that settles a second later.
      store.mark(requestKey);
      // The browser leg is best-effort: if the SDK was blocked, ttq?.track is
      // a no-op and the server leg above already reported the conversion.
      // Identify before tracking, so the conversion carries the match keys.
      // Only ever digests, and only on a confirmed paid order — the one moment
      // this customer's identity is both known and relevant.
      // Meta, behind the same single paid gate, for every visitor. No identity
      // here: the browser pixel only accepts match keys at init, which runs in
      // the root layout, and the server leg carries the full hashed identity.
      // The eventID is the order id, so the two legs count as one purchase.
      if (body.metaPurchase) {
        emitMetaEvent(
          body.metaPurchase,
          (name, properties, options) => window.fbq?.("track", name, properties, options),
          browserFiredStore(),
        );
      }

      // Google Ads, ABOVE the consent return on purpose — the same position
      // Meta holds, for a different reason.
      //
      // The Google tag is not held back by the cookie banner (see
      // google-ads-tag.tsx): it is present on every page with Consent Mode
      // starting every storage signal DENIED, which is what does the privacy
      // work instead. So a visitor who declined still has a live tag, and their
      // conversion goes out as a cookieless ping — no advertising cookie, no
      // identifier, nothing tying it to them or to any other visit — which
      // Google counts through modelling.
      //
      // Moving this below the return would drop every conversion from a
      // declining visitor while that same visitor's page views carried on being
      // reported: the account would optimise against sales it was never told
      // about. google-ads-purchase-wiring.test.ts fails if it ever moves.
      //
      // Optional-chained like every other gtag call in the tree. The tag is not
      // rendered outside production at all, so this is a no-op on every preview
      // deployment and local run rather than an error.
      if (body.googleAdsPurchase) {
        emitGoogleAdsConversion(
          body.googleAdsPurchase,
          (command, name, params) => window.gtag?.(command, name, params),
          browserFiredStore(),
        );
      }

      if (!consented) return;

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

      // Reddit, behind the same single paid gate. No identify() call: its match
      // keys are attached once at init, as server-side digests, so there is
      // nothing to send again here.
      if (body.redditPurchase) {
        emitRedditEvent(body.redditPurchase, (name, properties) => window.rdt?.("track", name, properties));
      }
    } catch {
      // A failed check must never invent a conversion. Staying silent loses at
      // most one browser-side event; the server-side Events API is the durable
      // path for that gap.
    } finally {
      inFlight.current = false;
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
