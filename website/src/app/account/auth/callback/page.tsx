"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { safeInternalPath } from "@/lib/internal-path";
import { readOAuthCallbackFragment, type OAuthCallbackReturn } from "@/lib/auth-link-fragment";

// ---------------------------------------------------------------------------
// WHERE GOOGLE AND APPLE LAND, AND WHERE THEY BECOME A REAL SESSION.
//
// signInWithOAuth sends the visitor to the provider; the provider returns them
// to Supabase; Supabase returns them HERE. What arrives is a URL fragment
// carrying the tokens, and this page's job is to turn that into the exact same
// httpOnly cookie a password sign-in produces, then get out of the way.
//
// ONE SESSION SHAPE, THREE FRONT DOORS. Google, Apple and email all end at
// POST /api/auth/session, which verifies the access token against GoTrue
// server-side before it writes anything. So there is no second authorisation
// path to keep in step, no provider-specific claim anywhere downstream, and no
// way for a provider to mint more access than a password login would. The
// cookie, its rotation in middleware and every server-side check are unchanged.
//
// THE TOKENS COME FROM THE URL, AND FROM NOWHERE ELSE.
//
// This page used to ask supabase-js for "the session" and promote whatever came
// back. That is a different question from the one that matters: getSession()
// answers from localStorage when the URL carries nothing usable, so on a shared
// machine it hands back the PREVIOUS customer's session — a perfectly valid
// token, which the server then verifies quite correctly and writes a thirty-day
// cookie for. The visitor lands as somebody else, holding their order history,
// addresses and store credit.
//
// Guarding that with a "does this URL look like a callback" predicate was not
// enough either, because supabase-js uses a DIFFERENT predicate and the gap
// between them is exactly the hole: see readOAuthCallbackFragment in
// lib/auth-link-fragment.ts, which records both bypasses in full.
//
// So the fragment is read once, at render time, before anything touches
// supabase.auth and lets the client consume it; the tokens it yields are the
// only tokens used, to establish the client session and to post to the server;
// and client storage is never consulted for identity. A fragment without both
// tokens is not a sign-in, whatever else it contains.
//
// WHY THE IMPLICIT FLOW AND NOT PKCE. PKCE is the better default in general,
// but flowType is a property of the whole client, and this app's password-reset
// and email-confirmation links are already implicit-shaped (see
// recovery-link-catcher.tsx and app/auth/confirm/route.ts). Switching the shared
// client to PKCE to gain a marginally better OAuth handshake would change how
// those existing links parse, which is a real risk for zero benefit to them.
// The tokens ride in the URL FRAGMENT, which browsers never send to a server and
// never put in a Referer header, and supabase-js strips it from the address bar
// as soon as it has parsed it.
//
// NOTHING FROM THE URL DECIDES ANYTHING EXCEPT WHERE TO LAND, and even that is
// laundered through safeInternalPath — the same guard the referral links and the
// sign-in form use. `next` is attacker-supplied by construction: it survives a
// round trip through two external services. It may name a path on this site and
// nothing else.
// ---------------------------------------------------------------------------

const FALLBACK = "/account";

// One sentence for every way this can fail, because none of the underlying text
// is ours to show. A provider's own error arrives in the query string, which
// means it arrives from whoever wrote the link. Printing it verbatim publishes
// attacker-chosen prose on our own sign-in page, under our domain and our
// styling — "Your account is locked, call 1-800-…" is a complete phishing
// message we would be hosting for them. The raw text is logged, never displayed.
const SIGN_IN_FAILED = "We couldn't complete that sign-in. Please try again.";
const NOT_A_SIGN_IN =
  "This page finishes a sign-in that's already in progress. Start from the sign-in screen and you'll be brought back here automatically.";

/** What the round trip was supposed to carry, once the tokens are in hand. */
type PendingSignIn = {
  accessToken: string;
  refreshToken: string;
  marketingOptIn: boolean;
  referralCode: string;
};

