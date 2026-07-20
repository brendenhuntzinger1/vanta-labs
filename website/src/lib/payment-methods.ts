// -------------------------------------------------------------------------
// Payment method configuration + shared card-processing-fee math.
//
// Single source of truth for every payment method the checkout offers:
//   - the recommended, no-fee manual methods (Cash App, Zelle, PayPal, and
//     any future ones), shown first, and
//   - the Credit/Debit Card processor option, shown as secondary, which
//     carries a configurable processing fee.
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
// HOW TO CONFIGURE (no code changes beyond editing the objects below):
//   * Everything is a PLACEHOLDER. Replace handles, emails, phone numbers,
//     QR image paths and instructions with your real details when ready.
//   * QR images live in /public/images/payments/. Drop a real PNG/SVG in at
//     the same path and it appears automatically.
//   * The card processing fee is DEFAULT_CARD_PROCESSING_FEE below - change
//     the percentage (or disable it) in one place. It can also be overridden
//     at runtime from the admin "Payments" settings without a deploy.
//   * To add a brand-new method (Venmo, Apple Cash, ACH, Wire, Crypto, ...)
//     just add another object to DEFAULT_PAYMENT_METHODS with a unique `id`
//     and `kind: "manual"`. Nothing else in checkout needs to change.
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
  return `A ${config.percentage}% processing fee applies to Credit/Debit Card payments. Our recommended payment methods (Cash App, Zelle, PayPal) do not include this fee.`;
}

export const DEFAULT_PAYMENT_METHODS: PaymentMethodConfig[] = [
  {
    id: "cashapp",
    label: "Cash App",
    kind: "manual",
    enabled: true,
    order: 10,
    icon: "🟢",
    recommended: true,
    badges: ["⭐ Recommended", "✅ No Processing Fee", "⚡ Instant"],
    description: "Fast & secure — no processing fee",
    tagline: "Preferred payment method",
    handle: "$YOURCASHTAG", // PLACEHOLDER — replace with your $cashtag
    qrImageUrl: "/images/payments/cashapp-qr.svg",
    instructions: [
      "Open Cash App and send the exact amount shown above to our $cashtag.",
      "Add your Order Number to the payment note.",
      "Enter your Cash App payment/transaction ID below and submit.",
    ],
    memoNote: "Please include your Order Number in the Cash App note so we can match your payment.",
    referenceLabel: "Transaction ID",
  },
  {
    id: "zelle",
    label: "Zelle",
    kind: "manual",
    enabled: true,
    order: 20,
    icon: "🏦",
    recommended: true,
    badges: ["⭐ Recommended", "✅ No Processing Fee", "⚡ Fast Checkout"],
    description: "Bank-to-bank — no processing fee",
    tagline: "Instant payment",
    businessName: "Your Business LLC", // PLACEHOLDER
    email: "payments@yourbusiness.com", // PLACEHOLDER
    phone: "(000) 000-0000", // PLACEHOLDER
    qrImageUrl: "/images/payments/zelle-qr.svg",
    instructions: [
      "Open your bank's Zelle and send the exact amount shown above to our email or phone number.",
      "Add your Order Number to the memo.",
      "Enter your Zelle confirmation number below and submit.",
    ],
    memoNote: "Please include your Order Number in the Zelle memo so we can match your payment.",
    referenceLabel: "Confirmation Number",
  },
  {
    id: "paypal",
    label: "PayPal",
    kind: "manual",
    enabled: true,
    order: 30,
    icon: "🅿️",
    recommended: true,
    badges: ["⭐ Recommended", "✅ No Processing Fee"],
    description: "No processing fee",
    tagline: "Fast & secure",
    email: "payments@yourbusiness.com", // PLACEHOLDER
    qrImageUrl: "/images/payments/paypal-qr.svg",
    instructions: [
      "Send the exact amount shown above to our PayPal email.",
      "Add your Order Number in the notes.",
      "Enter your PayPal transaction ID below and submit.",
    ],
    memoNote: "Please include your Order Number in the PayPal note so we can match your payment.",
    referenceLabel: "Transaction ID",
  },
  {
    id: "card",
    label: "Credit / Debit Card",
    kind: "card",
    enabled: true,
    order: 100,
    icon: "💳",
    recommended: false,
    badges: [],
    description: "Visa, Mastercard & Apple Pay",
    tagline: "Secure processor checkout",
    instructions: [],
    referenceLabel: "Transaction ID",
  },
  // --- Future methods -----------------------------------------------------
  // Flip `enabled: true`, drop in a QR image, and it appears automatically.
  // No checkout code changes required. Example scaffold:
  {
    id: "venmo",
    label: "Venmo",
    kind: "manual",
    enabled: false,
    order: 40,
    icon: "🔵",
    recommended: true,
    badges: ["⭐ Recommended", "✅ No Processing Fee"],
    description: "No processing fee",
    tagline: "Fast & secure",
    handle: "@YourVenmo", // PLACEHOLDER
    qrImageUrl: "/images/payments/venmo-qr.svg",
    instructions: [
      "Open Venmo and send the exact amount shown above to our handle.",
      "Add your Order Number to the payment note.",
      "Enter your Venmo transaction ID below and submit.",
    ],
    memoNote: "Please include your Order Number in the Venmo note so we can match your payment.",
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
