"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { offerTag, type StorefrontOffer } from "@/lib/storefront-offer-format";

// ---------------------------------------------------------------------------
// THE OFFER MODAL.
//
// One centred card, shown once, when a shopper first reaches the catalogue
// while a promotion is running. It says the same thing the bar above it says,
// because it is handed the same array — see the note on `offers` below.
//
// WHY IT EXISTS, AND WHY IT IS NOT ON THE HOME PAGE. The store owner's rule is
// that the front page stays brand-only and promotions begin where shopping
// begins. The bar honours that by route (see isSuppressedRoute in
// storefront-offers-bar.tsx); this is the other half of the same decision —
// the moment a shopper arrives in the catalogue is the moment the sale is
// worth interrupting for, and it is the only moment.
//
// IT IS NOT A NAG, AND THE RULES BELOW ARE WHAT KEEP IT FROM BECOMING ONE:
//
//   * once per offer, per visit. Dismissing it puts the offer's id in
//     sessionStorage, so browsing thirty products does not reopen it and
//     coming back to the catalogue does not either;
//   * a NEW promotion is a new id and may show again, which is the whole
//     reason the key is the offer rather than a blanket "seen the popup" flag;
//   * never during the age gate, never on the home page, never on checkout;
//   * escape closes it, the close control is real and labelled, and nothing
//     about it is required to keep shopping.
//
// IT CANNOT ADVERTISE WHAT CHECKOUT WILL NOT HONOUR. It renders `offers`, the
// array the root layout already resolved for the bar — the same objects, not a
// second lookup of the same idea. Upstream, resolveStorefrontOffers builds the
// automatic promotions from getApplicableBxgyPromotions, which is the list
// checkout prices from, and coupons from the rows validateCoupon enforces. So
// there is no path by which the card and the till can disagree: they are
// reading one value.
// ---------------------------------------------------------------------------

/**
 * Where the shopping experience begins, and therefore where a promotion may
 * interrupt.
 *
 * The catalogue and the product pages under it, and nothing else. The cart and
 * checkout are deliberately absent: by then the offer is already applied or
 * already missed, and a card over a cart is an obstacle rather than an
 * announcement.
 */
function isShoppingRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/products" || pathname.startsWith("/products/");
}

/**
 * WHAT HAS BEEN SEEN, FOR THIS VISIT.
 *
 * sessionStorage, deliberately, and neither of its neighbours:
 *
 *   IN MEMORY — lost on every navigation that loads a document, so the card
 *   would reappear on the first full page load after a dismissal.
 *
 *   A COOKIE / localStorage — what the BAR uses, and right for the bar: waving
 *   away a ribbon is a lasting preference. A modal is not. Remembering a
 *   dismissal for a year means a customer who returns during the same sale
 *   never learns it is running, and the sale is the thing we are trying to
 *   tell them about.
 *
 * A visit is the honest unit: seen once, not seen again until they come back.
 *
 * Keyed on the OFFER, never on the modal. offerTag hashes the offer's id, which
 * storefront-offer-format derives from the terms themselves — so changing the
 * sale from Buy 2 Get 1 to 20% off produces a different key and the new sale is
 * free to announce itself. That property is the reason this is not a boolean.
 */
const SEEN_KEY = "vl-offer-modal-seen";

function readSeen(): string[] {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Private mode, disabled storage, a webview that throws on access. The
    // failure mode is "show it", which is the harmless direction: a card the
    // customer can close, rather than a sale they never hear about.
    return [];
  }
}

// ---------------------------------------------------------------------------
// SEEN-NESS AS AN EXTERNAL STORE, AND WHY IT IS NOT AN EFFECT.
//
// sessionStorage is state React does not own and the server cannot see, which
// is exactly what useSyncExternalStore is for — the age gate reads its own
// confirmation the same way, for the same reason.
//
// The alternative, and the first thing written here, was an effect that read
// storage and called setState to open the card. That is a cascading render and
// the project's lint rules reject it outright (react-hooks/set-state-in-effect)
// — correctly: it paints the catalogue, then decides, then paints again. Read
// as a store, whether the card is open is DERIVED during render from four
// things that are all already known, and there is no second pass.
//
// The snapshot is the serialised string rather than a parsed array because it
// must be referentially stable between changes or React re-renders forever.
// ---------------------------------------------------------------------------
let seenSnapshot: string | null = null;
const seenListeners = new Set<() => void>();

function subscribeToSeen(onChange: () => void): () => void {
  seenListeners.add(onChange);
  return () => seenListeners.delete(onChange);
}

function seenClientSnapshot(): string {
  if (seenSnapshot === null) seenSnapshot = JSON.stringify(readSeen());
  return seenSnapshot;
}

/** The server has no sessionStorage, and no age gate cleared either. */
function seenServerSnapshot(): string {
  return "[]";
}

