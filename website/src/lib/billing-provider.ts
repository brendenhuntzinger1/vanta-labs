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

export type BillingProviderName = "noop";

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

export function getBillingProvider(providerName = process.env.BILLING_PROVIDER ?? "noop"): BillingProvider {
  switch (providerName) {
    case "noop":
    default:
      return new NoopBillingProvider();
  }
}
