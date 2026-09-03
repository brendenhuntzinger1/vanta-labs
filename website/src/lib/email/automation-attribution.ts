import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { decodeAutomationCookie } from "@/lib/email/automation-links";
import { isAutomationKey } from "@/lib/email/automations";

/**
 * Credit an order to the retention automation whose link brought the customer
 * here.
 *
 * The twin of attributeOrderToCampaign, and it inherits that function's two
 * non-negotiables:
 *
 *   IT CAN NEVER THROW. It runs after the order exists and, in the express
 *   lane, after it is already paid. A reporting gap is recoverable; an
 *   exception thrown into the checkout controller is a customer who was charged
 *   and told the order failed.
 *
 *   IT IS WRITTEN ONCE. `attributed_automation_key` is only set while it is
 *   null, so a second call for the same order cannot move revenue from one
 *   automation to another after the fact.
 *
 * The cookie is more trustworthy than an ad-attribution payload — our own
 * click route wrote it after verifying an HMAC, rather than the browser
 * supplying it — and it is still re-validated here: the window is re-checked
 * against the clock, and the key must be a real automation. A hand-edited
 * cookie should credit nothing, not credit an arbitrary string.
 *
 * Deliberately INDEPENDENT of campaign attribution rather than exclusive with
 * it. An order can genuinely follow both a campaign click and an automation
 * click; the two columns answer two different questions and neither should
 * silently suppress the other. Anyone summing across both surfaces for a single
 * "email revenue" figure has to de-duplicate, and that is the honest shape of
 * the data rather than a number that hides the overlap.
 */
export async function attributeOrderToAutomation(input: {
  orderId: string;
  cookieValue: string | null | undefined;
  now?: number;
}): Promise<{ attributed: boolean; automationKey?: string; reason?: string }> {
  try {
    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) return { attributed: false, reason: "missing_order_id" };

    const decoded = decodeAutomationCookie(input.cookieValue, input.now ?? Date.now());
    if (!decoded) return { attributed: false, reason: "no_click" };

    // No database round trip to prove the automation exists: the set of keys is
    // a compile-time constant, so this is both stricter and cheaper than the
    // campaign version's row lookup.
    if (!isAutomationKey(decoded.automationKey)) {
      return { attributed: false, reason: "unknown_automation" };
    }

    const { error } = await supabaseAdmin
      .from("orders")
      .update({
        attributed_automation_key: decoded.automationKey,
        attributed_automation_at: new Date(input.now ?? Date.now()).toISOString(),
      })
      .eq("order_id", orderId)
      .is("attributed_automation_key", null);

    if (error) {
      console.error("Automation attribution: unable to stamp order", orderId, error.message);
      return { attributed: false, reason: "write_failed" };
    }

    return { attributed: true, automationKey: decoded.automationKey };
  } catch (error) {
    console.error("Automation attribution: unexpected failure", error);
    return { attributed: false, reason: "exception" };
  }
}
