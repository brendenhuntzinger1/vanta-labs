import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkReferralCodeAvailability } from "@/lib/referral-code-service";

// Live availability check for the code editor. Requires a signed-in user
// (no anonymous access) AND is rate-limited per user+IP so it can't be used to
// enumerate existing codes.
export async function GET(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const ip = getRequestIpAddress(request) ?? "unknown";
  const limit = await checkRateLimit(`referral-code-check:${user.id}:${ip}`, 30, 60); // 30/min
  if (!limit.allowed) {
    const res = NextResponse.json({ success: false, error: "Too many checks. Slow down a moment." }, { status: 429 });
    res.headers.set("Retry-After", String(limit.retryAfterSeconds));
    return res;
  }

  const code = new URL(request.url).searchParams.get("code") ?? "";
  const result = await checkReferralCodeAvailability(code, user.id);
  return NextResponse.json({ success: true, ...result });
}
