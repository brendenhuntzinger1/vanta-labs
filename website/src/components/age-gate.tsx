"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { detectInAppBrowser } from "@/lib/in-app-browser";
import { trustPoints } from "@/lib/trust-claims";

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
// ONCE PER VISIT. NOT ONCE PER PAGE, AND NOT FOR EVER.
//
// This has been wrong in both directions, and the middle is the requirement.
//
//   TOO LONG — it once persisted for 30 days in localStorage
//   ("vanta-labs-age-verified") with a cookie mirror ("vl_age_verified"). A
//   visitor months later was never asked again, and a shared device carried one
//   person's attestation to the next. Removed, correctly.
//
//   TOO SHORT — it was then held only in React state for the life of ONE
//   document. Client-side navigation kept it; anything that loaded a new
//   document did not. Checkout hands off to the payment page with
//   window.location.assign(), so a real customer pressed BACK from payment and
//   met the gate again mid-purchase. Route exemptions were added for the routes
//   someone thought of, and /checkout was not one of them — which is the tell
//   that exemptions were treating a symptom.
//
//   NOW — sessionStorage, read through useSyncExternalStore. It survives
//   refresh, full-document navigation, back/forward and the payment round trip,
//   and it is gone when the tab closes, so the next visit is asked again.
//   Being signed in still grants nothing: authentication and age attestation
//   are separate, and no account or session can satisfy this gate.
//
// The route exemptions below remain as defence in depth. They are no longer
// what carries a shopper through checkout.
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

// PAYING AND THE RECEIPT. The gate must not stand between a shopper and the
// card form they were just sent to.
//
// Reproduced live: create-session writes the order row, then the checkout page
// does window.location.assign() to /checkout/pay/<orderId>. That is a FULL
// DOCUMENT LOAD, and the gate's only source of truth is in-memory state that
// resets on every fresh document (deliberately — it is never remembered). So
// the shopper filled in their address, pressed "Continue to secure payment",
// and landed on the age gate. It reads as a failed payment. The cost is not
// cosmetic: the order row already exists, so anyone who gives up there leaves
// an orphaned awaiting_payment order, and anyone who goes back and resubmits
// creates a second one.
//
// Exempting these routes removes NO age assurance. To reach any of them an
// order must already exist, which means checkout's acknowledgements were
// accepted — including "I confirm that I am 21 years of age or older and
// legally permitted to purchase laboratory research materials", recorded
// against the exact copy version shown. That is a stronger, durable record
// than this gate produces; the gate stores nothing at all. Showing it again
// here would add no evidence and no protection, only an interruption at the
// single worst moment.
//
// Deliberately narrow, and deliberately NOT /checkout itself: the gate still
// stands in front of browsing, the cart, and checkout, where a visitor has not
// yet attested to anything.
const PAYMENT_AND_RECEIPT = ["/checkout/pay", "/pay", "/order-confirmation"];

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
const SOCIAL_DESTINATION = "/products";
const NEVER_A_DESTINATION = ["/legal"];

