"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SMS_BAR_TEXT,
  SMS_CONTINUE_BUTTON,
  SMS_COPIED_LABEL,
  SMS_COPY_BUTTON,
  SMS_INVITE_BODY,
  SMS_INVITE_BUTTON,
  SMS_INVITE_FIELD_LABEL,
  SMS_INVITE_HEADLINE,
  SMS_PRODUCT_LINK,
  SMS_SUCCESS_BODY,
  SMS_SUCCESS_HEADLINE,
  WELCOME_OFFER_TERMS,
} from "@/lib/offers/welcome-offer-copy";
import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";

/**
 * THE TEXT-LIST SIGN-UP, WHEREVER THE SHOPPER ALREADY IS.
 *
 * Three quiet shapes of one thing: a slim bar above the catalogue, a single
 * line on a product page, a card beside the cart's order summary.
 *
 * IT ASKS FOR NOTHING IN RETURN FOR A DISCOUNT ANY MORE, because there is no
 * longer one to give: the welcome code was retired on 2026-09-18 and the wheel
 * took its place as the store's acquisition offer. So these say what the texts
 * are and nothing else, and every shopper sees the same sentence — the ask no
 * longer has an eligible and an ineligible version of itself, which is what
 * `offerAvailable` and the separate returning-buyer wording existed to
 * separate. Two constants saying the same thing is exactly the drift this
 * module was written to stop.
 *
 * NO POPUP HERE, EVER. These open in place, pushing the page down, and close
 * again. The one modal in this store's shopping flow is the wheel invitation,
 * and it coordinates so that it and the promotions modal are never both on
 * screen.
 *
 * IT DISAPPEARS WHEN IT SHOULD. Someone already on the list with nothing to
 * give sees nothing at all; someone still holding a code from before the
 * retirement sees the code instead of an ask; and with the kill switch off,
 * none of it renders. The server decides all of that, so no surface can reach
 * its own conclusion.
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
 * The consent box is separate from the field and never pre-ticked, and the full
 * disclosure sits under it with both policy links. There are no offer terms
 * above the button any more because there is no offer: the terms block stated
 * the retired welcome code's three restrictions, and printing them over a form
 * that mints nothing would describe a deal the shopper is not being given.
 */
export function SmsSignupForm({
  onSubscribed,
  autoFocus = false,
}: {
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
        // The submit above refuses without the tick, so this path is always a
        // consent — stated explicitly because the endpoint no longer infers it
        // from a number being present.
        body: JSON.stringify({ phone, placement: "storefront", smsConsent: true }),
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
    <div className="mt-4" data-testid="welcome-offer-form">
      <div className="mt-3 space-y-2.5">
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
          className="vl-sms-field vl-focus-ring"
        />
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={saving}
          data-testid="welcome-offer-submit"
          className="vl-sms-submit vl-focus-ring"
        >
          {saving ? "Sending" : SMS_INVITE_BUTTON}
        </button>
      </div>
      <label className="vl-sms-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          data-testid="welcome-offer-consent"
        />
        <span className="vl-sms-legal">{SMS_CONSENT_TEXT}</span>
      </label>
      <p className="vl-sms-legal mt-2">
        {SMS_DISCLOSURE_TEXT}{" "}
        <Link href="/legal/terms">Terms</Link>
        {" and "}
        <Link href="/legal/privacy">Privacy Policy</Link>
      </p>
      {error ? <p className="vl-sms-error" data-testid="welcome-offer-error">{error}</p> : null}
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
      <p className="vl-sms-eyebrow">{SMS_SUCCESS_HEADLINE}</p>
      <p className="vl-sms-body">{SMS_SUCCESS_BODY}</p>
      <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
        <code className="vl-sms-code" data-testid="welcome-offer-code">{code}</code>
        <button type="button" onClick={() => { void copy(); }} data-testid="welcome-offer-copy" className="vl-sms-ghost vl-focus-ring">
          {copied ? SMS_COPIED_LABEL : SMS_COPY_BUTTON}
        </button>
        {onContinue ? (
          <button type="button" onClick={onContinue} data-testid="welcome-offer-continue" className="vl-sms-ghost vl-focus-ring">
            {SMS_CONTINUE_BUTTON}
          </button>
        ) : null}
      </div>
      <p className="vl-sms-terms">{ends ? `Valid until ${ends}. ` : ""}{WELCOME_OFFER_TERMS}</p>
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
  if (!claimed && dismissed) return null;

  // ONE SENTENCE FOR EVERYONE. A first-time shopper and a returning buyer are
  // offered the same thing now — the list — so telling them apart here would
  // only produce two ways of saying it.
  const invitation = SMS_INVITE_BODY;
  const form = <SmsSignupForm onSubscribed={(next) => { setOffer(next); setOpen(false); }} autoFocus={open} />;
  const claimedBody = claimed ? <WelcomeCodeCard offer={offer} /> : null;

  if (variant === "link") {
    return (
      <div className="mt-5" data-testid="welcome-offer-link">
        {claimedBody ? <div className="vl-sms-card p-5 text-center">{claimedBody}</div> : (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              data-testid="welcome-offer-open"
              className="vl-sms-quiet-link vl-focus-ring"
            >
              {SMS_PRODUCT_LINK}
            </button>
            {open ? (
              <div className="vl-sms-card mt-3 p-5">
                <p className="vl-sms-eyebrow">Vanta Labs</p>
                <p className="vl-sms-body">{invitation}</p>
                {form}
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  }

  // THE BAR. One line of furniture at the top of the catalogue, not a banner.
  if (variant === "bar") {
    if (claimed) {
      return (
        <div className="vl-sms-card p-5 text-center" data-testid="welcome-offer-bar">{claimedBody}</div>
      );
    }
    return (
      <div data-testid="welcome-offer-bar">
        <div className="vl-sms-bar">
          <p className="vl-sms-bar-text">{SMS_BAR_TEXT}</p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-testid="welcome-offer-open"
            className="vl-sms-pill vl-focus-ring"
          >
            {open ? "Close" : "Join"}
          </button>
          <button
            type="button"
            onClick={() => { setDismissed(true); writeDismissed(); }}
            aria-label="Dismiss"
            data-testid="welcome-offer-dismiss"
            className="vl-sms-dismiss vl-focus-ring"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {open ? (
          <div className="vl-sms-card mt-2 p-5">
            <p className="vl-sms-body mt-0">{invitation}</p>
            {form}
          </div>
        ) : null}
      </div>
    );
  }

  // THE CART CARD. Beside the money, so it carries the full promise: eyebrow,
  // the serif headline, the reason, the terms.
  return (
    <div className="vl-sms-card p-6" data-testid="welcome-offer-card">
      {claimedBody ? <div className="text-center">{claimedBody}</div> : (
        <>
          <div className="flex items-start justify-between gap-3">
            <p className="vl-sms-eyebrow">Vanta Labs</p>
            <button
              type="button"
              onClick={() => { setDismissed(true); writeDismissed(); }}
              aria-label="Dismiss"
              data-testid="welcome-offer-dismiss"
              className="vl-sms-dismiss vl-focus-ring -mt-1"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <p className="vl-sms-headline">{SMS_INVITE_HEADLINE}</p>
          <p className="vl-sms-body">{SMS_INVITE_BODY}</p>
          {open ? form : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              data-testid="welcome-offer-open"
              className="vl-sms-submit vl-focus-ring mt-4"
            >
              {SMS_INVITE_BUTTON}
            </button>
          )}
        </>
      )}
    </div>
  );
}