function markSeen(tag: string) {
  const next = [...new Set([...readSeen(), tag])].slice(-8);
  seenSnapshot = JSON.stringify(next);
  try {
    window.sessionStorage.setItem(SEEN_KEY, seenSnapshot);
  } catch {
    /* nothing depends on this persisting; the card still closes for this view */
  }
  for (const listener of seenListeners) listener();
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="vl-offer-modal-x"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function StorefrontOfferModal({ offers }: { offers: StorefrontOffer[] }) {
  const pathname = usePathname();
  const seenRaw = useSyncExternalStore(subscribeToSeen, seenClientSnapshot, seenServerSnapshot);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The same filter the bar applies. Standing terms — free shipping, quantity
  // pricing — are always true and are not news; a card announcing them would be
  // an interruption that tells the customer nothing.
  const offer = useMemo(() => offers.find((o) => !o.standing) ?? null, [offers]);

  // DERIVED, NOT DECIDED. All four inputs are known during render, so the card
  // is open or it is not — there is no moment where it has been mounted and is
  // still working out whether it should have been.
  //
  // It is false on the server on two counts: nothing has been seen there, and
  // The age gate is gone — the Research Access Portal is the one consent
  // screen now, and it stands at the catalog rather than in front of the site.
  // So the
  // document ships without it and it appears when the shopper actually arrives,
  // which is also the answer to "never over the age gate".
  const seen = useMemo<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(seenRaw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }, [seenRaw]);

  const open = Boolean(
    isShoppingRoute(pathname) && offer && !seen.includes(offerTag(offer.id)),
  );

  const close = useCallback(() => {
    if (offer) markSeen(offerTag(offer.id));
  }, [offer]);

  // ESCAPE CLOSES IT. A modal that can only be dismissed by finding a small
  // control is a modal that traps a keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Focus moves into the card so a keyboard or screen-reader user meets it
  // rather than continuing to tab through the catalogue behind it.
  //
  // NO SCROLL LOCK, DELIBERATELY. The age gate already owns body overflow for
  // its own lifetime and restores what it found; a second component writing the
  // same property is how one of them ends up leaving the store unscrollable.
  // The page behind this card scrolls, which costs nothing — the card is
  // centred and fixed, and closing it is one tap.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  const copy = useCallback(async () => {
    if (!offer?.code) return;
    try {
      await navigator.clipboard.writeText(offer.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is blocked in several webviews. The code is rendered as text
      // for exactly this reason: it can still be read and typed.
    }
  }, [offer]);

  if (!open || !offer) return null;

  const titleId = "vl-offer-modal-title";

  return (
    <div className="vl-offer-modal-scrim" data-offer-modal="true">
      {/* THE BACKDROP IS A BUTTON, not a div with a click handler: tapping
          outside to dismiss is a real affordance and it should be reachable
          and announced like one. It sits behind the card in the DOM so the
          card's own controls are the first thing focus reaches. */}
      <button
        type="button"
        className="vl-offer-modal-backdrop"
        aria-label="Close offer"
        onClick={close}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        /* Dressed by the offer it is showing, exactly like the bar — the theme
           is the current offer's, not the store's and not the date's. The
           token block in globals.css is shared between the two selectors, so
           the card cannot drift from the band above it. */
        className={`vl-offer-modal vl-focus-ring${offer.theme ? ` vl-offer-modal--${offer.theme}` : ""}`}
      >
        {offer.theme === "americana" ? <span className="vl-offer-flag" aria-hidden="true" /> : null}

        <button
          type="button"
          onClick={close}
          className="vl-offer-modal-close vl-focus-ring"
          aria-label="Close offer"
        >
          <CloseIcon />
        </button>

        <div className="vl-offer-modal-inner">
          <p className="vl-offer-modal-eyebrow">{offer.eyebrow}</p>
          <p id={titleId} className="vl-offer-modal-headline">{offer.headline}</p>

          {offer.code ? (
            <>
              {/* A CODE THAT MUST BE TYPED GETS A CONTROL THAT TYPES IT. */}
              <button
                type="button"
                onClick={copy}
                className="vl-offer-modal-code vl-focus-ring"
                aria-label={`Copy promo code ${offer.code} to your clipboard`}
              >
                <span className="vl-offer-modal-code-label" aria-hidden="true">Code</span>
                <span className="vl-offer-modal-code-text">{offer.code}</span>
                <span className="vl-offer-modal-copy" aria-hidden="true">
                  {copied ? "Copied" : "Copy code"}
                </span>
              </button>
              <span aria-live="polite" className="sr-only">
                {copied ? `Code ${offer.code} copied` : ""}
              </span>
            </>
          ) : (
            /* NO CODE MEANS NO CODE UI — the same rule the bar states. A copy
               button with nothing to copy teaches a customer to hunt for
               something to type that does not exist. */
            <p className="vl-offer-modal-auto">{offer.automaticNote}</p>
          )}

          <button type="button" onClick={close} className="vl-offer-modal-continue vl-focus-ring">
            Continue shopping
          </button>
        </div>
      </div>
    </div>
  );
}
