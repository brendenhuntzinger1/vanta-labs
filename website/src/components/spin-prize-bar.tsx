"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { useCart } from "@/components/cart-context";
import { isSuppressedRoute } from "@/components/storefront-offers-bar";
import { useOfferQuote } from "@/lib/offer-quote";
import { claimSpinPrizeOnce } from "@/lib/spin/claim-client";

// ---------------------------------------------------------------------------
// THE PRIZE FOLLOWS THE SHOPPER.
//
// A won reward is the reason someone is browsing at all, and until now it was
// invisible for the entire stretch where it could still change what they buy.
// The cart drawer, /cart and the checkout all carry it; the catalogue and the
// product pages — where the basket is actually built — carried nothing. So a
// shopper who won a free $119.99 vial with a $100 minimum shopped as if they
// had won nothing, and only met the condition once the basket was already
// settled. That is the same mistake the drawer's own banner was written to fix,
// one screen earlier in the journey.
//
// IT IS NOT AN OFFER AND HAS NO DISMISS CONTROL. A promotion is an ask and can
// be declined, which is why the offers bar above has one. This is the shopper's
// own property, stated once, quietly; it disappears by itself the moment the
// reward is spent or expires, because the server stops reporting it.
//
// THE SHORTFALL IS THE SERVER'S FIGURE WHENEVER THERE IS ONE, and the fallback
// is second for the reason checkout states at length: the till gates on what is
// actually PAID once the prize's own unit has left the paid lines, so the
// browser's gross-basket arithmetic is identical right up until the prize is in
// the cart, and wrong after that. Two vials at $119.99 read as $227.98 here
// against a $200 floor and $119.99 there — the bar would fall silent while the
// reward was being withdrawn.
//
// IT CLAIMS BEFORE IT READS, which is what makes it work on a second device.
// A prize won on a phone lives in that phone's cookie; the claim puts it into
// this browser first, and the status read then sees it. Same order, same
// reasoning, as /cart — see spin/claim-client.ts.
// ---------------------------------------------------------------------------

type PendingOffer = {
  rewardKind: string;
  rewardName: string;
  minSubtotalCents: number;
};

/** Only a product gift needs the word "free" put in front of it. */
function rewardPhrase(offer: PendingOffer): string {
  return offer.rewardKind === "free_product" ? `free ${offer.rewardName}` : offer.rewardName.toLowerCase();
}

export function SpinPrizeBar() {
  const pathname = usePathname();
  const {
    items,
    subtotal,
    couponCode,
    referralCode,
    shippingProtectionEnabled,
    signedIn,
    emailGrant,
  } = useCart();

  const [pendingOffer, setPendingOffer] = useState<PendingOffer | null>(null);

  useEffect(() => {
    // Nothing to ask for while signed out and uninvited: /api/offer/status is
    // behind the account wall, and this sits in the root layout, so an
    // unconditional read would log a 401 on the sign-in portal — the first
    // screen of almost every visit. The grant is included because a win-back
    // recipient browsing without an account is exactly who holds a prize.
    if (!signedIn && !emailGrant) return;
    let cancelled = false;
    claimSpinPrizeOnce()
      .then(() => fetch("/api/offer/status", { cache: "no-store" }))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (!cancelled && data?.offer) setPendingOffer(data.offer); })
      // A reward reminder is never worth a console error or a broken page.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [signedIn, emailGrant]);

  const offerQuote = useOfferQuote({
    active: Boolean(pendingOffer) && items.length > 0,
    items,
    couponCode,
    referralCode,
    shippingProtection: shippingProtectionEnabled,
  });

  if (!pendingOffer) return null;
  // The routes a promotion has no business on are the routes this has no
  // business on, and they are already written down once.
  if (isSuppressedRoute(pathname)) return null;
  // Said once. The cart page and the wheel both show this reward in their own
  // words, and the drawer opens over whatever is behind it.
  if (pathname === "/cart" || pathname === "/spin") return null;

  const shortfall = typeof offerQuote?.offerShortfallCents === "number"
    ? offerQuote.offerShortfallCents / 100
    : Math.max(0, pendingOffer.minSubtotalCents / 100 - subtotal);

  return (
    <div
      data-testid="spin-prize-bar"
      className="border-b border-[color:var(--accent-gold)]/20 bg-[color:var(--accent-gold)]/[0.06] px-4 py-2.5"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <p className="text-[0.8rem] leading-5 text-white/70 sm:text-[0.85rem]">
          {shortfall > 0 ? (
            <>
              Your <span className="font-semibold text-[color:var(--accent-gold)]">{rewardPhrase(pendingOffer)}</span>{" "}
              is waiting — add{" "}
              <span className="font-semibold text-[color:var(--accent-gold)]">${shortfall.toFixed(2)}</span> more to claim it.
            </>
          ) : (
            <>
              Your <span className="font-semibold text-[color:var(--accent-gold)]">{rewardPhrase(pendingOffer)}</span>{" "}
              is applied at checkout.
            </>
          )}
        </p>
        <Link
          href="/cart"
          className="vl-focus-ring flex-shrink-0 rounded-full border border-[color:var(--accent-gold)]/35 px-3 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-[color:var(--accent-gold)] transition hover:bg-[color:var(--accent-gold)]/10"
        >
          Cart
        </Link>
      </div>
    </div>
  );
}
