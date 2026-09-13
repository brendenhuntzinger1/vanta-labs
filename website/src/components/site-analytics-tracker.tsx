"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { captureAttribution } from "@/lib/attribution-client";
import { hasAcceptedConsent, subscribeToConsent } from "@/lib/cookie-consent-client";

const SESSION_KEY = "vl_analytics_session_id";
const VISITOR_KEY = "vl_analytics_visitor_id";
const SESSION_STARTED_KEY = "vl_analytics_session_started";

// Liveness ping for /admin/live (the live-visitor dashboard). 15s is the
// requirement; a visitor is considered live if the server heard from them
// within ~60s (admin-live-visitors.ts), so one missed beat is still fine.
const HEARTBEAT_INTERVAL_MS = 15_000;

function randomId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function getOrCreateStorageValue(key: string) {
  if (typeof window === "undefined") {
    return "";
  }
  const existing = window.localStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const next = randomId();
  window.localStorage.setItem(key, next);
  return next;
}

function sendTrackEvent(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon("/api/analytics/track", blob);
    return;
  }

  // .catch(() => {}) rather than letting a dropped request surface as an
  // unhandled rejection — a network blip must self-heal on the next beat,
  // not spam the console on every visitor who loses signal for a moment.
  void fetch("/api/analytics/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

export function SiteAnalyticsTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [consentRevision, setConsentRevision] = useState(0);

  useEffect(() => {
    const handleConsentChange = () => setConsentRevision((revision) => revision + 1);
    return subscribeToConsent(handleConsentChange);
  }, []);

  const currentUrl = useMemo(() => {
    const query = searchParams?.toString();
    return `${pathname}${query ? `?${query}` : ""}`;
  }, [pathname, searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const isEnabled = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true";
    if (!isEnabled) {
      return;
    }

    // Analytics is opt-in. Do not create analytics storage or send events until
    // the visitor explicitly accepts; this makes Decline a real no-track path.
    try {
      if (!hasAcceptedConsent()) {
        return;
      }
    } catch {
      return;
    }

    const sessionId = getOrCreateStorageValue(SESSION_KEY);
    const visitorId = getOrCreateStorageValue(VISITOR_KEY);

    const params = new URLSearchParams(window.location.search);
    const basePayload = {
      sessionId,
      visitorId,
      pagePath: pathname,
      pageUrl: window.location.href,
      referrer: document.referrer || null,
      deviceType: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop",
      utmSource: params.get("utm_source"),
      utmMedium: params.get("utm_medium"),
      utmCampaign: params.get("utm_campaign"),
      // utm_content carries the creative id and utm_term the ad group, so the
      // funnel above the purchase event can be segmented per creative rather
      // than only per campaign. ttclid is the click id TikTok appends; capture
      // it here as well as at order time so a session that never converts is
      // still attributable to the ad that produced it.
      utmContent: params.get("utm_content"),
      utmTerm: params.get("utm_term"),
      ttclid: params.get("ttclid"),
      payload: {
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    };

    // Capture the campaign that produced this visit while the query string is
    // still readable — by checkout it is long gone. Sits inside the consent
    // gate above with the rest of analytics, and writes nothing on its own for
    // an organic visit.
    captureAttribution({
      search: window.location.search,
      pathname,
      referrer: document.referrer || null,
      visitorId,
      sessionId,
    });

    if (!window.sessionStorage.getItem(SESSION_STARTED_KEY)) {
      sendTrackEvent({ ...basePayload, eventType: "session_start" });
      window.sessionStorage.setItem(SESSION_STARTED_KEY, "1");
    }

    sendTrackEvent({ ...basePayload, eventType: "page_view" });
  }, [consentRevision, currentUrl, pathname]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const isEnabled = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true";
    if (!isEnabled) {
      return;
    }

    // Analytics is opt-in. Do not create analytics storage or send events until
    // the visitor explicitly accepts; this makes Decline a real no-track path.
    try {
      if (!hasAcceptedConsent()) {
        return;
      }
    } catch {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {};
      const eventType = typeof detail.eventType === "string" ? detail.eventType : "page_view";
      const sessionId = getOrCreateStorageValue(SESSION_KEY);
      const visitorId = getOrCreateStorageValue(VISITOR_KEY);

      sendTrackEvent({
        eventType,
        sessionId,
        visitorId,
        pagePath: pathname,
        pageUrl: window.location.href,
        referrer: document.referrer || null,
        deviceType: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop",
        payload: detail,
      });
    };

    window.addEventListener("vanta:analytics", handler as EventListener);
    return () => {
      window.removeEventListener("vanta:analytics", handler as EventListener);
    };
  }, [consentRevision, pathname]);

  // LIVENESS PING FOR /admin/live. Kept as a ref, not an effect dependency,
  // so a client-side navigation updates what the NEXT beat reports without
  // tearing down and restarting the 15s timer — a visitor clicking through
  // five pages in ten seconds still sends heartbeats on a steady clock
  // instead of a burst of interval resets.
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const isEnabled = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true";
    if (!isEnabled) {
      return;
    }

    // Consent is re-checked on every beat below, not just once here — a
    // decline mid-session (a real, supported path) stops the very next tick,
    // not just future effect runs.
    const sendHeartbeat = () => {
      // Only while the tab is actually visible/active — a backgrounded tab
      // is not "someone on the site right now", and this is also what makes
      // a closed/crashed tab age out on its own: nothing else has to notice.
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        if (!hasAcceptedConsent()) {
          return;
        }
      } catch {
        return;
      }

      const sessionId = getOrCreateStorageValue(SESSION_KEY);
      const visitorId = getOrCreateStorageValue(VISITOR_KEY);

      sendTrackEvent({
        eventType: "heartbeat",
        sessionId,
        visitorId,
        pagePath: pathnameRef.current,
        pageUrl: window.location.href,
        deviceType: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop",
      });
    };

    // Fire immediately (a refresh or a fresh visit shouldn't wait 15s to
    // appear live), then on a steady clock.
    sendHeartbeat();
    const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    // Coming back to a backgrounded tab shouldn't wait up to 15s for the
    // next scheduled beat to reappear as live.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        sendHeartbeat();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(heartbeatTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [consentRevision]);

  return null;
}