// SOCIAL TRAFFIC GOES TO THE SHOP; EVERYONE ELSE GETS THE HOME PAGE.
//
// Somebody who tapped a link in TikTok is mid-scroll and came to look at a
// product. The catalog is the shortest honest path to that, and it also keeps
// the highest-risk browsers off the animated hero entirely. Somebody who typed
// the domain, or found it through search, is choosing to visit the brand and
// gets the home page they asked for.
//
// Judged on how the visitor ARRIVED, never on anything a link can assert about
// where it wants them sent. A campaign marker or a social referrer is evidence
// of a traffic source; it is not a destination, so the worst a forged one can
// do is show the catalog.
function cameFromSocial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    // The markers real campaigns actually carry.
    for (const key of ["ttclid", "fbclid", "igshid", "sccid", "twclid", "utm_source", "utm_medium"]) {
      const value = params.get(key);
      if (!value) continue;
      if (key.startsWith("utm_")) {
        if (/tiktok|instagram|facebook|meta|snap|reddit|pinterest|twitter|social|paid/i.test(value)) return true;
      } else {
        return true;
      }
    }
    // An in-app browser IS social traffic, whatever the URL carries.
    if (detectInAppBrowser()) return true;
    const ref = document.referrer;
    return Boolean(ref) && /tiktok|instagram|facebook|snapchat|reddit|pinterest|t\.co|lnkd\.in/i.test(ref);
  } catch {
    return false;
  }
}

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
  if (stranded) return POST_GATE_DESTINATION;
  // Only a visitor who arrived on the home page is re-routed. Anyone who asked
  // for a specific page — a product, the cart, checkout — stays there; sending
  // them to the catalog would throw away the click that brought them.
  if (pathname === POST_GATE_DESTINATION && cameFromSocial()) {
    // ATTRIBUTION SURVIVES THE REDIRECT. ttclid, fbclid, utm_*, a referral
    // code — everything the campaign attached is carried onto the catalog.
    // Dropping it here would silently break attribution for exactly the paid
    // traffic this route exists to serve, and the loss would be invisible
    // until a report came back empty.
    //
    // The query is carried, never consulted: it decides nothing about where
    // the visitor goes, so a forged parameter still cannot choose a
    // destination. Only the path above does that, and it is a constant.
    const query = typeof window !== "undefined" ? window.location.search : "";
    return `${SOCIAL_DESTINATION}${query}`;
  }
  return null;
}

/**
 * Where "yes, I confirmed" lives for the rest of this visit.
 *
 * sessionStorage, deliberately, and neither of the two neighbouring choices:
 *
 *   IN MEMORY ONLY — what this was. It survives client-side navigation and
 *   nothing else. checkout hands off to the payment page with
 *   window.location.assign(), which is a whole new document, so pressing BACK
 *   from payment produced a fresh document with the flag gone and the gate
 *   back up. A real customer hit exactly that mid-purchase. Route exemptions
 *   papered over the routes we thought of; /checkout was not one of them.
 *
 *   localStorage / a dated cookie — what it was before that, and why it was
 *   ripped out: a 30-day token means a returning visitor months later is never
 *   asked again, which is not what an age attestation is for.
 *
 * sessionStorage is the shape of the actual requirement: one confirmation per
 * visit. It survives refresh, full-document navigation, back/forward and the
 * payment round trip, and it is gone when the tab is closed, so the next visit
 * asks again.
 */
const AGE_SESSION_KEY = "vl-age-confirmed-session";

/**
 * Whether THIS document should consider the visitor past the gate.
 *
 * Pulled out as a pure function on purpose. The defect a real customer found
 * was not in any rendered markup — it was that a NEW DOCUMENT started with no
 * knowledge of a confirmation the visitor had already given, and the only test
 * covering it asserted the source text of a route list, which cannot express
 * "a fresh document in the same visit". This signature can: `confirmedInMemory`
 * is what a fresh document has (false), `sessionConfirmed` is what it can
 * recover, and the two together are the whole rule.
 */
export function isVerifiedForDocument(input: {
  /** React state — false on every fresh document, by construction. */
  confirmedInMemory: boolean;
  /** Recovered from sessionStorage: did this VISIT already confirm? */
  sessionConfirmed: boolean;
  pathname: string | null;
}): boolean {
  const { confirmedInMemory, sessionConfirmed, pathname } = input;
  const matches = (list: string[]) =>
    list.some((p) => pathname === p || pathname?.startsWith(`${p}/`));
  // Route exemptions remain, as defence in depth — but they are no longer what
  // carries a shopper through checkout. The session is.
  return confirmedInMemory || sessionConfirmed || matches(STAFF_ONLY) || matches(PAYMENT_AND_RECEIPT);
}

function readSessionConfirmation(): boolean {
  try {
    return window.sessionStorage.getItem(AGE_SESSION_KEY) === "true";
  } catch {
    // Private mode, disabled storage, a webview that throws on access. The gate
    // simply shows again — the failure mode stays "ask", never "let through".
    return false;
  }
}

