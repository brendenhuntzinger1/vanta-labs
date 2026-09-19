"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  AGE_ATTESTATION_TEXT,
  AGE_GATE_STORAGE_KEY,
  RESEARCH_USE_ATTESTATION_TEXT,
} from "@/lib/attestation-text";

/**
 * THE FRONT DOOR'S AGE GATE.
 *
 * WHY IT HAD TO BE BUILT. The wall used to do this job by accident: every
 * unauthenticated request answered 307, so a stranger never saw the home page
 * and never needed asking. Opening "/" (access-policy.ts, "THE FRONT DOOR")
 * was right and is not being undone — with it closed, Twilio's toll-free
 * verification could not validate the business website and this store's SMS
 * programme was refused on that basis repeatedly. But it left a
 * research-peptide storefront's marketing in front of anyone, with nothing
 * asked. This is the thing that was implicit becoming explicit.
 *
 * CLIENT-SIDE, AND THAT IS THE POINT. The server still renders the whole page
 * and still serves it to Googlebot, to Twilio's reviewer and to Meta's — the
 * overlay is painted afterwards, in the browser, by a person's own session. So
 * the page remains verifiable and indexable while a human is still asked.
 * Gating it server-side would recreate the exact failure "/" was opened to fix.
 *
 * A UI GATE, NOT AN ACCESS CONTROL, and the distinction is worth stating
 * plainly so nobody later mistakes it for one: the catalogue stays behind the
 * wall, the SQL policies withhold the rows, and checkout takes its own
 * attestation. This stops the marketing being shown, and nothing else. Anyone
 * who wants past it can clear their own storage — which is equally true of
 * every age gate on the internet.
 *
 * NOTHING IS PRE-TICKED. Both boxes start false, the button is disabled until
 * both are true, and the answer is remembered only after they are.
 */
/**
 * Whether this browser has already answered.
 *
 * READ THROUGH useSyncExternalStore RATHER THAN IN AN EFFECT, for two reasons
 * that happen to be the same reason. React's own rule refuses a setState fired
 * synchronously from an effect (it cascades a second render), and the server
 * has no localStorage to read — so the server snapshot says "attested", the
 * overlay is absent from the HTML, and the client decides on its first paint.
 * A returning visitor who has already answered therefore never sees a flash of
 * the gate, and Googlebot and the carrier reviewers are served the page whole.
 */
const subscribeToAttestation = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

const readAttestation = () => {
  try {
    return window.localStorage.getItem(AGE_GATE_STORAGE_KEY) === "true";
  } catch {
    // Private mode, or storage blocked. Asking again is the safe direction:
    // the cost is one more tap, and the cost of the other error is showing
    // this to somebody who never said they were 21.
    return false;
  }
};

/** The server cannot know, and must not render an interstitial on a guess. */
const attestedOnServer = () => true;

export function AgeGate() {
  const attested = useSyncExternalStore(subscribeToAttestation, readAttestation, attestedOnServer);
  // Answered in THIS render pass, before the storage event lands.
  const [justEntered, setJustEntered] = useState(false);
  const [age, setAge] = useState(false);
  const [research, setResearch] = useState(false);
  const [declined, setDeclined] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);

  const open = !attested && !justEntered;

  // THE PAGE BEHIND DOES NOT SCROLL while this is up. Without it the overlay is
  // a sheet of paper over a page the visitor can still read and use on a phone.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  // Focus moves into the dialog, and stays in it. aria-modal tells assistive
  // technology everything else is hidden; without a trap that is a lie, and a
  // keyboard user tabs into a page they were told they could not reach.
  useEffect(() => {
    if (!open) return;
    const root = panel.current;
    if (!root) return;
    const focusable = () => Array.from(
      root.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    // Escape is deliberately NOT a way out: this is a question, not a promotion.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, declined]);

  const enter = useCallback(() => {
    if (!age || !research) return;
    try {
      window.localStorage.setItem(AGE_GATE_STORAGE_KEY, "true");
    } catch {
      // Storage refused. They still get in for this visit; they are asked again
      // next time, which is the honest outcome of not being able to remember.
    }
    setJustEntered(true);
  }, [age, research]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-heading"
      data-testid="age-gate"
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-black/95 px-4 py-8 backdrop-blur-md"
    >
      <div
        ref={panel}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b0b0b] px-6 py-7 text-white shadow-[0_24px_70px_-20px_rgba(0,0,0,0.9)] sm:px-8"
      >
        <div className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[color:var(--accent-gold)]">
          Vanta Labs
        </div>
        <div className="mt-0.5 text-[0.62rem] uppercase tracking-[0.3em] text-white/35">Research Peptides</div>

        {declined ? (
          <>
            <h2 id="age-gate-heading" className="mt-5 font-serif text-[1.5rem] leading-[1.15] sm:text-[1.7rem]">
              You cannot enter this site.
            </h2>
            <p className="mt-3 text-[0.85rem] leading-6 text-white/55">
              These materials are sold for laboratory research use only, to buyers who are 21 or
              older. If you reached this in error you can go back and confirm.
            </p>
            <button
              type="button"
              onClick={() => setDeclined(false)}
              data-testid="age-gate-back"
              className="vl-focus-ring mt-6 w-full rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/5"
            >
              Go back
            </button>
          </>
        ) : (
          <>
            <h2 id="age-gate-heading" className="mt-5 font-serif text-[1.5rem] leading-[1.15] sm:text-[1.7rem]">
              Confirm before you enter.
            </h2>
            <p className="mt-2.5 text-[0.85rem] leading-6 text-white/55">
              Everything sold here is a research material. Two things have to be true before you
              go any further.
            </p>

            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
              <input
                type="checkbox"
                checked={age}
                onChange={(event) => setAge(event.target.checked)}
                data-testid="age-gate-age"
                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[color:var(--accent-gold)]"
              />
              <span className="text-[0.85rem] leading-[1.3rem] text-white/85">{AGE_ATTESTATION_TEXT}</span>
            </label>

            <label className="mt-2.5 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
              <input
                type="checkbox"
                checked={research}
                onChange={(event) => setResearch(event.target.checked)}
                data-testid="age-gate-research"
                className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[color:var(--accent-gold)]"
              />
              <span className="text-[0.85rem] leading-[1.3rem] text-white/85">{RESEARCH_USE_ATTESTATION_TEXT}</span>
            </label>

            <button
              type="button"
              onClick={enter}
              disabled={!age || !research}
              data-testid="age-gate-enter"
              className="vl-focus-ring mt-5 w-full rounded-xl bg-[color:var(--accent-gold)] px-6 py-3.5 text-sm font-semibold tracking-wide text-[#0b0b0b] shadow-[0_8px_24px_-8px_rgba(199,174,94,0.55)] transition hover:bg-[color:var(--accent-gold-strong)] disabled:opacity-40"
            >
              Enter site
            </button>
            <button
              type="button"
              onClick={() => setDeclined(true)}
              data-testid="age-gate-decline"
              className="vl-focus-ring mt-2 w-full rounded-xl py-3 text-center text-xs text-white/45 transition hover:text-white"
            >
              I am under 21
            </button>
          </>
        )}
      </div>
    </div>
  );
}
