/**
 * What the health board can learn from the browser it is running in.
 *
 * This runs inside the real deployed bundle on the real production domain, so
 * it answers questions no amount of source reading can: is the pixel actually
 * in the page, is it the pixel we intended, is anything else initialising a
 * second one, is the funnel listener attached, does the deployed mapping code
 * turn a cart action into the right TikTok event.
 *
 * The one rule it obeys absolutely: **a diagnostic must not create data.** The
 * funnel probes run the production mapping with the outgoing call captured
 * instead of sent, and they never dispatch onto the shared `vanta:analytics`
 * bus — first-party analytics and the upsell prompt listen there too, and a
 * self-test that quietly writes fake add-to-cart rows into your own reporting
 * is worse than no self-test.
 */

import {
  buildViewContent,
  emitEvent,
  mapAnalyticsDetail,
  type FiredStore,
  type TikTokEvent,
} from "@/lib/ads/tiktok-events";
import type { BrowserHealthInput } from "@/lib/ads/tracking-health";

/** Set by the commerce listener while it is mounted. */
export const LISTENER_FLAG = "__vlTikTokCommerceListener";
/** Incremented by the pixel each time it reports a page view. */
export const PAGEVIEW_COUNTER = "__vlTikTokPageViews";

const CONSENT_KEY = "vl_cookie_consent";

export function readConsent(): BrowserHealthInput["consent"] {
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (raw === "accepted") return "accepted";
    if (raw === "declined") return "declined";
    return "unset";
  } catch {
    return "unset";
  }
}

/**
 * Every pixel id initialised in this page.
 *
 * The vendor snippet records each `ttq.load(id)` under `ttq._i`, so this reads
 * TikTok's own bookkeeping rather than ours — which is what makes it able to
 * catch a duplicate installed by something outside this codebase (a tag
 * manager, a theme app, a second snippet pasted into the head).
 */
export function loadedPixelIds(): string[] {
  const ttq = (window as unknown as { ttq?: { _i?: Record<string, unknown> } }).ttq;
  if (!ttq?._i) return [];
  return Object.keys(ttq._i);
}

function memoryStore(): FiredStore {
  const seen = new Set<string>();
  return { has: (k) => seen.has(k), mark: (k) => void seen.add(k) };
}

/**
 * Run one event through the production path with the outgoing call captured.
 * Returns the event TikTok *would* have received, or null if the path is dead.
 */
type Captured = { name: string; eventId: string; contentIds: string[]; currency: unknown; value: unknown };

function capture(event: TikTokEvent | null): Captured | null {
  let captured: Captured | null = null;
  emitEvent(event, (name, properties, options) => {
    const contents = (properties.contents ?? []) as { content_id?: string }[];
    captured = {
      name,
      eventId: options.event_id,
      contentIds: contents.map((entry) => String(entry.content_id ?? "")),
      currency: properties.currency,
      value: properties.value,
    };
  }, memoryStore());
  return captured;
}

/**
 * A probe passes only if the event is the right one AND it is fully formed.
 *
 * Checking the name alone is what let "Content ID is missing" ship green: the
 * event fired, it was the correct event, and it identified nothing. Every
 * commerce event must carry at least one non-empty content id, a currency and
 * a positive value, or the ad platform cannot attribute it to a product.
 */
function wellFormed(captured: Captured | null, expected: string): boolean {
  if (!captured || captured.name !== expected) return false;
  if (captured.contentIds.length === 0) return false;
  if (captured.contentIds.some((id) => !id.trim())) return false;
  return captured.currency === "USD" && typeof captured.value === "number" && captured.value > 0;
}

export function runFunnelProbes(): BrowserHealthInput["probes"] {
  // A sentinel that is obviously not a real product, so if one of these ever
  // did escape into reporting it would be recognisable at a glance.
  const SLUG = "__vanta_health_probe__";

  const viewContent = capture(buildViewContent({ slug: SLUG, name: "Health probe", price: 1 }));
  const addToCart = capture(
    mapAnalyticsDetail({ eventType: "add_to_cart", productSlug: SLUG, productName: "Health probe", quantity: 1, price: 1 }),
  );
  const checkout = capture(
    mapAnalyticsDetail({
      eventType: "begin_checkout",
      itemCount: 1,
      total: 1,
      items: [{ slug: SLUG, name: "Health probe", quantity: 1, price: 1 }],
    }),
  );

  // The mapping being right is necessary but not sufficient: for a cart action
  // to reach TikTok the listener also has to be attached. Requiring both is
  // what makes a green row mean the event would genuinely be reported.
  const listenerMounted = Boolean((window as unknown as Record<string, unknown>)[LISTENER_FLAG]);

  return {
    viewContent: wellFormed(viewContent, "ViewContent") && viewContent?.eventId === `vc-${SLUG}`,
    addToCart: listenerMounted && wellFormed(addToCart, "AddToCart"),
    initiateCheckout: listenerMounted && wellFormed(checkout, "InitiateCheckout"),
  };
}

/**
 * Record a cookie choice for this browser, exactly as the banner does.
 *
 * The banner only renders when no choice is stored, so a Decline — or a stale
 * Accept from before the pixel existed — is invisible and unreachable
 * afterwards. Diagnosing that used to mean opening DevTools and editing
 * localStorage by hand, which is not a reasonable thing to ask of anyone.
 *
 * This is the same key, the same value and the same event the banner writes;
 * it is the owner making the choice in their own browser, not consent being
 * granted on anyone else's behalf. Passing null clears the choice, which makes
 * the banner appear again on the next page.
 */
export function setConsentForThisBrowser(choice: "accepted" | "declined" | null): void {
  try {
    if (choice === null) window.localStorage.removeItem(CONSENT_KEY);
    else window.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    return;
  }
  window.dispatchEvent(new Event("vanta:cookie-consent"));
}

export function observeBrowser(): BrowserHealthInput {
  const pageViews = Number((window as unknown as Record<string, unknown>)[PAGEVIEW_COUNTER] ?? 0);
  return {
    available: true,
    consent: readConsent(),
    pixelLoaded: Boolean(window.ttq),
    loadedPixelIds: loadedPixelIds(),
    pageViewObserved: pageViews > 0,
    probes: runFunnelProbes(),
  };
}
