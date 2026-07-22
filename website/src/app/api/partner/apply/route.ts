import { NextResponse } from "next/server";
import { createPartnerApplication } from "@/lib/partner-portal";
import { createServerClient } from "@/lib/supabase-server";
import { checkRateLimit, rateLimitedResponseBody } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
    const rl = await checkRateLimit({ action: "partner_apply", identifier: ip, limit: 5, windowSeconds: 600 });
    if (!rl.allowed) {
      return NextResponse.json(rateLimitedResponseBody(), { status: 429 });
    }

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
    const message = error instanceof Error ? error.message : "Unable to submit application";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
