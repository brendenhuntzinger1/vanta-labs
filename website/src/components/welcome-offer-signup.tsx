"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  WELCOME_OFFER_READY,
  WELCOME_OFFER_HEADLINE,
  WELCOME_OFFER_LINK_LABEL,
  WELCOME_OFFER_SENTENCE,
  WELCOME_OFFER_TERMS,
  welcomeOfferCodeLine,
} from "@/lib/offers/welcome-offer-copy";
import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";

/**
 * THE WELCOME OFFER, WHEREVER THE SHOPPER ALREADY IS.
 *
 * Three shapes of the same thing: a slim bar above the catalogue, a single
 * discreet line on a product page, and a card beside the cart's order summary.
 * The checkout has its own treatment, wired into the coupon field, because
 * there the code has to land on the order rather than be read.
 *
 * NO POPUP, EVER. It opens in place, pushing the page down a little, and it
 * closes again. The store already has one overlay (the Omnisend pop-up) and a
 * second thing that covers the page is how a subtle offer becomes an
 * annoyance — the owner's instruction, and the reason this is a disclosure
 * rather than a dialog. Nothing here traps focus or blocks the page.
 *
 * IT DISAPPEARS WHEN IT SHOULD. Someone who has already bought never sees it;
 * someone who already holds a code sees the code instead of the ask; someone
 * who closes it is not asked again on that device. The server decides the
 * first two (GET /api/offers/welcome), localStorage the third, and a
 * localStorage that throws (private windows do) simply means it shows.
 */

type OfferState =
  | { status: "loading" }
  | { status: "eligible" }
  | { status: "claimed"; code: string; endsAt: string; percent: number }
  | { status: "ineligible" };

const DISMISS_KEY = "vl-welcome-offer-dismissed";

/** Deterministic on both sides of hydration: fixed locale, fixed zone. */
function formatEnds(endsAt: string): string {
  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" }).format(date);
  } catch {
    return "";
  }
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "true");
  } catch {
    // A private window keeps nothing. Showing the offer again is the harmless
    // direction; never let a storage refusal break the render.
  }
}

export function WelcomeOfferSignup({ variant }: { variant: "bar" | "link" | "card" }) {
  const [offer, setOffer] = useState<OfferState>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const phoneRef = useRef<HTMLInputElement | null>(null);

  // The dismissal is read in the same callback that settles the offer, not in
  // the effect body: a synchronous setState there costs a cascading render for
  // a value nothing can display yet (the component renders nothing at all
  // until the fetch answers).
  useEffect(() => {
    let live = true;
    void fetch("/api/offers/welcome", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : { status: "ineligible" }))
      .then((data: OfferState) => {
        if (!live) return;
        setDismissed(readDismissed());
        const status = (data as { status?: string })?.status;
        if (status === "eligible" || status === "claimed") setOffer(data);
        else setOffer({ status: "ineligible" });
      })
      .catch(() => { if (live) setOffer({ status: "ineligible" }); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (open) phoneRef.current?.focus();
  }, [open]);

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
        body: JSON.stringify({ phone, placement: variant }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; code?: string; endsAt?: string; percent?: number };
      if (data?.ok && data.code && data.endsAt) {
        setOffer({ status: "claimed", code: data.code, endsAt: data.endsAt, percent: data.percent ?? 15 });
        setOpen(false);
        return;
      }
      setError(data?.error ?? "This offer is not available right now.");
    } catch {
      setError("This offer is not available right now.");
    } finally {
      setSaving(false);
    }
  }, [consent, phone, saving, variant]);

  if (offer.status === "loading" || offer.status === "ineligible") return null;

  const claimed = offer.status === "claimed" ? offer : null;
  if (!claimed && dismissed) return null;

  const form = (
    <div className="mt-3 space-y-3" data-testid="welcome-offer-form">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={phoneRef}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Mobile number"
          aria-label="Mobile number"
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
          {saving ? "Sending" : "Get the code"}
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
        <Link href="/legal/privacy" className="text-white/50 underline underline-offset-2 hover:text-white">Privacy Policy</Link>
      </p>
      {error ? <p className="text-[11px] text-[#f09ca8]" data-testid="welcome-offer-error">{error}</p> : null}
    </div>
  );

  const claimedBody = claimed ? (
    <div data-testid="welcome-offer-claimed">
      <p className="text-sm text-white/80">{WELCOME_OFFER_READY}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-white/45">
        {welcomeOfferCodeLine(claimed.code)}
        {formatEnds(claimed.endsAt) ? ` Valid until ${formatEnds(claimed.endsAt)}.` : ""}
      </p>
      <p className="mt-1 text-[11px] text-white/30">Cannot be combined with other offers.</p>
    </div>
  ) : null;

  if (variant === "link") {
    return (
      <div className="mt-4" data-testid="welcome-offer-link">
        {claimedBody ?? (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="vl-focus-ring text-left text-[12px] leading-relaxed text-[color:var(--accent-gold)]/85 underline underline-offset-4 hover:text-[color:var(--accent-gold)]"
            >
              {WELCOME_OFFER_LINK_LABEL}
            </button>
            {open ? (
              <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-[12px] leading-relaxed text-white/55">{WELCOME_OFFER_SENTENCE}</p>
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

  return (
    <div className={shell} data-testid={variant === "bar" ? "welcome-offer-bar" : "welcome-offer-card"}>
      {claimedBody ?? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] leading-relaxed text-white/75">
                <span className="text-white">{WELCOME_OFFER_HEADLINE}</span>{" "}
                <span className="text-white/45">{WELCOME_OFFER_TERMS}</span>
              </p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid="welcome-offer-open"
                className="vl-focus-ring whitespace-nowrap text-[12px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)] underline underline-offset-4"
              >
                {open ? "Close" : "Subscribe"}
              </button>
              <button
                type="button"
                onClick={() => { setDismissed(true); writeDismissed(); }}
                aria-label="Dismiss the welcome offer"
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
