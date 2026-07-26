import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";
import { getMembershipBonusSettings } from "@/lib/membership";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const settings = await getMembershipBonusSettings();
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage membership settings." }, { status: 403 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const ipAddress = getRequestIpAddress(request);
    const userAgent = getRequestUserAgent(request);

    const entries: Array<[string, unknown]> = [
      ["signup_bonus_enabled", body.signupBonusEnabled],
      ["referral_bonus_enabled", body.referralBonusEnabled],
      ["birthday_bonus_enabled", body.birthdayBonusEnabled],
      ["signup_bonus_points", body.signupBonusPoints],
      ["referral_bonus_points", body.referralSignupBonusPoints],
      ["birthday_bonus_points", body.birthdayBonusPoints],
    ];

    // Points fields are written straight into the points_ledger for every new
    // customer, so a NaN or absurd value would corrupt balances. Validate them
    // (finite, 0..1,000,000) before storing — matches the ambassadors/settings
    // pattern. The *_enabled fields are booleans and pass through.
    const NUMERIC_KEYS = new Set(["signup_bonus_points", "referral_bonus_points", "birthday_bonus_points"]);
    for (const [key, rawValue] of entries) {
      if (rawValue === undefined) continue;
      let value = rawValue;
      if (NUMERIC_KEYS.has(key)) {
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
          return NextResponse.json({ success: false, error: `${key.replace(/_/g, " ")} must be a number between 0 and 1,000,000.` }, { status: 400 });
        }
        value = n;
      }
      await upsertControlValue({
        section: "membership",
        key,
        value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
