"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  MAX_DISMISSALS,
  OFFERS_DISMISSED_COOKIE,
  endsLabel,
  offerTag,
  parseDismissed,
  serializeDismissed,
  type StorefrontOffer,
} from "@/lib/storefront-offer-format";

// ---------------------------------------------------------------------------
// THE OFFERS BAR.
//
// A thin ribbon at the top of the shopping pages carrying whatever the store is
// genuinely running. Everything it says comes from storefront-offers.ts, which
// reads the systems that actually apply the discounts — so the bar cannot get
// out of step with the total.
//
// WHAT IT IS NOT. It is not a sale banner. There is no gold fill, no glow, no
// shimmer, no countdown, no pulsing, and nothing moves after it has arrived.
// The whole effect is one hairline of warm gold on near-black and a single
// figure set large — the offer reads because it has room and contrast, not
// because it is shouting. A luxury house running an exclusive offer states it
// once, quietly, in good type.
//
// WHY IT IS IN NORMAL FLOW. Same reason the consent bar is (see
// cookie-consent.tsx): the site header is `position: fixed`, and anything
// pinned near it either hides under it or covers the page. In flow, at the top,
// it pushes content down by exactly its own height and can never cover a
// control or be covered by one. It scrolls away and does not come back.
// ---------------------------------------------------------------------------

/** Routes where an offer would be a distraction or a risk, not a service. */
function isSuppressedRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return (
    // Money in progress. Nothing new goes on the screen during payment, and
    // nothing in this component is allowed anywhere near that flow.
    pathname.startsWith("/checkout")
    || pathname.startsWith("/order")
    // Operator surfaces, not shopping surfaces.
    || pathname.startsWith("/admin")
    || pathname.startsWith("/vault")
    || pathname.startsWith("/partner")
  );
}

