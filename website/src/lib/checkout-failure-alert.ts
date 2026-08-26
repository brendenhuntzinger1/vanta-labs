import "server-only";

import { createHash } from "crypto";

import { recordSystemAlert } from "@/lib/monitoring";
import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// Notice when ONE shopper keeps failing to check out.
//
// On 2026-08-26 one shopper created three orders in sixteen minutes and paid
// for none. Nothing noticed: nothing errored, no processor event arrived, and
// no rule existed to spot the pattern. They were found days later by hand.
//
// WHAT IS COUNTED, AND WHY IT IS NOT "FAILED PAYMENTS". Counting payment_failed
// rows would not have caught that incident — those attempts produced no payment
// event at all. The signal that genuinely existed was orders created and left
// unpaid, so that is what this counts. It covers a declined card and a silent
// abandonment equally, which is the point: from the store's side those look
// identical, and both are worth knowing about while the shopper is still there.
//
// This is a WARNING, not a critical. Three unpaid orders is a strong hint and
// not proof of a fault — a shopper may simply have changed their mind three
// times. It is worth a look, not a page at 2am.
// ---------------------------------------------------------------------------

/** How far back to count this shopper's unpaid orders. */
const WINDOW_MS = 60 * 60 * 1000;
/** Unpaid orders inside the window before it is worth saying anything. Two is a retry; three is a pattern. */
const ATTEMPT_THRESHOLD = 3;
/** How long the alert stays quiet after firing, so one stuck shopper cannot flood the channel. */
const THROTTLE_MS = 6 * 60 * 60 * 1000;
const ALERT_TYPE = "checkout_repeated_failure";

/**
 * A stable, non-reversible handle for one shopper.
 *
 * The alert must be correlatable across firings without carrying the shopper's
 * email into a third-party monitoring system. Twelve hex characters is enough to
 * tell two shoppers apart in an alert feed and short enough to read.
 *
 * Normalised first, or "A@x " and "a@x" look like two different people and
 * neither ever reaches the threshold.
 */
export function shopperKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12);
}

/** Has this alert been quiet long enough to fire again? Fails OPEN. */
async function throttleAllows(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("system_alerts")
      .select("created_at")
      .eq("type", ALERT_TYPE)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return true;
    const last = Date.parse(String((data[0] as { created_at?: string }).created_at ?? ""));
    if (!Number.isFinite(last)) return true;
    return Date.now() - last > THROTTLE_MS;
  } catch {
    // A throttle must never be the reason a real warning goes unsent.
    return true;
  }
}

/**
 * Count this shopper's recent unpaid orders and, past the threshold, say so.
 *
 * NEVER THROWS and never blocks anything. It runs immediately after an order
 * row is written, on the path where the shopper is waiting to be sent to the
 * card form; a monitoring nicety must not be able to cost someone a checkout.
 */
export async function reportRepeatedCheckoutFailure(email: string): Promise<void> {
  try {
    const normalized = String(email ?? "").trim().toLowerCase();
    if (!normalized) return;

    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_number, created_at")
      .eq("payment_status", "pending_payment")
      .eq("customer_email", normalized)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error || !data) return;
    const attempts = data.length;
    if (attempts < ATTEMPT_THRESHOLD) return;
    if (!(await throttleAllows())) return;

    // Order numbers only. No email, no name, no address, and nothing about the
    // card ever reaches this function in the first place.
    const orderNumbers = (data as Array<{ order_number?: string | null }>)
      .map((row) => row.order_number)
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .slice(0, 10);

    await recordSystemAlert({
      type: ALERT_TYPE,
      severity: "warning",
      message: `One shopper has left ${attempts} orders unpaid within the hour. That is either a card being repeatedly declined or checkout failing for them; from the store's side those look the same. Worth checking while they are still on the site.`,
      context: {
        shopper: shopperKey(normalized),
        attempts,
        windowMinutes: Math.round(WINDOW_MS / 60000),
        orderNumbers,
      },
    });
  } catch {
    // Best effort by design — see the doc comment.
  }
}
