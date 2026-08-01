import { NextResponse } from "next/server";
import {
  addressFingerprint,
  loadIntentBySession,
  secretsMatch,
  shippingCallbackToken,
  shippingMethodId,
  type WalletPartialContact,
} from "@/lib/express-checkout-service";
import { recordSystemAlert } from "@/lib/monitoring";
import { quoteOrder } from "@/lib/quote-order";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

// Veyra calls this while the Apple Pay sheet is open, every time the shopper
// edits their address. It is the ONE place shipping (S) and sales tax (T) are
// computed for the express lane, and the numbers it returns are what Veyra
// locks into its rates cache and later charges.
//
// Hard budget: comfortably under 3s. Veyra aborts at 5s and FAILS OPEN to a $0
// shipping / $0 tax method — while skipping its cache write, so its cache still
// holds the previous address's numbers. Every failure path here therefore
// returns an explicit error shape (never a bare empty list, which Veyra's
// validator also treats as a fail-open) and raises a durable alert.

const NOT_SHIPPABLE_MESSAGE = "We do not ship to that address.";

interface CallbackBody {
  session_id?: string;
  amount_cents?: number;
  currency?: string;
  contact?: WalletPartialContact & { postalCode?: string; postal_code?: string };
}

/**
 * The refusal shape.
 *
 * The `error` string is MANDATORY: Veyra's validator rejects an empty method
 * list with no message as `empty_shipping_methods_without_error_message` and
 * degrades the whole response to free shipping. A silent refusal is therefore
 * indistinguishable from a $0 charge instruction.
 */
function refuse(message: string, status = 200) {
  return NextResponse.json({ shipping_methods: [], error: message }, { status });
}

export async function POST(request: Request) {
  // The bypass token is the only thing authenticating this callback — it is a
  // shared secret set unconditionally at session create and echoed by Veyra on
  // every delivery. Compared in constant time.
  const presented = request.headers.get("x-vercel-protection-bypass") ?? "";
  let expected: string;
  try {
    expected = shippingCallbackToken();
  } catch {
    console.error("VEYRA_SHIPPING_CALLBACK_TOKEN is not configured");
    return NextResponse.json({ shipping_methods: [], error: "Shipping is unavailable." }, { status: 500 });
  }
  if (!secretsMatch(presented, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CallbackBody;
  try {
    body = (await request.json()) as CallbackBody;
  } catch {
    return refuse("We could not calculate shipping for that address.", 400);
  }

  const sessionId = String(body.session_id ?? "").trim();
  if (!sessionId) {
    return refuse("We could not calculate shipping for that address.", 400);
  }

  const intent = await loadIntentBySession(sessionId);
  if (!intent || intent.consumed_at || intent.status !== "open" || new Date(intent.expires_at).getTime() < Date.now()) {
    return refuse("This checkout has expired. Please start again.");
  }

  // Never trust the amount in the body — cross-check it against the intent's
  // own authoritative `A`. A disagreement means this callback is not describing
  // the session we armed.
  if (typeof body.amount_cents === "number" && body.amount_cents !== intent.amount_cents) {
    return refuse("We could not calculate shipping for that address.", 400);
  }

  const rawContact = body.contact ?? {};
  const contact: WalletPartialContact = {
    country: rawContact.country ?? null,
    state: rawContact.state ?? null,
    city: rawContact.city ?? null,
    postal_code: rawContact.postal_code ?? rawContact.postalCode ?? null,
  };

  try {
    // The SAME email session-create priced with (empty for a guest, whose
    // address Apple has not handed over yet), so the discount — and therefore
    // the taxable base — matches `A` exactly instead of drifting on a coupon
    // that validates differently for a different email.
    const customerEmail = intent.customer_email ?? "";

    const quote = await quoteOrder({
      items: intent.items.map((item) => ({ id: item.id, quantity: item.quantity })),
      customer: {
        email: customerEmail,
        fullName: "",
        address: "",
        city: contact.city ?? "",
        postalCode: contact.postal_code ?? "",
        country: contact.country ?? "",
        state: contact.state ?? "",
      },
      referralCode: intent.referral_code ?? undefined,
      couponCode: intent.coupon_code ?? undefined,
      customerUserId: intent.customer_user_id ?? undefined,
      pointsToRedeem: 0,
      shippingProtection: intent.shipping_protection,
      paymentMethod: "card",
      mode: "destination_only",
    });

    const shippingAmountCents = Math.round(quote.shipping * 100);
    const taxAmountCents = Math.round(quote.taxAmount * 100);
    const fingerprint = addressFingerprint(contact);
    const methodId = shippingMethodId(fingerprint);
    const payload = {
      shipping_methods: [
        {
          id: methodId,
          label: "Standard Shipping",
          detail: "3-5 business days",
          amount_cents: shippingAmountCents,
        },
      ],
      tax_amount_cents: taxAmountCents,
    };

    // Persist BEFORE responding. An unpersisted quote is unverifiable at
    // authorize and would have to be refused there anyway — better to refuse
    // now, while the shopper can still read an addressable message, than to
    // let them authorize against a quote we cannot prove we issued.
    const { error: persistError } = await supabaseAdmin.from("express_shipping_quotes").insert({
      veyra_session_id: sessionId,
      address_fingerprint: fingerprint,
      contact: contact as unknown as Record<string, unknown>,
      shipping_methods: payload.shipping_methods,
      tax_amount_cents: taxAmountCents,
      shipping_amount_cents: shippingAmountCents,
    });
    if (persistError) {
      console.error("Unable to persist express shipping quote", persistError);
      await recordSystemAlert({
        type: "express_shipping_callback_failed",
        severity: "critical",
        message: "An Apple Pay shipping quote could not be persisted, so the charge was refused. Express checkout may be failing for shoppers.",
        context: { session_id: sessionId, reason: String(persistError.message ?? persistError) },
      });
      return refuse("We could not calculate shipping for that address.");
    }

    return NextResponse.json(payload);
  } catch (error) {
    // A destination we don't ship to is an expected, shopper-addressable
    // outcome — surface it as such rather than as an internal failure.
    const message = error instanceof Error ? error.message : "";
    const isDestinationRefusal =
      message.includes("ship only to") || message.includes("state for your shipping address");
    if (isDestinationRefusal) {
      return refuse(NOT_SHIPPABLE_MESSAGE);
    }

    console.error("Express shipping callback failed", error);
    await recordSystemAlert({
      type: "express_shipping_callback_failed",
      severity: "critical",
      message: "The Apple Pay shipping callback threw, so shipping and tax could not be locked. Express checkout may be failing for shoppers.",
      context: { session_id: sessionId, reason: message || "unknown error" },
    });
    return refuse("We could not calculate shipping for that address.");
  }
}
