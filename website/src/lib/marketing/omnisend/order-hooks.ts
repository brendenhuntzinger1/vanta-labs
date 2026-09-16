import "server-only";

import { isProductPurchaseOrder } from "@/lib/ledger";
import { omnisendActive } from "@/lib/marketing/omnisend/client";
import { findLiveContactCode, retireContactCode, type ContactCode, type ContactCodeKind } from "@/lib/marketing/omnisend/codes";
import { upsertOmnisendContact, type ContactExtras } from "@/lib/marketing/omnisend/contacts";
import {
  buildOrderEvent,
  sendOmnisendEvent,
  transientOmnisendRefusal,
  type OmnisendOrder,
  type OmnisendOrderEventName,
} from "@/lib/marketing/omnisend/events";
import { omnisendLedger } from "@/lib/marketing/omnisend/ledger";
import { OMNISEND_LINK_TTL_MS, signOmnisendLink } from "@/lib/marketing/omnisend/link-token";
import { loadOrderForOmnisend } from "@/lib/marketing/omnisend/orders";
import { siteUrl } from "@/lib/site-identity";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The order-shaped Omnisend hooks (design spec §4, "Order paid", "Shipped /
 * delivered", "Cancelled", "Refunded").
 *
 * Every export here is called from a place that has already done the real
 * work — the paid side-effects block of the payment webhook, the manual
 * approval lane, the Shippo tracking handler, the admin cancel and refund
 * actions, the backstop sweep — so the contract is the one the ad legs keep:
 *
 *   * the gate is asked FIRST, before any database read, so a preview
 *     deployment or a build without a key returns having touched nothing;
 *   * every body is inside try/catch and logs under `[omnisend/orders]`;
 *   * nothing here ever throws. An order, a webhook ack and an admin action
 *     may not fail over a marketing sync.
 *
 * EXACTLY ONCE PER (ORDER, EVENT). The ledger claim is an INSERT taken before
 * the send, so the webhook's after() callback and the sweep cannot both
 * report the same order; the loser sees a duplicate key and sends nothing. A
 * send that never happened hands its claim back, so the sweep can retry. A
 * send Omnisend refused is one of two things: a TRANSIENT refusal (a
 * transport failure, a rate limit, a gateway error — transientOmnisendRefusal
 * in events.ts) also hands the claim back, because only paid-order claims
 * are ever released by the sweep and a fulfilment, cancel or refund notice
 * that was refused once would otherwise never be retried; a PERMANENT one is
 * recorded undelivered, and for a paid order the sweep retries that too once
 * the attempt is old enough to be dead (sweeps.ts).
 *
 * Consent, cart, checkout and product-view hooks live in hooks.ts. This file
 * is only the order lifecycle.
 */

const LOG = "[omnisend/orders]";

/**
 * The per-contact link builder handed to the order loader (spec §3.3): every
 * productURL on a line item carries the contact's own signed token, so the
 * click lands past the account wall on the product page rather than on the
 * sign-in page. The token is minted here rather than read back from the
 * contact record because the event may be the first thing Omnisend ever
 * hears about this address. When no secret is configured the token is empty
 * and the route sends the click to sign-in, which is what every link did
 * before this module existed.
 */
function linkFor(email: string): (path: string) => Promise<string> {
  return async (path: string) => {
    const token = (await signOmnisendLink(email)) ?? "";
    return `${siteUrl()}/api/email/omnisend-link?t=${token}&to=${encodeURIComponent(path)}&utm_source=omnisend&utm_medium=email&utm_campaign=order`;
  };
}

/**
 * The address on the row, lowercased. The loader needs the link builder, and
 * the link builder needs the address, so it is read once ahead of the load.
 */
async function readCustomerEmail(orderId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("orders").select("customer_email").eq("order_id", orderId).maybeSingle();
  if (error) {
    console.error(LOG, "customer email read refused", orderId, error.message);
    return null;
  }
  const email = String((data as { customer_email?: string | null } | null)?.customer_email ?? "").trim().toLowerCase();
  return email || null;
}

async function loadOrder(orderId: string): Promise<OmnisendOrder | null> {
  const email = await readCustomerEmail(orderId);
  if (!email) return null;
  return loadOrderForOmnisend(orderId, linkFor(email));
}

/**
 * Has Omnisend been told about this order at all?
 *
 * A cancel or a refund of an order Omnisend never received — one that was
 * never paid, or one paid before this integration existed — would put a
 * contact into a cancellation flow for a purchase Omnisend has no record of.
 * The ledger is the record of what was delivered, so it is the thing asked.
 * Fails OPEN on a ledger error, in the same direction as the claim: a lost
 * event costs a flow, a spurious one costs nothing Omnisend cannot ignore.
 */
async function knownToOmnisend(orderId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("omnisend_events_sent")
      .select("entity_id")
      .eq("entity_id", orderId)
      .in("event_name", ["placed order", "paid for order"])
      .eq("delivered", true)
      .limit(1);
    if (error) return true;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

/**
 * Send one order event behind the ledger claim. True when Omnisend accepted
 * it. Never throws.
 */
async function deliverOrderEvent(orderId: string, name: OmnisendOrderEventName, order?: OmnisendOrder | null): Promise<boolean> {
  const ledger = omnisendLedger(orderId);
  const eventId = `${orderId}:${name}`;
  if (!(await ledger.claimSend(name, eventId))) return false;

  try {
    const loaded = order ?? (await loadOrder(orderId));
    const event = loaded ? buildOrderEvent({ name, order: loaded }) : null;
    if (!event) {
      // Nothing to send: the row could not be read, has no address, or is not
      // a sale. The claim goes back so the backstop can ask again once the
      // row is readable; a non-sale is filtered before it ever gets here.
      await ledger.releaseSend(name);
      return false;
    }
    const result = await sendOmnisendEvent(event);
    if (result.ok) {
      await ledger.recordSend(name, event.eventID, true, null);
      return true;
    }
    console.error(LOG, name, "refused", orderId, { status: result.status, error: result.error });
    if (transientOmnisendRefusal(result.status)) {
      // The refusal may not recur: the claim goes back so a later legitimate
      // notice, or the backstop for a paid order, can try again.
      await ledger.releaseSend(name);
    } else {
      // The request's own fault: kept, recorded undelivered, so the same
      // notice is not re-sent to be refused the same way.
      await ledger.recordSend(name, event.eventID, false, result.error);
    }
    return false;
  } catch (error) {
    // The send never happened, so the claim must not outlive it.
    await ledger.releaseSend(name);
    console.error(LOG, name, "threw", orderId, error);
    return false;
  }
}

/**
 * Send one order event once. Pass the loaded order when the caller already
 * has it, so the two paid-lane events share one read.
 */
export async function sendOrderEventOnce(
  orderId: string,
  name: OmnisendOrderEventName,
  order?: OmnisendOrder | null,
): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    await deliverOrderEvent(orderId, name, order);
  } catch (error) {
    console.error(LOG, "sendOrderEventOnce failed", orderId, name, error);
  }
}

