import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { decodeAttributionCookie } from "@/lib/email/campaign-links";

/**
 * Credit an order to the campaign whose link brought the customer here.
 *
 * Runs AFTER the order exists and can never throw, for the same reason the ad
 * attribution module can't: the order is already committed and, in the express
 * lane, already paid. A reporting gap is recoverable; an exception thrown into
 * the checkout controller is a customer who was charged and told the order
 * failed.
 *
 * The cookie is trustworthy in a way the ad-attribution payload is not — it was
 * written by our own click route after verifying an HMAC, not supplied by the
 * browser as JSON — but it is still re-validated here: the window is re-checked
 * against the clock, and the campaign must actually exist. A cookie a customer
 * hand-edits should credit nothing, not credit an arbitrary uuid.
 *
 * WRITTEN ONCE. `attributed_campaign_id` is only set when it is currently null,
 * so a second call for the same order cannot move revenue from one campaign to
 * another after the fact.
 */
export async function attributeOrderToCampaign(input: {
  orderId: string;
  cookieValue: string | null | undefined;
  now?: number;
}): Promise<{ attributed: boolean; campaignId?: string; reason?: string }> {
  try {
    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) return { attributed: false, reason: "missing_order_id" };

    const decoded = decodeAttributionCookie(input.cookieValue, input.now ?? Date.now());
    if (!decoded) return { attributed: false, reason: "no_click" };

    const { data: campaign } = await supabaseAdmin
      .from("email_campaigns")
      .select("id")
      .eq("id", decoded.campaignId)
      .maybeSingle();
    if (!campaign) return { attributed: false, reason: "unknown_campaign" };

    const { error } = await supabaseAdmin
      .from("orders")
      .update({
        attributed_campaign_id: decoded.campaignId,
        attributed_at: new Date(input.now ?? Date.now()).toISOString(),
      })
      .eq("order_id", orderId)
      .is("attributed_campaign_id", null);

    if (error) {
      console.error("Campaign attribution: unable to stamp order", orderId, error.message);
      return { attributed: false, reason: "write_failed" };
    }

    return { attributed: true, campaignId: decoded.campaignId };
  } catch (error) {
    console.error("Campaign attribution: unexpected failure", error);
    return { attributed: false, reason: "exception" };
  }
}
