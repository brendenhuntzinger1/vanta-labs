import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { getControlSnapshot, getReferralProgramConfig, upsertControlValue } from "@/lib/admin-control";
import { findDestructiveClears, type ControlUpdate } from "@/lib/admin-control-updates";

/**
 * What the referral rates ACTUALLY resolve to, and where each one comes from.
 *
 * Computed with getReferralProgramConfig() — the same function checkout and the
 * approval email call — so the Control Center cannot display one number while
 * the business logic uses another. `source` distinguishes a value the owner
 * stored from the code default, because "20% because nothing is stored" and
 * "20% because someone typed 20" look identical in an input box and are not the
 * same fact when something looks wrong.
 */
async function referralEffective(snapshot: Record<string, Record<string, unknown>>) {
  const stored = snapshot.referral ?? {};
  const config = await getReferralProgramConfig();
  const sourceOf = (key: string) => {
    const value = stored[key];
    // Blank is not "stored": the canonical rule treats it as "use the default",
    // so reporting it as an override would be a lie in the owner's own words.
    return value === undefined || value === null || value === "" ? "default" : "stored";
  };
  return {
    personalDiscountPercent: config.personalDiscountPercent,
    personalDiscountSource: sourceOf("personal_discount_percent"),
    discountPercent: config.discountPercent,
    discountSource: sourceOf("discount_percent"),
    defaultCommissionPercent: config.defaultCommissionPercent,
    defaultCommissionSource: sourceOf("default_commission_percent"),
  };
}

// Sections that hold credentials — these are managed ONLY through
// /api/admin/settings (which masks secrets on read and writes them carefully).
// They must never be written through this generic endpoint, nor returned here.
const SECRET_SECTIONS = new Set(["email", "payment_processor", "fulfillment"]);

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to change store settings." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  // Config editing is a manager+ capability.
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  try {
    const url = new URL(request.url);
    const section = url.searchParams.get("section") ?? undefined;
    const snapshot = await getControlSnapshot(section);
    // Never expose credential sections through this endpoint.
    for (const secret of SECRET_SECTIONS) {
      delete (snapshot as Record<string, unknown>)[secret];
    }
    const effective = { referral: await referralEffective(snapshot).catch(() => null) };
    return NextResponse.json({ success: true, snapshot, effective });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load control settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageSettings(session.role)) {
    return forbiddenResponse();
  }

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  try {
    const body = await request.json() as {
      updates?: ControlUpdate[];
    };

    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) {
      return NextResponse.json({ success: false, error: "No updates provided" }, { status: 400 });
    }

    // Reject any attempt to write a credential section through this endpoint.
    if (updates.some((update) => SECRET_SECTIONS.has(String(update.section ?? "").trim().toLowerCase()))) {
      return NextResponse.json({ success: false, error: "Use the Settings page to change email, processor, or fulfillment credentials." }, { status: 403 });
    }

    // THE BLANKING BACKSTOP (F-02). A save that would empty a setting which
    // currently holds a value is refused unless the caller declared that clear
    // deliberately. On 2026-08-15 an unloaded Control Center form PATCHed "" over
    // every key it owns; tax.nexus_states went from 48 states to empty and the
    // store silently stopped charging sales tax for eight days.
    //
    // Checked BEFORE any write and refused in full, so a rejected save can never
    // leave settings half-wiped. The client applies the same rule when building
    // the request -- this is the copy that also covers a stale tab, a replayed
    // request, or any future caller that forgets to read before writing.
    const destructive = findDestructiveClears(updates, await getControlSnapshot());
    if (destructive.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            `Refusing to clear ${destructive.length} setting${destructive.length === 1 ? "" : "s"} that currently hold a value: ` +
            `${destructive.join(", ")}. Reload the Control Center so it shows the current settings, then clear the field you meant to clear.`,
          destructiveClears: destructive,
        },
        { status: 409 },
      );
    }

    for (const update of updates) {
      await upsertControlValue({
        section: String(update.section ?? ""),
        key: String(update.key ?? ""),
        value: update.value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save control settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