/** The live codes this address holds, read (never minted) so the upsert reports what is real. */
async function liveCodes(email: string): Promise<ContactExtras["codes"]> {
  const kinds: ContactCodeKind[] = ["welcome", "winback", "recovery"];
  const found = await Promise.all(kinds.map((kind) => findLiveContactCode(kind, email)));
  const codes: Partial<Record<ContactCodeKind, ContactCode>> = {};
  kinds.forEach((kind, index) => {
    const code = found[index];
    if (code) codes[kind] = code;
  });
  return codes;
}

/**
 * Order paid: the contact upsert (which recomputes the tags, so `customer`
 * is added) followed by `placed order` and `paid for order`.
 *
 * Returns whether `paid for order` was DELIVERED on this call, which is what
 * the backstop sweep counts; the two request-path callers ignore it. A
 * membership charge or a replacement reship is not a purchase and produces
 * nothing (isProductPurchaseOrder, the same rule every ledger applies).
 */
export async function onOrderPaid(orderId: string): Promise<boolean> {
  if (!omnisendActive().active) return false;
  try {
    const order = await loadOrder(orderId);
    if (!order) return false;
    if (!isProductPurchaseOrder({ order_type: order.orderType, replacement_of: order.replacementOf })) return false;

    const email = order.email;
    // A FIRST ORDER ENDS THE WELCOME CODE. It is a first-order discount (spec
    // §3.4), and this is the first moment the store knows the first order
    // happened, so it is retired BEFORE the live codes are read: the push
    // below, the one that adds the `customer` tag, must not carry it. A code
    // this order redeemed is already spent and is left as the record of that.
    await retireContactCode("welcome", email);
    const [token, codes] = await Promise.all([signOmnisendLink(email), liveCodes(email)]);
    const link = token ? { token, endsAt: new Date(Date.now() + OMNISEND_LINK_TTL_MS).toISOString() } : null;
    // The upsert is not gated on the event ledger: a customer's order count
    // and tags must reflect the row even when the events were already sent.
    // A first order ends the welcome offer whether or not the vial was
    // claimed: the paid path has already closed the offer row
    // (customer_offer_close_cycle), and null clears the five properties so
    // the welcome-offer flow's card cannot outlive the offer.
    await upsertOmnisendContact(email, { link, codes, welcomeGift: null });

    await deliverOrderEvent(orderId, "placed order", order);
    return await deliverOrderEvent(orderId, "paid for order", order);
  } catch (error) {
    console.error(LOG, "onOrderPaid failed", orderId, error);
    return false;
  }
}

/** Shipped: `order fulfilled`, once per order; the tracking rides on the row. */
export async function onOrderFulfilled(orderId: string): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    if (!(await knownToOmnisend(orderId))) return;
    await deliverOrderEvent(orderId, "order fulfilled");
  } catch (error) {
    console.error(LOG, "onOrderFulfilled failed", orderId, error);
  }
}

/** Cancelled: `order canceled`, only for an order Omnisend was told about. */
export async function onOrderCancelled(orderId: string): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    if (!(await knownToOmnisend(orderId))) return;
    await deliverOrderEvent(orderId, "order canceled");
  } catch (error) {
    console.error(LOG, "onOrderCancelled failed", orderId, error);
  }
}

/** Fully refunded: `order refunded`, only for an order Omnisend was told about. */
export async function onOrderRefunded(orderId: string): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    if (!(await knownToOmnisend(orderId))) return;
    await deliverOrderEvent(orderId, "order refunded");
  } catch (error) {
    console.error(LOG, "onOrderRefunded failed", orderId, error);
  }
}
