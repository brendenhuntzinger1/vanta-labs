import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { collectServerHealth } from "@/lib/ads/tracking-health-server";

/**
 * The server half of the tracking health board.
 *
 * Admin-only: it reports which environment variables are configured and what
 * the deployment is, which is not anonymous-visitor information even though no
 * value is ever returned.
 *
 * Read-only and side-effect free. It sends nothing to TikTok — the live call is
 * a separate, deliberately-triggered action — so refreshing this page cannot
 * put anything into anyone's reporting.
 */
export async function GET() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    return NextResponse.json({ error: "admin session required" }, { status: 401 });
  }

  return NextResponse.json(await collectServerHealth(), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
