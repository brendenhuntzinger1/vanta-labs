"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  SMS_INVITE_BODY,
  SMS_INVITE_HEADLINE,
} from "@/lib/offers/welcome-offer-copy";
import {
  SmsSignupForm,
  WelcomeCodeCard,
  useWelcomeOffer,
  type OfferState,
} from "@/components/welcome-offer-signup";

/**
 * THE ONE INVITATION.
 *
 * The store's single interruption, and it earns that by being rare rather than
 * by being loud: one card, on the catalogue, a few seconds after a shopper has
 * had a chance to look at something, only for a person the offer is actually
 * open to, never twice in a session, and not again for a week after it is
 * dismissed.
 *
 * WHAT IT WILL NOT DO:
 *
 *   * open anywhere but the catalogue and its product pages. Never the home
 *     page (the owner keeps the front page brand-only), never the cart, never
 *     the checkout, never a payment screen;
 *   * open while anything else is on screen. It looks for a live dialog or the
 *     promotions card before it opens and yields to it, so a shopper never
 *     meets two cards at once;
 *   * open for someone who has bought, someone already on the list, someone
 *     holding a code, or someone who once said stop. The server decides all of
 *     that and answers `mayInterrupt`; this component never works it out;
 *   * open at all while the kill switch is off, which it is until the carriers
 *     approve this store's use case.
 *
 * DISMISSAL IS REAL. The close control is labelled, the backdrop closes it,
 * escape closes it, and none of it is required to keep shopping. Closing it
 * ends it for the session and starts the cooldown for later visits.
 */

/** Where shopping happens, and therefore the only place an invitation may open. */
function isShoppingRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/products" || pathname.startsWith("/products/");
}

/**
 * IS ANYTHING ELSE ON SCREEN? Read from the DOM rather than from shared state,
 * deliberately: the promotions card, the mobile filter sheet and anything else
 * that opens over the page already mark themselves, and a coordinator both
 * components have to remember to call is a coordinator that will eventually be
 * forgotten. The question "is something covering the page right now" has one
 * honest answer and the DOM is holding it.
 */
function anotherOverlayIsOpen(): boolean {
  try {
    return Boolean(document.querySelector('[data-offer-modal], [role="dialog"], [data-vl-overlay]'));
  } catch {
    return true;
  }
}

const SESSION_KEY = "vl-sms-invite-seen";
const COOLDOWN_KEY = "vl-sms-invite-dismissed-at";
/** Long enough to look at something, short enough to still be the first offer. */
const OPEN_AFTER_MS = 6000;

function seenThisSession(): boolean {
  try { return window.sessionStorage.getItem(SESSION_KEY) === "true"; } catch { return false; }
}
function markSeenThisSession(): void {
  try { window.sessionStorage.setItem(SESSION_KEY, "true"); } catch { /* private window */ }
}
function withinCooldown(days: number): boolean {
  try {
    const raw = window.localStorage.getItem(COOLDOWN_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < days * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}
function markDismissed(): void {
  try { window.localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch { /* private window */ }
}

export function SmsInviteModal() {
  const pathname = usePathname();
  const [offer, setOffer] = useWelcomeOffer();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    markSeenThisSession();
    markDismissed();
  }, []);

  useEffect(() => {
    if (open) return;
    if (!isShoppingRoute(pathname)) return;
    if (offer.status !== "eligible" || !offer.mayInterrupt) return;
    if (offer.promptsEnabled === false) return;
    if (seenThisSession()) return;
    if (withinCooldown(offer.dismissCooldownDays ?? 7)) return;

    const timer = window.setTimeout(() => {
      // Re-checked at the moment of opening, not only when the timer was set:
      // the promotions card may have opened in the meantime.
      if (anotherOverlayIsOpen()) return;
      markSeenThisSession();
      setOpen(true);
    }, OPEN_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [offer, open, pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, open]);

  if (!open) return null;

  const claimed = offer.status === "claimed";
  const titleId = "vl-sms-invite-title";

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center px-4"
      data-vl-overlay="sms-invite"
      data-testid="sms-invite-modal"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="absolute inset-0 h-full w-full bg-black/70 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[420px] rounded-2xl border border-[color:var(--accent-gold)]/25 bg-[#141414] p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]"
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          data-testid="sms-invite-close"
          className="vl-focus-ring absolute right-3 top-3 rounded-full px-2 py-1 text-lg leading-none text-white/40 transition hover:bg-white/[0.06] hover:text-white"
        >
          <span aria-hidden="true">×</span>
        </button>

        <p className="text-[10px] uppercase tracking-[0.3em] text-[color:var(--accent-gold)]/75">Vanta Labs</p>

        {claimed ? (
          <div className="mt-4">
            <WelcomeCodeCard offer={offer as OfferState} onContinue={close} />
          </div>
        ) : (
          <>
            <h2 id={titleId} className="vl2-serif mt-3 text-[1.6rem] leading-tight text-white">
              {SMS_INVITE_HEADLINE}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-white/60">{SMS_INVITE_BODY}</p>
            <SmsSignupForm
              offerAvailable
              autoFocus
              onSubscribed={(next) => {
                setOffer(next);
                markSeenThisSession();
                if (next.status !== "claimed") close();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