export default function OAuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Set only when the session is real but the attestation did not survive the
  // trip. See the long note at the re-ask below.
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [researchUseAgreed, setResearchUseAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // WHICH TOKENS ARRIVED IN THIS URL, decided before anything reads
  // supabase.auth.
  //
  // Read in a useState initializer, which runs during render, so it sees the
  // fragment before the effect below triggers the lazy construction of the
  // supabase browser client that would consume and strip it. Same ordering the
  // sign-in form relies on for confirmation links.
  const [callbackReturn] = useState<OAuthCallbackReturn>(() => {
    if (typeof window === "undefined") return { kind: "none" };
    return readOAuthCallbackFragment(window.location.hash);
  });

  const destination = safeInternalPath(params.get("next"), FALLBACK);

  /** Establish the client session, write the cookie, and leave. */
  const completeSignIn = useCallback(
    async (signIn: PendingSignIn, attested: boolean, landAt: string): Promise<boolean> => {
      try {
        // Establish the client session from THESE tokens explicitly, rather than
        // waiting to see what supabase-js decides it has. Passing the pair means
        // the result cannot be a session from storage, and it keeps the browser
        // client in step with the cookie exactly as the password path does.
        const { error: setSessionError } = await supabase.auth.setSession({
          access_token: signIn.accessToken,
          refresh_token: signIn.refreshToken,
        });
        if (setSessionError) {
          console.error("Could not establish the client session", setSessionError);
          setError(SIGN_IN_FAILED);
          return false;
        }

        // THE SAME ENDPOINT EMAIL SIGN-IN USES. It re-verifies the token against
        // GoTrue before writing the cookie, so a forged fragment buys nothing.
        //
        // rememberMe is true because a visitor who chose a provider account is
        // asking that browser to remember them; the checkbox on the email form
        // exists for shared machines and has no equivalent here.
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // The fragment's tokens, not a re-read of client state.
            accessToken: signIn.accessToken,
            refreshToken: signIn.refreshToken,
            rememberMe: true,
            // What the visitor ticked — before the hand-off, or just now on the
            // re-ask below. The server writes it to user_metadata only when the
            // account does not already carry it, so a returning customer's
            // original attestation timestamp is never overwritten.
            oauthAttested: attested,
            // Only ever true when the visitor ticked the optional third box on
            // the portal. Entry never depended on it, so this is a real answer
            // rather than the price of getting in.
            oauthMarketingOptIn: signIn.marketingOptIn,
            // The ambassador who sent them. The server ignores this whenever the
            // account already carries a code, so a later sign-in cannot
            // re-attribute an existing customer.
            oauthReferralCode: signIn.referralCode,
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          setError(typeof body?.error === "string" ? body.error : SIGN_IN_FAILED);
          return false;
        }

        // Spent, and only now — after the work that can fail. Clearing these up
        // front left a retry with nothing to send, and the retry then SUCCEEDED,
        // quietly recording no attestation at all.
        try {
          window.sessionStorage.removeItem("vl-oauth-attested");
          window.sessionStorage.removeItem("vl-oauth-marketing");
          window.sessionStorage.removeItem("vl-oauth-referral");
        } catch {
          /* storage unavailable: nothing was stored to clear */
        }

        // replace(), not push(): the callback URL held the tokens and has no
        // business in the visitor's history.
        router.replace(landAt);
        return true;
      } catch (err) {
        console.error("OAuth callback failed", err);
        setError(SIGN_IN_FAILED);
        return false;
      }
    },
    [router],
  );

  useEffect(() => {
    // React 18/19 mount effects run twice in development. Exchanging once is not
    // merely tidier: the second run finds the fragment already consumed and
    // would report a spurious failure over a session that is perfectly fine.
    if (ran.current) return;
    ran.current = true;

    (async () => {
      // A provider can refuse, and it says so in the QUERY string rather than
      // the fragment. Read it first: without this the visitor waits for a
      // session that is never coming.
      const providerError = params.get("error_description") || params.get("error");
      if (providerError) {
        console.error("OAuth provider refused the sign-in", { providerError });
        setError(SIGN_IN_FAILED);
        return;
      }

      // GoTrue reports its own refusals in the FRAGMENT, a separate channel from
      // the query above, so both have to be read and neither replaces the other.
      if (callbackReturn.kind === "error") {
        console.error("GoTrue refused the sign-in", { errorCode: callbackReturn.errorCode });
        setError(SIGN_IN_FAILED);
        return;
      }

      // NO TOKENS, NO SIGN-IN. Landing here means this address was opened
      // without a sign-in attached to it — typed, shared, bookmarked, or reached
      // with the back button. There is nothing to complete, and the one thing
      // that must never happen is falling back to whatever the browser still
      // holds. Send them to the front door instead.
      if (callbackReturn.kind !== "session") {
        setError(NOT_A_SIGN_IN);
        return;
      }

      const { accessToken, refreshToken } = callbackReturn;

      let attested = false;
      let marketingOptIn = false;
      let referralCode = "";
      try {
        attested = window.sessionStorage.getItem("vl-oauth-attested") === "true";
        // Read as a strict "true", so a missing key or any other value means no.
        // Silence must never be read as consent.
        marketingOptIn = window.sessionStorage.getItem("vl-oauth-marketing") === "true";
        referralCode = window.sessionStorage.getItem("vl-oauth-referral") ?? "";
      } catch {
        /* storage unavailable — handled by the re-ask below, not by admitting */
      }

      const signIn: PendingSignIn = { accessToken, refreshToken, marketingOptIn, referralCode };

      // THE MARKER DID NOT SURVIVE, SO ASK AGAIN RATHER THAN ADMIT WITHOUT IT.
      //
      // The two representations ride in tab-scoped sessionStorage across two
      // external redirects, and there are loss modes the sending page cannot
      // detect: storage blocked at the far end, or — the one that matters for
      // this store — the hand-off landing in a DIFFERENT browser context. Google
      // refuses OAuth inside embedded webviews, so an ad click opened in the
      // TikTok or Meta in-app browser gets bounced out to the system browser,
      // where the tab that wrote the marker does not exist.
      //
      // That is precisely the population this storefront buys. Admitting them
      // with `oauthAttested: false` skips the entire metadata write: no
      // age_confirmed_21, no research_use_only_agreed, no timestamp. Nothing in
      // the app reads those flags back, so nothing ever re-asks or backfills —
      // the gap is permanent for that account and invisible to everyone,
      // including the owner, on a store selling 21+ research-use-only material.
      //
      // So the page re-asks instead of failing open. The session is real and the
      // visitor is right here; only the record is missing. Ticking both is the
      // same refusal the portal applies before the hand-off, made at the far end
      // of the trip. Nobody is locked out: this is one extra tap, and only on
      // the loads where the marker was actually lost.
      if (!attested) {
        setPending(signIn);
        return;
      }

      await completeSignIn(signIn, true, destination);
    })();
  }, [callbackReturn, completeSignIn, destination, params]);

  const confirmAndContinue = async () => {
    if (!pending || !ageConfirmed || !researchUseAgreed || submitting) return;
    setSubmitting(true);
    const ok = await completeSignIn(pending, true, destination);
    if (!ok) setSubmitting(false);
  };

  const backToSignIn = (
    <a
      href={`/account/login?next=${encodeURIComponent(destination)}`}
      className="vl2-btn-primary vl-focus-ring mt-7 inline-flex px-7 py-3.5"
    >
      Back to sign in
    </a>
  );

  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        {error ? (
          <>
            <h1 className="vl2-serif text-2xl text-white">Sign-in didn&apos;t complete</h1>
            <p className="mt-3 text-sm leading-6 text-white/60">{error}</p>
            {backToSignIn}
          </>
        ) : pending ? (
          <>
            <h1 className="vl2-serif text-2xl text-white">One more thing</h1>
            <p className="mt-3 text-sm leading-6 text-white/60">
              You&apos;re signed in. Please confirm the following to continue.
            </p>

            <div className="mt-7 space-y-2.5 text-left">
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

            <button
              type="button"
              onClick={() => void confirmAndContinue()}
              disabled={!ageConfirmed || !researchUseAgreed || submitting}
              className="vl-auth-submit vl-focus-ring mt-6 w-full"
            >
              {submitting ? "Continuing…" : "Continue"}
            </button>
          </>
        ) : (
          <>
            {/* aria-live so a screen reader announces the wait rather than
                landing on a page that appears empty. */}
            <div
              className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80"
              aria-hidden="true"
            />
            <p className="mt-5 text-sm text-white/60" role="status" aria-live="polite">
              Signing you in…
            </p>
          </>
        )}
      </div>
    </main>
  );
}
