// Recurring-billing charge abstraction - same shape/purpose as
// src/lib/payment-provider.ts's PaymentProvider, but for the subscription
// charges the membership engine schedules (intro charge, first-month
// remainder, monthly renewals).
//
// There is no real processor connected yet (see membership-billing.sql's
// header comment). getBillingProvider() defaults to NoopBillingProvider,
// which always reports a charge as failed - honestly, not silently - so
// every date/state-transition/email/admin-metric built on top of this
// module is real today, and the moment real processor credentials are
// added (a new BillingProvider implementation registered below, selected
// via the BILLING_PROVIDER env var), charges start actually moving money
// with zero other code changes required.

export type BillingProviderName = "noop" | "mock";

export interface ChargeCardInput {
  billingProviderCustomerId: string | null;
  paymentMethodRef: string | null;
  amountCents: number;
  currency: string;
  description: string;
  idempotencyKey: string;
}

export interface ChargeCardResult {
  success: boolean;
  providerChargeId?: string;
  error?: string;
}

export interface CreateBillingCustomerInput {
  email: string;
  name?: string;
}

export interface CreateBillingCustomerResult {
  success: boolean;
  billingProviderCustomerId?: string;
  error?: string;
}

export interface BillingProvider {
  createCustomer(input: CreateBillingCustomerInput): Promise<CreateBillingCustomerResult>;
  chargeCard(input: ChargeCardInput): Promise<ChargeCardResult>;
}

// No processor is configured. Every method resolves cleanly (never throws)
// so the surrounding subscription state machine still runs in full - the
// charge itself is simply, honestly, not possible yet.
export class NoopBillingProvider implements BillingProvider {
  async createCustomer(input: CreateBillingCustomerInput): Promise<CreateBillingCustomerResult> {
    void input;
    return {
      success: false,
      error: "No billing processor configured. Set BILLING_PROVIDER and the matching credentials once one is connected.",
    };
  }

  async chargeCard(input: ChargeCardInput): Promise<ChargeCardResult> {
    void input;
    return {
      success: false,
      error: "No billing processor configured. Set BILLING_PROVIDER and the matching credentials once one is connected.",
    };
  }
}

// Simulated recurring-billing processor for development and testing. It NEVER
// moves real money; it lets the whole subscription state machine (intro charge,
// first-month remainder, monthly renewals, dunning) be exercised with fake
// charges before a real processor is connected. A charge succeeds unless the
// stored payment method reference marks it as a decline test card
// ("decline"/"4000...") — mirroring the mock order gateway's test cards — so
// both the happy path and failed-renewal/past-due handling can be proven.
export class MockBillingProvider implements BillingProvider {
  async createCustomer(input: CreateBillingCustomerInput): Promise<CreateBillingCustomerResult> {
    const seed = (input.email || "customer").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24) || "customer";
    return {
      success: true,
      billingProviderCustomerId: `mock_cus_${seed}`,
    };
  }

  async chargeCard(input: ChargeCardInput): Promise<ChargeCardResult> {
    const ref = (input.paymentMethodRef ?? "").toLowerCase();
    const isDecline = ref.includes("decline") || ref.includes("4000000000000002");

    if (isDecline) {
      return {
        success: false,
        error: "Card declined (sandbox test card).",
      };
    }

    return {
      success: true,
      providerChargeId: `mock_ch_${input.idempotencyKey}`,
    };
  }
}

export function getBillingProvider(providerName = process.env.BILLING_PROVIDER ?? "noop"): BillingProvider {
  switch ((providerName ?? "").trim().toLowerCase()) {
    case "mock":
    case "test":
      return new MockBillingProvider();
    case "noop":
    default:
      return new NoopBillingProvider();
  }
}
