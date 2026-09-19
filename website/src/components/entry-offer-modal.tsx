"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { trackFunnelEvent } from "@/lib/analytics-funnel-client";
import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";
import { REQUEST_TIMEOUT_MS, timeoutSignal } from "@/lib/request-timeout";
import { FREE_VIAL_WEDGES, SpinWheelFace, WEDGE_COUNT } from "@/components/spin-wheel-face";

/**
 * THE STORE INVITATION — and what it invites people to is the wheel.
 *
 * IT USED TO SELL 15% OFF A FIRST ORDER. That discount is retired: nothing
 * mints it any more, at any call site. The wheel replaced it as the store's
 * acquisition offer, and this card is how a shopper who never got a win-back
 * email finds out the wheel exists. An invitation still advertising the old
 * number would be advertising something the till cannot honour.
 *
 * WHY THE WHEEL IS THE BETTER OFFER TO PUT HERE. Fifteen per cent off a $60
 * vial is $9 and reads as a coupon. Every wedge on the wheel is a real reward
 * and four of them are a free vial worth up to $119.99 — and every one of them
 * carries a minimum spend, so the store is paid before it pays out. The
 * arithmetic is in the dose-ladder spec; the point here is that this card is
 * offering something worth crossing a room for, and the old one was not.
 *
 * WHERE IT OPENS, AND WHY NOT AT THE DOOR. It used to mount on the access
 * portal. The owner's call is that the gate asks one thing: a visitor standing
 * at a sign-in screen has not chosen this store yet, and interrupting that
 * decision is the wrong first impression. So it opens on the storefront pages
 * behind the gate — the catalogue and its product pages — and never on
 * checkout, an account screen or a payment page, where a card over the task is
 * a lost order rather than a captured shopper.
 *
 * IT ASKS FOR TWO THINGS AND THEY ARE NOT THE SAME THING.
 *
 * THE NUMBER IS COLLECTED FROM EVERYBODY, alongside the account's address, and
 * the wheel will not spin without one. Holding a customer's phone is ordinary
 * contact data — it is how an order problem gets solved — and the store kept
 * none, because until now the only path that stored a number also claimed
 * permission to market to it.
 *
 * THE PERMISSION IS A SEPARATE, OPTIONAL TICK that buys nothing. Nobody is
 * subscribed by entering a number: the request says `smsConsent` explicitly,
 * the server stores the number with marketing_consent false, and every
 * standing check reads that as "not subscribed". The box says Optional because
 * it is, which is also exactly how the create-account form at /account/login —
 * the surface a carrier review actually loads — has always put it.
 *
 * SO THE TICK CAN BE SWITCHED ON LATER WITHOUT TOUCHING THIS CARD. When
 * Omnisend SMS is approved, the number is already on the contact as a
 * nonSubscribed phone identifier; a tick flips that identifier's status. No
 * number is collected twice, and nothing here has to change.
 *
 * THE AGE AND RESEARCH CONFIRMATION STAYS, AND STAYS REQUIRED, for the text
 * sign-up alone — it gates MARKETING, and keeping a number is not marketing.
 * Someone who gives their number and leaves the tick alone never touches it.
 *
 * THE SERVER DECIDES WHO MAY BE INTERRUPTED. /api/spin/invite answers it —
 * wheel switched off, already spun, already on the list — and this component
 * never works any of it out for itself.
 *
 * NOT REACHABLE BY AN A2P REVIEWER, DELIBERATELY. Everything here is behind the
 * account wall. The publicly reachable opt-in, which is what a carrier review
 * can actually load, is the create-account form at /account/login: same consent
 * sentence, same unticked box, same two legal links.
 */

type InviteShape = {
  /** May this card open at all? Every reason to stay silent is decided server-side. */
  mayInvite?: boolean;
  alreadySpun?: boolean;
  /** Is there a text list left to ask this person about? */
  askForTexts?: boolean;
  /** Does the store still need a number, or does it already hold one? */
  needPhone?: boolean;
  /** The address the consent would be recorded against — the session's, never what is typed. */
  accountEmail?: string | null;
  dismissCooldownDays?: number;
};

/**
 * Where shopping happens, and therefore the only place this may open.
 *
 * THE FRONT PAGE IS NOT ON THIS LIST, and that is the point. It is brand-only,
 * and a visitor who has just come through the gate has not seen a product or a
 * price yet — an offer needs something to attach to. Checkout and the account
 * screens are absent for a different reason: a card thrown over a task someone
 * is mid-way through costs an order.
 */
