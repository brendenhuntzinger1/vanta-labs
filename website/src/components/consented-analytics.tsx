"use client";

import { Analytics } from "@vercel/analytics/next";
import { useEffect, useState } from "react";

/**
 * Vercel Analytics, behind the same consent gate as everything else.
 *
 * It used to mount unconditionally at the bottom of the root layout, outside
 * both the age gate and any consent check — so it ran for visitors who had just
 * clicked "Decline" on a banner promising that analytics would not run. The
 * first-party tracker honours that choice strictly; this did not. One of them
 * was lying, and a consent gate that is selectively enforced is not one.
 *
 * Mirrors `site-analytics-tracker.tsx`: same storage key, same `accepted`
 * comparison, same event to re-read after a choice is made.
 *
 * This changes WHEN an existing first-party measurement script loads. It does
 * not add, enable or prepare any advertising tracker.
 */
const STORAGE_KEY = "vl_cookie_consent";
const CONSENT_EVENT = "vanta:cookie-consent";

function hasAccepted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "accepted";
  } catch {
    // Storage blocked (private mode, some in-app browsers). Absence of a
    // recorded "yes" is a no.
    return false;
  }
}

export function ConsentedAnalytics() {
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    const sync = () => setAccepted(hasAccepted());
    sync();

    // The banner fires this on accept/decline; `storage` covers a choice made
    // in another tab.
    window.addEventListener(CONSENT_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CONSENT_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  if (!accepted) return null;
  return <Analytics />;
}
