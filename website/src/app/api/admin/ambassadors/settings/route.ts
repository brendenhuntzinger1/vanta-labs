import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getAmbassadorProgramSettings, setAmbassadorMarketingResources, setAmbassadorProgramSetting } from "@/lib/ambassador-settings";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage the ambassador program." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const settings = await getAmbassadorProgramSettings();
  return NextResponse.json({ success: true, settings });
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  // These settings (qualifying-order minimum, payout threshold, hold days)
  // directly govern how much partners are paid, so they are manager+ only.
  if (!canManageRefunds(session.role)) {
    return forbiddenResponse();
  }

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  try {
    const body = await request.json();

    // Marketing resources are a separate, list-shaped setting (title/url/desc).
    if (Array.isArray(body?.marketingResources)) {
      const marketingResources = await setAmbassadorMarketingResources({
        resources: body.marketingResources,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
      return NextResponse.json({ success: true, marketingResources });
    }

    const ALLOWED_KEYS = [
      "minimum_qualifying_order",
      "minimum_payout_threshold",
      "commission_hold_days",
      "store_credit_multiplier_percent",
      "ambassador_discount_percent",
    ] as const;
    const key = body?.key as (typeof ALLOWED_KEYS)[number];
    const value = Number(body?.value);

    if (!ALLOWED_KEYS.includes(key)) {
      return NextResponse.json({ success: false, error: "Invalid setting key" }, { status: 400 });
    }

    // Store credit worth less than cash would turn the "bonus" into a penalty.
    if (key === "store_credit_multiplier_percent" && value < 100) {
      return NextResponse.json({ success: false, error: "Store credit multiplier must be at least 100%" }, { status: 400 });
    }

    // A discount over 100% would make orders free / negative.
    if (key === "ambassador_discount_percent" && value > 100) {
      return NextResponse.json({ success: false, error: "Ambassador discount can't exceed 100%" }, { status: 400 });
    }

    if (!Number.isFinite(value) || value < 0) {
      return NextResponse.json({ success: false, error: "Value must be a non-negative number" }, { status: 400 });
    }

    await setAmbassadorProgramSetting({
      key,
      value,
      actorUsername: session.username,
      ipAddress,
      userAgent,
    });

    const settings = await getAmbassadorProgramSettings();
    return NextResponse.json({ success: true, settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update setting";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
