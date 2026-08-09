/**
 * The server half of the browsing funnel.
 *
 * Why this exists: TikTok's setup shows "Server events received" as its own
 * step, and nothing satisfies it except a real event sent from a server. Today
 * the only server-side event is Purchase, so that step cannot go green until
 * money moves — and beyond the checkbox, a browser-only funnel is the half that
 * ad blockers, ITP and closed tabs delete. Reporting the same three events from
 * both sides is the ordinary fix.
 *
 * The rule that makes it safe: **the browser is not a source of truth about
 * money.** A relay that forwarded whatever the page claimed would be an open
 * endpoint for writing arbitrary values into your ad reporting. So every
 * product is re-resolved against the catalogue server-side, prices come from
 * the catalogue rather than the request, and a checkout total is accepted only
 * if it is plausible for the merchandise it claims to contain.
 *
 * Purchase is deliberately NOT relayable here. It stays where it is — derived
 * from the order's own settled payment state — because that is the one event
 * where a wrong number is a lie about revenue.
 */

import type { TikTokContent } from "./tiktok-events";

/** Browsing events only. Purchase is excluded by design, not by omission. */
export const RELAYABLE_EVENTS = ["ViewContent", "AddToCart", "InitiateCheckout"] as const;
export type RelayableEvent = (typeof RELAYABLE_EVENTS)[number];

export function isRelayableEvent(value: unknown): value is RelayableEvent {
  return typeof value === "string" && (RELAYABLE_EVENTS as readonly string[]).includes(value);
}

/** What the catalogue says a product is, resolved server-side. */
export type CatalogEntry = { slug: string; name: string | null; price: number };

export type RelayRequest = {
  event: string;
  eventId: string;
  /** Lines the page claims. Quantities are honoured, prices are not. */
  lines: { slug?: unknown; quantity?: unknown }[];
  /** The checkout total, for InitiateCheckout only. Validated, not trusted. */
  claimedTotal?: unknown;
};

export type RelayDecision =
  | { ok: false; reason: string }
  | {
      ok: true;
      event: RelayableEvent;
      eventId: string;
      contents: TikTokContent[];
      value: number;
      /** True when the page's total was rejected and the subtotal used instead. */
      totalOverridden: boolean;
    };

const MAX_LINES = 50;
const MAX_QUANTITY = 100;

/**
 * How far above the merchandise subtotal a checkout total may plausibly sit.
 *
 * Shipping, tax, handling and a card fee all land on top of the subtotal, so
 * the charged total is legitimately higher and refusing to accept that would
 * make the two legs disagree on every real order. The band is generous enough
 * for those and narrow enough that a fabricated figure — the reason to validate
 * at all — cannot get through. Outside it, the subtotal we computed ourselves
 * is used and the substitution is reported rather than hidden.
 */
export function totalIsPlausible(claimed: number, subtotal: number): boolean {
  if (!Number.isFinite(claimed) || claimed <= 0) return false;
  // Compared in whole cents. Done in floats, the one-cent rounding allowance
  // below evaluates against 49.980000000000004 and rejects a legitimate 49.98.
  const claimedCents = Math.round(claimed * 100);
  const subtotalCents = Math.round(subtotal * 100);
  if (claimedCents < subtotalCents - 1) return false;
  return claimedCents <= Math.round(subtotalCents * 1.5) + 5000;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function decideRelay(request: RelayRequest, catalog: Map<string, CatalogEntry>): RelayDecision {
  if (!isRelayableEvent(request.event)) {
    return { ok: false, reason: `${String(request.event)} is not relayable from the browser` };
  }
  const eventId = String(request.eventId ?? "").trim();
  if (!eventId) return { ok: false, reason: "event id is required — without it the two legs would double count" };

  const lines = Array.isArray(request.lines) ? request.lines.slice(0, MAX_LINES) : [];
  const contents: TikTokContent[] = [];
  let subtotal = 0;

  for (const line of lines) {
    const slug = String(line.slug ?? "").trim();
    // A slug the catalogue does not know is dropped rather than passed through:
    // an unrecognised content id teaches the ad platform about a product that
    // does not exist, and is the shape an injected value would take.
    const entry = catalog.get(slug);
    if (!entry) continue;
    const quantity = Math.min(MAX_QUANTITY, Math.max(1, Math.floor(Number(line.quantity) || 1)));
    subtotal += entry.price * quantity;
    contents.push({
      content_id: entry.slug,
      content_type: "product",
      content_name: entry.name ?? undefined,
      quantity,
      price: entry.price > 0 ? money(entry.price) : undefined,
    });
  }

  if (contents.length === 0) {
    return { ok: false, reason: "no line matched a catalogue product" };
  }

  subtotal = money(subtotal);
  let value = subtotal;
  let totalOverridden = false;

  if (request.event === "InitiateCheckout") {
    const claimed = money(Number(request.claimedTotal));
    if (totalIsPlausible(claimed, subtotal)) {
      // Matches the browser leg, which sends the figure actually being charged.
      value = claimed;
    } else {
      totalOverridden = true;
    }
  }

  if (!(value > 0)) return { ok: false, reason: "no positive value to report" };

  return { ok: true, event: request.event, eventId, contents, value, totalOverridden };
}
