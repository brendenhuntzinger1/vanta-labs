import { createHmac, timingSafeEqual } from "crypto";
import { getSiteUrl } from "@/lib/env";

// Order-checkout payment abstraction. Everything the store does with a card
// order goes through the PaymentProvider interface, so swapping in a real
// high-risk processor later is a CONFIG change (PAYMENT_PROVIDER + credentials),
// not a checkout rewrite:
//
//   • "mock" / "test"  -> MockPaymentProvider: a fully simulated gateway for
//     development and testing. It routes the shopper to an internal fake
//     checkout page (/pay/mock/<orderId>) where a payment can be approved or
//     declined, and that action drives the SAME signed-webhook pipeline a real
//     processor would (payment.succeeded / payment.failed / refund.completed),
//     so the entire order lifecycle can be proven end-to-end with fake money.
//   • "live" (default) -> LivePaymentProvider: the seam a real processor plugs
//     into. Until a real integration is registered it is intentionally inert
//     (never invents a "paid" state), so production can't accidentally take an
//     unbacked order.
export type PaymentProviderName = "mock" | "live";

export type PaymentStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "canceled"
  | "refunded";

export interface PaymentProvider {
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult>;
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean;
  processWebhookEvent(event: PaymentWebhookEvent): Promise<void>;
  refundPayment(paymentId: string): Promise<void>;
  retrievePaymentStatus(paymentId: string): Promise<PaymentStatus>;
}

export interface CreateCheckoutSessionInput {
  orderId: string;
  customerEmail: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSessionResult {
  paymentId: string;
  hostedCheckoutUrl: string;
}

export interface PaymentWebhookEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

// Hex HMAC-SHA256 of the raw body keyed with the webhook secret — the exact
// string a processor (and our mock gateway) is configured to send in the
// signature header. Shared by signing (mock) and verification (both providers)
// so the two can never drift apart.
export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

// Constant-time signature check. Rejects when the secret is unset or the
// signature doesn't match, so the public webhook endpoint cannot be used to
// forge "paid" orders or rewrite order state. A "sha256=" prefix
// (GitHub/Stripe-style) is tolerated.
export function verifyWebhookSignatureImpl(payload: string, signature: string, secret: string): boolean {
  if (!payload || !signature || !secret) {
    return false;
  }

  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = signWebhookPayload(payload, secret);

  let providedBuffer: Buffer;
  try {
    providedBuffer = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, "hex");

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Verify VeyraGate's timestamped signature: `t=<unix>,v1=<hex>` over
 * `${t}.${rawBody}`.
 *
 * Distinct from verifyWebhookSignatureImpl, which signs the body alone with no
 * timestamp. The replay window is bounded in BOTH directions — a far-future
 * timestamp is as much a replay signal as an old one — and the digest length is
 * checked before comparison because timingSafeEqual requires equal lengths and a
 * short digest is a cheap probe.
 *
 * `now` is a parameter so this is testable without freezing the clock.
 */
export function verifyTimestampedSignature(
  payload: string,
  header: string,
  secret: string,
  now: number,
  toleranceSeconds = 300,
): boolean {
  if (!payload || !header || !secret) {
    return false;
  }

  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") t = v ?? null;
    else if (k === "v1") v1 = v ?? null;
  }
  if (!t || !v1 || !/^\d+$/.test(t)) {
    return false;
  }
  if (Math.abs(now - Number(t)) > toleranceSeconds) {
    return false;
  }
  if (v1.length !== 64) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  let providedBuffer: Buffer;
  try {
    providedBuffer = Buffer.from(v1, "hex");
  } catch {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export class LivePaymentProvider implements PaymentProvider {
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    // No real card processor is integrated yet. The previous stub returned a
    // hosted-checkout URL that pointed back at /checkout, which bounced the
    // shopper in a loop and never captured payment. Fail loudly with a clear,
    // friendly message instead of shipping a broken card flow.
    //
    // TO GO LIVE WITH CARDS: replace the body of this method with a call to your
    // processor (Stripe/Square/etc.) that creates a hosted-checkout session and
    // returns its real { paymentId, hostedCheckoutUrl }. The webhook handler
    // (processPaymentWebhook) is already wired to settle the order on callback.
    void input;
    throw new Error(
      "Card payments are being set up and aren't available yet. Please choose another payment method or check back soon.",
    );
  }

  // Accepts BOTH signing schemes, because two different senders hit this path:
  //
  //   • VeyraGate signs `t=<unix>,v1=<hex>` over `${t}.${rawBody}` — Stripe-style,
  //     timestamped and replay-bounded. Its portal states the header outright:
  //     "Each delivery includes a Veyragate-Signature header."
  //   • The pre-existing internal scheme is a bare hex HMAC over the raw body.
  //
  // Both require the same secret, so accepting either does not weaken the endpoint
  // — it only stops every real VeyraGate delivery being rejected, which is what
  // happened before: signature verification failed, the webhook 400'd, and the
  // order behind a charged card never settled. The `t=` prefix is an unambiguous
  // discriminator, so the existing scheme is untouched.
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (signature?.includes("t=") && signature.includes("v1=")) {
      return verifyTimestampedSignature(payload, signature, secret, Math.floor(Date.now() / 1000));
    }
    return verifyWebhookSignatureImpl(payload, signature, secret);
  }

  async processWebhookEvent(event: PaymentWebhookEvent): Promise<void> {
    void event;
  }

  async refundPayment(paymentId: string): Promise<void> {
    void paymentId;
  }

  async retrievePaymentStatus(paymentId: string): Promise<PaymentStatus> {
    void paymentId;
    return "pending";
  }
}

// Simulated gateway for development and testing. It NEVER moves real money; it
// exists so every downstream money/stock/email/commission side-effect can be
// exercised with fake payments before a real processor is connected.
//
// createCheckoutSession points the shopper at the internal /pay/mock page,
// where "Approve" or "Decline" posts to /api/checkout/mock-pay, which signs a
// webhook event and feeds it through the real webhook handler — identical to
// what a live processor callback does.
export class MockPaymentProvider implements PaymentProvider {
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    const siteUrl = getSiteUrl();

