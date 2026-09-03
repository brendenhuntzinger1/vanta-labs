"use client";

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// THE SERVER'S OWN NUMBERS, FOR A CART THAT HOLDS A ONE-TIME OFFER.
//
// One hook, used by both the cart drawer and the checkout summary, so the two
// surfaces cannot disagree with each other OR with the till. It never computes
// a price: it asks /api/checkout/quote, which runs quoteOrder.
//
// It only runs when an offer is actually armed. A shopper without one takes
// exactly the code path they took before this existed — no request, no state,
// no behaviour change — which is deliberate: the offer is the only thing the
// browser genuinely cannot price for itself.
// ---------------------------------------------------------------------------

export interface OfferQuoteLine {
  name: string;
  variantLabel: string | null;
  quantity: number;
}

export interface OfferQuote {
  subtotal: number;
  shipping: number;
  discountAmount: number;
  taxAmount: number;
  taxKnown: boolean;
  taxState: string | null;
  taxRatePercent: number;
  shippingProtectionFee: number;
  storeCreditRedeemedCents: number;
  pointsDiscountAmount: number;
  expectedTotal: number;
  cardFeeAmount: number;
  cardFeePercent: number;
  finalTotal: number;
  couponCode: string | null;
  giftLines: OfferQuoteLine[];
  offer: { rewardKind: string; description: string } | null;
  /** True when priced for the address the offer was mailed to, because the
   *  shopper has not typed one yet. The caller words the banner accordingly. */
  assumedBoundEmail: boolean;
}

export interface OfferQuoteItem {
  slug: string;
  variantId?: string | null;
  quantity: number;
}

export interface UseOfferQuoteInput {
  /** Whether an offer is armed. False short-circuits the whole hook. */
  active: boolean;
  items: OfferQuoteItem[];
  email?: string;
  country?: string;
  state?: string;
  couponCode?: string | null;
  referralCode?: string | null;
  shippingProtection?: boolean;
  pointsToRedeem?: number;
  paymentMethod?: string;
}

/** The same id shape create-session is sent, so the preview prices the same cart. */
function serialiseItems(items: OfferQuoteItem[]) {
  return items.map((item) => ({
    id: item.variantId ? `${item.slug}::${item.variantId}` : item.slug,
    quantity: item.quantity,
  }));
}

export function useOfferQuote(input: UseOfferQuoteInput): OfferQuote | null {
  // The answer is stored WITH the request that produced it. Keeping the two
  // together is what lets a stale quote be discarded during render rather than
  // cleared from an effect: when the cart changes, the signature changes, the
  // stored answer no longer matches, and the caller falls back to its own
  // figures until the new one lands. Nothing has to remember to null it out.
  const [entry, setEntry] = useState<{ signature: string; quote: OfferQuote } | null>(null);

  // Every input that moves a price, in one string — and, because it is exactly
  // the request body, the thing that gets sent. One value to compare, one value
  // to post, so the two can never describe different carts.
  const signature = input.active
    ? JSON.stringify({
      items: serialiseItems(input.items),
      email: input.email?.trim() ?? "",
      country: input.country ?? "",
      state: input.state ?? "",
      couponCode: input.couponCode ?? "",
      referralCode: input.referralCode ?? "",
      shippingProtection: Boolean(input.shippingProtection),
      pointsToRedeem: input.pointsToRedeem ?? 0,
      paymentMethod: input.paymentMethod ?? "card",
    })
    : "";

  useEffect(() => {
    if (!signature) return;
    let cancelled = false;
    const controller = new AbortController();

    // Debounced: typing a state or nudging a quantity should cost one request
    // when the shopper stops, not one per keystroke.
    const timer = setTimeout(() => {
      fetch("/api/checkout/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        body: signature,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (cancelled) return;
          // A refusal is an answer, and the caller keeps what it had. Dropping
          // the quote on a transient failure would flip the totals between two
          // different numbers, which is worse than being one request behind.
          if (data?.ok && data.quote) setEntry({ signature, quote: data.quote as OfferQuote });
        })
        // A preview is never worth a console error or a broken summary.
        .catch(() => {});
    }, 250);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [signature]);

  return entry && entry.signature === signature ? entry.quote : null;
}