function readCookie(): string[] {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${OFFERS_DISMISSED_COOKIE}=([^;]*)`));
    return parseDismissed(match ? decodeURIComponent(match[1]) : "");
  } catch {
    return [];
  }
}

function writeCookie(tags: string[]) {
  try {
    const value = serializeDismissed(tags);
    // A year, site-wide, Lax. Nothing identifying is stored — see the note on
    // OFFERS_DISMISSED_COOKIE. Secure is set only on https so this still works
    // on a local http build.
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${OFFERS_DISMISSED_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  } catch {
    /* dismissal simply does not persist if cookies are unavailable */
  }
}

function GiftIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="vl-offer-icon"
    >
      <path d="M4 11h16v9H4z" />
      <path d="M3 7.5h18V11H3z" />
      <path d="M12 7.5V20" />
      <path d="M12 7.5S10.6 4 8.7 4a2 2 0 0 0 0 3.5z" />
      <path d="M12 7.5S13.4 4 15.3 4a2 2 0 0 1 0 3.5z" />
    </svg>
  );
}

function OfferBody({ offer, onCopy, copied }: {
  offer: StorefrontOffer;
  onCopy: (code: string) => void;
  copied: boolean;
}) {
  const ends = endsLabel(offer.endsAt);
  return (
    <div className="vl-offer-body">
      <GiftIcon />
      <div className="vl-offer-text">
        <p className="vl-offer-eyebrow">{offer.eyebrow}</p>
        {/* The benefit, largest, first. Nothing above it competes for the eye. */}
        <p className="vl-offer-headline">{offer.headline}</p>
      </div>

      {offer.code ? (
        <div className="vl-offer-code-group">
          <span className="vl-offer-code-label">Use code</span>
          <button
            type="button"
            onClick={() => onCopy(offer.code as string)}
            className="vl-offer-code vl-focus-ring"
            aria-label={`Copy promo code ${offer.code}`}
          >
            <span className="vl-offer-code-text">{offer.code}</span>
            {/* Confirmation lives inside the control that was tapped. A toast
                for copying six characters is a modal interrupting a decision. */}
            <span className="vl-offer-copy" aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
          </button>
          <span aria-live="polite" className="sr-only">{copied ? `Code ${offer.code} copied` : ""}</span>
        </div>
      ) : (
        // NO CODE MEANS NO CODE UI. A fake "AUTO" chip styled like a coupon
        // teaches customers to look for something to type that does not exist.
        <p className="vl-offer-auto">{offer.automaticNote}</p>
      )}

      {ends ? <span className="vl-offer-ends">{ends}</span> : null}
    </div>
  );
}

export function StorefrontOffersBar({ offers }: { offers: StorefrontOffer[] }) {
  const pathname = usePathname();
  // Starts EMPTY on purpose. The server has already removed everything this
  // visitor dismissed, using the same cookie, so `offers` is the final list and
  // the first paint is correct. This state only records dismissals made during
  // THIS page view, before the cookie is read again on the next request.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const live = useMemo(
    () => offers.filter((o) => !dismissed.includes(o.id)),
    [offers, dismissed],
  );
  // Standing terms (free shipping, quantity pricing) are listed in the sheet
  // but never carry the bar alone — dismissing the sale should close the bar,
  // not leave a shipping-policy ribbon behind pretending to be an offer.
  const promotions = useMemo(() => live.filter((o) => !o.standing), [live]);
  const current = promotions[Math.min(index, Math.max(promotions.length - 1, 0))];

  const copy = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Clipboard is blocked in several in-app webviews. The code is on screen
      // in full, so it can still be read and typed — which is why the code is
      // rendered as text and not hidden behind the copy button.
    }
  }, []);

  const dismiss = useCallback(() => {
    if (!current) return;
    setDismissed((prev) => [...new Set([...prev, current.id])]);
    setIndex(0);
    // Keyed on the offer's content-derived id, never a blanket "hidden" flag:
    // a different or improved offer hashes differently and is free to appear.
    writeCookie([...readCookie(), offerTag(current.id)].slice(-MAX_DISMISSALS));
  }, [current]);

  if (isSuppressedRoute(pathname) || !current) return null;

  return (
    <>
      <section className="vl-offer-bar" aria-label="Current offers">
        <div className="vl-offer-inner">
          {current.href ? (
            <Link href={current.href} className="vl-offer-main vl-focus-ring" aria-label={`${current.headline}. Shop the offer.`}>
              <OfferBody offer={current} onCopy={copy} copied={copied === current.code} />
            </Link>
          ) : (
            <div className="vl-offer-main">
              <OfferBody offer={current} onCopy={copy} copied={copied === current.code} />
            </div>
          )}

          <div className="vl-offer-actions">
            {live.length > 1 ? (
              <button type="button" onClick={() => setSheetOpen(true)} className="vl-offer-link vl-focus-ring">
                {promotions.length > 1 ? `All ${live.length} offers` : "Details"}
              </button>
            ) : (
              <button type="button" onClick={() => setSheetOpen(true)} className="vl-offer-link vl-focus-ring">
                Details
              </button>
            )}
            <button type="button" onClick={dismiss} className="vl-offer-close vl-focus-ring" aria-label="Dismiss this offer">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className="h-3.5 w-3.5">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
      </section>

      {sheetOpen ? (
        <div className="vl-offer-sheet-root" role="presentation">
          <button type="button" tabIndex={-1} aria-label="Dismiss offers" onClick={() => setSheetOpen(false)} className="absolute inset-0 bg-black/70 backdrop-blur-[3px]" />
          <div role="dialog" aria-modal="true" aria-labelledby="offers-sheet-title" className="vl-offer-sheet">
            <div className="flex items-start justify-between gap-3">
              <p id="offers-sheet-title" className="vl-offer-sheet-title">Current offers</p>
              <button type="button" onClick={() => setSheetOpen(false)} aria-label="Close" className="vl-offer-sheet-close vl-focus-ring">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            <ul className="vl-offer-list">
              {live.map((o) => {
                const ends = endsLabel(o.endsAt);
                return (
                  <li key={o.id} className="vl-offer-list-item">
                    <p className="vl-offer-list-headline">{o.headline}</p>
                    <p className="vl-offer-list-meta">
                      {o.code ? <>Use code <span className="vl-offer-list-code">{o.code}</span></> : o.automaticNote}
                      {ends ? <> · {ends}</> : null}
                    </p>
                    {/* Conditions belong here, in full sentences, and nowhere
                        near the bar itself. The bar states the benefit; this
                        states what it takes to get it. */}
                    {o.details.map((d) => (
                      <p key={d} className="vl-offer-list-detail">{d}</p>
                    ))}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
