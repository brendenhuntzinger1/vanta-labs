import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getHomepageControlConfig, upsertControlValue } from "@/lib/admin-control";
import { areUsageLimitsEnforceable, getBxgyPromotions, hasUsageLimit, saveBxgyPromotions } from "@/lib/bxgy-promotions";
import { normalizeBxgyPromotion, serializeBxgyPromotions } from "@/lib/bxgy-config";
import { isPromotionScheduled, type BxgyPromotion } from "@/lib/bxgy-engine";

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}
function forbidden() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage promotions." }, { status: 403 });
}

/**
 * The promotion centre's read.
 *
 * `promotions` is the full Buy X Get Y list — every built-in plus anything an
 * admin added — with the two legacy control-centre switches already reconciled
 * onto it, so the centre shows the store's real state rather than a second
 * opinion about it. `scheduledNow` is computed here and not stored: whether a
 * promotion is inside its window is a function of the clock, and a persisted
 * "is it live" flag is a flag someone has to remember to flip.
 *
 * `promotions.buy3Get1Enabled` is kept in the response because the original
 * single-toggle client read it. Nothing else needs it.
 */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageSettings(session.role)) return forbidden();

  const [config, promotions, limitsEnforceable] = await Promise.all([
    getHomepageControlConfig(),
    getBxgyPromotions(),
    // Whether orders.promotion_id exists. A promotion carrying a usage limit
    // does NOT run while its limit cannot be counted, so the centre has to say
    // so — otherwise an admin sets "one per customer", sees the promotion never
    // apply, and reports it as a broken promotion rather than a missing
    // migration.
    areUsageLimitsEnforceable().catch(() => true),
  ]);
  const now = new Date();

  return NextResponse.json({
    success: true,
    promotions: {
      buy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
    },
    usageLimitsEnforceable: limitsEnforceable,
    bxgyPromotions: serializeBxgyPromotions(promotions).map((promotion, index) => ({
      ...promotion,
      // Switched on AND inside its window — the only state that actually
      // discounts an order.
      liveNow: promotions[index].enabled
        && isPromotionScheduled(promotions[index], now)
        && (limitsEnforceable || !hasUsageLimit(promotions[index])),
      scheduledNow: isPromotionScheduled(promotions[index], now),
      /** Configured with a limit that this database cannot count yet. */
      limitBlocked: !limitsEnforceable && hasUsageLimit(promotions[index]),
    })),
  });
}

/**
 * Save the promotion list, the legacy toggle, or both.
 *
 * The two bodies are deliberately both accepted. `{ buy3Get1Enabled }` is what
 * the original single-switch client sends and it keeps working unchanged;
 * `{ promotions: [...] }` is the promotion centre. Sending the second also
 * rewrites the legacy control keys from the promotion list (see
 * saveBxgyPromotions), so the two representations cannot drift apart.
 */
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
    const body = (await request.json()) as { buy3Get1Enabled?: boolean; promotions?: unknown };

    if (Array.isArray(body.promotions)) {
      // Normalised through the same reader the storefront uses, so nothing an
      // admin form can send becomes a promotion the engine would price
      // differently from what the centre displayed back to them.
      const submitted = body.promotions
        .map((entry) => normalizeBxgyPromotion(entry))
        .filter((promotion): promotion is BxgyPromotion => promotion !== null);

      // Merged over the resolved list rather than replacing it, so a partial
      // submission (one promotion edited) cannot silently delete the other
      // five. A promotion is only ever removed by an explicit delete, which
      // this endpoint does not offer — the built-ins are permanent and simply
      // switch off.
      const existing = await getBxgyPromotions();
      const bySubmittedId = new Map(submitted.map((promotion) => [promotion.id, promotion]));
      const merged = existing.map((promotion) => bySubmittedId.get(promotion.id) ?? promotion);
      for (const promotion of submitted) {
        if (!merged.some((entry) => entry.id === promotion.id)) merged.push(promotion);
      }

      const invalid = merged.find((promotion) => (
        promotion.startsAt !== null
        && promotion.endsAt !== null
        && Date.parse(promotion.endsAt) <= Date.parse(promotion.startsAt)
      ));
      if (invalid) {
        return NextResponse.json(
          { success: false, error: `${invalid.name}: the end date must be after the start date.` },
          { status: 400 },
        );
      }

      await saveBxgyPromotions(merged, meta);
      return NextResponse.json({ success: true, bxgyPromotions: serializeBxgyPromotions(merged) });
    }

    if (typeof body.buy3Get1Enabled === "boolean") {
      await upsertControlValue({ section: "promotions", key: "buy_3_get_1_enabled", value: body.buy3Get1Enabled, ...meta });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Nothing to save." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save promotions";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
