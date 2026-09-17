"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SMS_BAR_TEXT,
  SMS_CART_TEXT,
  SMS_CONTINUE_BUTTON,
  SMS_COPIED_LABEL,
  SMS_COPY_BUTTON,
  SMS_INVITE_BODY,
  SMS_INVITE_BUTTON,
  SMS_INVITE_FIELD_LABEL,
  SMS_PRODUCT_LINK,
  SMS_RETURNING_INVITE,
  SMS_SUCCESS_BODY,
  SMS_SUCCESS_HEADLINE,
  WELCOME_OFFER_TERMS,
} from "@/lib/offers/welcome-offer-copy";
import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";

/**
 * THE TEXT-LIST SIGN-UP, WHEREVER THE SHOPPER ALREADY IS.
 *
 * Three quiet shapes of one thing: a slim bar above the catalogue, a single
 * line on a product page, a card beside the cart's order summary. The
 * invitation modal (sms-invite-modal.tsx) and the checkout panel reuse the
 * same state and the same form; the checkout has its own treatment because
 * there the code has to land on the order rather than be read.
 *
 * NO POPUP HERE, EVER. These open in place, pushing the page down, and close
 * again. The one modal in this store's shopping flow is the invitation, and it
 * coordinates so that it and the promotions modal are never both on screen.
 *
 * IT DISAPPEARS WHEN IT SHOULD. Someone who has bought never sees a
 * first-order discount; someone already on the list with nothing to give sees
 * nothing at all; someone holding a code sees the code instead of an ask; and
 * with the kill switch off, none of it renders. The server decides all of
 * that, so no surface can reach its own conclusion.
 */

export type OfferState = {
  status: "loading" | "unknown" | "eligible" | "claimed" | "returning" | "suppressed";
  code?: string;
  endsAt?: string;
  percent?: number;
  mayInterrupt?: boolean;
  promptsEnabled?: boolean;
  dismissCooldownDays?: number;
};

/** Deterministic on both sides of hydration: fixed locale, fixed zone. */
export function formatEnds(endsAt: string | undefined): string {
  if (!endsAt) return "";
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" }).format(date);
  } catch {
    return "";
  }
}

/** One read of the offer for whichever surface asked. Never mints. */
export function useWelcomeOffer(): [OfferState, (next: OfferState) => void] {
  const [offer, setOffer] = useState<OfferState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void fetch("/api/offers/welcome", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: OfferState | null) => {
        if (!live) return;
        const status = data?.status;
        if (status === "eligible" || status === "claimed" || status === "returning") setOffer(data as OfferState);
        else setOffer({ status: (status === "unknown" ? "unknown" : "suppressed"), promptsEnabled: data?.promptsEnabled });
      })
      .catch(() => { if (live) setOffer({ status: "suppressed" }); });
    return () => { live = false; };
  }, []);
  return [offer, setOffer];
}

/**
 * THE FORM ITSELF: a number, the consent box, the button.
 *
 * The consent box is separate from the field and never pre-ticked, the full
 * disclosure sits under it with both policy links, and the offer's terms are
 * on screen BEFORE the button rather than revealed afterwards. A returning
 * buyer sees the same form with no discount attached to it.
 */
