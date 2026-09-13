"use client";

import { useState } from "react";

/**
 * THE TWO STATEMENTS, WORDED EXACTLY AS THE SIGN-IN FORM WORDS THEM.
 *
 * Not a stylistic preference. This is a representation a person makes, and two
 * screens that ask for it in different words are two different representations
 * in the record. The strings here are copied from account-auth-form.tsx and
 * must move with it.
 *
 * NOTHING IS PRE-TICKED AND NOTHING IS INFERRED. The button is disabled until
 * both are checked, the server refuses the request unless both arrive true, and
 * neither side reads a prior order, a shipping address or a subscription as
 * evidence of either. A customer who has bought before is why we are writing to
 * them; it is not a statement about their age.
 *
 * The whole row is the control — the label wraps its input — so the tap target
 * is the width of the card rather than a sixteen-pixel box. Same reasoning as
 * the sign-in form: on a phone that is the difference between two confident
 * taps and two near-misses.
 */
export function AttestationForm({ handoff }: { handoff: string }) {
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [researchUseAgreed, setResearchUseAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = ageConfirmed && researchUseAgreed;

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: handoff, ageConfirmed, researchUseOnly: researchUseAgreed }),
      });
      const body = (await response.json()) as { ok?: boolean; destination?: string; error?: string };
      if (!response.ok || !body.ok || !body.destination) {
        setError(body.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      // A full navigation, not a client route change: the grant and the offer
      // arrive as Set-Cookie on this response and the next request has to carry
      // them. `submitting` is left true so the button cannot be pressed twice
      // while the browser is on its way.
      window.location.assign(body.destination);
    } catch {
      setError("We could not reach the server. Please check your connection and try again.");
      setSubmitting(false);
    }
  }

  return (
    <form
      className="mt-8"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-2.5">
        <label className="vl-portal-row">
          <input
            type="checkbox"
            checked={ageConfirmed}
            onChange={(event) => setAgeConfirmed(event.target.checked)}
            className="vl-auth-check mt-0.5"
          />
          <span>I confirm I am 21 years of age or older</span>
        </label>

        <label className="vl-portal-row">
          <input
            type="checkbox"
            checked={researchUseAgreed}
            onChange={(event) => setResearchUseAgreed(event.target.checked)}
            className="vl-auth-check mt-0.5"
          />
          <span>I understand products are offered exclusively for research use</span>
        </label>
      </div>

      {error ? (
        <p role="alert" className="mt-5 text-[0.875rem] leading-6 text-red-300">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!ready || submitting}
        className="mt-7 inline-flex w-full items-center justify-center rounded-lg bg-[color:var(--accent-gold)] px-6 py-3.5 text-[0.9375rem] font-semibold text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
      >
        {submitting ? "One moment…" : "Confirm and continue"}
      </button>

      <p className="mt-5 text-[0.8125rem] leading-6 text-white/40">
        Already have an account?{" "}
        <a href="/account/login" className="underline underline-offset-4 hover:text-white/70">
          Sign in instead
        </a>
        .
      </p>
    </form>
  );
}
