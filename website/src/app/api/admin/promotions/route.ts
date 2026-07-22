import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getHomepageControlConfig, upsertControlValue } from "@/lib/admin-control";
import { getPromotionRules, setPromotionRules } from "@/lib/promotion-rules";
import type { PromotionRulesConfig } from "@/lib/promotion-engine";

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}
function forbidden() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage promotions." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageSettings(session.role)) return forbidden();

  const [config, rules] = await Promise.all([getHomepageControlConfig(), getPromotionRules()]);
  return NextResponse.json({
    success: true,
    promotions: {
      buy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
    },
    rules,
  });
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageSettings(session.role)) return forbidden();

  const meta = {
    actorUsername: session.username,
    ipAddress: getRequestIpAddress(request),
    userAgent: getRequestUserAgent(request),
  };

  try {
    const body = (await request.json()) as { buy3Get1Enabled?: boolean; rules?: PromotionRulesConfig };
    if (typeof body.buy3Get1Enabled === "boolean") {
      await upsertControlValue({ section: "promotions", key: "buy_3_get_1_enabled", value: body.buy3Get1Enabled, ...meta });
    }
    let rules;
    if (body.rules) {
      rules = await setPromotionRules({ rules: body.rules, actorUsername: meta.actorUsername, ipAddress: meta.ipAddress, userAgent: meta.userAgent });
    }
    return NextResponse.json({ success: true, rules });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save promotions";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