export function SmsSignupForm({
  offerAvailable,
  onSubscribed,
  autoFocus = false,
}: {
  offerAvailable: boolean;
  onSubscribed: (next: OfferState) => void;
  autoFocus?: boolean;
}) {
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const phoneRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { if (autoFocus) phoneRef.current?.focus(); }, [autoFocus]);

  const submit = useCallback(async () => {
    if (saving) return;
    if (!consent) { setError("Tick the box to receive texts."); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/offers/welcome", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, placement: "storefront" }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; code?: string; endsAt?: string; percent?: number };
      if (data?.ok && data.code) {
        onSubscribed({ status: "claimed", code: data.code, endsAt: data.endsAt, percent: data.percent ?? 15 });
        return;
      }
      if (data?.ok) {
        // Subscribed with no code: a returning buyer, or the kill switch is on.
        onSubscribed({ status: "suppressed" });
        return;
      }
      setError(data?.error ?? "This did not go through. Please try again.");
    } catch {
      setError("This did not go through. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [consent, onSubscribed, phone, saving]);

  return (
    <div className="mt-3 space-y-3" data-testid="welcome-offer-form">
      {offerAvailable ? (
        <p className="text-[11px] leading-relaxed text-white/45" data-testid="welcome-offer-terms">{WELCOME_OFFER_TERMS}</p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={phoneRef}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={SMS_INVITE_FIELD_LABEL}
          aria-label={SMS_INVITE_FIELD_LABEL}
          data-testid="welcome-offer-phone"
          className="vl-focus-ring min-w-0 flex-1 rounded-xl border border-white/[0.16] bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/30"
        />
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={saving}
          data-testid="welcome-offer-submit"
          className="vl-focus-ring flex-shrink-0 rounded-xl border border-[color:var(--accent-gold)]/40 bg-[var(--accent-gold-soft)] px-5 py-3 text-xs font-semibold uppercase tracking-wide text-[color:var(--accent-gold)] transition hover:bg-[var(--accent-gold-soft)]/70 disabled:opacity-50"
        >
          {saving ? "Sending" : offerAvailable ? SMS_INVITE_BUTTON : "Join the list"}
        </button>
      </div>
      <label className="flex cursor-pointer items-start gap-3 text-white/55">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          data-testid="welcome-offer-consent"
          className="mt-0.5 h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-[color:var(--accent-gold)]"
        />
        <span className="text-[11px] leading-relaxed">{SMS_CONSENT_TEXT}</span>
      </label>
      <p className="text-[11px] leading-relaxed text-white/30">
        {SMS_DISCLOSURE_TEXT}{" "}
        <Link href="/legal/terms" className="text-white/50 underline underline-offset-2 hover:text-white">Terms</Link>
        {" and "}
        <Link href="/legal/privacy" className="text-white/50 underline underline-offset-2 hover:text-white">Privacy Policy</Link>
      </p>
      {error ? <p className="text-[11px] text-[#f09ca8]" data-testid="welcome-offer-error">{error}</p> : null}
    </div>
  );
}

/**
 * THE REWARD, IMMEDIATELY. The code is on screen the moment the sign-up
 * succeeds, with one press to copy it and a way back to shopping. Nothing
 * here waits on the half-hourly Omnisend sync; that sync is a backstop for
 * the contact record, not the path to the customer's reward.
 */
export function WelcomeCodeCard({ offer, onContinue }: { offer: OfferState; onContinue?: () => void }) {
  const [copied, setCopied] = useState(false);
  const code = offer.code ?? "";
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (permissions, an insecure origin). The code is on
      // screen and selectable, which is the fallback that always works.
      setCopied(false);
    }
  }, [code]);

  const ends = formatEnds(offer.endsAt);
  return (
    <div data-testid="welcome-offer-claimed">
      <p className="text-sm text-white">{SMS_SUCCESS_HEADLINE}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-white/50">{SMS_SUCCESS_BODY}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code data-testid="welcome-offer-code" className="rounded-lg border border-[color:var(--accent-gold)]/35 bg-black/40 px-3 py-2 font-mono text-sm tracking-widest text-[color:var(--accent-gold)]">
          {code}
        </code>
        <button
          type="button"
          onClick={() => { void copy(); }}
          data-testid="welcome-offer-copy"
          className="vl-focus-ring rounded-lg border border-white/[0.16] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-white/70 hover:bg-white/[0.06]"
        >
          {copied ? SMS_COPIED_LABEL : SMS_COPY_BUTTON}
        </button>
        {onContinue ? (
          <button
            type="button"
            onClick={onContinue}
            data-testid="welcome-offer-continue"
            className="vl-focus-ring rounded-lg px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)] underline underline-offset-4"
          >
            {SMS_CONTINUE_BUTTON}
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-white/35">
        {ends ? `Valid until ${ends}. ` : ""}{WELCOME_OFFER_TERMS}
      </p>
    </div>
  );
}

const DISMISS_KEY = "vl-welcome-offer-dismissed";

function readDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}
function writeDismissed(): void {
  try { window.localStorage.setItem(DISMISS_KEY, "true"); } catch { /* private window: it simply shows again */ }
}

export function WelcomeOfferSignup({ variant }: { variant: "bar" | "link" | "card" }) {
  const [offer, setOffer] = useWelcomeOffer();
  const [open, setOpen] = useState(false);
  // Read lazily rather than in an effect: a synchronous setState there costs a
  // cascading render, and there is no hydration risk because this component
  // renders nothing at all until the fetch resolves, on the server and on the
  // first client pass alike.
  const [dismissed, setDismissed] = useState(readDismissed);

  // The kill switch hides every acquisition prompt. The plain consent boxes at
  // the checkout, the sign-in gate and the account page are not prompts and
  // stay where they are.
  // "unknown" means no session, and these surfaces are signed-in only.
  if (offer.status === "loading" || offer.status === "suppressed" || offer.status === "unknown") return null;
  if (offer.promptsEnabled === false) return null;

  const claimed = offer.status === "claimed";
  const returning = offer.status === "returning";
  const offerAvailable = offer.status === "eligible";
  if (!claimed && dismissed) return null;

  const invitation = returning ? SMS_RETURNING_INVITE : SMS_INVITE_BODY;
  const form = <SmsSignupForm offerAvailable={offerAvailable} onSubscribed={(next) => { setOffer(next); setOpen(false); }} autoFocus={open} />;
  const claimedBody = claimed ? <WelcomeCodeCard offer={offer} /> : null;

  if (variant === "link") {
    return (
      <div className="mt-4" data-testid="welcome-offer-link">
        {claimedBody ?? (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              data-testid="welcome-offer-open"
              className="vl-focus-ring text-left text-[12px] leading-relaxed text-[color:var(--accent-gold)]/85 underline underline-offset-4 hover:text-[color:var(--accent-gold)]"
            >
              {returning ? SMS_RETURNING_INVITE : SMS_PRODUCT_LINK}
            </button>
            {open ? (
              <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-[12px] leading-relaxed text-white/55">{invitation}</p>
                {form}
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const shell = variant === "bar"
    ? "rounded-xl border border-[color:var(--accent-gold)]/20 bg-[var(--accent-gold-soft)]/40 px-4 py-3"
    : "rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5";
  const headline = returning ? SMS_RETURNING_INVITE : variant === "bar" ? SMS_BAR_TEXT : SMS_CART_TEXT;

  return (
    <div className={shell} data-testid={variant === "bar" ? "welcome-offer-bar" : "welcome-offer-card"}>
      {claimedBody ?? (
        <>
          <div className="flex items-start justify-between gap-4">
            <p className="min-w-0 text-[13px] leading-relaxed text-white/75">
              <span className="text-white">{headline}</span>
              {offerAvailable ? <span className="text-white/45">{` ${WELCOME_OFFER_TERMS}`}</span> : null}
            </p>
            <div className="flex flex-shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid="welcome-offer-open"
                className="vl-focus-ring whitespace-nowrap text-[12px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)] underline underline-offset-4"
              >
                {open ? "Close" : "Join"}
              </button>
              <button
                type="button"
                onClick={() => { setDismissed(true); writeDismissed(); }}
                aria-label="Dismiss"
                data-testid="welcome-offer-dismiss"
                className="vl-focus-ring text-white/30 transition hover:text-white/60"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>
          {open ? form : null}
        </>
      )}
    </div>
  );
}
