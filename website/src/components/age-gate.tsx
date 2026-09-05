"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

// TWO TICKS. NOT FOUR, AND NEVER ONE.
//
// This used to ask for four separate ticks — age, organisation, research use,
// terms — on the reasoning that a single combined checkbox is one click
// standing for four different representations, which is exactly the assent a
// regulator would question.
//
// That reasoning is still right about ONE box. It was wrong that the only
// alternative was four. A column of four legal sentences is what made the first
// screen of the store read as a warning notice rather than a shop, and all four
// clicks land on the same visitor in the same second regardless.
//
// So the representations are grouped by KIND instead of split by sentence, and
// nothing is given up: every one of the four is still made, and entry is still
// refused until both are ticked.
//
//   1. WHO IS ASKING        — 21 or older, and here on behalf of a lab,
//                             business, school or research organisation.
//   2. WHAT IS BEING AGREED — laboratory research only, not for human
//                             consumption, plus the Terms and the Research Use
//                             Policy.
//
// Those are two genuinely different assertions, made by two deliberate and
// separate acts. Collapsing them further, into one "I agree", is the line this
// must not cross. The test alongside pins both the count and every
// representation the copy is required to carry, so neither can be edited away
// by accident.
const ATTESTATIONS = [
  {
    id: "eligibility",
    text: "I'm 21 or older, and I'm here for a lab, business, school, or research organization",
  },
  {
    id: "researchUse",
    text: "I understand these products are for laboratory research only — not for human consumption — and I accept the Terms & Research Use Policy",
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
const NEVER_A_DESTINATION = ["/legal"];

// THE HOME PAGE IS NO LONGER SKIPPED FOR ANYONE, AND THE CATALOG GATE IS WHY.
//
// A long-lived rule lived here: an app's embedded WebView cannot play the hero
// vial, so those visitors were pushed to the catalog on clearing the gate, with
// middleware making the same decision on the server. hero-video.tsx served them
// a still independently.
//
// The catalog now requires an account (GATED_PREFIXES in middleware.ts), so
// that push resolves to a sign-in form. A TikTok or Instagram visitor would
// attest their age and be handed a login wall in the same instant — worse than
// the motionless hero the rule was written to avoid, and aimed squarely at the
// paid traffic it was written to serve.
//
// So both halves are gone: IN_APP_HOME_REPLACEMENT is null in middleware, and
// the in-app branch that used to sit here is deleted rather than left
// unreachable, along with the helper it called. detectInAppBrowser is no longer imported by this file
// at all, which is the point — the gate now routes nobody on the strength of
// their browser, and cannot start again by having a dormant helper revived.
//
// hero-video.tsx keeps its own check, and should: choosing a still over a
// player is a judgement about what a browser can DO. Deciding what a visitor
// may SEE is the thing that must never depend on their client.

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
  // AN IN-APP BROWSER IS NO LONGER MOVED OFF THE HOME PAGE, AND THE CATALOG
  // GATE IS WHY.
  //
  // This used to return "/products" for a browser that cannot play the hero,
  // mirroring the middleware rule of the same name. The catalog now requires an
  // account, so both halves of that rule would land a TikTok or Instagram
  // visitor on a login wall as their first impression — worse than the still
  // hero it was avoiding, and on the traffic that matters most. Middleware's
  // IN_APP_HOME_REPLACEMENT is null for the same reason; the two are meant to
  // agree and the test alongside pins that they do.
  //
  // Signed out, the home page now carries the brand, the testing story and an
  // explicit invitation to sign in, so it is a reasonable landing for these
  // browsers even with a motionless hero.
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
      {/* INERT, NOT INVISIBLE.
          The storefront used to be `visibility: hidden` while the gate was up,
          which made it unreachable by every route at once — including the
          keyboard, because a hidden element is not in the tab order. That rule
          is gone (it also hid the page from Google's renderer, so every URL on
          the site indexed as the same "Are you 21?" panel), and covering the
          store with an opaque overlay does not replace the half of it that was
          about focus: 60 presses of Tab walked straight past the gate and into
          the staff shortcut in the footer, then End scrolled the store behind
          the overlay.

          `inert` is the exact primitive for that: the subtree cannot be
          focused, clicked or reached by assistive technology, and it is still
          laid out, painted and readable to a renderer. It is rendered by the
          server, so it holds from the first byte rather than from hydration,
          and it costs nothing when JavaScript never runs.

          `display: contents` because <body> is `flex flex-col` and these are
          its flex items. A wrapper that generated a box would collect all of
          them into one item and re-lay-out the entire site; a wrapper that
          generates none leaves the layout byte-identical. Inline rather than a
          class so it cannot be lost if the stylesheet is slow — the wrapper is
          in the HTML from the first parse, and so is its display. */}
      <div data-storefront="" style={{ display: "contents" }} inert={!isVerified}>
        {children}
      </div>
      {!isVerified ? (
      <div
        data-age-gate="true"
        className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[#0a0908] px-4 py-8 text-zinc-100 sm:items-center sm:px-6 sm:py-10"
      >
        {/* Layered ambient light — warm gold + cool blue, matching the brand */}
        <div className="vl-gate-glow pointer-events-none absolute inset-0" />
        {/* Faint grid texture for depth */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.28] [background-image:linear-gradient(rgba(199,174,94,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(199,174,94,0.05)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]" />

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
             Widening at lg fixes both at once: the card fills the screen
             properly AND gets short enough to fit without scrolling. */
          /* vl2-hero-enter, NOT vl2-fade-in. On a first visit this panel is the
             ONLY thing on the screen -- the storefront behind it is inert until
             the attestations are confirmed -- so holding it at opacity:0 for the
             560ms entrance leaves the visitor looking at an empty page, and the
             browser records no first-contentful-paint at all. Measured on the
             production build at 390x844 on throttled 4G with 4x CPU: a cold
             first visit reported `first-paint` at 780ms and NO
             first-contentful-paint and NO largest-contentful-paint entry, across
             every run. The panel still rises; it is simply legible while it does. */
          className="vl-gate-panel vl2-hero-enter vl-focus-ring relative w-full max-w-lg rounded-[1.75rem] p-6 text-center backdrop-blur-2xl sm:rounded-[2rem] sm:p-9 lg:max-w-3xl lg:p-8 xl:max-w-4xl"
        >
          {/* TWO COLUMNS ON A LAPTOP, ONE ON A PHONE.
              Setting the brand beside the form rather than above it is what
              makes the gate fit a laptop without scrolling. It was introduced
              when four attestations made a single column 921px tall, and
              dropping to two did NOT make it unnecessary — measured in the
              browser at 1280x800, with the same content: 628px in two
              columns, 922px in one. The gate's own padding leaves 712px of
              that screen, so one column would still overflow and two still
              clears it by 84px.
              Below lg this is not a grid at all and the DOM order is
              unchanged, so the phone layout behaves exactly as before. */}
          <div className="lg:grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:items-center lg:gap-0 lg:text-left">
          <div className="lg:pr-8">
          {/* THE MONOGRAM SITS WITH THE BRAND, NOT ABOVE THE WHOLE CARD.
              It used to be a sibling of the two-column grid, which was fine
              while four attestations made the right-hand column tall. With two
              it is shorter, the grid centres itself against it, and the
              monogram was left stranded at the top of the card above roughly
              120px of nothing. Inside the brand column it simply leads the
              brand, and the phone layout is untouched: the DOM order is the
              same, and it is still centred until lg. */}
          <div className="vl-gate-monogram mx-auto flex h-14 w-14 items-center justify-center rounded-full sm:h-16 sm:w-16 lg:mx-0">
            <span className="vl2-serif text-xl tracking-[0.12em] text-[color:var(--accent-gold-strong)]">VL</span>
          </div>

          <p className="vl2-eyebrow mt-5 flex items-center justify-center gap-2 text-[color:var(--accent-gold)] sm:mt-6 lg:justify-start">
            <span className="vl-gate-rule h-px w-6" />
            21+ · Research Use Only
            <span className="vl-gate-rule h-px w-6" />
          </p>

          {/* h2, not h1. This dialog renders on all 111 public URLs, so an h1 here
              put a second top-level heading on every page in the site — measured
              across all 55 sitemap URLs. A modal title is not the document's
              top-level heading, and the page beneath it already has one.

              Nothing else changes: aria-labelledby below resolves this by ID and
              does not care about the tag, so the dialog keeps exactly the same
              accessible name, and the styling is entirely utility classes rather
              than a bare-element rule. Verified in the browser at 390px: identical
              computed font, colour and box. */}
          <h2 id="age-gate-title" className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Vanta Labs</h2>
          <p className="mt-3 text-sm text-white/55 sm:text-base">Research Integrity. Verified Quality.</p>

          {/* Trust chips */}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5 sm:mt-6 sm:gap-2 lg:justify-start">
            {trustPoints().slice(0, 3).map((point: string) => (
              <span key={point} className="vl-gate-chip inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6rem] font-medium uppercase tracking-[0.1em] sm:px-3 sm:py-1.5 sm:text-[0.62rem] sm:tracking-[0.14em]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-[color:var(--accent-gold)]" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
                {point}
              </span>
            ))}
          </div>

          <div className="vl-gate-rule my-6 h-px w-full lg:hidden" />
          </div>

          {/* The same rule the phone gets, stood up. Below lg the brand and the
              form are one column separated by a champagne hairline; at lg they
              sit side by side, so the hairline turns vertical rather than
              disappearing and the two halves stay visibly related. */}
          <div className="lg:border-l lg:border-[rgba(199,174,94,0.18)] lg:pl-8">

          <p className="text-lg font-medium text-white sm:text-xl lg:mt-0">Two quick things before you browse</p>

          <div className="mt-5 flex flex-col gap-3 lg:mt-4">
            {ATTESTATIONS.map((attestation) => (
              <label
                key={attestation.id}
                className="vl-gate-row group flex cursor-pointer items-start gap-3.5 rounded-2xl p-4 text-left text-sm leading-6 text-white/75 has-[:checked]:text-white"
              >
                <input
                  type="checkbox"
                  checked={Boolean(confirmed[attestation.id])}
                  onChange={(event) => toggle(attestation.id, event.target.checked)}
                  className="vl-gate-check mt-0.5 h-5 w-5 shrink-0"
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

          {showPrompt ? <p role="alert" className="mt-3 text-sm text-[color:var(--accent-gold)]">Please tick both boxes to continue.</p> : null}

          {/* THE ENTRY BUTTONS MUST BE ON SCREEN WITHOUT SCROLLING.
              An in-app browser keeps its own top and bottom chrome on screen,
              which leaves roughly 664px of an 844px iPhone. When this card was
              taller these two buttons sat about 200px BELOW the fold — enabled,
              correct, and unreachable unless you knew to scroll the panel. In
              Safari the chrome auto-hides, the viewport is taller, and they
              were reachable: the entire difference between "works in Safari"
              and "cannot sign in from TikTok".

              They were pinned there with position: sticky, which cured that and
              caused something worse — see .vl-gate-actions in globals.css: the
              bar painted OVER the attestation rows scrolling beneath it, so a
              tap aimed at a checkbox activated "Create account / Sign in"
              instead. It is position: relative now, and HEIGHT is what keeps
              them reachable. Measured on the harness at 390x844: both buttons
              end at 820px, inside the fold, at the gate's initial scroll
              position.

              So height above these buttons is a constraint, not a preference.
              Anything added above them has to be paid for.

              lg:flex-col because side by side they do not fit the right-hand
              column: at 1280 each of the pair wrapped onto two lines. Full
              width of that column, stacked, is also the larger tap target. */}
          <div className="vl-gate-actions mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center lg:mt-5 lg:flex-col lg:justify-start">
            <button
              type="button"
              onClick={handleAccount}
              disabled={!agreed}
              className="vl2-btn-primary vl-gate-cta vl-focus-ring px-6 py-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
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
            Create an account to track orders and earn rewards — or continue as a guest and check out with just your email.
          </p>

          </div>
          </div>

          <button
            type="button"
            onClick={handleExit}
            className="vl-focus-ring mt-5 lg:mt-4 text-xs text-white/40 underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Not 21 yet? Leave the site
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
