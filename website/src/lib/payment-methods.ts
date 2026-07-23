// -------------------------------------------------------------------------
// Payment method configuration + shared card-processing-fee math.
//
// Single source of truth for every payment method the checkout offers. Vanta
// Labs takes payment through its card processor only — Debit, Credit & Apple
// Pay. (Peer-to-peer transfer apps such as Cash App, Zelle, PayPal and Venmo
// are intentionally NOT offered.)
//
// This file has NO `server-only` import on purpose, so the SAME file (and the
// SAME fee math) is used by both:
//   - the checkout client (src/components/payment-method-picker.tsx), to show
//     the card processing fee / final total instantly, and
//   - the server checkout total (src/lib/payment-service.ts), which is the
//     authoritative amount actually charged.
// One formula, not two hand-synced copies - same reasoning as
// bundle-pricing.ts / shipping.ts / discount-resolution.ts.
//
// HOW TO CONFIGURE:
//   * The card processing fee is DEFAULT_CARD_PROCESSING_FEE below - change
//     the percentage (or disable it) in one place. It can also be overridden
//     at runtime from the admin "Payments" settings without a deploy.
//
// The `kind: "manual"` scaffold below is retained so a future non-card option
// (ACH, wire, etc.) could be added, but no manual method ships enabled.
//
// NOTE ON CARD SURCHARGES: charging a fee on card payments is regulated in
// some regions (and often prohibited on debit cards). The fee is fully
// configurable, including disabling it, so you can stay compliant.
// -------------------------------------------------------------------------

export type PaymentMethodKind = "card" | "manual";

export interface PaymentMethodConfig {
  /** Stable machine id, e.g. "cashapp". Used in the DB and admin config. */
  id: string;
  /** Human label shown in checkout, e.g. "Cash App". */
  label: string;
  kind: PaymentMethodKind;
  /** Whether the method is offered at checkout at all. */
  enabled: boolean;
  /** Display order (lower first). Manual/recommended methods come first. */
  order: number;
  /** Emoji/short glyph used as a lightweight icon. */
  icon: string;
  /** Whether to highlight this as a recommended, primary option. */
  recommended: boolean;
  /** Badges shown on the card, e.g. ["⭐ Recommended", "✅ No Processing Fee"]. */
  badges: string[];
  /** Short supporting description, e.g. "Fast & Secure — no processing fee". */
  description?: string;
  /** One-line supporting copy under the label. */
  tagline?: string;

  // --- Account details (shown on the payment instructions panel) ---------
  /** Cash App $cashtag / Venmo handle / generic username. */
  handle?: string;
  /** Registered business/recipient name (Zelle). */
  businessName?: string;
  /** Recipient email (Zelle / PayPal). */
  email?: string;
  /** Recipient phone (Zelle). */
  phone?: string;
  /** Path or URL to the QR code image. */
  qrImageUrl?: string;
  /** Ordered step-by-step payment instructions. */
  instructions: string[];
  /** Reminder about referencing the order number in the payment note. */
  memoNote?: string;
  /** Label for the reference field, e.g. "Transaction ID" / "Confirmation Number". */
  referenceLabel?: string;
}

export interface CardProcessingFeeConfig {
  /** Master switch. Disable to charge card orders with no fee. */
  enabled: boolean;
  /** Fee as a percentage of the order total, e.g. 5 for 5%. */
  percentage: number;
  /** Line-item label shown at checkout. */
  label: string;
  /**
   * Optional custom notice copy. When empty, the UI builds a default notice
   * from the percentage so the two never drift out of sync.
   */
  noticeText: string;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

// Change the percentage here (or set enabled:false) to update the card fee
// everywhere. Manual methods never carry a fee.
export const DEFAULT_CARD_PROCESSING_FEE: CardProcessingFeeConfig = {
  enabled: true,
  percentage: 5,
  label: "Card Processing Fee",
  noticeText: "",
};

export interface CardProcessingFeeResult {
  amount: number;
  percentage: number;
}

// Authoritative fee math, shared client + server. `baseTotal` is the order
// total before the card fee (subtotal + shipping + handling − discounts −
// points). Only the card method uses this; manual methods pay `baseTotal`.
export function calculateCardProcessingFee(
  baseTotal: number,
  config: CardProcessingFeeConfig,
): CardProcessingFeeResult {
  if (!config.enabled || baseTotal <= 0 || config.percentage <= 0) {
    return { amount: 0, percentage: config.percentage };
  }
  return { amount: roundMoney(baseTotal * (config.percentage / 100)), percentage: config.percentage };
}

export function cardProcessingFeeNotice(config: CardProcessingFeeConfig): string {
  if (config.noticeText.trim()) return config.noticeText.trim();
  return `A ${config.percentage}% processing fee applies to card payments.`;
}

export const DEFAULT_PAYMENT_METHODS: PaymentMethodConfig[] = [
  {
    id: "card",
    label: "Debit, Credit & Apple Pay",
    kind: "card",
    enabled: true,
    order: 100,
    icon: "💳",
    recommended: true,
    badges: ["🔒 Secure checkout", "Apple Pay"],
    description: "Visa, Mastercard, Amex, Discover & Apple Pay",
    tagline: "Fast, encrypted card checkout",
    instructions: [],
    referenceLabel: "Transaction ID",
  },
];

export function isManualPaymentMethod(config: PaymentMethodConfig | undefined | null): boolean {
  return Boolean(config && config.kind === "manual");
}

export function getPaymentMethodById(
  methods: PaymentMethodConfig[],
  id: string | null | undefined,
): PaymentMethodConfig | undefined {
  if (!id) return undefined;
  return methods.find((method) => method.id === id);
}

export function getEnabledPaymentMethods(methods: PaymentMethodConfig[]): PaymentMethodConfig[] {
  return methods
    .filter((method) => method.enabled)
    .sort((a, b) => a.order - b.order);
}
