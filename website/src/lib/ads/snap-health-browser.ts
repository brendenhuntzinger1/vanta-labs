/**
 * What the Snap board can learn from the browser it is running in.
 *
 * Same rule as the TikTok probes: **a diagnostic must not create data.** The
 * funnel probes run the production builders with the outgoing call captured
 * instead of sent, and nothing here dispatches onto the shared
 * `vanta:analytics` bus, which first-party analytics and the upsell prompt
 * also read.
 */

import { buildSnapAddToCart, buildSnapCheckout, buildSnapViewContent, emitSnapEvent, type SnapEvent } from "./snap-events";
import { readConsent } from "./tracking-health-browser";
import type { SnapHealthInput } from "./snap-health";

/** Incremented by the pixel component each time it reports a page view. */
export const SNAP_PAGEVIEW_COUNTER = "__vlSnapPageViews";

const LOADER_SRC = "sc-static.net";

type SnapStub = {
  /** Installed by the downloaded SDK, absent while only the stub exists. */
  handleRequest?: unknown;
  /** Calls the stub is holding until the SDK arrives. */
  queue?: unknown[];
};

function stub(): SnapStub | undefined {
  return (window as unknown as { snaptr?: SnapStub }).snaptr;
}

/**
 * How many Snap loaders are in the document.
 *
 * Counted from the DOM rather than from our own bookkeeping, which is the only
 * way to notice a second pixel installed by something outside this codebase —
 * a tag manager, or the snippet pasted into the site head by hand.
 */
export function loaderScriptCount(): number {
  return document.querySelectorAll(`script[src*="${LOADER_SRC}"]`).length;
}

/**
 * Whether the real SDK is running, as opposed to the bootstrap stub.
 *
 * The snippet defines `snaptr` immediately and pushes into `snaptr.queue`; the
 * downloaded library replaces that by installing `handleRequest`. So the
 * presence of `snaptr` proves only that our own code ran, while the presence of
 * `handleRequest` proves sc-static.net was fetched and executed. Conflating the
 * two is how a fully ad-blocked pixel reports as healthy.
 */
export function snapSdkLoaded(): boolean {
  return typeof stub()?.handleRequest === "function";
}

export function queuedCallCount(): number {
  const queue = stub()?.queue;
  return Array.isArray(queue) ? queue.length : 0;
}

export function countSnapPageView(): void {
  const w = window as unknown as Record<string, unknown>;
  w[SNAP_PAGEVIEW_COUNTER] = Number(w[SNAP_PAGEVIEW_COUNTER] ?? 0) + 1;
}

/** Run a builder with the emit captured, and say whether it is fully formed. */
function wellFormed(event: SnapEvent | null, expected: string): boolean {
  let captured: { name: string; properties: Record<string, unknown> } | null = null;
  emitSnapEvent(event, (name, properties) => void (captured = { name, properties }), {
    has: () => false,
    mark: () => {},
  });
  if (!captured) return false;
  const { name, properties } = captured as { name: string; properties: Record<string, unknown> };
  if (name !== expected) return false;
  const ids = (properties.item_ids ?? []) as string[];
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !String(id).trim())) return false;
  return properties.currency === "USD" && typeof properties.price === "number" && properties.price > 0;
}

export function runSnapProbes(): SnapHealthInput["probes"] {
  // A sentinel that is obviously not a real product, so if one ever did escape
  // into reporting it would be recognisable at a glance.
  const SLUG = "__vanta_health_probe__";
  return {
    viewContent: wellFormed(buildSnapViewContent({ slug: SLUG, price: 1 }), "VIEW_CONTENT"),
    addToCart: wellFormed(buildSnapAddToCart({ slug: SLUG, quantity: 1, price: 1 }), "ADD_CART"),
    checkout: wellFormed(buildSnapCheckout({ itemCount: 1, total: 1, items: [{ slug: SLUG }] }), "START_CHECKOUT"),
  };
}

export function observeSnap(configuredPixelId: string): SnapHealthInput {
  return {
    available: true,
    consent: readConsent(),
    configuredPixelId,
    loaderScripts: loaderScriptCount(),
    stubPresent: Boolean(stub()),
    sdkLoaded: snapSdkLoaded(),
    queuedCalls: queuedCallCount(),
    pageViews: Number((window as unknown as Record<string, unknown>)[SNAP_PAGEVIEW_COUNTER] ?? 0),
    probes: runSnapProbes(),
  };
}
