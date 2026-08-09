"use client";

import {
  emptyAttributionRecord,
  hasAnyAttribution,
  isTouchExpired,
  mergeAttribution,
  parseAttributionTouch,
  type AttributionRecord,
} from "@/lib/attribution";

// ---------------------------------------------------------------------------
// Browser-side capture.
//
// The campaign that produced a sale is visible for exactly one moment — the
// first page load after the click, while `?ttclid=...` is still in the URL.
// After that the customer browses, the query string is gone, and by checkout
// there is nothing left to read. So the touch is captured on arrival and
// carried forward in localStorage until an order is placed.
//
// CONSENT: capture is driven by SiteAnalyticsTracker, which already refuses to
// run until the visitor accepts cookies. Nothing is written here for a visitor
// who declined, and their order simply has no attribution row — which is the
// honest outcome, and the same answer this system gives for any order it cannot
// evidence. The practical consequence is that measured ad performance is a
// FLOOR, not a total: real performance is at least what we can prove.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "vl_attribution";

function readStored(): AttributionRecord | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AttributionRecord;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Corrupt or unavailable storage behaves exactly like "no attribution".
    return null;
  }
}

function writeStored(record: AttributionRecord): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private mode, quota, storage disabled — all fine. Attribution is a
    // best-effort signal and must never break a page.
  }
}

/**
 * Record this page view's campaign evidence, if it has any.
 *
 * Called on every navigation. When there is nothing to record it still folds in
 * the visitor/session identity, because that link is what lets a purchase be
 * matched back to its own browsing session later — useful whether or not an ad
 * was ever involved.
 */
export function captureAttribution(input: {
  search: string;
  pathname: string;
  referrer: string | null;
  visitorId: string | null;
  sessionId: string | null;
}): void {
  if (typeof window === "undefined") return;

  try {
    const now = new Date();
    const incoming = parseAttributionTouch({
      search: input.search,
      pathname: input.pathname,
      referrer: input.referrer,
      now,
    });

    const stored = readStored();

    // Nothing new and nothing stored: don't create an empty record just to have
    // one. Writing on every page view of every organic visit is pure noise.
    if (!incoming && !stored && !input.visitorId && !input.sessionId) return;

    const merged = mergeAttribution(stored, incoming, {
      now,
      visitorId: input.visitorId,
      sessionId: input.sessionId,
    });

    if (hasAnyAttribution(merged)) {
      writeStored(merged);
    }
  } catch {
    // Never let telemetry throw into a render path.
  }
}

/**
 * What to send with a checkout submission, or null when we know nothing.
 *
 * Expired touches are dropped here as well as at merge time, because a record
 * can sit untouched in storage for months — the window has to be enforced at
 * the moment of use, not only at the moment of capture.
 */
export function readAttributionForCheckout(): AttributionRecord | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = readStored();
    if (!stored) return null;

    const now = new Date();
    const pruned: AttributionRecord = {
      ...emptyAttributionRecord(),
      visitorId: stored.visitorId ?? null,
      sessionId: stored.sessionId ?? null,
      first: isTouchExpired(stored.first, now) ? null : stored.first,
      last: isTouchExpired(stored.last, now) ? null : stored.last,
    };

    return hasAnyAttribution(pruned) ? pruned : null;
  } catch {
    return null;
  }
}
