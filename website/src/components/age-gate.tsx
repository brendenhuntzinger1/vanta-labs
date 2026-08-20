"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";

// ACCESS IS PUBLISHED, NEVER REACHED FOR.
//
// The gate knows nothing about the homepage, the hero, or any media. It answers
// one question — has this visitor been let in — and anything that cares
// subscribes. That direction matters: the gate previously reached out to wake
// the hero video, which is how a tap on a checkbox ended up starting playback
// and handing an iPhone its native fullscreen player.
//
// Nothing in the entry path may hold a video ref, call play(), or touch a media
// API. Components that depend on access decide for themselves what to do.
const AccessContext = createContext(false);

/** True once the visitor has been let past the age gate, for this document. */
export function useAccessGranted() {
  return useContext(AccessContext);
}

// -----------------------------------------------------------------------------
// AGE VERIFICATION IS NEVER REMEMBERED.
//
// This gate used to persist confirmation for 30 days in localStorage
// ("vanta-labs-age-verified") with a cookie mirror ("vl_age_verified"), and an
// inline script in the root layout read them before first paint. A returning
// visitor therefore reached the storefront without being asked again — and a
// shared or previously-used device carried one person's attestation to the next.
//
// That persistence is now GONE. Confirmation lives only in React state for the
// life of the loaded document:
//
//   * a fresh load, a refresh, a new tab, a reopened browser, a direct link to
//     ANY storefront route -> the gate is shown;
//   * client-side navigation within one visit -> the state survives, so a
//     visitor is not re-asked while browsing;
//   * being signed in grants nothing. Authentication and age attestation are
//     separate, and no account, profile or session can satisfy this gate.
//
// There is deliberately no storage read anywhere below. Adding one back would
// reintroduce exactly the behaviour this removes.
// -----------------------------------------------------------------------------

// Each statement is acknowledged individually: a single combined tick is one
// click that stands for four different representations, which is exactly the
// assent a regulator would question. Entry is refused until all four are made.
const ATTESTATIONS = [
  { id: "age", text: "I am 21 years of age or older" },
  {
    id: "organization",
    text: "I represent a laboratory, business, educational institution, or qualified research organization",
  },
  {
    id: "researchUse",
    text: "I understand products are sold for research/laboratory purposes only and are not intended for human consumption",
  },
  {
    id: "terms",
    text: "I agree to the Terms & Conditions and Research Use Policy",
  },
] as const;

type AttestationId = (typeof ATTESTATIONS)[number]["id"];

// The gate protects the STOREFRONT. These are the staff areas — the admin
// console and the /vault door that leads to it — and they are not customer
// facing, so the age attestation does not apply to them.
//
// Without this the owner would meet the gate on every single admin page load,
// because confirmation is no longer remembered for anyone. That is a real cost
// during inventory and order work, and it buys nothing: /admin is already
// behind authentication, which is the control that actually matters there.
//
// Deliberately narrow. Everything a shopper can reach — products, cart,
// checkout, account, membership, ambassador, legal — is gated.
const STAFF_ONLY = ["/admin", "/vault"];

// WHERE A VISITOR LANDS AFTER CLEARING THE GATE.
//
// The home page, unless they are standing on one of a fixed, hard-coded list of
// pages where being moved would cost them something. Nothing here is derived
// from a URL: not returnTo, not next, not a redirect parameter, not
// document.referrer, not history. An external link — a TikTok URL, an ad, a
// stale campaign destination — cannot influence this, which is the property
// that matters. The list below is source code, not input.
//
// Why the exceptions exist, and they are not cosmetic: the gate appears on
// EVERY load, because confirmation is never remembered. So a customer who
// refreshes the checkout page, or returns to it, meets the gate — and sending
// them to the home page from there abandons a cart mid-purchase. That was
// measured, not guessed: forcing the home page unconditionally broke
// cart-and-checkout navigation in the regression suite.
//
// A legal page is deliberately NOT on the list. Nobody chooses the Research
// Disclaimer as a destination; landing there was the reported bug.
const POST_GATE_DESTINATION = "/";
const NEVER_A_DESTINATION = ["/legal"];

function destinationAfterGate(pathname: string | null): string | null {
  if (!pathname) return POST_GATE_DESTINATION;
  // A legal page is somewhere you READ, never somewhere you are sent. Being
  // left on the Research Disclaimer after clearing the gate was the reported
  // bug, and in an in-app browser a policy link navigates the view you are in,
  // so this is reachable by accident.
  const stranded = NEVER_A_DESTINATION.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  // Otherwise: null, meaning no navigation at all. The gate simply closes and
  // the visitor is left on the page they asked for.
  //
  // This was briefly "always send them to /", and that was wrong in a way the
  // journey test caught: a link straight to a product — an ad, a bio link, a
  // shared URL — put the visitor through the gate and then dumped them on the
  // home page, throwing away the click that brought them. A refresh mid-
  // checkout did the same to a cart. Clearing the gate is not a navigation.
  return stranded ? POST_GATE_DESTINATION : null;
}