function isStoreRoute(pathname: string | null): boolean {
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
 *
 * THE LAYOUT HAS CLAIMED THIS FOR A FORTNIGHT AND NOTHING IMPLEMENTED IT. The
 * mount comment says this card "yields to the card above rather than stacking
 * on it"; the yield lived in the older invitation that this one replaced, and
 * did not come across with it. Seen on the harness at 390x844: the promotions
 * card open on the catalogue with the invitation timer still running, which is
 * two interruptions stacked on a phone — the exact outcome the two components
 * were arranged to prevent.
 */
function anotherOverlayIsOpen(): boolean {
  try {
    return Boolean(document.querySelector('[data-offer-modal], [role="dialog"], [data-vl-overlay]'));
  } catch {
    return true;
  }
}

/**
 * Ten seconds: long enough to have read the page, short enough to arrive
 * before the decision.
 *
 * Everyone who sees this is already signed in — they made an account and made
 * the 21+ and research attestations to get through the door — so intent is not
 * in doubt and a long warm-up buys nothing. A minute would be worse than
 * useless: most product-page visits are settled before then, and the ask would
 * land after the answer.
 */
const OPEN_AFTER_MS = 10000;

/**
 * Remembered per browser, so a dismissal is not re-asked on the next page.
 *
 * A NEW KEY, NOT THE OLD ONE. The retired invitation stored
 * `vl_entry_offer_joined` for somebody who had joined the text list, and
 * reading it here would silence the wheel for every shopper who ever took the
 * old 15% — the people most worth inviting. "Already spun" is the real
 * don't-ask-again and it is the server's answer, which is also the only version
 * of it that survives a second device.
 */
const DISMISSED_KEY = "vl_spin_invite_dismissed_at";

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

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing to do — the modal simply asks again next time */
  }
}

