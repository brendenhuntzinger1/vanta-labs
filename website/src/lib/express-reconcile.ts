import "server-only";

import { getRequiredEnv } from "@/lib/env";
import { veyraApiBase, veyraSecretKey } from "@/lib/express-checkout-service";
import { recordSystemAlert } from "@/lib/monitoring";
import { signWebhookPayload } from "@/lib/payment-provider";
import { processPaymentWebhook } from "@/lib/payment-webhook";
import { supabaseAdmin } from "@/lib/supabase-server";

// -------------------------------------------------------------------------
// Settlement backstop for the express (Apple Pay) lane.
//
// The signed webhook is the authoritative paid signal. This is what runs when
// one is LOST — the case the express lane makes newly dangerous, because it is
// the first path where a missing webhook means a charged card sitting against
// an order that reads unpaid, with stock still only reserved.
//
// It deliberately settles by feeding a signed event through the REAL webhook
// handler rather than flipping the row itself: that way it inherits the
// paid_side_effects_at exactly-once claim, the event dedup, and every
// side-effect in one place. If the genuine webhook turns up later, its own
// event id is different but the claim has already been spent, so nothing runs
// twice.
// -------------------------------------------------------------------------

/** How long a charge may sit unsettled before we go and ask about it. */
const RECONCILE_AFTER_MS = 10 * 60 * 1000;
const RECONCILE_BATCH = 25;

interface VeyraSessionStatus {
  status?: string;
  amount_cents?: number;
}

export interface ReconcileResult {
  checked: number;
  settled: number;
}

async function fetchSessionStatus(sessionId: string): Promise<VeyraSessionStatus | null> {
  try {
    const response = await fetch(`${veyraApiBase()}/api/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${veyraSecretKey()}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as VeyraSessionStatus;
  } catch {
    return null;
  }
}

export async function reconcileVeyraPendingPayments(): Promise<ReconcileResult> {
  // Only orders that recorded a processor session id at checkout can be polled.
  // That is exactly the express lane: the card lane leaves payment_id null until
  // its own webhook fills it in, so those rows never match here.
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  const { data: orders, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, payment_id, amount_paid")
    .eq("payment_status", "pending_payment")
    .not("payment_id", "is", null)
    .lt("created_at", cutoff)
    .limit(RECONCILE_BATCH);

  if (error || !orders || orders.length === 0) {
    return { checked: 0, settled: 0 };
  }

  const secret = getRequiredEnv("PAYMENT_WEBHOOK_SECRET");
  let settled = 0;

  for (const order of orders) {
    const sessionId = String(order.payment_id ?? "");
    if (!sessionId) continue;

    const session = await fetchSessionStatus(sessionId);
    const status = String(session?.status ?? "").toLowerCase();
    // Veyra's v1 read maps a succeeded charge to "paid".
    if (status !== "paid" && status !== "succeeded") continue;

    // Carry Veyra's OWN amount when it gives us one, so the webhook's amount
    // assertion is a real cross-check rather than a tautology against the
    // number we recorded ourselves.
    const body = JSON.stringify({
      orderId: String(order.order_id),
      type: "payment.succeeded",
      paymentId: sessionId,
      ...(typeof session?.amount_cents === "number" ? { amount: session.amount_cents / 100 } : {}),
    });

    try {
      await processPaymentWebhook(
        body,
        signWebhookPayload(body, secret),
        secret,
        // Deterministic and distinct from any real delivery, so re-running the
        // sweep is a no-op rather than a second settlement attempt.
        `reconcile-${order.order_id}`,
      );
      settled += 1;
    } catch (settleError) {
      await recordSystemAlert({
        type: "express_reconcile_failed",
        severity: "critical",
        message: `A paid Apple Pay charge could not be settled from reconciliation. Order ${order.order_id} is charged but still reads unpaid.`,
        context: { order_id: order.order_id, session_id: sessionId, reason: String(settleError) },
      });
    }
  }

  return { checked: orders.length, settled };
}

/**
 * Retire armed-but-never-used wallet sessions.
 *
 * Purely hygiene — an expired intent is already refused everywhere by its
 * expires_at, and it never held stock or wrote an order. This just stops the
 * table filling with rows that read "open" forever.
 */
export async function expireStaleExpressIntents(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("express_checkout_intents")
    .update({ status: "expired" })
    .is("consumed_at", null)
    .eq("status", "open")
    .lt("expires_at", new Date().toISOString())
    .select("id");
  if (error || !data) return 0;
  return data.length;
}
