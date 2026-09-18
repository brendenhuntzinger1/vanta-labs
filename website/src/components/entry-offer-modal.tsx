"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";
import { WELCOME_OFFER_PERCENT } from "@/lib/offers/welcome-offer-copy";

/**
 * THE STORE INVITATION — the email and text sign-up a shopper meets once they
 * are inside.
 *
 * WHERE IT OPENS, AND WHY NOT AT THE DOOR. It used to mount on the access
 * portal. The owner's call is that the gate asks one thing: a visitor standing
 * at a sign-in screen has not chosen this store yet, and interrupting that
 * decision with a discount is the wrong first impression. So it opens on the
 * storefront pages behind the gate — the home page and the catalogue — and
 * never on checkout, an account screen or a payment page, where a card over
 * the task is a lost order rather than a captured address.
 *
 * SIX SECONDS, which is what sms-invite-modal.tsx already used before this
 * replaced it. A card that lands the instant a page paints reads as an ad; one
 * that waits until someone has looked at something reads as an offer. It is
 * also long enough that a shopper who arrived to do one specific thing can do
 * it first.
 *
 * IT REPLACES THAT OLDER INVITATION RATHER THAN JOINING IT. Two cards asking
 * the same question is worse than one, and this is the design the owner
 * approved. What carried over from it is the gating, which is the part that
 * matters: the server decides who may be interrupted and this never works it
 * out for itself.
 *
 * THE TWO TICKS ARE SEPARATE DECISIONS, AND STAY SEPARATE.
 *
 *   * the age and research confirmation is REQUIRED — this store may not
 *     market to anyone who has not made it;
 *   * the text consent is its own box and the offer rides on it, because the
 *     server issues no code without a mobile number. Neither box is ever
 *     pre-ticked, which is not a nicety — a pre-ticked box is not consent
 *     under the TCPA.
 *
 * THE COPY FOLLOWS THE SERVER, NEVER THE OTHER WAY ROUND. `promptsEnabled` is
 * the store's kill switch for first-order discounts. While it is off the
 * server records consent and issues NO code, so this must not promise one.
 *
 * NOT REACHABLE BY AN A2P REVIEWER, DELIBERATELY. Everything here is behind
 * the account wall. The publicly reachable opt-in, which is what a carrier
 * review can actually load, is the create-account form at /account/login: same
 * consent sentence, same unticked box, same two legal links.
 */

type OfferShape = {
  status?: string;
  /** The address the code will go to — the session's, never what is typed. */
  accountEmail?: string;
  mayInterrupt?: boolean;
  promptsEnabled?: boolean;
  dismissCooldownDays?: number;
};

/**
 * Where shopping happens, and therefore the only place this may open. Checkout
 * and the account screens are deliberately absent: a card over a task someone
 * is mid-way through costs an order.
 */
function isStoreRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/" || pathname === "/products" || pathname.startsWith("/products/");
}

/** The house interval, carried over from the invitation this replaced. */
const OPEN_AFTER_MS = 6000;

/** Remembered per browser, so a dismissal is not re-asked on the next page. */
const DISMISSED_KEY = "vl_entry_offer_dismissed_at";
const JOINED_KEY = "vl_entry_offer_joined";

function dismissedRecently(cooldownDays: number): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < Math.max(1, cooldownDays) * 24 * 60 * 60 * 1000;
  } catch {
    // Storage blocked (private mode). Treat as "not dismissed" rather than
    // suppressing an invitation nobody has actually declined.
    return false;
  }
}