function writeSessionConfirmation(confirmed: boolean): void {
  try {
    if (confirmed) window.sessionStorage.setItem(AGE_SESSION_KEY, "true");
    else window.sessionStorage.removeItem(AGE_SESSION_KEY);
  } catch {
    /* Nothing depends on this succeeding; in-memory state still carries the page. */
  }
}

/**
 * The visit's confirmation, as an external store.
 *
 * sessionStorage is state React does not own, and the server cannot see it —
 * so it is exactly what useSyncExternalStore is for. Reading it during render
 * would be a hydration mismatch; reading it in an effect and calling setState
 * is a cascading render. This is the third option: React subscribes, the server
 * snapshot is always false (so SSR always renders the gate), and the client
 * snapshot is the truth for this visit.
 */
let sessionSnapshotCache: boolean | null = null;
const sessionListeners = new Set<() => void>();

function subscribeToSessionConfirmation(onChange: () => void): () => void {
  sessionListeners.add(onChange);
  return () => sessionListeners.delete(onChange);
}

/** Must return a STABLE value between changes or React re-renders forever. */
function sessionConfirmationSnapshot(): boolean {
  if (sessionSnapshotCache === null) sessionSnapshotCache = readSessionConfirmation();
  return sessionSnapshotCache;
}

/** The server has no sessionStorage: always unconfirmed, so SSR shows the gate. */
function sessionConfirmationServerSnapshot(): boolean {
  return false;
}

function setSessionConfirmation(confirmed: boolean): void {
  writeSessionConfirmation(confirmed);
  sessionSnapshotCache = confirmed;
  for (const listener of sessionListeners) listener();
}

