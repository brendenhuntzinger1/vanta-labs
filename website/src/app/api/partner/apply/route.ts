import { NextResponse } from "next/server";
import { createPartnerApplication } from "@/lib/partner-portal";
import { createServerClient } from "@/lib/supabase-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { customerSafeMessage } from "@/lib/safe-error";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = typeof body?.accessToken === "string" ? body.accessToken : "";
    const firstName = String(body?.firstName ?? "").trim().slice(0, 80);
    const lastName = String(body?.lastName ?? "").trim().slice(0, 80);
    const phone = String(body?.phone ?? "").trim().slice(0, 40);
    const social = String(body?.social ?? "").trim().slice(0, 200);
    const preferredReferralCode = String(body?.preferredReferralCode ?? "").trim().slice(0, 20);
    const followerCountRaw = Number(body?.followerCount);
    const followerCount = Number.isFinite(followerCountRaw) && followerCountRaw > 0 ? Math.round(followerCountRaw) : null;
    // Backwards-compatible: accept an explicit fullName, else compose it.
    const fullName = (String(body?.fullName ?? "").trim() || `${firstName} ${lastName}`.trim());

    if (!accessToken) {
      return NextResponse.json({ success: false, error: "Missing access token" }, { status: 400 });
    }

    if (!firstName || !lastName) {
      return NextResponse.json({ success: false, error: "First and last name are required" }, { status: 400 });
    }
    if (!phone) {
      return NextResponse.json({ success: false, error: "Phone number is required" }, { status: 400 });
    }

    const supabaseAuthClient = createServerClient();
    const { data, error } = await supabaseAuthClient.auth.getUser(accessToken);
    if (error || !data.user || !data.user.email) {
      return NextResponse.json({ success: false, error: "Invalid auth session" }, { status: 401 });
    }

    const rateLimit = await checkRateLimit(`partner-application:${data.user.id}`, 3, 60 * 60);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Please wait before submitting another application." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const result = await createPartnerApplication({
      authUserId: data.user.id,
      email: data.user.email,
      name: fullName,
      firstName,
      lastName,
      phone,
      social,
      followerCount,
      preferredReferralCode,
    });

    return NextResponse.json({ success: true, partner: result });
  } catch (error) {
    // Sanitised, matching /api/auth/session and /api/contact. A raw message here
    // hands an applicant a Postgres relation or column name ("null value in
    // column referral_code of relation ambassadors"), and this route is
    // reachable by anyone with an account. Logged in full server-side, so no
    // diagnostic is lost; genuinely applicant-facing validation text still
    // passes, because the sanitiser is a deny-list.
    console.error("[partner/apply]", error);
    const message = customerSafeMessage(error, "Unable to submit application");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
