import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getPaymentProvider, resolvePaymentProviderName } from "@/lib/payment-provider";

/**
 * Can checkout actually take a payment right now?
 *
 * The question that matters before a real order, and the one that could
 * previously only be answered by placing one. It asks the payment provider for
 * a checkout session — the exact call the checkout controller makes, with the
 * same credentials, from production — and reports whether a session came back.
 *
 * Nothing is charged and nothing is created here. A checkout session is not a
 * payment: the storefront abandons them constantly, once per abandoned cart.
 * No order row is written, no inventory is held, and the synthetic order id is
 * obviously not a real order if it ever appears in the provider's dashboard.
 *
 * This exists because of a specific failure. Checkout used to treat a missing
 * session as a completed order and send the shopper to a thank-you page having
 * charged nothing. The bypass is fixed, but "the provider returns a session"
 * was still an untested assumption, and it is precisely the assumption that
 * was wrong.
 */
export async function POST() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) return NextResponse.json({ error: "admin session required" }, { status: 401 });

  const mode = resolvePaymentProviderName(process.env.PAYMENT_PROVIDER);
  const config = {
    provider: mode,
    checkoutEnabled: process.env.CHECKOUT_ENABLED?.trim().toLowerCase() === "true",
    // Presence only. No value is ever read into the response.
    veyraApiBase: Boolean(process.env.VEYRA_API_BASE?.trim()),
    veyraSecretKey: Boolean((process.env.VEYRA_SECRET_KEY || process.env.PAYMENT_SECRET_KEY || "").trim()),
    webhookSecret: Boolean(process.env.PAYMENT_WEBHOOK_SECRET?.trim()),
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
  };

  if (!config.checkoutEnabled) {
    return NextResponse.json(
      {
        ok: false,
        config,
        stage: "config",
        reason: "CHECKOUT_ENABLED is not \"true\", so every checkout returns 503 before reaching the provider.",
      },
      { status: 200 },
    );
  }

  const orderId = `preflight-${Date.now()}`;
  try {
    const result = await getPaymentProvider().createCheckoutSession({
      orderId,
      customerEmail: "preflight@vantalabsresearch.com",
      amount: 100, // $1.00 in minor units. Never captured — the session is abandoned.
      currency: "USD",
      metadata: { orderId, orderNumber: "PREFLIGHT", preflight: "true" },
    });

    // The exact condition checkout now treats as a failure. A session with no
    // url is the state that used to become a silent unpaid "purchase".
    const hasUrl = Boolean(result.hostedCheckoutUrl);
    return NextResponse.json(
      {
        ok: hasUrl,
        config,
        stage: "session",
        paymentIdReturned: Boolean(result.paymentId),
        hostedCheckoutUrlReturned: hasUrl,
        reason: hasUrl
          ? "The provider returned a payment session. A real checkout would send the shopper to a card form."
          : "The provider returned no checkout url. A real checkout would refuse and keep the cart, and no card form would appear.",
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // The provider's own words. Paraphrasing them here is how a credential
    // problem gets mistaken for an outage.
    return NextResponse.json(
      {
        ok: false,
        config,
        stage: "session",
        reason: error instanceof Error ? error.message : String(error),
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
}
