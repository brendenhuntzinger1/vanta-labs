import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { randomUUID } from "crypto";
import {
  adminAdjustAmbassadorCredit,
  getAmbassadorWalletBalanceCents,
  grantAmbassadorCredit,
} from "@/lib/ambassador-wallet";

export const dynamic = "force-dynamic";

// Admin tools for the ambassador wallet + monthly bonus:
//   action "bonus_credit" — grant store-credit bonus (positive cents)
//   action "bonus_cash"   — record a cash bonus payout
//   action "adjust"       — signed manual adjustment (clamped to >= 0 balance)
// Manager+ only; every action writes an admin_audit_logs entry.
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to award bonuses or adjust wallets." }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const partnerId = String(body?.partnerId ?? "").trim();
    const action = String(body?.action ?? "");
    const amountCents = Math.round(Number(body?.amountCents ?? 0));
    const note = body?.note ? String(body.note).slice(0, 300) : null;

    if (!partnerId) {
      return NextResponse.json({ success: false, error: "partnerId is required" }, { status: 400 });
    }
    if (!Number.isFinite(amountCents) || amountCents === 0) {
      return NextResponse.json({ success: false, error: "A non-zero amount is required" }, { status: 400 });
    }

    const { data: partner, error: partnerError } = await supabaseAdmin
      .from("partners")
      .select("id, auth_user_id")
      .eq("id", partnerId)
      .maybeSingle();
    if (partnerError) throw partnerError;
    if (!partner) {
      return NextResponse.json({ success: false, error: "Ambassador not found" }, { status: 404 });
    }

    const ipAddress = getRequestIpAddress(request);
    const userAgent = getRequestUserAgent(request);
    let result: Record<string, unknown> = {};

    if (action === "bonus_cash") {
      if (amountCents <= 0) {
        return NextResponse.json({ success: false, error: "Cash bonus must be positive" }, { status: 400 });
      }
      const payoutId = randomUUID();
      const amount = amountCents / 100;
      const payoutNote = `Monthly bonus${note ? ` — ${note}` : ""}`;
      const { error: payoutError } = await supabaseAdmin.from("partner_payouts").insert({
        id: payoutId, ambassador_id: partnerId, amount, note: payoutNote, processed_by: session.username ?? null,
      });
      if (payoutError) throw payoutError;
      await supabaseAdmin.from("payouts").insert({
        id: payoutId, partner_id: partnerId, amount, note: payoutNote, processed_by: session.username ?? null,
      });
      result = { method: "cash", amount };
    } else if (action === "bonus_credit" || action === "adjust") {
      if (!partner.auth_user_id) {
        return NextResponse.json({ success: false, error: "This ambassador has no linked account for store credit" }, { status: 400 });
      }
      const userId = String(partner.auth_user_id);
      if (action === "bonus_credit") {
        if (amountCents <= 0) {
          return NextResponse.json({ success: false, error: "Bonus credit must be positive" }, { status: 400 });
        }
        await grantAmbassadorCredit({ userId, amountCents, reason: "bonus", note: note ?? "Monthly bonus", createdBy: session.username });
      } else {
        await adminAdjustAmbassadorCredit({ userId, amountCents, note, createdBy: session.username });
      }
      result = { method: "store_credit", balanceCents: await getAmbassadorWalletBalanceCents(userId) };
    } else {
      return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    }

    await supabaseAdmin.from("admin_audit_logs").insert({
      actor_user_id: null,
      action: `ambassador_wallet_${action}`,
      target_table: "ambassador_wallet_ledger",
      target_id: partnerId,
      metadata: { partnerId, action, amountCents, note, actorUsername: session.username ?? null, ipAddress, userAgent },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process wallet action";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
