import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { changeOwnReferralCode } from "@/lib/referral-code-service";
import { customerSafeMessage } from "@/lib/safe-error";

// An APPROVED ambassador changes their OWN referral code. Scoped to the
// signed-in user (server derives the ambassador from the session, never the
// body), rate-limited to blunt abuse, and fully validated + atomic downstream.
export async function PUT(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const ip = getRequestIpAddress(request) ?? "unknown";
  const limit = await checkRateLimit(`referral-code-change:${user.id}`, 5, 3600); // 5/hour/user
  if (!limit.allowed) {
    const res = NextResponse.json({ success: false, error: "Too many changes right now. Please wait a bit." }, { status: 429 });
    res.headers.set("Retry-After", String(limit.retryAfterSeconds));
    return res;
  }

  try {
    const body = (await request.json()) as { code?: string };
    const result = await changeOwnReferralCode({
      authUserId: user.id,
      requestedCode: String(body.code ?? ""),
      ipAddress: ip,
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ success: true, code: result.code });
  } catch (error) {
    // "Only approved ambassadors can set a referral code." and the other
    // messages written for the ambassador pass through; a database message does
    // not.
    console.error("[partner/referral-code]", error);
    const message = customerSafeMessage(error, "Unable to update your referral code.");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
