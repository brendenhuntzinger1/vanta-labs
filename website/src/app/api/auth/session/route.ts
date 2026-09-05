import { NextResponse } from "next/server";
import { buildAuthCookieValue, buildExpiredAuthCookie, getSessionAccessToken } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { createServerClient, supabaseAdmin } from "@/lib/supabase-server";
import { awardReferralSignupBonus, awardSignupBonusIfNeeded } from "@/lib/membership";
import { getUserIdByReferralCode, setReferredByCode } from "@/lib/customer-account";
import { customerSafeMessage } from "@/lib/safe-error";
import { recordMarketingOptIn } from "@/lib/marketing-broadcast";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";
    // The half that makes "keep me signed in" mean thirty days rather than one
    // hour. Without it the cookie holds a JWT that expires long before the
    // cookie does and nothing can renew it — see lib/auth-cookie.ts.
    const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken : null;
    // Default to remembering (persistent cookie); an explicit `false` makes it
    // a session-only cookie that clears when the browser closes.
    const rememberMe = body?.rememberMe !== false;
    // Set by the OAuth callback, and only there. Email signup records the same
    // two representations through /api/auth/signup before the account exists.
    const oauthAttested = body?.oauthAttested === true;
    // Strict true only. A missing field, a null, or anything else is "no" —
    // silence is never consent, and this value crosses a network boundary.
    const oauthMarketingOptIn = body?.oauthMarketingOptIn === true;
    // The ambassador code the visitor arrived on, carried across the provider
    // round trip because Google hands back an identity and nothing else. Only
    // ever used when the account does not already carry one — see the referral
    // block below, where the stored value always wins.
    //
    // Bounded and character-restricted here rather than trusted: it survives a
    // trip through two external services and is written to user_metadata, so it
    // is attacker-supplied by construction. getUserIdByReferralCode is the thing
    // that decides whether it names a real ambassador; this only decides it is
    // shaped like a code at all.
    const oauthReferralCode =
      typeof body?.oauthReferralCode === "string"
        ? body.oauthReferralCode.trim().slice(0, 64).replace(/[^A-Za-z0-9_-]/g, "")
        : "";

    if (!accessToken) {
      return NextResponse.json({ success: false, error: "Missing access token" }, { status: 400 });
    }

    const supabaseAuthClient = createServerClient();
    const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);

    if (error || !data.user) {
      return NextResponse.json({ success: false, error: "Invalid session token" }, { status: 401 });
    }

    // Establishing a login session NEVER creates an ambassador/partner record.
    // Becoming an ambassador is an explicit, separate action (POST
    // /api/partner/apply) so a normal customer signup can never trigger the
    // ambassador application flow or its "application received" email.
    const role = detectRoleFromUser(data.user);

    // Points bonuses (signup + referral) are awarded only once the email is
    // CONFIRMED. This stops throwaway/unverified accounts from farming signup
    // and referral points at scale. Both awards are idempotent, so they fire on
    // the first confirmed session and never double. If the project auto-confirms
    // emails, email_confirmed_at is already set and this is a no-op.
    // ------------------------------------------------------------------
    // AN ACCOUNT CREATED THROUGH A PROVIDER STILL HAS TO MAKE THE SAME TWO
    // REPRESENTATIONS.
    //
    // /api/auth/signup writes age_confirmed_21 and research_use_only_agreed
    // into user_metadata, and cannot run until the form's boxes are ticked.
    // Google and Apple hand back an identity and nothing else, so without this
    // an OAuth account would carry neither — on a store that sells 21+
    // research-use-only material. The sign-in form refuses to hand a visitor to
    // a provider until they have ticked both; this records what they ticked.
    //
    // WRITTEN ONCE, NEVER OVERWRITTEN. A returning customer already carries the
    // flags from their original signup, and re-stamping them on every sign-in
    // would replace a real first-time attestation with today's date and destroy
    // the only evidence of when it was actually made.
    //
    // `role` is set at the same time and for the same reason: detectRoleFromUser
    // reads user_metadata.role, and an OAuth account arrives without one.
    // ERRORS HERE ARE RETURNED, NOT THROWN, AND THAT MATTERS.
    //
    // admin.updateUserById catches every GoTrue non-2xx and RETURNS it as
    // `{ error }`; PostgREST builders likewise default to shouldThrowOnError
    // false. So a `try/catch` around these calls only ever fires on a raw
    // network throw, and the refusals that actually happen — a 429 under
    // sign-in load, a service-key rotation, a column or constraint change —
    // sailed through as success with nothing in the logs. Every write below
    // inspects its returned error as well as catching a throw.
    const oauthMeta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
    const alreadyAttested =
      oauthMeta.age_confirmed_21 === true && oauthMeta.research_use_only_agreed === true;

    if (oauthAttested) {
      if (!alreadyAttested) {
        try {
          const { error: attestationError } = await supabaseAdmin.auth.admin.updateUserById(
            data.user.id,
            {
              user_metadata: {
                ...oauthMeta,
                age_confirmed_21: true,
                research_use_only_agreed: true,
                attested_at: new Date().toISOString(),
                ...(oauthMeta.role ? {} : { role: "customer" }),
              },
            },
          );
          if (attestationError) {
            console.error(
              "[auth/session] REFUSED: could not record OAuth attestation",
              { userId: data.user.id, message: attestationError.message },
            );
          }
        } catch (attestationError) {
          // Never fail the sign-in over it. The visitor made the representation
          // and the age gate holds the session-level record; losing the durable
          // copy is worth logging, not worth locking someone out of their account.
          console.error("[auth/session] could not record OAuth attestation", attestationError);
        }
      }
    } else if (!alreadyAttested) {
      // ADMITTED WITH NO ATTESTATION ON FILE, AND NOBODY WOULD HAVE KNOWN.
      //
      // The sign-in form refuses to hand anyone to a provider without both
      // ticks, so reaching here means the record of those ticks did not survive
      // the round trip — sessionStorage blocked, or the provider returned into a
      // different tab. The session is still issued (locking someone out of their
      // own account over a storage quirk would be worse), but this store sells
      // 21+ research-use-only material and an account admitted without the
      // representations is a hole in the compliance record. Silence was the
      // actual defect: nothing reads these flags anywhere, so an absent one is
      // invisible forever. At minimum it is now greppable.
      console.warn(
        "[auth/session] account admitted with no 21+/research-use attestation on file",
        { userId: data.user.id, provider: data.user.app_metadata?.provider ?? "unknown" },
      );
    }

    // ------------------------------------------------------------------
    // MARKETING CONSENT FROM THE PORTAL'S OPTIONAL THIRD BOX.
    //
    // Written through exactly the same two places /api/auth/signup uses, so a
    // customer who arrived through Google is on the list on identical terms to
    // one who typed their address: marketing_subscribers carries the opt-in
    // TIME (what an unsubscribe request and an audit both need), and
    // customer_preferences.marketing_emails is the per-account switch the
    // account settings screen and every send already read.
    //
    // ONLY EVER TRUE, NEVER FALSE. This does not write an opt-OUT. A customer
    // who declines simply has no row, which is already how the rest of the
    // system reads "not subscribed" — and an explicit false written here would
    // silently overwrite a real opt-in from an earlier signup the next time
    // that person signed in with Google.
    //
    // A relayed Apple address is stored as given. It is a deliverable address
    // that Apple forwards, so mail reaches the customer; if they turn the relay
    // off later, the send simply stops, which is the same outcome as any dead
    // address and needs no special case here.
    if (oauthMarketingOptIn && data.user.email) {
      try {
        const subscribed = await recordMarketingOptIn(data.user.email, "oauth_portal");
        if (subscribed === false) {
          // The owner's whole reason for the optional third box is that the
          // address turns up in the subscribers admin. A refused write means it
          // did not, and that has to be visible rather than assumed.
          console.error("[auth/session] REFUSED: marketing_subscribers write did not land", {
            userId: data.user.id,
          });
        }
        const { error: preferenceError } = await supabaseAdmin
          .from("customer_preferences")
          .upsert(
            { user_id: data.user.id, marketing_emails: true, updated_at: new Date().toISOString() },
            { onConflict: "user_id" },
          );
        if (preferenceError) {
          console.error("[auth/session] REFUSED: could not set marketing preference", {
            userId: data.user.id,
            message: preferenceError.message,
          });
        }
      } catch (consentError) {
        // Never fail a sign-in over a mailing list.
        console.error("[auth/session] could not record marketing consent", consentError);
      }
    }

    const emailConfirmed = Boolean(data.user.email_confirmed_at);

    if (role === "customer" && emailConfirmed) {
      try {
        await awardSignupBonusIfNeeded(data.user.id);

        // THE CODE CAN ARRIVE TWO WAYS NOW, AND ONLY ONE OF THEM EXISTED.
        //
        // The email paths write referred_by_code into user_metadata at signup,
        // so it is on the account by the time this runs. A provider signup has
        // no equivalent: Google hands back an identity and nothing else, and
        // startOAuth used to carry only the attestation and the marketing tick
        // across the round trip. So a customer who followed an ambassador link
        // and then took the fastest door was silently unattributed — no welcome
        // points for her, no referral bonus for the ambassador who sent her, and
        // no repair path, because nothing later ever asks again.
        //
        // Squarely reachable rather than a corner: `?ref=` opens SIGNUP mode,
        // and signup mode renders "Continue with Google" directly beneath the
        // submit button.
        //
        // The stored value still wins. It was written at signup, is not
        // attacker-supplied at this point, and re-attributing an existing
        // account from a URL a later sign-in happened to carry is exactly the
        // hijack this must not allow.
        const storedReferralCode = typeof data.user.user_metadata?.referred_by_code === "string"
          ? data.user.user_metadata.referred_by_code
          : "";
        const referredByCode = storedReferralCode || oauthReferralCode;

        // Persist it so the account carries its attribution the same way an
        // email signup's does, and a second sign-in cannot re-point it.
        if (!storedReferralCode && referredByCode) {
          const { error: referralMetaError } = await supabaseAdmin.auth.admin.updateUserById(
            data.user.id,
            {
              user_metadata: {
                ...((data.user.user_metadata ?? {}) as Record<string, unknown>),
                referred_by_code: referredByCode,
              },
            },
          );
          if (referralMetaError) {
            console.error("[auth/session] could not stamp referral code on account", {
              userId: data.user.id,
              message: referralMetaError.message,
            });
          }
        }

        if (referredByCode) {
          await setReferredByCode(data.user.id, referredByCode);
          const referrerUserId = await getUserIdByReferralCode(referredByCode);
          if (referrerUserId && referrerUserId !== data.user.id) {
            await awardReferralSignupBonus(data.user.id, referrerUserId);
          }
        }
      } catch (membershipError) {
        // A points/membership hiccup must never block establishing the
        // session itself.
        console.error("Unable to process membership signup bonuses", membershipError);
      }
    }

    const response = NextResponse.json({
      success: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        role,
      },
    });

    const authCookie = buildAuthCookieValue(accessToken, rememberMe, refreshToken);
    response.cookies.set(authCookie.name, authCookie.value, authCookie.options);

    return response;
  } catch (error) {
    // Sanitised rather than echoed. safe-error.ts:5-16 is explicit that a raw
    // message hands a shopper a vendor hostname, a Postgres relation/column
    // name or an env-var name. Logged in full server-side, so no diagnostic
    // is lost; a genuinely shopper-written message still passes through,
    // because the sanitiser is a deny-list.
    console.error("[auth/session]", error);
    const message = customerSafeMessage(error, "Unable to set session");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE() {
  // Revoke the Supabase session server-side, not just clear the cookie — so a
  // token captured before logout (shared machine, leaked log) can't keep being
  // used until its natural expiry. Best-effort: never block logout on it.
  try {
    const token = await getSessionAccessToken();
    if (token) {
      await supabaseAdmin.auth.admin.signOut(token).catch(() => {});
    }
  } catch {
    /* best-effort revocation */
  }

  const response = NextResponse.json({ success: true });
  const expired = buildExpiredAuthCookie();
  response.cookies.set(expired.name, expired.value, expired.options);
  return response;
}