    return {
      paymentId: `mock_pay_${input.orderId}`,
      hostedCheckoutUrl: `${siteUrl}/pay/mock/${input.orderId}`,
    };
  }

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    return verifyWebhookSignatureImpl(payload, signature, secret);
  }

  async processWebhookEvent(event: PaymentWebhookEvent): Promise<void> {
    void event;
  }

  // The order-level refund side-effects (commission reversal, points/store-
  // credit return, restock) are performed by the admin refund route itself.
  // A real processor call would go here; the mock simply reports success so
  // that route's best-effort provider call resolves cleanly.
  async refundPayment(paymentId: string): Promise<void> {
    void paymentId;
  }

  async retrievePaymentStatus(paymentId: string): Promise<PaymentStatus> {
    void paymentId;
    return "pending";
  }
}

// Resolve the configured provider name from an explicit argument, else the
// PAYMENT_PROVIDER env var, defaulting to "live" so a missing config never
// silently runs the mock gateway in production.
export function resolvePaymentProviderName(providerName = process.env.PAYMENT_PROVIDER): PaymentProviderName {
  const normalized = (providerName ?? "").trim().toLowerCase();
  if (normalized === "mock" || normalized === "test") {
    // HARD STOP: the simulated gateway must never run in production. If it does,
    // any unauthenticated caller can mark orders paid via /api/checkout/mock-pay.
    // Fail loudly at the first payment operation rather than silently accepting
    // fake payments. The only escape hatch is an explicit non-prod opt-in.
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_PAYMENTS !== "true") {
      throw new Error(
        "PAYMENT_PROVIDER=mock/test is forbidden in production. Set PAYMENT_PROVIDER=live. " +
        "(ALLOW_MOCK_PAYMENTS=true may be set ONLY in a non-production environment.)",
      );
    }
    return "mock";
  }
  return "live";
}

// True when the store is running the simulated gateway. Gates the internal
// fake-checkout page/route so they are inert in production.
export function isMockPaymentMode(providerName?: string): boolean {
  return resolvePaymentProviderName(providerName) === "mock";
}

// Checkout is "open" only when the store can actually capture money: the mock
// gateway (dev/test) OR an explicit CHECKOUT_ENABLED=true flag the owner sets
// once a real payment path is live (a card processor wired into
// LivePaymentProvider, or manual payment methods enabled). Default CLOSED so a
// production store with no processor can NEVER accept an order it can't charge —
// checkout refuses up front instead of creating an orphan, uncharged order.
export function isCheckoutOpen(): boolean {
  if (isMockPaymentMode()) {
    return true;
  }
  return process.env.CHECKOUT_ENABLED === "true";
}

export function getPaymentProvider(providerName = process.env.PAYMENT_PROVIDER): PaymentProvider {
  if (resolvePaymentProviderName(providerName) === "mock") {
    return new MockPaymentProvider();
  }

  return new LivePaymentProvider();
}
