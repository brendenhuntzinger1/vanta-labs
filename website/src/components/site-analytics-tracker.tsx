"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const SESSION_KEY = "vl_analytics_session_id";
const VISITOR_KEY = "vl_analytics_visitor_id";
const SESSION_STARTED_KEY = "vl_analytics_session_started";

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

  void fetch("/api/analytics/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  });
}

export function SiteAnalyticsTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

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

    // Honor the cookie-consent choice: if the visitor declined, don't track.
    // (Matches the STORAGE_KEY used by cookie-consent.tsx.)
    try {
      if (window.localStorage.getItem("vl_cookie_consent") === "declined") {
        return;
      }
    } catch {
      // If storage is unreadable, fall through (no consent stored = default on).
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
      payload: {
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    };

    if (!window.sessionStorage.getItem(SESSION_STARTED_KEY)) {
      sendTrackEvent({ ...basePayload, eventType: "session_start" });
      window.sessionStorage.setItem(SESSION_STARTED_KEY, "1");
    }

    sendTrackEvent({ ...basePayload, eventType: "page_view" });
  }, [currentUrl, pathname]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const isEnabled = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true";
    if (!isEnabled) {
      return;
    }

    // Honor the cookie-consent choice: if the visitor declined, don't track.
    // (Matches the STORAGE_KEY used by cookie-consent.tsx.)
    try {
      if (window.localStorage.getItem("vl_cookie_consent") === "declined") {
        return;
      }
    } catch {
      // If storage is unreadable, fall through (no consent stored = default on).
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
  }, [pathname]);

  return null;
}