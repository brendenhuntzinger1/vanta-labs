"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { SMS_CONSENT_TEXT, SMS_DISCLOSURE_TEXT } from "@/lib/sms-consent-text";

/**
 * THE FORM ON /sms.
 *
 * TWO BOXES, AND THEY ARE ABOUT DIFFERENT THINGS.
 *
 *   * the 21+ statement is about who may use this site at all, and it is here
 *     because the catalogue is age-restricted;
 *   * the SMS agreement is about whether this business may send marketing text
 *     messages to the number typed above it.
 *
 * NEITHER TICKS THE OTHER, in this component or anywhere downstream. They are
 * separate pieces of state, rendered as separate controls with separate
 * labels, and the request carries only the SMS one because only the SMS one is
 * a permission this store records. Bundling them — one box reading "I am 21
 * and agree to receive texts" — is the "messaging consent must be optional"
 * rejection wearing a disguise, because it makes the marketing permission a
 * condition of using the form.
 *
 * BOTH START UNTICKED AND THERE IS NO CODE PATH THAT PRE-TICKS EITHER. The
 * initial state is a literal `false`; nothing reads a query parameter, a
 * cookie or a stored preference to seed it.
 *
 * THE CONSENT SENTENCE IS NOT WRITTEN HERE. It is imported from
 * lib/sms-consent-text.ts, the same constant the checkout, the account page,
 * the storefront prompts and the Omnisend pop-up render, and the same one
 * whose version is stamped onto every consent row. A second, subtly different
 * copy of that sentence living on the one page a carrier reads would be the
 * worst possible place for it to drift.
 *
 * WHAT IT WILL NOT DO: mention a discount, offer a code, or open on its own.
 */
export function SmsOptInForm() {
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const statusRef = useRef<HTMLParagraphElement | null>(null);

  const submit = useCallback(async () => {
    if (saving) return;
    // Checked here for the message, and again on the server for the truth:
    // api/sms/subscribe refuses anything whose `consent` is not exactly true,
    // so a client that skipped this cannot create a subscriber.
    if (!ageConfirmed) {
      setError("Confirm you are 21 or older to continue.");
      return;
    }
    if (!smsConsent) {
      setError("Tick the box to agree to receive marketing text messages.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/sms/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, email, consent: true }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data?.ok) {
        setDone(true);
        return;
      }
      setError(data?.error ?? "This did not go through. Please try again.");
    } catch {
      setError("This did not go through. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [ageConfirmed, email, phone, saving, smsConsent]);

  if (done) {
    return (
      <div className="vl-optin-card mt-8" data-testid="sms-optin-done">
        <h2 className="vl-optin-done-title">You are subscribed</h2>
        <p className="vl-optin-done-body">
          Thank you. You will receive recurring automated marketing text messages from Vanta
          Labs at the number you gave. Reply STOP to any message to cancel, or HELP for help.
        </p>
      </div>
    );
  }

  return (
    <form
      className="vl-optin-card mt-8"
      data-testid="sms-optin-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      noValidate
    >
      <div className="vl-optin-field-row">
        <label className="vl-optin-label" htmlFor="sms-optin-phone">
          Mobile phone number
        </label>
        <input
          id="sms-optin-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="(555) 555-5555"
          data-testid="sms-optin-phone"
          className="vl-sms-field vl-focus-ring"
        />
      </div>

      {/* THE ADDRESS IS NOT DECORATION. Omnisend — the service that actually
          sends these messages — identifies a contact by email address, so a
          number recorded without one is a consent this store could never act
          on. Said on the label rather than left for the visitor to wonder
          about on a page that is otherwise entirely about texting. */}
      <div className="vl-optin-field-row mt-4">
        <label className="vl-optin-label" htmlFor="sms-optin-email">
          Email address
        </label>
        <input
          id="sms-optin-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          data-testid="sms-optin-email"
          className="vl-sms-field vl-focus-ring"
        />
        <p className="vl-optin-hint">Used to identify your subscription and to send your opt-in confirmation.</p>
      </div>

      <label className="vl-optin-consent" htmlFor="sms-optin-age">
        <input
          id="sms-optin-age"
          name="age"
          type="checkbox"
          checked={ageConfirmed}
          onChange={(event) => setAgeConfirmed(event.target.checked)}
          data-testid="sms-optin-age"
        />
        <span className="vl-optin-consent-text">
          I confirm I am 21 years of age or older.
        </span>
      </label>

      <label className="vl-optin-consent" htmlFor="sms-optin-consent">
        <input
          id="sms-optin-consent"
          name="consent"
          type="checkbox"
          checked={smsConsent}
          onChange={(event) => setSmsConsent(event.target.checked)}
          data-testid="sms-optin-consent"
        />
        <span className="vl-optin-consent-text">
          I agree to receive marketing text messages from Vanta Labs.
        </span>
      </label>

      {/* The full TCPA sentence, at a size somebody can read in a screenshot.
          It is the shared constant, not a paraphrase of it. */}
      <p className="vl-optin-disclosure" data-testid="sms-optin-disclosure">
        {SMS_CONSENT_TEXT}
      </p>

      <button
        type="submit"
        disabled={saving}
        data-testid="sms-optin-submit"
        className="vl-sms-submit vl-focus-ring mt-5"
      >
        {saving ? "Signing up" : "Sign up for text messages"}
      </button>

      <p className="vl-optin-disclosure mt-4">
        {SMS_DISCLOSURE_TEXT}{" "}
        <Link href="/legal/privacy">Privacy Policy</Link>
        {" · "}
        <Link href="/legal/terms">Terms</Link>
      </p>

      {/* aria-live so a screen reader hears the refusal: the button stays put
          and only this line changes, which is otherwise a silent failure. */}
      <p
        ref={statusRef}
        role="status"
        aria-live="polite"
        className={error ? "vl-sms-error" : "sr-only"}
        data-testid="sms-optin-error"
      >
        {error ?? ""}
      </p>
    </form>
  );
}
