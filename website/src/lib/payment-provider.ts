export type PaymentProviderName = "demo" | "live";

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

export class DemoPaymentProvider implements PaymentProvider {
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    return {
      paymentId: `demo-${input.orderId}`,
      hostedCheckoutUrl: `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/checkout/demo-confirmation?order=${input.orderId}`,
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

export function getPaymentProvider(providerName = process.env.PAYMENT_PROVIDER ?? "demo"): PaymentProvider {
  if (providerName === "demo") {
    return new DemoPaymentProvider();
  }

  // Approved processor integration point:
  // Replace this branch with a provider-specific implementation once an approved processor is selected.
  return new DemoPaymentProvider();
}
