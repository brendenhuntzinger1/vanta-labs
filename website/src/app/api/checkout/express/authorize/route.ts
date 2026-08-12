import { NextResponse } from "next/server";
import {
  DEFAULT_RESERVATION_MINUTES,
  releaseInventoryForOrder,
  reserveInventoryForOrder,
  describeUnavailable,
} from "@/lib/inventory-reservation";
import {
  VEYRA_FALLBACK_SHIPPING_METHOD_ID,
  addressFingerprint,
  claimIntent,
  fingerprintFromShippingMethodId,
  loadIntentBySession,
  loadShippingQuote,
  recordIntentOutcome,
  resolveShopperIdentity,
  resolveWalletName,
  veyraApiBase,
  type WalletContact,
} from "@/lib/express-checkout-service";
import { recordSystemAlert } from "@/lib/monitoring";
import { isCheckoutOpen } from "@/lib/payment-provider";
import { buildOrderRow, insertOrderItems, insertOrderRow, quoteOrder } from "@/lib/quote-order";
import { supabaseAdmin } from "@/lib/supabase-server";
import type { CustomerInput } from "@/lib/payment-types";
import { recordOrderAttribution } from "@/lib/order-attribution";
import { customerSafeMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The ONE endpoint on the express lane that can move money.
//
// Steps 1-5 below run with the intent still UNCLAIMED, so every refusal in them
// leaves the sheet retryable — a shopper whose first tap failed validation can
// fix the cause and tap again. The claim happens immediately before the order
// write and the charge; from there on the outcome is terminal and is recorded
// on the intent so a duplicate authorize replays it instead of charging twice.

/** What actually happened at Veyra, which is not a yes/no question. */
type PayOutcome =
  | "succeeded"
  /** 409 duplicate — a REFUSAL, not a success. Veyra's cross-session guard
   *  matches (merchant, email, amount) against a prior CAPTURED charge and
   *  fires BEFORE any PaymentIntent exists, then releases its session back to
   *  `open`. Nothing was charged for THIS order; the charge it matched belongs
   *  to an earlier order that holds its own stock. */
  | "duplicate"
  /** 409 session_not_available with public_status succeeded — THIS session's
   *  own capture. The only 409 that is genuinely a success. */
  | "already_succeeded"
  /** 3DS pending. Veyra returns the hosted challenge URL with it; we hand that
   *  to the shopper so the sheet isn't a dead end. Without one the order is
   *  stranded and needs an operator. */
  | "requires_action"
  /** Veyra answered, and the answer was no. */
  | "answered_no"
  /** We never heard back. NOT a decline — the charge may well have landed. */
  | "never_heard_back";

interface AuthorizeBody {
  session_id?: string;
  basis_theory_token_intent_id?: string;
  selected_shipping_method_id?: string;
  wallet_contact?: WalletContact;
  /** Campaign evidence captured on arrival; re-validated server-side. */
  attribution?: unknown;
}

interface AuthorizeResult {
  ok: boolean;
  outcome: PayOutcome | "refused";
  orderId?: string;
  orderNumber?: string;
  totalCents?: number;
  message?: string;
  /** Hosted 3DS challenge page, on `requires_action` only. Validated https
   *  before it leaves this route — it is handed to the browser to navigate to. */
  redirectUrl?: string;
}

function refuse(message: string, status = 200) {
  return NextResponse.json({ ok: false, outcome: "refused", message } satisfies AuthorizeResult, { status });
}

export async function POST(request: Request) {
  if (!isCheckoutOpen()) {
    return refuse("Checkout is temporarily unavailable. No charge was made.", 503);
  }

  let body: AuthorizeBody;
  try {
    body = (await request.json()) as AuthorizeBody;
  } catch {
    return refuse("Invalid request.", 400);
  }

  const sessionId = String(body.session_id ?? "").trim();
  const tokenIntentId = String(body.basis_theory_token_intent_id ?? "").trim();
  const selectedShippingMethodId = String(body.selected_shipping_method_id ?? "").trim();
  const walletContact = body.wallet_contact ?? {};

  if (!sessionId || !tokenIntentId) {
    return refuse("We couldn't complete that payment. Please try again.", 400);
  }

  // ---- 5.1 Intent ---------------------------------------------------------
  const intent = await loadIntentBySession(sessionId);
  if (!intent) {
    return refuse("This checkout has expired. Please try again.", 410);
  }
  if (new Date(intent.expires_at).getTime() < Date.now() && !intent.consumed_at) {
    return refuse("This checkout has expired. Please try again.", 410);
  }
  if (intent.consumed_at && intent.outcome) {
    // A terminal result already exists for this session. Replay it; never
    // charge a second time.
    return NextResponse.json(intent.outcome as unknown as AuthorizeResult);
  }
  if (intent.consumed_at) {
    // Claimed but no recorded outcome yet — a concurrent authorize is mid-flight.
    return refuse("We're confirming your payment. Please don't try again.", 409);
  }

  // ---- 5.2 Shipping, bound to the address actually being charged ----------
  //
  // The fingerprint is recomputed from the AUTHORIZING contact and used as the
  // lookup key, so "latest quote wins" is impossible: a quote computed for a
  // different address simply isn't found. Apple fires the address handler on
  // every edit and Veyra's cache has no optimistic concurrency, so without this
  // two out-of-order commits can leave the cache holding address A's tax while
  // address B is charged.
  const fingerprint = addressFingerprint({
    country: walletContact.country,
    state: walletContact.state,
    city: walletContact.city,
    postal_code: walletContact.postal_code,
  });

  if (!selectedShippingMethodId) {
    // Not a soft case: with no method id Veyra charges the bare session amount,
    // collecting neither shipping nor tax.
    return refuse("We couldn't confirm shipping for that address. Please try again.");
  }
  if (selectedShippingMethodId === VEYRA_FALLBACK_SHIPPING_METHOD_ID) {
    // The processor's fail-open placeholder. Its presence means our own
    // shipping callback never completed, so the locked cache holds either
    // nothing or a stale address's numbers.
    return refuse("We couldn't confirm shipping for that address. Please try again.");
  }
  if (fingerprintFromShippingMethodId(selectedShippingMethodId) !== fingerprint.slice(0, 12)) {
    return refuse("Your shipping address changed. Please try again.");
  }

  const shippingQuote = await loadShippingQuote(sessionId, fingerprint);
  if (!shippingQuote) {
    return refuse("We couldn't confirm shipping for that address. Please try again.");
  }
  const lockedMethod = shippingQuote.shipping_methods.find((method) => method.id === selectedShippingMethodId);
  if (!lockedMethod) {
    return refuse("We couldn't confirm shipping for that address. Please try again.");
  }
  const lockedShippingCents = Number(lockedMethod.amount_cents ?? 0);
  const lockedTaxCents = Number(shippingQuote.tax_amount_cents ?? 0);

  // ---- 5.3 / 5.4 Re-price and validate identity ---------------------------
  //
  // Two quotes, because A and (S, T) are authored by different things:
  //
  //   • The address-INDEPENDENT amount A is re-derived exactly as session
  //     create derived it (same inputs, same email), so this is a pure
  //     anti-tamper check on the number the shopper authorized. Re-deriving it
  //     from the full quote instead would produce a false mismatch, because the
  //     card fee is charged on the address-independent base only and store
  //     credit is capped against a different running total.
  //   • S and T come from a FULL quote against the real wallet address, and
  //     must equal what the callback locked. That is the tax anti-tamper, and
  //     it is the primary one — the fingerprint check above is what makes it
  //     meaningful.
  //
  // The full quote also runs validateCustomer (email, name, address, US/CA,
  // resolvable US state) and re-validates the coupon / referral for the real
  // customer, so an ineligible order is refused before the claim.
  const name = resolveWalletName({
    billing: { firstName: walletContact.first_name, lastName: walletContact.last_name },
    shipping: { firstName: walletContact.first_name, lastName: walletContact.last_name },
    email: walletContact.email,
  });
  const fullName = (walletContact.name ?? `${name.firstName} ${name.lastName}`).trim();
  const customer: CustomerInput = {
    email: (walletContact.email ?? "").trim().toLowerCase(),
    fullName,
    address: [walletContact.address1, walletContact.address2].filter(Boolean).join(" ").trim(),
    city: (walletContact.city ?? "").trim(),
    state: (walletContact.state ?? "").trim(),
    postalCode: (walletContact.postal_code ?? "").trim(),
    country: (walletContact.country ?? "").trim(),
    phone: (walletContact.phone ?? "").trim(),
  };

  const quoteInputs = {
    items: intent.items.map((item) => ({ id: item.id, quantity: item.quantity })),
    referralCode: intent.referral_code ?? undefined,
    couponCode: intent.coupon_code ?? undefined,
    customerUserId: intent.customer_user_id ?? undefined,
    pointsToRedeem: 0,
    shippingProtection: intent.shipping_protection,
    paymentMethod: "card",
  };

  let quoteA;
  let quoteFull;
  try {
    quoteA = await quoteOrder({
      ...quoteInputs,
      customer: {
        email: intent.customer_email ?? "",
        fullName: "",
        address: "",
        city: "",
        postalCode: "",
        country: "",
      },
      mode: "address_optional",
    });
    quoteFull = await quoteOrder({ ...quoteInputs, customer, mode: "full" });
  } catch (error) {
    console.error("[checkout/express/authorize]", error);
    return refuse(customerSafeMessage(error, "We couldn't complete that payment."));
  }

  if (quoteA.addressIndependentCents !== intent.amount_cents) {
    return refuse("Your order total changed. Please try again.");
  }
  if (Math.round(quoteFull.shipping * 100) !== lockedShippingCents) {
    return refuse("Your shipping cost changed. Please try again.");
  }
  if (Math.round(quoteFull.taxAmount * 100) !== lockedTaxCents) {
    return refuse("Your sales tax changed. Please try again.");
  }

  const expectedCents = intent.amount_cents + lockedShippingCents + lockedTaxCents;

  // ---- 5.5 Shopper attribution, from this request's own headers -----------
  const { ip, userAgent } = resolveShopperIdentity(request);

  // ---- 5.6 CLAIM. Outcomes are terminal from here. -----------------------
  const claimed = await claimIntent(sessionId);
  if (!claimed) {
    return refuse("We're confirming your payment. Please don't try again.", 409);
  }

  // ---- 5.7 Order row + inventory hold ------------------------------------
  const orderRow = buildOrderRow({
    orderId: claimed.order_id,
    orderNumber: claimed.order_number,
    // The order id doubles as the idempotency key on this lane: there is
    // exactly one order per intent, and the intent claim already guarantees it.
    idempotencyKey: claimed.order_id,
    // Persisting the Veyra session id here is what makes reconciliation
    // possible at all — the cron polls Veyra by orders.payment_id, and the
    // settlement webhook matches on it.
    paymentId: sessionId,
    paymentMethod: "card",
    cardProcessingFee: quoteA.cardFee.amount,
    cardProcessingFeePercent: quoteA.cardFee.percentage,
    customer,
    // Apple's billing contact carries name + email only, so the shipping
    // address is the only address of record for this order.
    billing: { fullName: customer.fullName, address: customer.address, city: customer.city, postalCode: customer.postalCode },
    currency: claimed.currency || "USD",
    subtotal: quoteA.subtotal,
    shippingAmount: lockedShippingCents / 100,
    taxAmount: lockedTaxCents / 100,
    discountAmount: quoteA.discountAmount,
    bulkDiscountTier: quoteA.bulkDiscountTier,
    priority: quoteA.isPriorityOrder,
    amountPaid: expectedCents / 100,
    referralCode: quoteA.referral?.code ?? null,
    ambassadorId: quoteA.referral?.ambassadorId ?? null,
    couponCode: quoteA.couponCode,
    customerUserId: claimed.customer_user_id,
    pointsRedeemed: 0,
    storeCreditRedeemedCents: quoteA.storeCreditRedeemedCents,
    taxRatePercent: quoteFull.taxQuote.collected ? quoteFull.taxQuote.ratePercent : 0,
    taxState: quoteFull.taxQuote.collected ? quoteFull.taxQuote.state : null,
    // The acknowledgement evidence is NOT copied onto the order: orders has no
    // column for it, and the intent row already holds it (with the copy version
    // and the timestamp) keyed by this same order_id. One record, not two that
    // can disagree.
    extraColumns: { checkout_channel: "express_apple_pay" },
  });

  const insertOutcome = await insertOrderRow(orderRow);
  if (insertOutcome.status !== "inserted") {
    await finish(sessionId, { ok: false, outcome: "refused", message: "We couldn't create your order. No charge was made." }, "failed");
    return refuse("We couldn't create your order. No charge was made.");
  }

  const { payload: orderItemsPayload, error: itemError } = await insertOrderItems(
    claimed.order_id,
    quoteA.lineItems,
    quoteA.unitCostCentsForLine,
  );
  if (itemError) {
    await cancelOrder(claimed.order_id);
    await finish(sessionId, { ok: false, outcome: "refused", message: "We couldn't create your order. No charge was made." }, "failed");
    return refuse("We couldn't create your order. No charge was made.");
  }

  const reservation = await reserveInventoryForOrder(
    claimed.order_id,
    orderItemsPayload.map((item) => ({ productId: item.product_id, quantity: item.quantity })),
    { expiresInMinutes: DEFAULT_RESERVATION_MINUTES },
  );
  // Order is committed and past every guard that could still cancel it, so
  // this is the first safe point to link it to its campaign. Cannot throw.
  await recordOrderAttribution({ orderId: claimed.order_id, raw: body.attribution });

  if (!reservation.ok) {
    await cancelOrder(claimed.order_id);
    // Same detail as the standard checkout, plus the reassurance that matters
    // most in a wallet sheet: no money moved.
    const message = `${describeUnavailable(reservation.unavailable)} No charge was made.`;
    await finish(sessionId, { ok: false, outcome: "refused", message }, "failed");
    return refuse(message);
  }

  // ---- 5.8 Charge ---------------------------------------------------------
  const { outcome, redirectUrl } = await chargeViaVeyra({
    sessionId,
    tokenIntentId,
    orderId: claimed.order_id,
    customer,
    walletContact,
    selectedShippingMethodId,
    lockedShippingCents,
    lockedTaxCents,
    ip,
    userAgent,
  });

  // ---- 5.9 Record ---------------------------------------------------------
  //
  // The order is NEVER marked paid here. The signed webhook is the authoritative
  // paid signal; the reconciliation cron is the backstop when it is lost.
  if (outcome === "answered_no") {
    // Veyra answered, and the answer was no. This is the ONLY branch that
    // releases inventory: on any other failure the charge may have landed, and
    // releasing stock we may have already sold produces an oversell on top of a
    // mis-signalled decline.
    await supabaseAdmin
      .from("orders")
      .update({ payment_status: "payment_failed", updated_at: new Date().toISOString() })
      .eq("order_id", claimed.order_id);
    await releaseInventoryForOrder(claimed.order_id);
    const result: AuthorizeResult = {
      ok: false,
      outcome,
      message: "Your bank declined that payment. Please try another card.",
    };
    await finish(sessionId, result, "failed");
    return NextResponse.json(result);
  }

  if (outcome === "duplicate") {
    // A REFUSAL, not a success. Veyra's duplicate guard runs before any
    // PaymentIntent exists and releases its session back to `open`, so no
    // money moved for this order — its own 409 body says so ("Your card has
    // not been charged again"). The charge it matched belongs to an EARLIER
    // order, which is holding its own reservation.
    //
    // So this row is a phantom: cancel it and hand the stock back, or it sits
    // at pending_payment forever with inventory reserved against no money,
    // being polled by a reconciliation cron that can never settle it. This is
    // safe in a way the `never_heard_back` release would not be — there, the
    // charge may have landed; here Veyra told us it explicitly did not.
    await cancelOrder(claimed.order_id);
    await releaseInventoryForOrder(claimed.order_id);
    await recordSystemAlert({
      type: "express_duplicate_refused",
      severity: "warning",
      message: `Apple Pay order ${claimed.order_number} was refused as a duplicate of a charge placed moments earlier, so it was never charged and has been canceled. Confirm the earlier order settled — a duplicate refusal usually means the shopper never saw its confirmation.`,
      context: { order_id: claimed.order_id, session_id: sessionId, outcome },
    });
    const result: AuthorizeResult = {
      ok: false,
      outcome,
      message:
        "This looks like a repeat of an order you just placed, so we didn't charge you again. Check your email for that confirmation before trying again.",
    };
    await finish(sessionId, result, "failed");
    return NextResponse.json(result);
  }

  if (outcome === "requires_action" || outcome === "never_heard_back") {
    // Money may well have moved. Leave the order pending, keep the hold, and
    // let the webhook or the reconciliation cron settle it.
    //
    // `requires_action` WITH a hosted challenge URL is the one case here that
    // has a shopper-side path: the sheet closes and we send them to Veyra's
    // hosted 3DS page, which finishes the charge and fires the webhook. Only
    // an action-required charge with nowhere to send them is a true dead end.
    const stranded = outcome === "never_heard_back" || !redirectUrl;
    await recordSystemAlert({
      type: "express_charge_unresolved",
      severity: stranded ? "critical" : "warning",
      message: stranded
        ? `An Apple Pay charge did not resolve (${outcome}). Order ${claimed.order_number} is pending and may or may not be paid — reconcile it against Veyra before refunding or re-charging.`
        : `Apple Pay order ${claimed.order_number} needs 3DS. The shopper was sent to the hosted challenge; it settles by webhook if they complete it, and stays pending if they abandon it.`,
      context: { order_id: claimed.order_id, session_id: sessionId, outcome, has_redirect: Boolean(redirectUrl) },
    });
    const result: AuthorizeResult = {
      ok: false,
      outcome,
      orderId: claimed.order_id,
      orderNumber: claimed.order_number,
      totalCents: expectedCents,
      ...(redirectUrl ? { redirectUrl } : {}),
      message: redirectUrl
        ? "Your bank needs to verify this payment. We're taking you there now."
        : "We're confirming your payment. Do not try again — you'll get an email once it's confirmed.",
    };
    await finish(sessionId, result, "consumed");
    return NextResponse.json(result);
  }

  const result: AuthorizeResult = {
    ok: true,
    outcome,
    orderId: claimed.order_id,
    orderNumber: claimed.order_number,
    totalCents: expectedCents,
  };
  await finish(sessionId, result, "consumed");
  return NextResponse.json(result);
}

async function finish(sessionId: string, result: AuthorizeResult, status: "consumed" | "failed") {
  await recordIntentOutcome(sessionId, result as unknown as Record<string, unknown>, status);
}

async function cancelOrder(orderId: string) {
  await supabaseAdmin
    .from("orders")
    .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
    .eq("order_id", orderId);
}

async function chargeViaVeyra(input: {
  sessionId: string;
  tokenIntentId: string;
  orderId: string;
  customer: CustomerInput;
  walletContact: WalletContact;
  selectedShippingMethodId: string;
  lockedShippingCents: number;
  lockedTaxCents: number;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ outcome: PayOutcome; redirectUrl: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${veyraApiBase()}/api/checkout/${encodeURIComponent(input.sessionId)}/pay-bt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Forward the SHOPPER's address and agent, not this function's egress.
        // These feed velocity rules, the IP blacklist and the card-testing lock
        // on Veyra's side; presenting our own infrastructure IP would arm those
        // rules against every one of our customers at once.
        ...(input.ip ? { "x-forwarded-for": input.ip, "x-real-ip": input.ip } : {}),
        ...(input.userAgent ? { "user-agent": input.userAgent } : {}),
      },
      body: JSON.stringify({
        basis_theory_token_intent_id: input.tokenIntentId,
        wallet_type: "apple_pay",
        card_summary: {},
        // Veyra derives its own Stripe idempotency key and ignores this one; it
        // is sent because it lands on the attempt row and is useful in support.
        // It is NOT a double-charge guard — those are Veyra's atomic session
        // claim, our intent claim, and the client's in-flight refs.
        idempotency_key: `vanta-x-${input.orderId}`,
        customer_name: input.customer.fullName || undefined,
        customer_email: input.customer.email || undefined,
        wallet_contact: {
          name: input.customer.fullName || null,
          email: input.customer.email || null,
          phone: input.customer.phone || null,
          address1: input.walletContact.address1 ?? null,
          address2: input.walletContact.address2 ?? null,
          city: input.customer.city || null,
          state: input.customer.state || null,
          zip: input.customer.postalCode || null,
          country: input.customer.country || null,
        },
        // A real tripwire: Veyra compares this against the method it locked and
        // 409s on any disagreement.
        selected_shipping_method_id: input.selectedShippingMethodId,
        selected_shipping_amount_cents: input.lockedShippingCents,
        // NOT a tripwire — Veyra ignores it and re-reads its own locked tax.
        // Sent as a log artifact only; never reason about it as a guard.
        tax_amount_cents: input.lockedTaxCents,
      }),
    });
  } catch {
    // Never retry this POST. Veyra's Stripe idempotency key is derived from the
    // session's processing timestamp, which changes whenever the session is
    // released back to open — so a "retry" is a genuinely new key and a second
    // charge. The cron polls the session instead.
    return { outcome: "never_heard_back", redirectUrl: null };
  }

  let payload: { public_status?: string; error?: string; redirect_url?: unknown } | null = null;
  try {
    payload = (await response.json()) as { public_status?: string; error?: string; redirect_url?: unknown };
  } catch {
    payload = null;
  }

  if (!payload) {
    return { outcome: "never_heard_back", redirectUrl: null };
  }

  if (response.ok && payload.public_status === "succeeded") {
    return { outcome: "succeeded", redirectUrl: null };
  }
  if (response.status === 409 && payload.public_status === "duplicate") {
    return { outcome: "duplicate", redirectUrl: null };
  }
  if (response.status === 409 && payload.public_status === "succeeded" && payload.error === "session_not_available") {
    return { outcome: "already_succeeded", redirectUrl: null };
  }
  if (payload.public_status === "requires_action") {
    // The hosted challenge page. Validated here, not in the browser: this URL
    // is navigated to, so a non-https value from anywhere upstream must never
    // reach the client.
    return { outcome: "requires_action", redirectUrl: safeHttpsUrl(payload.redirect_url) };
  }
  if (
    payload.public_status === "failed" ||
    payload.public_status === "blocked" ||
    // Genuine client errors only. `answered_no` is the ONE branch that releases
    // inventory and tells the shopper they were declined, so nothing may land
    // in it by default — an unenumerated public_status, or a 2xx body shape we
    // don't recognise, must fall through to `never_heard_back` and be
    // reconciled against the processor instead of guessed at.
    (response.status >= 400 && response.status < 500)
  ) {
    return { outcome: "answered_no", redirectUrl: null };
  }
  // Anything else — a 5xx, or a 2xx/3xx whose body we could parse but can't
  // interpret: unresolved, not declined.
  return { outcome: "never_heard_back", redirectUrl: null };
}

/** A URL we are willing to navigate a browser to. Anything else becomes null. */
function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
