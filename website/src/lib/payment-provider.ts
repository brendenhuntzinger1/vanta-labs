import { createHmac, timingSafeEqual } from "crypto";
import { getSiteUrl } from "@/lib/env";

export type PaymentProviderName = "live";

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

export class LivePaymentProvider implements PaymentProvider {
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    const siteUrl = getSiteUrl();

    return {
      paymentId: input.orderId,
      hostedCheckoutUrl: `${siteUrl}/checkout?order=${input.orderId}`,
    };
  }

  // Real HMAC-SHA256 verification with a constant-time compare. Rejects when
  // the secret is unset or the signature doesn't match, so the public webhook
  // endpoint cannot be used to forge "paid" orders or rewrite order state.
  // The expected signature is the hex HMAC of the raw request body keyed with
  // PAYMENT_WEBHOOK_SECRET; a real processor is configured to send the same.
  // A "sha256=" prefix (GitHub/Stripe-style) is tolerated.
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    if (!payload || !signature || !secret) {
      return false;
    }

    const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");

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

export function getPaymentProvider(providerName = process.env.PAYMENT_PROVIDER ?? "live"): PaymentProvider {
  if (providerName === "live") {
    return new LivePaymentProvider();
  }

  return new LivePaymentProvider();
}