export function EntryOfferModal() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<InviteShape | null>(null);

  const [phone, setPhone] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  // THE FIELD THE CARD DECIDED NOT TO SHOW, shown after all. Set only by the
  // server answering that it has no number to put the tick against — the one
  // case where "we already have it" turns out to be wrong.
  const [revealPhone, setRevealPhone] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask the one endpoint what this visitor may be shown.
  useEffect(() => {
    let live = true;
    if (!isStoreRoute(pathname)) return;
    void fetch("/api/spin/invite", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: InviteShape | null) => {
        if (!live || !data) return;
        setInvite(data);
        // THE SERVER DECIDES WHO MAY BE INTERRUPTED. Someone who has already
        // spun, or whose wheel is switched off, is not asked — and this
        // component never reaches that conclusion for itself.
        if (!data.mayInvite) return;
        if (dismissedRecently(Number(data.dismissCooldownDays ?? 7))) return;
        window.setTimeout(() => {
          if (!live) return;
          // Re-checked at the moment of opening rather than only when the
          // timer was set: the promotions card may have opened in between,
          // which is the commonest way the two collide.
          if (anotherOverlayIsOpen()) return;
          setOpen(true);
          // Counted only once it is actually on screen. An invitation that
          // yielded was never shown, and counting it would put a denominator
          // under an event that did not happen.
          trackFunnelEvent("spin_invite_shown", { placement: "storefront" });
        }, OPEN_AFTER_MS);
      })
      .catch(() => { /* an invitation is never worth an error on screen */ });
    return () => { live = false; };
  }, [pathname]);

  // SKIPPING IS A FIRST-CLASS ANSWER. The close control, the backdrop, the
  // escape key and the "No thanks" button all land here, and all of them count
  // as the same thing: a shopper who was offered the wheel and said no.
  const close = useCallback(() => {
    setOpen(false);
    remember(DISMISSED_KEY, String(Date.now()));
    trackFunnelEvent("spin_invite_skipped", { placement: "storefront" });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const askForTexts = invite?.askForTexts === true;
  const needPhone = invite?.needPhone === true || revealPhone;

  /**
   * Take the shopper to the wheel, recording the consent first if they gave it.
   *
   * ONE BUTTON, TWO OUTCOMES, and the order matters. A shopper who left the
   * text section alone goes straight to the wheel. A shopper who ticked the box
   * has asked for two things, so both have to happen — and if the number or the
   * attestation is missing, they are told and kept here rather than being
   * carried off to the wheel with the sign-up they asked for silently dropped.
   *
   * THE SPIN SURVIVES A FAILED SIGN-UP. If the consent POST refuses for any
   * other reason the shopper still goes to the wheel: the offer was never
   * conditional on the text list, and stranding them on a card because a
   * subscription did not take would be making it conditional after the fact.
   */
  const spin = useCallback(async () => {
    if (saving) return;

    // THE NUMBER IS THE ONE THING THE WHEEL ASKS FOR. Not asked at all when
    // the store already holds one — that number is what a later tick would
    // subscribe, so making somebody retype it buys nothing.
    if (needPhone && !phone.trim()) {
      setError("Enter your mobile number to spin.");
      return;
    }
    // THE TICK IS ITS OWN DECISION, and the attestation gates that decision
    // rather than the spin: this store may not MARKET to anyone who has not
    // made it, and keeping a number is not marketing.
    if (smsConsent && !confirmed) {
      setError("Please confirm you are 21 or older and buying for research use.");
      return;
    }

    // A NUMBER OR A TICK IS A REASON TO POST, and the tick on its own is the
    // commonest one. The card stops asking for a number once the store holds
    // one, so a returning shopper agrees to texts with no field in front of
    // them; posting only on a typed number read that as nothing to send and
    // dropped the consent where no record could show it had been given.
    let joinedTexts = false;
    if (phone.trim() || smsConsent) {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/offers/welcome", {
          method: "POST",
          // A held-open socket would leave "One moment…" disabled for good.
          signal: timeoutSignal(REQUEST_TIMEOUT_MS),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          // SAID, NOT INFERRED. The endpoint keeps the number either way and
          // subscribes only on an explicit true, so an untouched box cannot
          // become a consent by accident. The address is the session's: the
          // endpoint reads `sessionEmail || typedEmail` and there is always a
          // session here. An empty `phone` is the tick alone — the endpoint
          // then reads the number it already holds for this address.
          body: JSON.stringify({ phone: phone.trim(), placement: "storefront", smsConsent }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; needPhone?: boolean; subscribed?: boolean } | null;
        // ONLY A REFUSAL THE SHOPPER CAN ACT ON KEEPS THEM HERE, and 400 is
        // how the endpoint says so: a number nobody could be texted at, or a
        // tick with no number to put it against. Everything else — the rate
        // limiter, a 500, an outage — is the store's problem, not theirs, and
        // taking the spin for it makes the offer conditional on the text list
        // after the fact. MEASURED: the limiter is keyed per request IP at ten
        // an hour, so behind one mobile carrier's NAT the eleventh shopper of
        // the hour was shown "Please wait a moment before trying again" and
        // could not spin at all.
        if (res.status === 400 && data?.ok === false) {
          if (data.needPhone) setRevealPhone(true);
          setError(data.error ?? "That does not look like a mobile number.");
          setSaving(false);
          return;
        }
        // WHAT ACTUALLY HAPPENED, not what was asked for. A limiter, a 500 or
        // the endpoint's own 200-with-ok:false all let the shopper through to
        // the wheel — and reporting the tick as a sign-up would put a join in
        // the funnel that no consent record can be shown for.
        joinedTexts = smsConsent && data?.subscribed === true;
      } catch {
        // Offline, or the request was cut off. The wheel is what they pressed
        // and the prize is not conditional on the store filing their number,
        // so they go through; the number is asked for again next time.
      }
      setSaving(false);
    }

    trackFunnelEvent("spin_invite_accepted", { placement: "storefront", joinedTexts });
    setOpen(false);
    router.push("/spin");
  }, [confirmed, needPhone, phone, router, saving, smsConsent]);

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

        {/* THE PRIZES, SHOWN RATHER THAN DESCRIBED.
            A card that says "sixteen wedges, free vials" is a claim; the board
            itself is evidence, and every wedge on it is a real reward the
            shopper can read. Drawn from SPIN_PRIZES by the same geometry the
            live wheel turns (spin-wheel-face.tsx), so it can never advertise a
            board that does not exist. Hidden on a short viewport, where the
            form is what has to fit. */}
        <div className="relative mt-4 flex justify-center [@media(max-height:780px)]:hidden sm:mt-5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 blur-2xl"
            style={{ background: "radial-gradient(circle at 50% 45%, var(--accent-gold-soft), transparent 65%)" }}
          />
          <SpinWheelFace className="h-[130px] w-[130px] drop-shadow-[0_10px_30px_rgba(0,0,0,0.65)] sm:h-[150px] sm:w-[150px]" />
        </div>

        <h2 id="entry-offer-heading" className="mt-3.5 text-center font-serif text-[1.45rem] leading-[1.12] [@media(max-height:780px)]:mt-2 [@media(max-height:780px)]:text-[1.35rem] sm:mt-4 sm:text-[1.7rem] sm:leading-[1.15]">
          Spin the wheel for a free vial.
        </h2>

        {/* WHO THIS IS FOR, in the shopper's own terms. The offer is the first
            order and the text list — say so rather than making them infer it
            from a form. The counts are read from the prize table so the claim
            cannot outrun the board. */}
        <p className="mt-2 text-center text-[0.82rem] leading-[1.3rem] text-white/60 sm:text-[0.86rem] sm:leading-[1.4rem]">
          New customers and text subscribers get a spin —{" "}
          <span className="font-semibold text-[color:var(--accent-gold)]">
            {FREE_VIAL_WEDGES} of the {WEDGE_COUNT} wedges are a free vial
          </span>
          , and the rest are free shipping or money off.
        </p>

        <p className="mt-1.5 text-center text-[0.72rem] leading-[1.05rem] text-white/35 [@media(max-height:780px)]:hidden">
          One spin per account. Whatever you land on waits in your cart for 72 hours.
        </p>

        {needPhone || askForTexts ? (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 sm:mt-5 sm:px-3.5">
            {needPhone ? (
              <>
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-white/40">
                  Your details
                </p>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="+1 (555) 123-4567"
                  aria-label="Mobile number"
                  data-testid="entry-offer-phone"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "entry-offer-error" : undefined}
                  className="vl-sms-field vl-focus-ring mt-2 w-full"
                />
                {/* WHAT THE NUMBER IS FOR, said before it is given. It is
                    contact detail for this account; it is not a subscription,
                    and the box below is where that decision is made. */}
                <p className="mt-1.5 pl-1 text-[0.7rem] leading-4 text-white/35">
                  {invite?.accountEmail
                    ? `Kept with ${invite.accountEmail} for your order. We do not text you unless you ask below.`
                    : "Kept with your account for your order. We do not text you unless you ask below."}
                </p>
              </>
            ) : null}

            {askForTexts ? (
              <>
                <label className={`flex cursor-pointer items-start gap-2.5 sm:gap-3 ${needPhone ? "mt-3" : "mt-0"}`}>
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

                <label className="mt-2 flex cursor-pointer items-start gap-2.5 sm:gap-3">
                  <input
                    type="checkbox"
                    checked={smsConsent}
                    onChange={(event) => setSmsConsent(event.target.checked)}
                    data-testid="entry-offer-sms-consent"
                    aria-describedby="entry-offer-sms-disclosure"
                    className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[color:var(--accent-gold)]"
                  />
                  <span className="text-[0.73rem] leading-[1.05rem] text-white/45 sm:text-[0.8rem] sm:leading-5">
                    {SMS_CONSENT_TEXT} <span className="text-white/40">Optional.</span>
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
              </>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p
            id="entry-offer-error"
            data-testid="entry-offer-error"
            // A validation refusal a screen reader never hears is a dead end:
            // the press appears to do nothing at all.
            role="alert"
            aria-live="assertive"
            className="mt-3 text-[0.8rem] leading-5 text-red-300"
          >
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => { void spin(); }}
          disabled={saving}
          data-testid="entry-offer-submit"
          className="vl-focus-ring mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--accent-gold)] px-6 py-3 text-sm font-semibold tracking-wide text-[#0b0b0b] shadow-[0_8px_24px_-8px_rgba(199,174,94,0.55)] transition hover:bg-[color:var(--accent-gold-strong)] disabled:opacity-60 sm:mt-4 sm:py-3.5"
        >
          {saving ? "One moment…" : "Spin the wheel"}
          {saving ? null : <span aria-hidden="true">→</span>}
        </button>

        {/* SAYING NO HAS ITS OWN CONTROL. The × in the corner is a close
            button; this is the answer to the question, in words, where a
            shopper reading the card will see it. */}
        <button
          type="button"
          onClick={close}
          data-testid="entry-offer-skip"
          className="vl-focus-ring mt-2.5 flex w-full items-center justify-center rounded-xl px-6 py-2 text-[0.8rem] text-white/45 transition hover:text-white/70"
        >
          No thanks
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
          For Research Use Only. Not for human consumption. Every reward has a minimum spend, shown on the wheel.
        </p>
      </div>
    </div>
  );
}