export function AgeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isStaffArea = STAFF_ONLY.some(
    (p) => pathname === p || pathname?.startsWith(`${p}/`),
  );
  const [localVerified, setLocalVerified] = useState(false);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [showPrompt, setShowPrompt] = useState(false);
  const agreed = ATTESTATIONS.every((a) => confirmed[a.id]);

  const toggle = (id: AttestationId, value: boolean) => {
    setConfirmed((prev) => ({ ...prev, [id]: value }));
    if (showPrompt) {
      setShowPrompt(false);
    }
  };
  // The ONLY source of truth: in-memory state for this document. It starts
  // false on the server and on every fresh client load, so the gate is always
  // rendered first.
  const isVerified = localVerified || isStaffArea;

  const markVerified = () => {
    setLocalVerified(true);
  };

  const handleEnter = () => {
    if (!agreed) {
      setShowPrompt(true);
      return;
    }
    markVerified();
    const destination = destinationAfterGate(pathname);
    if (destination) {
      router.push(destination);
    }
  };

  // Confirm age first (same gate), then send the visitor to the account
  // sign-up / sign-in page instead of straight into the storefront.
  //
  // THIS MUST BE A CLIENT-SIDE NAVIGATION. It used to be
  // window.location.assign(), which loads a whole new document — and because
  // age confirmation is no longer remembered anywhere, that new document came
  // up showing the gate again. Tapping "Create account / Sign in" therefore
  // looked like it did nothing: you attested, the page reloaded, and you were
  // staring at the same gate. router.push keeps the visitor inside the current
  // document, so the confirmation they just gave still stands.
  const handleAccount = () => {
    if (!agreed) {
      setShowPrompt(true);
      return;
    }
    markVerified();
    router.push("/account/login");
  };

  const handleExit = () => {
    // Nothing to clear — nothing was ever stored. Also clears any flag left in
    // a returning visitor's browser by the previous persisted implementation,
    // so an old 30-day token cannot outlive this change.
    setLocalVerified(false);
    try {
      window.localStorage.removeItem("vanta-labs-age-verified");
      document.cookie = "vl_age_verified=; path=/; max-age=0; samesite=lax";
    } catch {
      /* storage may be unavailable; there is nothing this gate depends on */
    }
    window.location.assign("https://www.google.com");
  };

  // Move focus into the blocking gate when it appears so keyboard/screen-reader
  // users land on it instead of the (inert) page behind it.
  const dialogRef = useRef<HTMLDivElement>(null);

  // Keep the attribute (server-rendered as "false" in the root layout) in step
  // with React. Without this it would still read "false" after someone
  // confirms, and the CSS scroll-lock keyed off it would leave the store
  // permanently unscrollable.
  useEffect(() => {
    document.documentElement.setAttribute("data-age-verified", isVerified ? "true" : "false");
  }, [isVerified]);

  useEffect(() => {
    if (isVerified) return;
    dialogRef.current?.focus();
    // Lock body scroll so the (now server-rendered) content behind the overlay
    // can't be scrolled or interacted with until the visitor confirms.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isVerified]);

  // Always render the store content so search engines receive the real
  // server-side HTML (the gate previously REPLACED all content, making every
  // page look like the same "Are you 21?" panel to crawlers). For human
  // visitors the gate is a fixed full-screen overlay on top of that content
  // until they confirm; body scroll is locked so they can't interact behind it.
  return (
    <AccessContext.Provider value={isVerified}>
      {children}
      {!isVerified ? (
      <div
        data-age-gate="true"
        className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[#060606] px-4 py-8 text-zinc-100 sm:items-center sm:px-6 sm:py-10"
      >
        {/* Layered ambient light — warm gold + cool blue, matching the brand */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_28%_18%,_rgba(199,174,94,0.12),_transparent_52%),radial-gradient(ellipse_at_82%_85%,_rgba(140,180,255,0.09),_transparent_50%),linear-gradient(160deg,_#050505_0%,_#0c0c0c_48%,_#050505_100%)]" />
        {/* Faint grid texture for depth */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]" />

        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="age-gate-title"
          tabIndex={-1}
          className="vl2-fade-in vl-focus-ring relative w-full max-w-lg rounded-[1.75rem] border border-white/10 bg-[rgba(12,12,12,0.72)] p-6 text-center shadow-[0_28px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:rounded-[2rem] sm:p-9"
        >
          {/* Monogram */}
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--accent-gold)]/25 bg-gradient-to-br from-[color:var(--accent-gold)]/[0.12] to-white/[0.02] shadow-[0_0_28px_rgba(199,174,94,0.14)]">
            <span className="vl2-serif text-xl tracking-[0.12em] text-white">VL</span>
          </div>

          <p className="vl2-eyebrow mt-6 flex items-center justify-center gap-2 text-[color:var(--accent-gold)]/70">
            <span className="h-px w-6 bg-[color:var(--accent-gold)]/30" />
            Restricted Access · 21+
            <span className="h-px w-6 bg-[color:var(--accent-gold)]/30" />
          </p>

          <h1 id="age-gate-title" className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Vanta Labs</h1>
          <p className="mt-3 text-sm text-white/55 sm:text-base">Research Integrity. Verified Quality.</p>

          {/* Trust chips */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {["Batch Tested", "COA Documented", "Encrypted Checkout"].map((point) => (
              <span key={point} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-white/55">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-[color:var(--accent-gold)]/80" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
                {point}
              </span>
            ))}
          </div>

          <div className="my-7 h-px w-full bg-gradient-to-r from-transparent via-white/12 to-transparent" />

          <p className="text-lg font-medium text-white sm:text-xl">Confirm each statement to enter</p>

          <div className="mt-5 flex flex-col gap-2.5">
            {ATTESTATIONS.map((attestation) => (
              <label
                key={attestation.id}
                className="group flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3.5 text-left text-[0.8125rem] leading-6 text-white/70 transition-colors duration-200 hover:border-white/20 has-[:checked]:border-[color:var(--accent-gold)]/40 has-[:checked]:bg-[var(--accent-gold-soft)] has-[:checked]:text-white/85"
              >
                <input
                  type="checkbox"
                  checked={Boolean(confirmed[attestation.id])}
                  onChange={(event) => toggle(attestation.id, event.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded accent-[var(--accent-gold-bright)]"
                />
                {/* NO LINKS INSIDE THE ROW.
                    The policy links used to live in this label, inline with the
                    text. A thumb aiming at a 44px row lands on a link often
                    enough — and in the TikTok and Instagram webviews
                    target="_blank" does NOT open a second tab, it navigates the
                    view you are already in. So a mistimed tap threw the visitor
                    onto the Research Disclaimer page, losing the gate and every
                    box already ticked. The links are still offered, below, where
                    only a deliberate tap reaches them. */}
                <span>{attestation.text}</span>
              </label>
            ))}
          </div>

          {/* The policies themselves, on their own line and well clear of the
              tappable rows above. Opening one leaves the gate — unavoidable in
              an in-app browser, where a new tab is not a thing — so it must
              take a deliberate tap, never a stray one. */}
          <p className="mt-3 text-center text-xs leading-6 text-white/45">
            Read the{" "}
            <a
              href="/legal/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--accent-gold)] underline underline-offset-4 decoration-[color:var(--accent-gold)]/40 transition hover:decoration-[color:var(--accent-gold)]"
            >
              Terms &amp; Conditions
            </a>{" "}
            and{" "}
            <a
              href="/legal/research-disclaimer"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--accent-gold)] underline underline-offset-4 decoration-[color:var(--accent-gold)]/40 transition hover:decoration-[color:var(--accent-gold)]"
            >
              Research Use Policy
            </a>
          </p>

          {showPrompt ? <p role="alert" className="mt-3 text-sm text-[color:var(--accent-gold)]">Please confirm all four statements before continuing.</p> : null}

          {/* THE ENTRY BUTTONS STICK TO THE BOTTOM OF THE GATE.
              An in-app browser keeps its own top and bottom chrome on screen,
              which leaves roughly 664px of a 844px iPhone. This card is taller
              than that, so these two buttons sat about 200px BELOW the fold —
              enabled, correct, and completely unreachable unless you knew to
              scroll the panel. In Safari the chrome auto-hides, the viewport is
              taller, and they were reachable. That is the entire difference
              between "works in Safari" and "cannot sign in from TikTok".
              Sticky keeps them on screen at any viewport height. */}
          <div className="vl-gate-actions mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={handleAccount}
              disabled={!agreed}
              className="vl2-btn-primary vl-focus-ring px-6 py-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create account / Sign in
            </button>
            <button
              type="button"
              onClick={handleEnter}
              disabled={!agreed}
              className="vl2-btn-secondary vl-focus-ring px-6 py-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue as guest
            </button>
          </div>

          <p className="mx-auto mt-5 max-w-sm text-xs leading-6 text-white/45">
            Create a free account to track orders, save your cart, and earn rewards — or continue as a guest and check out with just your email.
          </p>

          <button
            type="button"
            onClick={handleExit}
            className="vl-focus-ring mt-5 text-xs text-white/40 underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            I am under 21 — exit
          </button>

          <p className="mt-6 border-t border-white/[0.07] pt-5 text-[0.62rem] uppercase tracking-[0.2em] text-white/30">
            Research Use Only · © Vanta Labs
          </p>
        </div>
      </div>
      ) : null}
    </AccessContext.Provider>
  );
}