export function AgeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [localVerified, setLocalVerified] = useState(false);
  // What this VISIT already confirmed. Separate from localVerified because they
  // answer different questions: one is "did they confirm in this document", the
  // other "did they confirm in this visit".
  const sessionConfirmed = useSyncExternalStore(
    subscribeToSessionConfirmation,
    sessionConfirmationSnapshot,
    sessionConfirmationServerSnapshot,
  );
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
  const isVerified = isVerifiedForDocument({
    confirmedInMemory: localVerified,
    sessionConfirmed,
    pathname,
  });

  // The confirmation given earlier in this visit is already in `sessionConfirmed`
  // above; the inline script in app/layout.tsx flips the html attribute before
  // the first paint, so the CSS keeps the overlay hidden and there is no flash
  // of the gate on the way back from payment.
  const markVerified = () => {
    setLocalVerified(true);
    setSessionConfirmation(true);
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
    // End the visit's confirmation, and also clear any flag left in a returning
    // visitor's browser by the previous persisted implementation, so an old
    // 30-day token cannot outlive this change.
    setLocalVerified(false);
    setSessionConfirmation(false);
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
          /* WIDTH IS PER-DEVICE, NOT ONE PHONE COLUMN FOR EVERYTHING.
             This was max-w-lg at every size: a 512px column, which is right on
             a phone and is 26% of a 2000px laptop screen — the gate read as a
             phone layout letterboxed in black. Worse, stacking four
             attestations made the card 1052px tall, taller than a MacBook Air
             (900), a 14" (982) and a 1280x800 laptop, so it overflowed off the
             TOP of the screen and cut the wordmark in half.
             Widening at lg and pairing the attestations two-up fixes both at
             once: the card fills the screen properly AND gets short enough to
             fit without scrolling. */
          className="vl2-fade-in vl-focus-ring relative w-full max-w-lg rounded-[1.75rem] border border-white/10 bg-[rgba(12,12,12,0.72)] p-6 text-center shadow-[0_28px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:rounded-[2rem] sm:p-9 lg:max-w-3xl lg:p-8 xl:max-w-4xl"
        >
          {/* Monogram */}
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full lg:mx-0 border border-[color:var(--accent-gold)]/25 bg-gradient-to-br from-[color:var(--accent-gold)]/[0.12] to-white/[0.02] shadow-[0_0_28px_rgba(199,174,94,0.14)]">
            <span className="vl2-serif text-xl tracking-[0.12em] text-white">VL</span>
          </div>

          {/* TWO COLUMNS ON A LAPTOP, ONE ON A PHONE.
              A single column of brand-then-form is 921px tall even paired
              two-up, which still overflows a MacBook Air and a 1280x800
              laptop. Setting the brand beside the form instead of above it
              takes the tallest screen requirement to roughly 600px, so the
              whole gate fits without scrolling on every laptop measured.
              Below lg this is not a grid at all and the DOM order is
              unchanged, so the phone layout behaves exactly as before. */}
          <div className="lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:items-center lg:gap-9 lg:text-left">
          <div>
          <p className="vl2-eyebrow mt-6 flex items-center justify-center gap-2 text-[color:var(--accent-gold)]/70 lg:mt-0 lg:justify-start">
            <span className="h-px w-6 bg-[color:var(--accent-gold)]/30" />
            Restricted Access · 21+
            <span className="h-px w-6 bg-[color:var(--accent-gold)]/30" />
          </p>

          <h1 id="age-gate-title" className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Vanta Labs</h1>
          <p className="mt-3 text-sm text-white/55 sm:text-base">Research Integrity. Verified Quality.</p>

          {/* Trust chips */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
            {trustPoints().slice(0, 3).map((point: string) => (
              <span key={point} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-white/55">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-[color:var(--accent-gold)]/80" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
                {point}
              </span>
            ))}
          </div>

          <div className="my-7 h-px w-full bg-gradient-to-r from-transparent via-white/12 to-transparent lg:hidden" />
          </div>

          <div>

          <p className="text-lg font-medium text-white sm:text-xl lg:mt-0">Confirm each statement to enter</p>

          <div className="mt-5 flex flex-col gap-2.5 lg:mt-4">
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
          {/* py-1 -my-1 grows each link's tap box to 24px (WCAG 2.2 AA 2.5.8)
              while the negative margin cancels the same amount of layout, so
              the sentence keeps its exact line box. Measured at 320px before
              this: 107x17. Same treatment as the Cookie Policy link. */}
          <p className="mt-3 text-center text-xs leading-6 text-white/45 lg:text-left">
            Read the{" "}
            <a
              href="/legal/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="-my-1 inline-block py-1 text-[color:var(--accent-gold)] underline underline-offset-4 decoration-[color:var(--accent-gold)]/40 transition hover:decoration-[color:var(--accent-gold)]"
            >
              Terms &amp; Conditions
            </a>{" "}
            and{" "}
            <a
              href="/legal/research-disclaimer"
              target="_blank"
              rel="noopener noreferrer"
              className="-my-1 inline-block py-1 text-[color:var(--accent-gold)] underline underline-offset-4 decoration-[color:var(--accent-gold)]/40 transition hover:decoration-[color:var(--accent-gold)]"
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
          <div className="vl-gate-actions mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center lg:mt-5 lg:justify-start">
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

          <p className="mx-auto mt-5 max-w-sm text-xs leading-6 text-white/45 lg:mx-0 lg:mt-4">
            Create a free account to track orders, save your cart, and earn rewards — or continue as a guest and check out with just your email.
          </p>

          </div>
          </div>

          <button
            type="button"
            onClick={handleExit}
            className="vl-focus-ring mt-5 lg:mt-4 text-xs text-white/40 underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            I am under 21 — exit
          </button>

          <p className="mt-6 border-t border-white/[0.07] pt-5 text-[0.62rem] lg:mt-4 lg:pt-4 uppercase tracking-[0.2em] text-white/30">
            Research Use Only · © Vanta Labs
          </p>
        </div>
      </div>
      ) : null}
    </AccessContext.Provider>
  );
}
