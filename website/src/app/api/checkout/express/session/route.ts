import { createHmac, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getSalesTaxSettings } from "@/lib/admin-control";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getSiteUrl } from "@/lib/env";
import { EXPRESS_CHECKOUT_ENABLED } from "@/lib/express-checkout";
import {
  COMPLIANCE_COPY_VERSION,
  EXPRESS_SESSION_MINUTES,
  MAX_TAX_AMOUNT_CENTS,
  MIN_SESSION_AMOUNT_CENTS,
  hasAllAcknowledgements,
  resolveShopperIdentity,
  shippingCallbackToken,
  veyraApiBase,
  veyraSecretKey,
} from "@/lib/express-checkout-service";
import { isCheckoutOpen } from "@/lib/payment-provider";
import { generateOrderNumber } from "@/lib/payment-service";
import { quoteOrder } from "@/lib/quote-order";
import { checkRateLimit } from "@/lib/rate-limit";
import { US_STATE_TAX_TABLE } from "@/lib/sales-tax";
import { supabaseAdmin } from "@/lib/supabase-server";
import type { CartItemInput } from "@/lib/payment-types";
import { customerSafeMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

// Arms the Apple Pay sheet.
//
// Runs ONLY after the shopper has both required confirmations ticked, so
// this is not one session per drawer open — the compliance gate doubles as the
// session-mint gate, at zero UX cost (the button is disabled until then
// anyway). No orders row and no inventory hold is created here: at this point
// there is no address, and holding stock for every armed sheet is unacceptable.
// Both happen at authorize, when the address is real and the amount has been
// verified against two independent caches.
//
// Every refusal returns HTTP 200 with `available: false` so the client hides
// the button rather than rendering a dead one. "Proceed to checkout" is
// untouched by any of it.

interface ExpressSessionBody {
  items?: CartItemInput[];
  referralCode?: string;
  couponCode?: string;
  shippingProtection?: boolean;
  acknowledgements?: unknown;
}

function unavailable(reason: string) {
  return NextResponse.json({ available: false, reason });
}

// The largest tax this cart could possibly attract in any state we collect in.
//
// Veyra discards the ENTIRE rates response — shipping included — when tax
// exceeds its own cap, and reports it as a schema failure, which surfaces to
// the shopper as an unexplained decline mid-sheet. Gate it before the button
// renders instead.
async function worstCaseTaxCents(taxableBase: number): Promise<number> {
  const settings = await getSalesTaxSettings();
  let worstRate = 0;
  for (const state of settings.nexusStates) {
    const rate = settings.rateOverrides[state] ?? US_STATE_TAX_TABLE[state]?.ratePercent ?? 0;
    if (rate > worstRate) worstRate = rate;
  }
  return Math.round(taxableBase * 100 * (worstRate / 100));
}

export async function POST(request: Request) {
  if (!EXPRESS_CHECKOUT_ENABLED) {
    return unavailable("Express checkout is not enabled.");
  }

  // Same hard gate the card lane has: never arm a payment sheet the store
  // can't actually charge.
  if (!isCheckoutOpen()) {
    return NextResponse.json(
      { available: false, reason: "Checkout is opening soon. No charge was made and no order was placed." },
      { status: 503 },
    );
  }

  const { ip, userAgent } = resolveShopperIdentity(request);
  const rateLimit = await checkRateLimit(`express-session:${ip ?? "unknown"}`, 12, 60);
  if (!rateLimit.allowed) {
    const res = NextResponse.json(
      { available: false, reason: "Too many attempts. Please wait a moment and try again." },
      { status: 429 },
    );
    res.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return res;
  }

  let body: ExpressSessionBody;
  try {
    body = (await request.json()) as ExpressSessionBody;
  } catch {
    return NextResponse.json({ available: false, reason: "Invalid request." }, { status: 400 });
  }

  if (!hasAllAcknowledgements(body.acknowledgements)) {
    return NextResponse.json(
      { available: false, reason: "Required research and legal acknowledgements must be accepted." },
      { status: 400 },
    );
  }

  const authenticatedUser = await getAuthenticatedUser();
  const isCustomer = Boolean(authenticatedUser) && detectRoleFromUser(authenticatedUser!) === "customer";
  const customerUserId = isCustomer ? authenticatedUser!.id : undefined;
  // A guest's email is not known until Apple hands over the billing contact, so
  // per-email coupon limits can only be enforced at authorize. That is fine:
  // authorize re-quotes with the real email and refuses on any disagreement.
  const customerEmail = isCustomer ? (authenticatedUser!.email ?? "").trim().toLowerCase() : "";

  // Price the cart with no address. Any pricing refusal (referral minimum,
  // coupon/referral conflict, profit floor, out of stock, empty cart) hides the
  // button — fail closed BEFORE the sheet rather than mid-authorization.
  let quote;
  try {
    quote = await quoteOrder({
      items: body.items ?? [],
      customer: {
        email: customerEmail,
        fullName: "",
        address: "",
        city: "",
        postalCode: "",
        country: "",
      },
      referralCode: body.referralCode,
      couponCode: body.couponCode,
      customerUserId,
      // Points are user-entered at the full checkout; the express lane never
      // redeems them (there is nowhere in an Apple sheet to choose an amount).
      pointsToRedeem: 0,
      shippingProtection: Boolean(body.shippingProtection),
      paymentMethod: "card",
      mode: "address_optional",
    });
  } catch (error) {
    console.error("[checkout/express/session]", error);
    return unavailable(customerSafeMessage(error, "This order can't use express checkout."));
  }

  // `A` — the address-independent amount the sheet opens on. Shipping and tax
  // are $0 inside it by construction; the charge is A + locked S + locked T.
  const amountCents = quote.addressIndependentCents;

  if (amountCents < MIN_SESSION_AMOUNT_CENTS) {
    return unavailable("This order total is below the minimum for express checkout.");
  }

  const taxableBase = Math.max(0, quote.subtotal - quote.discountAmount);
  if ((await worstCaseTaxCents(taxableBase)) >= MAX_TAX_AMOUNT_CENTS) {
    return unavailable("This order is too large for express checkout.");
  }

  // Pre-allocate the order identity and hand it to Veyra as session metadata,
  // so the settlement webhook can find the order even though no orders row
  // exists yet. There is no PATCH on Veyra's v1 session surface — the id has to
  // be decided now or never.
  const orderId = `order-${randomUUID()}`;
  const orderNumber = generateOrderNumber();
  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + EXPRESS_SESSION_MINUTES * 60_000).toISOString();

  const { error: intentError } = await supabaseAdmin.from("express_checkout_intents").insert({
    id: intentId,
    order_id: orderId,
    order_number: orderNumber,
    customer_user_id: customerUserId ?? null,
    customer_email: customerEmail || null,
    // Frozen snapshot. Authorization re-prices from THESE ids and quantities,
    // never from the live cart, so mutating the cart while the sheet is open
    // cannot change what is charged.
    items: quote.lineItems.map((line) => ({
      id: line.product.id,
      quantity: line.quantity,
      unitPrice: line.product.price,
    })),
    referral_code: quote.referral?.code ?? null,
    coupon_code: quote.couponCode,
    points_to_redeem: 0,
    shipping_protection: Boolean(body.shippingProtection),
    store_credit_cents: quote.storeCreditRedeemedCents,
    amount_cents: amountCents,
    currency: "USD",
    compliance_ack: body.acknowledgements as unknown as Record<string, unknown>,
    compliance_acked_at: new Date().toISOString(),
    compliance_copy_version: COMPLIANCE_COPY_VERSION,
    client_ip: ip,
    user_agent: userAgent,
    status: "open",
    expires_at: expiresAt,
  });
  if (intentError) {
    console.error("Unable to record express checkout intent", intentError);
    return unavailable("Express checkout is unavailable right now.");
  }

  const siteUrl = getSiteUrl();
  const secretKey = veyraSecretKey();
  let sessionId: string;
  try {
    const response = await fetch(`${veyraApiBase()}/api/v1/checkout_sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secretKey}`,
        "Idempotency-Key": intentId,
      },
      body: JSON.stringify({
        amount_cents: amountCents,
        currency: "usd",
        description: orderNumber,
        allowed_origin: siteUrl,
        return_url: `${siteUrl}/order-confirmation/${encodeURIComponent(orderId)}`,
        expires_in_minutes: EXPRESS_SESSION_MINUTES,
        metadata: { order_id: orderId },
        // Required when the merchant has require_cart_hash; harmless otherwise.
        cart_hash: createHmac("sha256", secretKey).update(`${amountCents}.usd`).digest("hex"),
        client_ip: ip ?? undefined,
        client_user_agent: userAgent ?? undefined,
        // A callback, NOT static shipping_methods (the two are mutually
        // exclusive and 409 together). Static methods cannot express tax, and
        // this lane's whole correctness argument rests on locking tax.
        shipping_callback_url: `${siteUrl}/api/veyra/express-shipping-callback`,
        shipping_callback_bypass_token: shippingCallbackToken(),
      }),
    });
    const data: { id?: string; error?: { message?: string } } | null = await response.json().catch(() => null);
    if (!response.ok || !data?.id) {
      console.error("Veyra express session create failed", response.status, data?.error?.message);
      return unavailable("Express checkout is unavailable right now.");
    }
    // The POST returns the INTERNAL uuid as `id`. That is what every downstream
    // call is keyed by; the public `vcs_` id is never returned and would 404.
    sessionId = data.id;
  } catch (error) {
    console.error("Veyra express session create threw", error);
    return unavailable("Express checkout is unavailable right now.");
  }

  const { error: linkError } = await supabaseAdmin
    .from("express_checkout_intents")
    .update({ veyra_session_id: sessionId })
    .eq("id", intentId);
  if (linkError) {
    // Without the link, the shipping callback and authorize can't find this
    // intent — every later step would refuse anyway. Refuse now, plainly.
    console.error("Unable to link express intent to Veyra session", linkError);
    return unavailable("Express checkout is unavailable right now.");
  }

  return NextResponse.json({
    available: true,
    sessionId,
    amountCents,
    orderNumber,
    // Rendered VERBATIM by the client. The wallet client never derives a row.
    lineItems: quote.displayLineItems,
  });
}
