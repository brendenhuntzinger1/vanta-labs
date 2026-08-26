import { NextResponse } from "next/server";
import { buildAuthCookieValue, buildExpiredAuthCookie, getSessionAccessToken } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { createServerClient, supabaseAdmin } from "@/lib/supabase-server";
import { awardReferralSignupBonus, awardSignupBonusIfNeeded } from "@/lib/membership";
import { getUserIdByReferralCode, setReferredByCode } from "@/lib/customer-account";
import { customerSafeMessage } from "@/lib/safe-error";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";
    // Default to remembering (persistent cookie); an explicit `false` makes it
    // a session-only cookie that clears when the browser closes.
    const rememberMe = body?.rememberMe !== false;

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
    const emailConfirmed = Boolean(data.user.email_confirmed_at);

    if (role === "customer" && emailConfirmed) {
      try {
        await awardSignupBonusIfNeeded(data.user.id);

        const referredByCode = typeof data.user.user_metadata?.referred_by_code === "string"
          ? data.user.user_metadata.referred_by_code
          : "";

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

    const authCookie = buildAuthCookieValue(accessToken, rememberMe);
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
