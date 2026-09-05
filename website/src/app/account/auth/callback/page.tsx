"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { safeInternalPath } from "@/lib/internal-path";

// ---------------------------------------------------------------------------
// WHERE GOOGLE AND APPLE LAND, AND WHERE THEY BECOME A REAL SESSION.
//
// signInWithOAuth sends the visitor to the provider; the provider returns them
// to Supabase; Supabase returns them HERE. What arrives is a URL fragment
// carrying the tokens, and this page's only job is to turn that into the exact
// same httpOnly cookie a password sign-in produces, then get out of the way.
//
// ONE SESSION SHAPE, THREE FRONT DOORS. Google, Apple and email all end at
// POST /api/auth/session, which verifies the access token against GoTrue
// server-side before it writes anything. So there is no second authorisation
// path to keep in step, no provider-specific claim anywhere downstream, and no
// way for a provider to mint more access than a password login would. The
// cookie, its rotation in middleware and every server-side check are unchanged.
//
// WHY THE IMPLICIT FLOW AND NOT PKCE. PKCE is the better default in general,
// but flowType is a property of the whole client, and this app's password-reset
// and email-confirmation links are already implicit-shaped (see
// recovery-link-catcher.tsx and app/auth/confirm/route.ts). Switching the shared
// client to PKCE to gain a marginally better OAuth handshake would change how
// those existing links parse, which is a real risk for zero benefit to them.
// The tokens ride in the URL FRAGMENT, which browsers never send to a server and
// never put in a Referer header, and supabase-js strips it from the address bar
// as soon as it has parsed it. That is the same handling the confirmation links
// already get.
//
// NOTHING FROM THE URL DECIDES ANYTHING EXCEPT WHERE TO LAND, and even that is
// laundered through safeInternalPath — the same guard the referral links and the
// sign-in form use. `next` is attacker-supplied by construction: it survives a
// round trip through two external services. It may name a path on this site and
// nothing else.
// ---------------------------------------------------------------------------

const FALLBACK = "/account";

export default function OAuthCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // React 18/19 mount effects run twice in development. Exchanging once is not
    // merely tidier: the second run finds the fragment already consumed and
    // would report a spurious failure over a session that is perfectly fine.
    if (ran.current) return;
    ran.current = true;

    const destination = safeInternalPath(params.get("next"), FALLBACK);

    (async () => {
      // A provider can refuse, and it says so in the query rather than the
      // fragment. Read it first: without this the visitor waits for a session
      // that is never coming and then sees a generic timeout.
      const providerError = params.get("error_description") || params.get("error");
      if (providerError) {
        setError(providerError);
        return;
      }

      // Read and clear in one step: an attestation is consumed by the sign-in it
      // belongs to, and leaving it behind would let a later sign-in in the same
      // tab claim an assertion the visitor never made on that occasion.
      let attested = false;
      try {
        attested = window.sessionStorage.getItem("vl-oauth-attested") === "true";
        window.sessionStorage.removeItem("vl-oauth-attested");
      } catch {
        /* storage unavailable: the server simply records no attestation */
      }

      try {
        // supabase-js parses the fragment on load (detectSessionInUrl defaults
        // to true), but that is asynchronous and may not have finished when this
        // effect runs. onAuthStateChange fires on completion, so wait for
        // whichever arrives first rather than polling.
        const existing = await supabase.auth.getSession();
        const session =
          existing.data.session ??
          (await new Promise<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(
            (resolve) => {
              const timer = setTimeout(() => {
                sub.data.subscription.unsubscribe();
                resolve(null);
              }, 10_000);
              const sub = supabase.auth.onAuthStateChange((_event, s) => {
                if (s) {
                  clearTimeout(timer);
                  sub.data.subscription.unsubscribe();
                  resolve(s);
                }
              });
            },
          ));

        if (!session?.access_token) {
          setError("We could not complete that sign-in. Please try again.");
          return;
        }

        // THE SAME ENDPOINT EMAIL SIGN-IN USES. It re-verifies the token against
        // GoTrue before writing the cookie, so a forged fragment buys nothing.
        //
        // rememberMe is true because a visitor who chose a provider account is
        // asking that browser to remember them; the checkbox on the email form
        // exists for shared machines and has no equivalent here.
        //
        // NOTE WHAT IS NOT SENT: no marketing flag. An OAuth account therefore
        // starts with no marketing_emails row at all, which reads as opted OUT.
        // Handing over a Google address is consent to sign in, never consent to
        // be mailed campaigns, and the two must not be conflated by silence.
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken: session.access_token,
            refreshToken: session.refresh_token,
            rememberMe: true,
            // What the visitor ticked before they were handed to the provider.
            // The server writes it to user_metadata only when the account does
            // not already carry it, so a returning customer's original
            // attestation timestamp is never overwritten by a later sign-in.
            oauthAttested: attested,
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          setError(body?.error || "We could not complete that sign-in. Please try again.");
          return;
        }

        // replace(), not push(): the callback URL held the tokens and has no
        // business in the visitor's history.
        router.replace(destination);
      } catch {
        setError("We could not complete that sign-in. Please try again.");
      }
    })();
  }, [params, router]);

  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        {error ? (
          <>
            <h1 className="vl2-serif text-2xl text-white">Sign-in didn&apos;t complete</h1>
            <p className="mt-3 text-sm leading-6 text-white/60">{error}</p>
            <a
              href={`/account/login?next=${encodeURIComponent(safeInternalPath(params.get("next"), FALLBACK))}`}
              className="vl2-btn-primary vl-focus-ring mt-7 inline-flex px-7 py-3.5"
            >
              Back to sign in
            </a>
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
