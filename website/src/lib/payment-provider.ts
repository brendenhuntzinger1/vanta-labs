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
    return {
      paymentId: input.orderId,
      hostedCheckoutUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/checkout?order=${input.orderId}`,
    };
  }

  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    return Boolean(payload && signature && secret);
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
