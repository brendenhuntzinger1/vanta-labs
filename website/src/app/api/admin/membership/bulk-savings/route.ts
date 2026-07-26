import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { getBulkSavingsControlConfig, upsertControlValue } from "@/lib/admin-control";
import { getBulkSavingsStats } from "@/lib/admin-membership";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [config, stats] = await Promise.all([getBulkSavingsControlConfig(), getBulkSavingsStats()]);
    return NextResponse.json({ success: true, config, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load bulk savings settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage the bulk savings program." }, { status: 403 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const ipAddress = getRequestIpAddress(request);
    const userAgent = getRequestUserAgent(request);

    const entries: Array<[string, unknown]> = [
      ["enabled", body.enabled],
      ["tier1_threshold", body.tier1Threshold],
      ["tier1_percent", body.tier1Percent],
      ["tier2_threshold", body.tier2Threshold],
      ["tier2_percent", body.tier2Percent],
    ];

    // Validate numeric fields before they reach the discount math: thresholds
    // must be finite & >= 0, percents finite & 0..100. Prevents a NaN/absurd
    // value corrupting bulk-savings pricing.
    const THRESHOLD_KEYS = new Set(["tier1_threshold", "tier2_threshold"]);
    const PERCENT_KEYS = new Set(["tier1_percent", "tier2_percent"]);
    for (const [key, rawValue] of entries) {
      if (rawValue === undefined) continue;
      let value = rawValue;
      if (THRESHOLD_KEYS.has(key) || PERCENT_KEYS.has(key)) {
        const n = Number(rawValue);
        const max = PERCENT_KEYS.has(key) ? 100 : 10_000_000;
        if (!Number.isFinite(n) || n < 0 || n > max) {
          return NextResponse.json({ success: false, error: `${key.replace(/_/g, " ")} must be a number between 0 and ${max}.` }, { status: 400 });
        }
        value = n;
      }
      await upsertControlValue({
        section: "bulk_savings",
        key,
        value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save bulk savings settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
