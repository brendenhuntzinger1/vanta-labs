import { NextResponse } from "next/server";
import { buildAuthCookieValue, buildExpiredAuthCookie } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { createServerClient } from "@/lib/supabase-server";
import { awardReferralSignupBonus, awardSignupBonusIfNeeded } from "@/lib/membership";
import { getUserIdByReferralCode, setReferredByCode } from "@/lib/customer-account";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";

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

    if (role === "customer") {
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

    const authCookie = buildAuthCookieValue(accessToken);
    response.cookies.set(authCookie.name, authCookie.value, authCookie.options);

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to set session";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  const expired = buildExpiredAuthCookie();
  response.cookies.set(expired.name, expired.value, expired.options);
  return response;
}