function alreadyJoined(): boolean {
  try {
    return window.localStorage.getItem(JOINED_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing to do — the modal simply asks again next time */
  }
}

export function EntryOfferModal() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState<OfferShape | null>(null);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  // Ask the one public offer endpoint what this visitor may be shown. Every
  // other offer path is walled, so this is the only question a guest can ask.
  useEffect(() => {
    let live = true;
    if (alreadyJoined()) return;
    if (!isStoreRoute(pathname)) return;
    void fetch("/api/offers/welcome", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: OfferShape | null) => {
        if (!live || !data) return;
        setOffer(data);
        // Shown, not asked for: the POST discards anything typed here.
        if (data.accountEmail) setEmail(data.accountEmail);
        // THE SERVER DECIDES WHO MAY BE INTERRUPTED. Someone who has bought,
        // who already subscribed, who holds a code, or who once said stop is
        // not asked again — and this component never works that out for
        // itself. `mayInterrupt` is the whole of that answer.
        if (!data.mayInterrupt) return;
        if (dismissedRecently(Number(data.dismissCooldownDays ?? 7))) return;
        window.setTimeout(() => { if (live) setOpen(true); }, OPEN_AFTER_MS);
      })
      .catch(() => { /* an invitation is never worth an error on screen */ });
    return () => { live = false; };
  }, [pathname]);

  const close = useCallback(() => {
    setOpen(false);
    remember(DISMISSED_KEY, String(Date.now()));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const offerLive = offer?.promptsEnabled === true;

  const submit = useCallback(async () => {
    if (saving) return;
    if (!confirmed) { setError("Please confirm you are 21 or older and buying for research use."); return; }
    if (!email.trim()) { setError("Enter your email address."); return; }
    // THE OFFER IS THE TEXT LIST. claimWelcomeOffer refuses without an
    // acceptable mobile number and recordSmsSignupOnly does too, so there is
    // no email-only path behind this endpoint — letting someone submit an
    // address alone only produced "That does not look like a mobile number",
    // which answers a question they did not ask. Asked for here instead, in
    // the words of what they are actually agreeing to.
    // Both messages follow the switch, like the rest of the copy. With the
    // discount off the page says nothing about a code, so an error that
    // mentions one describes a screen the reader is not looking at.
    if (!smsConsent) {
      setError(offerLive
        ? "Tick the text box to get your code — that is what the discount is for."
        : "Tick the text box to join the text list.");
      return;
    }
    if (!phone.trim()) {
      setError(offerLive
        ? "Enter your mobile number so we can text your code."
        : "Enter your mobile number to join the text list.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/offers/welcome", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        // The tick is required above, so a number only ever reaches the
        // server behind an explicit, unticked-by-default agreement.
        body: JSON.stringify({
          email: email.trim(),
          phone: phone.trim(),
          placement: "storefront",
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; code?: string };
      if (data?.ok) {
        remember(JOINED_KEY, "1");
        setJoined(true);
        setCode(data.code ?? null);
        return;
      }
      setError(data?.error ?? "This did not go through. Please try again.");
    } catch {
      setError("This did not go through. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [confirmed, email, offerLive, phone, saving, smsConsent]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-black/80 px-4 py-6 backdrop-blur-sm sm:items-center"
      onClick={close}
      data-testid="entry-offer-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-offer-heading"
        onClick={(event) => event.stopPropagation()}
        data-testid="entry-offer-modal"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b0b] px-5 py-5 text-white shadow-[0_24px_70px_-20px_rgba(0,0,0,0.9)] [@media(max-height:780px)]:py-4 sm:px-8 sm:py-7"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--accent-gold)] to-transparent opacity-70"
        />
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          data-testid="entry-offer-close"
          className="vl-focus-ring absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-white/50 transition hover:bg-white/5 hover:text-white"
        >
          <span aria-hidden="true" className="text-lg leading-none">×</span>
        </button>

        <div className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[color:var(--accent-gold)]">Vanta Labs</div>
        <div className="mt-0.5 text-[0.62rem] uppercase tracking-[0.3em] text-white/35">Research Peptides</div>

        {joined ? (
          <div className="mt-6" data-testid="entry-offer-success">
            <h2 id="entry-offer-heading" className="font-serif text-2xl leading-tight">
              {code ? "Here&rsquo;s your code." : "You&rsquo;re on the list."}
            </h2>
            {code ? (
              <>
                <p className="mt-2 text-sm leading-6 text-white/60">
                  Copy it now and use it at checkout on your first order.
                </p>
                <p
                  data-testid="entry-offer-code"
                  className="mt-4 rounded-xl border border-[color:var(--accent-gold)]/40 bg-[color:var(--accent-gold-soft)] px-4 py-3 text-center font-mono text-lg tracking-[0.2em] text-[color:var(--accent-gold)]"
                >
                  {code}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm leading-6 text-white/60">
                Thanks — you&rsquo;ll hear from us with new product launches, restock alerts and subscriber offers.
              </p>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="vl-focus-ring mt-6 flex w-full items-center justify-center rounded-xl bg-[color:var(--accent-gold)] px-6 py-3.5 text-sm font-semibold text-[#0b0b0b] transition hover:bg-[color:var(--accent-gold-strong)]"
            >
              Continue
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 inline-flex rounded-full bg-[color:var(--accent-gold-soft)] px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.22em] text-[color:var(--accent-gold)] sm:mt-5 sm:py-1.5 sm:text-[0.65rem]">
              Email &amp; text sign-up
            </div>

            <h2 id="entry-offer-heading" className="mt-3 font-serif text-[1.5rem] leading-[1.12] [@media(max-height:780px)]:mt-2 [@media(max-height:780px)]:text-[1.35rem] sm:mt-4 sm:text-[1.75rem] sm:leading-[1.15]">
              {offerLive ? `Get ${WELCOME_OFFER_PERCENT}% off your first order.` : "Join the Vanta Labs list."}
            </h2>

            <p className="mt-2.5 text-[0.82rem] leading-[1.35rem] text-white/55 [@media(max-height:780px)]:hidden sm:mt-3 sm:text-sm sm:leading-6 sm:[@media(max-height:780px)]:block">
              {offerLive
                ? `Opt in to texts and your ${WELCOME_OFFER_PERCENT}% code appears right here — plus new product launches, restock alerts and exclusive offers from Vanta Labs.`
                : "Be first to hear about new product launches, restock alerts and exclusive offers from Vanta Labs — by email, and by text if you want them."}
            </p>

            <div className="mt-4 space-y-2 [@media(max-height:780px)]:mt-3 sm:mt-5 sm:space-y-2.5">
              {/* READ-ONLY WHEN THE SERVER NAMED AN ADDRESS. The POST reads
                  the session's address and discards this one, so an editable
                  field here is a promise the server does not keep. Checkout
                  says "Using your account email." for the same reason; this
                  says it the same way. */}
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                readOnly={Boolean(offer?.accountEmail)}
                placeholder="you@lab.com"
                aria-label="Email address"
                data-testid="entry-offer-email"
                className={`vl-sms-field vl-focus-ring w-full${offer?.accountEmail ? " cursor-default opacity-70" : ""}`}
              />
              {offer?.accountEmail ? (
                <p className="pl-1 text-[0.7rem] leading-4 text-white/35">Using your account email.</p>
              ) : null}
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+1 (555) 123-4567"
                aria-label="Mobile number"
                data-testid="entry-offer-phone"
                className="vl-sms-field vl-focus-ring w-full"
              />
            </div>

            <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 sm:mt-4 sm:gap-3 sm:px-3.5 sm:py-3">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                data-testid="entry-offer-confirm"
                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[color:var(--accent-gold)]"
              />
              <span className="text-[0.76rem] leading-[1.1rem] sm:text-[0.8rem] sm:leading-5">
                <span className="font-semibold text-white/90">I confirm I am 21 years of age or older.</span>{" "}
                <span className="text-white/45">These products are for laboratory research use only.</span>
              </span>
            </label>

            <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 sm:gap-3 sm:px-3.5 sm:py-3">
              <input
                type="checkbox"
                checked={smsConsent}
                onChange={(event) => setSmsConsent(event.target.checked)}
                data-testid="entry-offer-sms-consent"
                aria-describedby="entry-offer-sms-disclosure"
                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[color:var(--accent-gold)]"
              />
              <span className="text-[0.73rem] leading-[1.05rem] text-white/45 sm:text-[0.8rem] sm:leading-5">
                <span className="font-semibold text-white/90">Text me my {WELCOME_OFFER_PERCENT}% code and updates.</span>{" "}
                {SMS_CONSENT_TEXT}
              </span>
            </label>

            <p id="entry-offer-sms-disclosure" className="mt-2 px-1 text-[0.68rem] leading-[1rem] text-white/35 sm:mt-2.5 sm:text-[0.72rem] sm:leading-5">
              {SMS_DISCLOSURE_TEXT}{" "}
              See our{" "}
              <Link href="/legal/privacy" className="text-white/60 underline decoration-white/25 underline-offset-4 hover:text-white">
                Privacy Policy
              </Link>{" "}
              &amp;{" "}
              <Link href="/legal/terms" className="text-white/60 underline decoration-white/25 underline-offset-4 hover:text-white">
                Terms
              </Link>
              .
            </p>

            {error ? (
              <p data-testid="entry-offer-error" className="mt-3 text-[0.8rem] leading-5 text-red-300">
                {error}
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => { void submit(); }}
              disabled={saving}
              data-testid="entry-offer-submit"
              className="vl-focus-ring mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--accent-gold)] px-6 py-3 text-sm font-semibold tracking-wide text-[#0b0b0b] shadow-[0_8px_24px_-8px_rgba(199,174,94,0.55)] transition hover:bg-[color:var(--accent-gold-strong)] disabled:opacity-60 sm:mt-4 sm:py-3.5"
            >
              {saving ? "Sending…" : offerLive ? `Get ${WELCOME_OFFER_PERCENT}% Off` : "Join the list"}
              {saving ? null : <span aria-hidden="true">→</span>}
            </button>

            <ul className="mt-4 space-y-1.5 text-[0.75rem] text-white/45 [@media(max-height:780px)]:mt-3 sm:mt-5 sm:text-[0.78rem]">
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="text-[color:var(--accent-gold)]">✓</span>
                <span><span className="font-semibold text-white/75">≥99%</span> HPLC-verified purity</span>
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="text-[color:var(--accent-gold)]">✓</span>
                <span><span className="font-semibold text-white/75">Batch-specific</span> COAs</span>
              </li>
            </ul>

            <p className="mt-3 border-t border-white/10 pt-2.5 text-[0.65rem] leading-[0.95rem] text-white/30 sm:mt-4 sm:pt-3 sm:text-[0.68rem] sm:leading-5">
              For Research Use Only. Not for human consumption. Unsubscribe anytime.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
