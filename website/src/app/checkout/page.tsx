"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";
import { readAttributionForCheckout } from "@/lib/attribution-client";
import { calculateShipping, isDomesticCountry } from "@/lib/shipping";
import { resolveSalesTax } from "@/lib/sales-tax";
import { EXPRESS_CHECKOUT_ENABLED } from "@/lib/express-checkout";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { pointsToDollars } from "@/lib/points-math";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ManualPaymentInstructions } from "@/components/manual-payment-instructions";
import { PaymentMethodPicker } from "@/components/payment-method-picker";
import { TextField, SelectField, Collapse, CheckoutSection } from "@/components/checkout-fields";
import {
  calculateCardProcessingFee,
  getEnabledPaymentMethods,
  getPaymentMethodById,
  type CardProcessingFeeConfig,
  type PaymentMethodConfig,
} from "@/lib/payment-methods";

async function createSecureCheckoutSession(payload: unknown) {
  const response = await fetch("/api/checkout/create-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error ?? "Unable to create checkout session");
  }
  return data;
}

// A gentle tap on supported devices. No-op where Vibration isn't available.
function haptic(ms = 8) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try { navigator.vibrate(ms); } catch { /* ignore */ }
  }
}

type CheckoutForm = {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  billingFullName: string;
  billingAddress: string;
  billingCity: string;
  billingPostalCode: string;
  billingCountry: string;
};

// The store ships ONLY to the United States and Canada, so those are the only
// selectable destinations. This is enforced again server-side (validateCustomer
// -> isShippableCountry) so a tampered client can't check out elsewhere.
const COUNTRY_OPTIONS = [
  "United States",
  "Canada",
];

const US_STATE_OPTIONS = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC", "PR",
];

// Verbatim, legally load-bearing copy. `short` is a display label for the
// compact row; the full `body` stays one tap away behind "View details".
const REQUIRED_CONFIRMATIONS = [
  {
    key: "researchResponsibility" as const,
    short: "Research responsibility",
    title: "Research Responsibility Statement *",
    body: "The purchaser assumes full responsibility for the proper handling, storage, and use of these laboratory materials. The seller provides products solely as research reference materials and does not provide medical or dosing guidance.",
  },
  {
    key: "researchCompliance" as const,
    short: "Research & compliance agreement",
    title: "Research & Compliance Agreement *",
    body: "I acknowledge that the products sold on this website are intended strictly for laboratory research purposes. I confirm that I am purchasing these materials for legitimate research use and not for human or veterinary use. I understand these products are not drugs, dietary supplements, or medical products, and no instructions for preparation, dosage, or administration are provided by the seller.",
  },
  {
    key: "ageLegalConfirmation" as const,
    short: "I am 21+ and legally permitted",
    title: "Age & Legal Confirmation *",
    body: "I confirm that I am 21 years of age or older and legally permitted to purchase laboratory research materials.",
  },
];

function isUnitedStates(country: string) {
  return ["united states", "usa", "us", "u.s.", "u.s.a."].includes(country.trim().toLowerCase());
}

function isCanada(country: string) {
  return ["canada", "ca", "can"].includes(country.trim().toLowerCase());
}

// Country-aware postal-code check. US = 5 digits or ZIP+4; Canada = A1A 1A1
// (space optional). For anything else we only require non-empty. Returns an
// error string, or null when the value is acceptable for the country.
function postalCodeError(value: string, country: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Postal code is required.";
  if (isUnitedStates(country) && !/^\d{5}(-\d{4})?$/.test(trimmed)) {
    return "Enter a valid ZIP code (e.g. 78701).";
  }
  if (isCanada(country) && !/^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test(trimmed)) {
    return "Enter a valid postal code (e.g. K1A 0B1).";
  }
  return null;
}

type ComplianceAcknowledgements = {
  researchResponsibility: boolean;
  researchCompliance: boolean;
  ageLegalConfirmation: boolean;
};

type CreatedManualOrder = {
  orderId: string;
  orderNumber: string;
  method: PaymentMethodConfig;
  amountDue: number;
};

function validateCheckoutForm(form: CheckoutForm, sameAsShipping: boolean) {
  const errors: Partial<Record<keyof CheckoutForm, string>> = {};

  if (!form.fullName.trim()) errors.fullName = "Full name is required.";
  if (!form.email.trim() || !/^\S+@\S+\.\S+$/.test(form.email)) errors.email = "Enter a valid email.";
  if (form.phone.trim().replace(/\D/g, "").length < 7) errors.phone = "A phone number is required for delivery.";
  if (!form.address.trim()) errors.address = "Shipping address is required.";
  if (!form.city.trim()) errors.city = "City is required.";
  if (isUnitedStates(form.country) && !form.state.trim()) errors.state = "State is required.";
  const postalErr = postalCodeError(form.postalCode, form.country);
  if (postalErr) errors.postalCode = postalErr;
  if (!form.country.trim()) errors.country = "Country is required.";

  if (!sameAsShipping) {
    if (!form.billingFullName.trim()) errors.billingFullName = "Billing name is required.";
    if (!form.billingAddress.trim()) errors.billingAddress = "Billing address is required.";
    if (!form.billingCity.trim()) errors.billingCity = "Billing city is required.";
    const billingPostalErr = postalCodeError(form.billingPostalCode, form.billingCountry);
    if (billingPostalErr) errors.billingPostalCode = billingPostalErr;
    if (!form.billingCountry.trim()) errors.billingCountry = "Billing country is required.";
  }

  return errors;
}

// Honest progress for a SINGLE-PAGE checkout: two real steps (enter details →
// pay), not four page-like stages the shopper never actually navigates.
function CheckoutProgress({ onPayment }: { onPayment: boolean }) {
  const steps = ["Your details", "Payment"];
  const current = onPayment ? 1 : 0;
  return (
    <div className="flex items-center gap-3" aria-label={`Step ${current + 1} of 2: ${steps[current]}`}>
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <div key={label} className="flex flex-1 items-center gap-3">
            <div className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border transition-all duration-300 ${
                  done
                    ? "border-[color:var(--accent-gold)]/50 bg-[color:var(--accent-gold)]/15"
                    : active
                      ? "border-[color:var(--accent-gold)]/60 bg-[color:var(--accent-gold)]/10"
                      : "border-white/15"
                }`}
              >
                {done ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-gold)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                ) : (
                  <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-300 ${active ? "bg-[color:var(--accent-gold)]" : "bg-white/25"}`} />
                )}
              </span>
              <span className={`whitespace-nowrap text-xs transition-colors duration-300 ${active || done ? "text-white/85" : "text-white/35"}`}>{label}</span>
            </div>
            {index === 0 ? (
              <span className="h-px flex-1 overflow-hidden bg-white/10">
                <span className={`block h-full origin-left bg-[color:var(--accent-gold)]/50 transition-transform duration-500 ease-out ${current >= 1 ? "scale-x-100" : "scale-x-0"}`} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const TRUST_POINTS = [
  { label: "256-bit SSL encrypted", icon: <><path d="M6 10V8a6 6 0 1 1 12 0v2M5 10h14v10H5z" strokeLinejoin="round" /></> },
  { label: "Secure payment processing", icon: <><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" strokeLinejoin="round" /><path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></> },
  { label: "Full batch traceability", icon: <><path d="M9 3h6M10 3v5l-4 9a2 2 0 0 0 1.8 2.9h8.4A2 2 0 0 0 18 17l-4-9V3" strokeLinejoin="round" /></> },
  { label: "Ships within 1 business day", icon: <><path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" strokeLinejoin="round" /><circle cx="7" cy="17" r="1.6" /><circle cx="17.5" cy="17" r="1.6" /></> },
];

function TrustRow({ className = "" }: { className?: string }) {
  return (
    <div className={`grid grid-cols-2 gap-x-4 gap-y-3 ${className}`}>
      {TRUST_POINTS.map((point) => (
        <div key={point.label} className="flex items-center gap-2.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-gold)" strokeWidth="1.4" className="h-4 w-4 flex-shrink-0 opacity-70" aria-hidden>{point.icon}</svg>
          <span className="text-[11px] leading-tight text-white/45">{point.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function CheckoutPage() {
  const {
    items,
    subtotal,
    discountAmount,
    appliedDiscountLabel,
    autoBestDiscountApplied,
    referralCode,
    referralDetails,
    referralError,
    referralSuccess,
    applyReferralCode,
    clearReferralCode,
    isApplyingReferral,
    couponCode,
    couponDetails,
    couponError,
    couponSuccess,
    applyCouponCode,
    clearCouponCode,
    isApplyingCoupon,
    isBuy3Get1FreeActive,
    isSignedIn,
    isHydrated,
    pointsBalance,
    pointsToEarn,
    pointsToRedeem,
    setPointsToRedeem,
    setKnownEmail,
    clearCart,
    updateQuantity,
    removeFromCart,
    bulkSavingsTierReached,
    ambassadorDiscountApplied,
    ambassadorDiscountPercent,
    memberFreeShipping,
    storeCreditBalanceCents,
    storeCreditMinOrderCents,
    salesTaxConfig,
    shippingConfig,
    bundleConfig,
    shippingProtectionEnabled,
    setShippingProtectionEnabled,
    shippingProtectionFee,
  } = useCart();

  const [acknowledgements, setAcknowledgements] = useState<ComplianceAcknowledgements>({
    researchResponsibility: false,
    researchCompliance: false,
    ageLegalConfirmation: false,
  });
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [checkoutState, setCheckoutState] = useState<"idle" | "loading" | "success">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfig[]>([]);
  const [cardFeeConfig, setCardFeeConfig] = useState<CardProcessingFeeConfig | null>(null);
  const [selectedMethodId, setSelectedMethodId] = useState<string>("");
  // Whether the store can currently capture payment (server-authoritative; the
  // API also hard-blocks order creation when closed). Assume open until the
  // config loads so we never flash a false "closed" state.
  const [checkoutOpen, setCheckoutOpen] = useState(true);
  const [createdOrder, setCreatedOrder] = useState<CreatedManualOrder | null>(null);
  const [referralInput, setReferralInput] = useState("");
  const [couponInput, setCouponInput] = useState("");
  const [sameAsShipping, setSameAsShipping] = useState(true);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof CheckoutForm, string>>>({});
  // Locked (read-only) only when the signed-in account already has an email on
  // file. Phone-only accounts have no email, so they must enter one here to
  // receive their order confirmation / receipt.
  const [emailLockedToAccount, setEmailLockedToAccount] = useState(false);
  // Pre-checked by default for US shoppers (offers, coupons, restock alerts),
  // but defaults OFF for Canada where CASL requires express opt-in. The default
  // follows the destination country until the shopper manually toggles it.
  // Not an effect: this is derived state. CASL wants the opt-in defaulted OFF
  // for Canadian destinations and ON for the US, until the shopper toggles it —
  // after which their explicit choice wins. Computing it during render removes
  // the cascading re-render an effect caused, with identical behaviour.
  const [marketingChoice, setMarketingChoice] = useState(true);
  const [marketingTouched, setMarketingTouched] = useState(false);
  // Progressive disclosure: savings tools and legal detail stay out of the way
  // until asked for, so the default path to payment is as short as possible.
  const [savingsOpen, setSavingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [protectionOpen, setProtectionOpen] = useState(false);
  const [openLegal, setOpenLegal] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<CheckoutForm>({
    fullName: "",
    email: "",
    phone: "",
    address: "",
    address2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "United States",
    billingFullName: "",
    billingAddress: "",
    billingCity: "",
    billingPostalCode: "",
    billingCountry: "United States",
  });

  const orderCount = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);
  const effectiveReferralInput = referralInput || referralCode || "";
  const effectiveCouponInput = couponInput || couponCode || "";

  // Shipping depends on destination country, which the cart doesn't know -
  // recomputed here from the same shared shipping.ts formula the server
  // uses (see payment-service.ts), so expectedTotal below always matches
  // what the server independently computes for the entered country.
  // Mirror the server's free-shipping-on-bulk-tier rule so expectedTotal
  // always matches (see payment-service.ts and cart-context.tsx).
  const shipping = useMemo(
    () => ((bulkSavingsTierReached || memberFreeShipping) ? 0 : calculateShipping(subtotal, form.country, shippingConfig)),
    [bulkSavingsTierReached, memberFreeShipping, subtotal, form.country, shippingConfig],
  );
  // Live, address-based sales tax: recomputed the instant any address field
  // changes, with the SAME shared resolveSalesTax the server runs when it
  // builds the authoritative order total (payment-service.ts) — so the quote
  // shown here is the quote charged. $0 until a taxable (nexus) state is
  // entered; that's not a placeholder, it IS the correct amount for that
  // destination.
  const taxQuote = useMemo(
    () => resolveSalesTax({
      taxableAmount: Math.max(0, subtotal - discountAmount),
      shippingAmount: shipping,
      country: form.country,
      state: form.state,
      city: form.city,
      postalCode: form.postalCode,
      street: form.address,
      config: salesTaxConfig,
    }),
    [subtotal, discountAmount, shipping, form.country, form.state, form.city, form.postalCode, form.address, salesTaxConfig],
  );
  const taxAmount = taxQuote.amount;
  const totalBeforeCredit = Math.max(0, subtotal + shipping + taxAmount - discountAmount);
  // Membership store credit auto-applies when the merchandise subtotal meets
  // the tier's redemption minimum (mirrors payment-service.ts).
  const storeCreditApplied = useMemo(() => {
    if (referralDetails) return 0; // referral codes are exclusive of store credit
    if (storeCreditBalanceCents <= 0) return 0;
    if (Math.round(subtotal * 100) < storeCreditMinOrderCents) return 0;
    return Math.min(storeCreditBalanceCents / 100, totalBeforeCredit);
  }, [referralDetails, storeCreditBalanceCents, storeCreditMinOrderCents, subtotal, totalBeforeCredit]);
  const totalBeforePoints = Math.max(0, totalBeforeCredit - storeCreditApplied);
  const pointsRedeemedDiscount = useMemo(
    () => (referralDetails ? 0 : Math.min(pointsToDollars(pointsToRedeem), totalBeforePoints)),
    [referralDetails, pointsToRedeem, totalBeforePoints],
  );
  // `total` is the pre-payment-method total sent to the server as
  // expectedTotal (matches the server's own recompute exactly). The card
  // processing fee is then added ON TOP for the card method only; manual
  // methods pay `total`.
  const total = Math.max(0, totalBeforePoints - pointsRedeemedDiscount) + shippingProtectionFee;

  const selectedMethod = useMemo(
    () => getPaymentMethodById(paymentMethods, selectedMethodId),
    [paymentMethods, selectedMethodId],
  );
  const cardFee = useMemo(() => {
    if (!cardFeeConfig || !selectedMethod || selectedMethod.kind !== "card") {
      return { amount: 0, percentage: cardFeeConfig?.percentage ?? 0 };
    }
    return calculateCardProcessingFee(total, cardFeeConfig);
  }, [cardFeeConfig, selectedMethod, total]);
  const finalTotal = Math.max(0, total + cardFee.amount);
  const totalSaved = discountAmount + storeCreditApplied + pointsRedeemedDiscount;

  // Load the configured payment methods + card fee, and default to the first
  // recommended (no-fee) method.
  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/catalog/payment-methods", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as {
          success: boolean;
          methods?: PaymentMethodConfig[];
          cardProcessingFee?: CardProcessingFeeConfig | null;
          checkoutOpen?: boolean;
        };
        setCheckoutOpen(result.checkoutOpen !== false);
        if (!result.success || !Array.isArray(result.methods)) return;
        const enabled = getEnabledPaymentMethods(result.methods);
        setPaymentMethods(enabled);
        setCardFeeConfig(result.cardProcessingFee ?? null);
        setSelectedMethodId((current) => current || enabled[0]?.id || "");
      } catch {
        // Checkout still renders; the picker simply won't show until this loads.
      }
    })();
  }, []);

  // Fire begin_checkout exactly once, when the cart first has items. Depending
  // on `total`/`subtotal` would re-dispatch every time the shopper edits points,
  // country, or shipping, inflating the funnel.
  const beganCheckoutRef = useRef(false);
  // Synchronous double-submit latch. `isSubmitting` is React state and only
  // flips true on the next render, so two clicks in the same tick could both
  // pass the state check and create two orders (each taking an inventory hold).
  // This ref updates immediately, closing that window.
  const submitLatchRef = useRef(false);
  // Idempotency key for this checkout submit. Generated once, reused across
  // retries of the SAME order attempt (so a lost response + retry can't create
  // two orders), and cleared only after a real success so a later distinct
  // order gets a fresh key.
  const idempotencyKeyRef = useRef<string | null>(null);
  // Lets a failed validation scroll the shopper back up to the form fields
  // (with their inline errors) instead of leaving them at the submit button.
  const shippingSectionRef = useRef<HTMLElement | null>(null);
  const confirmationsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || beganCheckoutRef.current || items.length === 0) {
      return;
    }

    beganCheckoutRef.current = true;
    window.dispatchEvent(
      new CustomEvent("vanta:analytics", {
        detail: {
          eventType: "begin_checkout",
          itemCount: items.length,
          total,
          subtotal,
          // Measurement only — the lines are read from the cart and nothing
          // downstream of this dispatch touches checkout. Without them the ad
          // platform receives a checkout with a value and no product, which is
          // the "Content ID is missing" warning and leaves the checkout stage
          // of every product's funnel blank.
          items: items.map((item) => ({
            slug: item.slug,
            name: item.name,
            variantLabel: item.doseLabel ?? null,
            quantity: item.quantity,
            price: item.price,
          })),
        },
      }),
    );
  }, [items.length, subtotal, total]);

  useEffect(() => {
    if (/^\S+@\S+\.\S+$/.test(form.email)) {
      setKnownEmail(form.email);
    }
  }, [form.email, setKnownEmail]);

  // Whether the marketing box starts ticked, until the shopper touches it.
  //
  // ALLOWLIST, NOT A BLOCKLIST — a robustness change, not a bug fix.
  //
  // This previously read `!isCanada(country)`, and that was CORRECT for what
  // the form can produce: the country control is a two-option select (United
  // States, Canada), so carving out Canada for CASL covered every reachable
  // destination. Both forms behave identically today.
  //
  // Stated as an allowlist because the reason Canada is excluded is that an
  // opt-out default is lawful in very few places and the US is the outlier
  // that allows it. Written as a blocklist, adding a third country to that
  // select silently gives it a pre-ticked box; written this way, a new
  // destination starts unticked until someone decides otherwise. Nobody loses
  // the ability to subscribe — they just have to say yes.
  const marketingOptIn = marketingTouched ? marketingChoice : isUnitedStates(form.country);

  // Reveal the savings panel when a code becomes applied, so an applied code is
  // never hidden behind a collapsed row — while still letting the shopper
  // collapse it again afterwards.
  //
  // Adjusted DURING RENDER rather than in an effect (React's documented
  // "adjusting state when props change" pattern). An effect here fired a second
  // render pass on every code change; this settles in one, and unlike deriving
  // `savingsOpen` outright it does not trap the panel open.
  const codesKey = `${referralCode ?? ""}|${couponCode ?? ""}`;
  const [prevCodesKey, setPrevCodesKey] = useState(codesKey);
  if (codesKey !== prevCodesKey) {
    setPrevCodesKey(codesKey);
    if (referralCode || couponCode) setSavingsOpen(true);
  }

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/account/me", { cache: "no-store" });
        if (!response.ok) return;
        const result = await response.json() as {
          success: boolean;
          email?: string;
          fullName?: string;
          address?: { fullName: string; address: string; city: string; postalCode: string } | null;
        };
        if (!result.success) return;

        if (result.email) {
          setEmailLockedToAccount(true);
        }

        setForm((prev) => ({
          ...prev,
          email: prev.email || result.email || prev.email,
          fullName: prev.fullName || result.address?.fullName || result.fullName || prev.fullName,
          address: prev.address || result.address?.address || prev.address,
          city: prev.city || result.address?.city || prev.city,
          postalCode: prev.postalCode || result.address?.postalCode || prev.postalCode,
        }));
      } catch {
        // Guest checkout stays unaffected if this pre-fill lookup fails.
      }
    })();
    // Runs once on mount to pre-fill from a signed-in account.
  }, []);

  const handleFieldChange = (key: keyof CheckoutForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (formErrors[key]) {
      setFormErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  };

  const handleAcknowledgementChange = (key: keyof ComplianceAcknowledgements, checked: boolean) => {
    haptic();
    setAcknowledgements((prev) => ({ ...prev, [key]: checked }));
  };

  const allAcknowledged = Object.values(acknowledgements).every(Boolean);
  const acknowledgedCount = Object.values(acknowledgements).filter(Boolean).length;

  const handleCheckout = async () => {
    if (items.length === 0) {
      setCheckoutMessage("Your cart is empty.");
      return;
    }

    const errors = validateCheckoutForm(form, sameAsShipping);
    if (Object.keys(errors).length > 0) {
      haptic(18);
      setFormErrors(errors);
      setCheckoutMessage("Please complete all required fields before placing your order.");
      // Bring the shopper back to the fields (and their inline errors); on a
      // long mobile form the generic message sits below the fold otherwise.
      shippingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (Object.values(acknowledgements).some((value) => !value)) {
      haptic(18);
      setCheckoutMessage("Please confirm all required research and legal acknowledgements before placing the order.");
      confirmationsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (isSubmitting || submitLatchRef.current) return;
    submitLatchRef.current = true;
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `idem-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    }

    haptic(12);
    setCheckoutState("loading");
    setCheckoutMessage(null);
    setIsSubmitting(true);

    try {
      const payload = {
        items: items.map((item) => ({ id: item.variantId ? `${item.slug}::${item.variantId}` : item.slug, quantity: item.quantity })),
        customer: {
          email: form.email.trim(),
          fullName: form.fullName.trim(),
          address: form.address.trim(),
          address2: form.address2.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          postalCode: form.postalCode.trim(),
          country: form.country.trim(),
          phone: form.phone.trim(),
        },
        billing: sameAsShipping
          ? {
              fullName: form.fullName.trim(),
              address: form.address.trim(),
              city: form.city.trim(),
              postalCode: form.postalCode.trim(),
            }
          : {
              fullName: form.billingFullName.trim(),
              address: form.billingAddress.trim(),
              city: form.billingCity.trim(),
              postalCode: form.billingPostalCode.trim(),
            },
        referralCode: referralCode ?? undefined,
        couponCode: couponCode ?? undefined,
        // How this visit was acquired, captured on arrival. Null for organic
        // and for anyone who declined cookies; the server re-validates it and
        // stores nothing it cannot evidence.
        attribution: readAttributionForCheckout(),
        pointsToRedeem: pointsToRedeem > 0 ? pointsToRedeem : undefined,
        shippingProtection: shippingProtectionEnabled,
        marketingOptIn,
        expectedTotal: total,
        paymentMethod: selectedMethodId || undefined,
        complianceAcknowledgements: acknowledgements,
        idempotencyKey: idempotencyKeyRef.current,
      };

      const result = await createSecureCheckoutSession(payload);

      // Manual (non-card) methods: stay on-page and show the payment
      // instructions panel. None ship enabled today (card only), so this branch
      // is dormant unless a manual method is re-enabled in config.
      if (result.isManualPayment) {
        const method = getPaymentMethodById(paymentMethods, result.paymentMethod) ?? selectedMethod;
        if (method) {
          // Order placed — this attempt is done; a later distinct order gets a
          // fresh idempotency key.
          idempotencyKeyRef.current = null;
          setCreatedOrder({
            orderId: result.orderId,
            orderNumber: result.orderNumber,
            method,
            amountDue: Number(result.total ?? finalTotal),
          });
          if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
          // Intentionally do NOT reset the submit latch — the view switches to
          // the manual-payment screen and this checkout attempt is complete.
          return;
        }
      }

      // A card order with no payment session is a FAILURE, not a sale.
      //
      // This previously fell through to "treat the order as placed": clear the
      // cart and show the confirmation page. That is how a shopper reached
      // "Thank you for your order" without ever seeing a card form — the order
      // row exists, nothing was charged, and the cart that would have let them
      // try again was emptied. Several server paths can return an empty url on
      // a card order (a failed session re-creation on the idempotent-retry
      // path, a duplicate insert), and every one of them meant a silent
      // unpaid "purchase".
      //
      // The order row and its inventory hold are already written at this point
      // and are keyed to the idempotency key, so keeping that key lets a retry
      // resume the same order instead of creating a second one.
      if (!result.hostedCheckoutUrl) {
        setCheckoutState("idle");
        setCheckoutMessage(
          "We couldn't reach the payment provider, so your card was not charged and your order is not placed. " +
            "Your cart is intact — please try again in a moment.",
        );
        setIsSubmitting(false);
        submitLatchRef.current = false;
        return;
      }

      // The submit latch is deliberately LEFT ENGAGED here: the page unloads on
      // redirect, so re-enabling the button would only open a duplicate-order
      // window while the redirect is still in flight.
      idempotencyKeyRef.current = null;
      window.location.assign(result.hostedCheckoutUrl);
    } catch (error) {
      // Only an ERROR reopens the button for a retry (which reuses the same
      // idempotency key, so a server-committed-but-lost order won't duplicate).
      setCheckoutState("idle");
      setCheckoutMessage(error instanceof Error ? error.message : "Checkout could not be created.");
      setIsSubmitting(false);
      submitLatchRef.current = false;
    }
  };

  if (createdOrder) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white">
        <SiteHeaderV2 />
        <main className="mx-auto max-w-3xl px-5 pb-24 pt-20 sm:px-6 sm:pt-24 lg:px-12">
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 sm:p-7">
            <CheckoutProgress onPayment />
            <p className="mt-6 text-[10px] uppercase tracking-[0.34em] text-white/35">Almost there</p>
            <h1 className="vl2-serif mt-2.5 text-[1.85rem] leading-tight text-white sm:text-4xl">Send your {createdOrder.method.label} payment</h1>
            <p className="mt-3 text-sm leading-relaxed text-white/50">
              Your order is reserved. Send the exact amount, then submit your payment details below so we can verify and ship it.
            </p>
          </div>

          <div className="mt-6">
            <ManualPaymentInstructions
              method={createdOrder.method}
              orderId={createdOrder.orderId}
              orderNumber={createdOrder.orderNumber}
              amountDue={createdOrder.amountDue}
              onSubmitted={() => clearCart()}
            />
          </div>

          <Link href="/products" className="mt-8 inline-flex text-sm text-white/40 transition hover:text-white">
            Continue shopping
          </Link>
        </main>
      </div>
    );
  }

  const ctaDisabled = isSubmitting || items.length === 0 || !checkoutOpen;
  const ctaLabel = !checkoutOpen
    ? "Checkout opening soon"
    : checkoutState === "loading"
      ? "Creating secure checkout…"
      : selectedMethod && selectedMethod.kind === "manual"
        ? `Continue to ${selectedMethod.label}`
        : "Continue to secure payment";

  // The money rows, rendered identically in the mobile summary and the desktop
  // rail so the two can never drift apart.
  const summaryLines = (
    <div className="space-y-2.5 text-sm">
      <div className="flex justify-between"><span className="text-white/45">Items</span><span className="text-white/70 tabular-nums">{orderCount}</span></div>
      <div className="flex justify-between"><span className="text-white/45">Subtotal</span><span className="text-white/80 tabular-nums">{formatCartCurrency(subtotal)}</span></div>
      <div className="flex justify-between">
        <span className="text-white/45">Shipping</span>
        <span className="text-white/80 tabular-nums">{shipping === 0 && memberFreeShipping ? "Free (member)" : shipping === 0 ? "Free" : formatCartCurrency(shipping)}</span>
      </div>
      {shippingProtectionFee > 0 ? (
        <div className="flex justify-between"><span className="text-white/45">Shipping protection</span><span className="text-white/80 tabular-nums">+{formatCartCurrency(shippingProtectionFee)}</span></div>
      ) : null}
      {taxAmount > 0 ? (
        <div className="flex justify-between">
          <span className="text-white/45">Sales tax{taxQuote.state ? ` · ${taxQuote.state} ${taxQuote.ratePercent}%` : ""}</span>
          <span className="text-white/80 tabular-nums">{formatCartCurrency(taxAmount)}</span>
        </div>
      ) : taxQuote.reason === "no_state" && isDomesticCountry(form.country) && salesTaxConfig.nexusStates.length > 0 ? (
        <div className="flex justify-between"><span className="text-white/45">Sales tax</span><span className="text-white/30">Enter address</span></div>
      ) : null}
      {discountAmount > 0 ? (
        <div className="flex justify-between text-emerald-300"><span>{ambassadorDiscountApplied ? `Ambassador ${ambassadorDiscountPercent}% off` : (appliedDiscountLabel ?? "Discount")}</span><span className="tabular-nums">−{formatCartCurrency(discountAmount)}</span></div>
      ) : null}
      {storeCreditApplied > 0 ? (
        <div className="flex justify-between text-emerald-300"><span>Member store credit</span><span className="tabular-nums">−{formatCartCurrency(storeCreditApplied)}</span></div>
      ) : null}
      {pointsRedeemedDiscount > 0 ? (
        <div className="flex justify-between text-emerald-300"><span>Points redeemed</span><span className="tabular-nums">−{formatCartCurrency(pointsRedeemedDiscount)}</span></div>
      ) : null}
      {cardFee.amount > 0 ? (
        <div className="flex justify-between"><span className="text-white/45">{cardFeeConfig?.label ?? "Card processing fee"} ({cardFee.percentage}%)</span><span className="text-white/80 tabular-nums">+{formatCartCurrency(cardFee.amount)}</span></div>
      ) : null}
      {autoBestDiscountApplied ? (
        <p className="pt-1 text-[11px] text-emerald-300/70">✓ Your best available discount was applied automatically.</p>
      ) : null}
    </div>
  );

  const productLines = items.map((item) => (
    <div key={item.key} className="flex items-start gap-3">
      <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-lg border border-white/[0.06] bg-black/40">
        {item.image ? <Image src={item.image} alt={item.name} fill sizes="56px" className="object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[10px] text-white/30">No image</div>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{item.name}</p>
        {item.doseLabel ? <p className="mt-0.5 text-xs text-white/40">{item.doseLabel}</p> : null}
        <div className="mt-1.5 flex items-center gap-2.5">
          <div className="flex items-center rounded-full border border-white/[0.08] bg-black/30 text-xs text-white/80">
            <button type="button" onClick={() => { haptic(); updateQuantity(item.key, item.quantity - 1); }} className="vl-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-l-full transition hover:text-white active:scale-90" aria-label={`Decrease ${item.name} quantity`}>−</button>
            <span className="min-w-6 text-center font-semibold tabular-nums">{item.quantity}</span>
            <button type="button" onClick={() => { haptic(); updateQuantity(item.key, item.quantity + 1); }} className="vl-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-r-full transition hover:text-white active:scale-90" aria-label={`Increase ${item.name} quantity`}>+</button>
          </div>
          <button type="button" onClick={() => { haptic(12); removeFromCart(item.key); }} className="vl-focus-ring rounded px-1 py-1 text-xs text-white/35 transition hover:text-rose-300" aria-label={`Remove ${item.name} from cart`}>Remove</button>
        </div>
      </div>
      <p className="text-sm text-white/75 tabular-nums">{formatCartCurrency(getBundleDiscountedLineTotal(item.price, item.quantity, bundleConfig))}</p>
    </div>
  ));

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <SiteHeaderV2 />

      {/* pb allows for the sticky mobile CTA bar so nothing is ever covered. */}
      <main className="mx-auto max-w-[1200px] px-5 pb-44 pt-20 sm:px-6 sm:pt-24 lg:px-10 lg:pb-24">
        {/* Compact hero — ~40% shorter than before, so the form starts almost
            immediately on a phone. */}
        <header className="pb-6">
          <p className="text-[10px] uppercase tracking-[0.34em] text-white/35">Secure checkout</p>
          <h1 className="vl2-serif mt-2 text-[1.85rem] leading-[1.1] text-white sm:text-[2.5rem]">Complete your order</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/45">
            Transparent totals, encrypted payment, and full batch traceability.
          </p>
          <div className="mt-5 max-w-md">
            <CheckoutProgress onPayment={checkoutState === "loading" || checkoutState === "success"} />
          </div>
        </header>

        {/* Mobile order summary — collapsed, at the TOP. Previously the summary
            sat below the entire form on mobile, so a shopper couldn't see what
            they were paying without scrolling past every field. */}
        {isHydrated && items.length > 0 ? (
          <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] lg:hidden">
            <button
              type="button"
              onClick={() => setSummaryOpen((open) => !open)}
              aria-expanded={summaryOpen}
              className="vl-focus-ring flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
            >
              <span className="flex items-center gap-2 text-sm text-white/70">
                Order summary
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 text-white/35 transition-transform duration-300 ${summaryOpen ? "rotate-180" : ""}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
              </span>
              <span className="text-base font-semibold text-white tabular-nums">{formatCartCurrency(finalTotal)}</span>
            </button>
            <Collapse open={summaryOpen}>
              <div className="space-y-4 border-t border-white/[0.06] px-4 py-4">
                <div className="space-y-4">{productLines}</div>
                <div className="border-t border-white/[0.06] pt-4">{summaryLines}</div>
              </div>
            </Collapse>
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:gap-8">
          {/* ---------------- Left column: the form ---------------- */}
          <div className="space-y-5">
            <CheckoutSection innerRef={shippingSectionRef} step="01" title="Contact" subtitle="Where we send your receipt and tracking.">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Email"
                  value={form.email}
                  onChange={(v) => handleFieldChange("email", v)}
                  error={formErrors.email}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  readOnly={emailLockedToAccount}
                />
                <TextField
                  label="Phone"
                  value={form.phone}
                  onChange={(v) => handleFieldChange("phone", v)}
                  error={formErrors.phone}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>
              {emailLockedToAccount ? (
                <p className="mt-2 pl-1 text-[11px] text-white/35">Using your account email.</p>
              ) : null}
            </CheckoutSection>

            <CheckoutSection step="02" title="Shipping address" subtitle="United States and Canada.">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Full name"
                  value={form.fullName}
                  onChange={(v) => handleFieldChange("fullName", v)}
                  error={formErrors.fullName}
                  autoComplete="shipping name"
                  className="sm:col-span-2"
                />
                <SelectField
                  label="Country"
                  value={form.country}
                  onChange={(v) => handleFieldChange("country", v)}
                  error={formErrors.country}
                  autoComplete="shipping country-name"
                  className="sm:col-span-2"
                >
                  {COUNTRY_OPTIONS.map((c) => (
                    <option key={c} value={c} className="bg-[#0a0a0a] text-white">{c}</option>
                  ))}
                </SelectField>
                <TextField
                  label="Address"
                  value={form.address}
                  onChange={(v) => handleFieldChange("address", v)}
                  error={formErrors.address}
                  autoComplete="shipping address-line1"
                  className="sm:col-span-2"
                />
                {/* Its own field, not a hint on the line above. An apartment
                    typed into the street line still ships -- the carrier
                    attempts delivery, finds no unit, and the parcel comes back
                    a week later as a return, a refund and a re-ship. */}
                <TextField
                  label="Apartment, suite, unit (optional)"
                  value={form.address2}
                  onChange={(v) => handleFieldChange("address2", v)}
                  autoComplete="shipping address-line2"
                  className="sm:col-span-2"
                  maxLength={120}
                />
                <TextField
                  label="City"
                  value={form.city}
                  onChange={(v) => handleFieldChange("city", v)}
                  error={formErrors.city}
                  autoComplete="shipping address-level2"
                />
                {isUnitedStates(form.country) ? (
                  <SelectField
                    label="State"
                    value={form.state}
                    onChange={(v) => handleFieldChange("state", v)}
                    error={formErrors.state}
                    autoComplete="shipping address-level1"
                  >
                    <option value="" className="bg-[#0a0a0a] text-white/50">Select…</option>
                    {US_STATE_OPTIONS.map((s) => (
                      <option key={s} value={s} className="bg-[#0a0a0a] text-white">{s}</option>
                    ))}
                  </SelectField>
                ) : (
                  <TextField
                    label="Province / region"
                    value={form.state}
                    onChange={(v) => handleFieldChange("state", v)}
                    error={formErrors.state}
                    autoComplete="shipping address-level1"
                  />
                )}
                <TextField
                  label={isUnitedStates(form.country) ? "ZIP code" : "Postal code"}
                  value={form.postalCode}
                  onChange={(v) => handleFieldChange("postalCode", v)}
                  error={formErrors.postalCode}
                  // A numeric keypad for US ZIPs; Canadian codes are alphanumeric
                  // so they keep the full keyboard.
                  inputMode={isUnitedStates(form.country) ? "numeric" : "text"}
                  autoComplete="shipping postal-code"
                  autoCapitalize="characters"
                  className="sm:col-span-2"
                />
              </div>

              <p className="mt-4 flex items-center gap-2 text-[11px] text-white/35">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 flex-shrink-0" aria-hidden><path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" strokeLinejoin="round" /><circle cx="7" cy="17" r="1.5" /><circle cx="17.5" cy="17" r="1.5" /></svg>
                {isDomesticCountry(form.country)
                  ? `Standard secure shipping — free at ${formatCartCurrency(shippingConfig.freeShippingThreshold)}+, otherwise ${formatCartCurrency(shippingConfig.domesticFee)}.`
                  : `Secure Canada shipping — free at ${formatCartCurrency(shippingConfig.northAmericaFreeShippingThreshold)}+, otherwise ${formatCartCurrency(shippingConfig.northAmericaFee)}.`}
              </p>

              {/* Shipping protection lives HERE, next to shipping, and must stay
                  rendered wherever its fee is charged: the fee is added to the
                  order total, so removing the control would bill a shopper for
                  something they can't decline. */}
              {subtotal > 0 ? (
                <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3.5">
                    <input
                      type="checkbox"
                      checked={shippingProtectionEnabled}
                      onChange={(e) => { haptic(); setShippingProtectionEnabled(e.target.checked); }}
                      className="h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-[color:var(--accent-gold)]"
                      aria-label="Add shipping protection"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-white">Shipping protection</span>
                      <span className="block text-xs text-white/40">Protect against loss, theft, or damage.</span>
                    </span>
                    <span className="flex-shrink-0 text-sm text-white/70 tabular-nums">+{formatCartCurrency(calculateShippingProtectionFee(subtotal))}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setProtectionOpen((o) => !o)}
                    aria-expanded={protectionOpen}
                    className="vl-focus-ring px-4 pb-1 text-[11px] text-white/35 underline-offset-2 hover:text-white/60"
                  >
                    {protectionOpen ? "Hide details" : "View details"}
                  </button>
                  <Collapse open={protectionOpen}>
                    <p className="px-4 pb-4 pt-1 text-xs leading-relaxed text-white/40">
                      Store-backed coverage: we&apos;ll replace or refund items lost, stolen, or damaged in transit.{" "}
                      <a href="/legal/shipping" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-white/70">See terms</a>
                    </p>
                  </Collapse>
                </div>
              ) : null}
            </CheckoutSection>

            <CheckoutSection step="03" title="Billing" subtitle="Must match your payment method.">
              <label className="flex cursor-pointer items-center gap-3 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={sameAsShipping}
                  onChange={(e) => { haptic(); setSameAsShipping(e.target.checked); }}
                  className="h-[1.15rem] w-[1.15rem] accent-[color:var(--accent-gold)]"
                />
                Same as shipping address
              </label>

              <Collapse open={!sameAsShipping}>
                <div className="grid gap-4 pt-4 sm:grid-cols-2">
                  <TextField label="Billing full name" value={form.billingFullName} onChange={(v) => handleFieldChange("billingFullName", v)} error={formErrors.billingFullName} autoComplete="billing name" className="sm:col-span-2" />
                  <TextField label="Billing address" value={form.billingAddress} onChange={(v) => handleFieldChange("billingAddress", v)} error={formErrors.billingAddress} autoComplete="billing street-address" className="sm:col-span-2" />
                  <TextField label="Billing city" value={form.billingCity} onChange={(v) => handleFieldChange("billingCity", v)} error={formErrors.billingCity} autoComplete="billing address-level2" />
                  <TextField label="Billing postal code" value={form.billingPostalCode} onChange={(v) => handleFieldChange("billingPostalCode", v)} error={formErrors.billingPostalCode} autoComplete="billing postal-code" autoCapitalize="characters" />
                  <TextField label="Billing country" value={form.billingCountry} onChange={(v) => handleFieldChange("billingCountry", v)} error={formErrors.billingCountry} autoComplete="billing country-name" className="sm:col-span-2" />
                </div>
              </Collapse>
            </CheckoutSection>

            {/* Savings — collapsed by default. A prominent empty promo field is a
                known leak: it tells shoppers a discount exists that they don't
                have, and sends them off-site to hunt for codes. */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015]">
              <button
                type="button"
                onClick={() => setSavingsOpen((o) => !o)}
                aria-expanded={savingsOpen}
                className="vl-focus-ring flex w-full items-center justify-between px-5 py-4 text-left sm:px-6"
              >
                <span className="text-sm text-white/70">
                  {isSignedIn ? "Referral, coupon, or rewards points?" : "Have a referral or coupon code?"}
                </span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 text-white/35 transition-transform duration-300 ${savingsOpen ? "rotate-180" : ""}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
              </button>
              <Collapse open={savingsOpen}>
                <div className="space-y-5 px-5 pb-5 sm:px-6 sm:pb-6">
                  {/* Referral */}
                  <div>
                    <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-white/35">Referral code</p>
                    {isBuy3Get1FreeActive ? (
                      <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5 text-xs text-white/55">
                        Buy 3 Get 1 Free is active — referral discounts can&apos;t be combined with it.
                      </p>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={effectiveReferralInput}
                          onChange={(event) => setReferralInput(event.target.value)}
                          aria-label="Referral code"
                          placeholder="VANTA10"
                          autoCapitalize="characters"
                          className="w-full flex-1 rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-[16px] text-white outline-none transition placeholder:text-white/25 focus:border-white/40 focus:shadow-[0_0_0_4px_rgba(255,255,255,0.05)]"
                        />
                        <button type="button" onClick={() => applyReferralCode(effectiveReferralInput)} disabled={isApplyingReferral} className="vl-focus-ring flex-shrink-0 rounded-xl border border-white/[0.12] bg-white/[0.04] px-5 text-xs font-semibold uppercase tracking-wide text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50">
                          {isApplyingReferral ? "…" : "Apply"}
                        </button>
                      </div>
                    )}
                    {referralSuccess ? <p className="mt-2 text-xs text-emerald-300">{referralSuccess}</p> : null}
                    {referralError ? <p className="mt-2 text-xs text-rose-300">{referralError}</p> : null}
                    {referralDetails ? <p className="mt-2 text-xs text-white/45">{referralDetails.ambassadorName} · {referralDetails.customerDiscountPercent}% off</p> : null}
                    {referralCode && !isBuy3Get1FreeActive ? (
                      <button type="button" onClick={() => { clearReferralCode(); setReferralInput(""); }} className="vl-focus-ring mt-2 text-xs text-white/35 transition hover:text-white">Remove code</button>
                    ) : null}
                  </div>

                  {/* Coupon */}
                  <div>
                    <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-white/35">Coupon code</p>
                    {isBuy3Get1FreeActive ? (
                      <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5 text-xs text-white/55">
                        Buy 3 Get 1 Free is active — coupons can&apos;t be combined with it.
                      </p>
                    ) : referralCode ? (
                      <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5 text-xs text-white/55">
                        A referral code is applied. Remove it to use a coupon instead.
                      </p>
                    ) : (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={effectiveCouponInput}
                          onChange={(event) => setCouponInput(event.target.value)}
                          aria-label="Coupon code"
                          placeholder="SAVE10"
                          autoCapitalize="characters"
                          className="w-full flex-1 rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-[16px] text-white outline-none transition placeholder:text-white/25 focus:border-white/40 focus:shadow-[0_0_0_4px_rgba(255,255,255,0.05)]"
                        />
                        <button type="button" onClick={() => applyCouponCode(effectiveCouponInput)} disabled={isApplyingCoupon} className="vl-focus-ring flex-shrink-0 rounded-xl border border-white/[0.12] bg-white/[0.04] px-5 text-xs font-semibold uppercase tracking-wide text-white/80 transition hover:bg-white/[0.08] disabled:opacity-50">
                          {isApplyingCoupon ? "…" : "Apply"}
                        </button>
                      </div>
                    )}
                    {couponSuccess ? <p className="mt-2 text-xs text-emerald-300">{couponSuccess}</p> : null}
                    {couponError ? <p className="mt-2 text-xs text-rose-300">{couponError}</p> : null}
                    {couponDetails ? (
                      <p className="mt-2 text-xs text-white/45">{couponDetails.code} · {couponDetails.discountType === "fixed" ? formatCartCurrency(couponDetails.discountValue) : `${couponDetails.discountValue}%`} off</p>
                    ) : null}
                    {couponCode && !isBuy3Get1FreeActive ? (
                      <button type="button" onClick={() => { clearCouponCode(); setCouponInput(""); }} className="vl-focus-ring mt-2 text-xs text-white/35 transition hover:text-white">Remove code</button>
                    ) : null}
                  </div>

                  {/* Points */}
                  {isSignedIn ? (
                    <div>
                      <p className="mb-2 text-[10px] uppercase tracking-[0.24em] text-white/35">Rewards points</p>
                      <p className="text-xs text-white/45">
                        <span className="text-white/80">{pointsBalance.toLocaleString()}</span> available ({formatCartCurrency(pointsBalance / 100)} value).
                      </p>
                      {referralDetails ? (
                        <p className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5 text-xs text-white/55">
                          A referral code is applied. Remove it to redeem points.
                        </p>
                      ) : pointsBalance > 0 ? (
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="number"
                            aria-label="Points to redeem"
                            min={0}
                            max={pointsBalance}
                            inputMode="numeric"
                            value={pointsToRedeem || ""}
                            onChange={(event) => setPointsToRedeem(Number(event.target.value) || 0)}
                            placeholder="0"
                            className="w-32 rounded-xl border border-white/[0.10] bg-black/30 px-4 py-3 text-[16px] text-white outline-none transition placeholder:text-white/25 focus:border-white/40 focus:shadow-[0_0_0_4px_rgba(255,255,255,0.05)]"
                          />
                          <button type="button" onClick={() => setPointsToRedeem(pointsBalance)} className="vl-focus-ring rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 py-3 text-xs font-semibold uppercase tracking-wide text-white/80 transition hover:bg-white/[0.08]">Use max</button>
                          {pointsToRedeem > 0 ? <span className="text-xs text-emerald-300 tabular-nums">−{formatCartCurrency(pointsRedeemedDiscount)}</span> : null}
                        </div>
                      ) : null}
                      {pointsToEarn > 0 ? <p className="mt-2 text-[11px] text-white/35">You&apos;ll earn ~{pointsToEarn.toLocaleString()} points on this order.</p> : null}
                    </div>
                  ) : (
                    <p className="text-xs text-white/40">
                      <Link href="/account/login" className="text-white/70 underline underline-offset-4 hover:text-white">Sign in</Link> to earn and redeem rewards points.
                    </p>
                  )}
                </div>
              </Collapse>
            </div>

            {/* Required confirmations — compact rows, full legal text on demand */}
            <CheckoutSection innerRef={confirmationsRef} step="04" title="Required confirmations" subtitle="All three are required to place a research order.">
              <div className="overflow-hidden rounded-xl border border-white/[0.06]">
                <div className="flex items-center justify-between bg-white/[0.02] px-4 py-2.5">
                  <span className="text-[11px] text-white/40">Confirm to continue</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${allAcknowledged ? "bg-[color:var(--accent-gold)]/20 text-[color:var(--accent-gold-strong)]" : "bg-white/[0.06] text-white/50"}`}>
                    {acknowledgedCount} of {REQUIRED_CONFIRMATIONS.length}
                  </span>
                </div>
                <div className="divide-y divide-white/[0.05]">
                  {REQUIRED_CONFIRMATIONS.map((item) => (
                    <div key={item.key} className="px-4 py-3">
                      <label className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={acknowledgements[item.key]}
                          onChange={(event) => handleAcknowledgementChange(item.key, event.target.checked)}
                          className="h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-[color:var(--accent-gold)]"
                        />
                        <span className="flex-1 text-sm text-white/85">{item.short}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); setOpenLegal((prev) => ({ ...prev, [item.key]: !prev[item.key] })); }}
                          className="vl-focus-ring flex-shrink-0 rounded px-1 text-[11px] text-white/35 underline-offset-2 hover:text-white/70"
                          aria-expanded={Boolean(openLegal[item.key])}
                        >
                          {openLegal[item.key] ? "Hide" : "View details"}
                        </button>
                      </label>
                      <Collapse open={Boolean(openLegal[item.key])}>
                        <p className="pl-8 pr-1 pt-2 text-xs leading-relaxed text-white/40">{item.body}</p>
                      </Collapse>
                    </div>
                  ))}
                </div>
              </div>

              <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-white/60">
                <input type="checkbox" checked={marketingOptIn} onChange={(e) => { haptic(); setMarketingTouched(true); setMarketingChoice(e.target.checked); }} className="mt-0.5 h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-[color:var(--accent-gold)]" />
                <span className="text-xs leading-relaxed">Email me exclusive offers, coupons &amp; restock alerts. <span className="text-white/30">Optional — unsubscribe anytime.</span></span>
              </label>

              <p className="mt-4 text-[11px] leading-relaxed text-white/30">
                By placing your order, you agree to our{" "}
                <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="text-white/50 underline underline-offset-2 hover:text-white">Terms &amp; Conditions</a>{" "}
                and{" "}
                <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-white/50 underline underline-offset-2 hover:text-white">Privacy Policy</a>.
              </p>
            </CheckoutSection>
          </div>

          {/* ---------------- Right column: summary (sticky on desktop) ------- */}
          <aside className="hidden h-fit lg:sticky lg:top-24 lg:block">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
              <p className="text-[10px] uppercase tracking-[0.28em] text-white/35">Order summary</p>

              {!isHydrated ? (
                // Don't flash "No items in cart" before localStorage hydrates — a
                // refresh mid-checkout would otherwise look like a lost cart.
                <div className="mt-5 space-y-3">
                  {[0, 1].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="vl-skeleton h-14 w-14 flex-shrink-0 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <div className="vl-skeleton h-3 w-2/3 rounded" />
                        <div className="vl-skeleton h-3 w-1/3 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed border-white/[0.10] p-6 text-center text-sm text-white/35">No items in cart.</div>
              ) : (
                <div className="mt-5 space-y-4 border-b border-white/[0.06] pb-5">{productLines}</div>
              )}

              <div className="mt-5">{summaryLines}</div>

              <div className="my-5 h-px bg-white/[0.06]" />

              <div className="flex items-end justify-between">
                <span className="text-xs uppercase tracking-[0.24em] text-white/40">Total</span>
                <span className="text-[2rem] font-semibold leading-none tracking-tight text-white tabular-nums">{formatCartCurrency(finalTotal)}</span>
              </div>

              {totalSaved > 0 ? (
                <p className="mt-3 flex justify-between rounded-xl bg-emerald-400/[0.08] px-3.5 py-2 text-sm font-medium text-emerald-300">
                  <span>You saved</span><span className="tabular-nums">{formatCartCurrency(totalSaved)}</span>
                </p>
              ) : null}

              {selectedMethod && selectedMethod.kind === "manual" ? (
                <p className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] py-2 text-center text-xs text-emerald-300">
                  No processing fee with {selectedMethod.label}
                </p>
              ) : null}

              {/* Payment method chooser — shown only when more than one method is
                  enabled (today card is the only one, so this stays hidden until a
                  manual method like Cash App / Zelle is turned on in admin). The
                  server honors the chosen method authoritatively. */}
              {paymentMethods.length > 1 ? (
                <div className="mt-5">
                  <PaymentMethodPicker
                    methods={paymentMethods}
                    cardFeeConfig={cardFeeConfig}
                    baseTotal={total}
                    selectedMethodId={selectedMethodId}
                    onSelect={setSelectedMethodId}
                  />
                </div>
              ) : null}

              {!checkoutOpen ? (
                <div className="mt-5 rounded-xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] p-4 text-sm" role="status">
                  <p className="font-semibold text-[color:var(--accent-gold)]">Checkout is opening soon</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/50">
                    We&apos;re finalizing secure payment setup. Your cart is saved — no charge is made until then.
                  </p>
                </div>
              ) : null}

              <button
                type="button"
                onClick={handleCheckout}
                disabled={ctaDisabled}
                className="vl-focus-ring mt-5 flex w-full items-center justify-center gap-2.5 rounded-full bg-white px-6 py-4 text-sm font-semibold tracking-wide text-black transition hover:bg-zinc-200 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
              >
                {checkoutState === "loading" ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/25 border-t-black" aria-hidden />
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" strokeLinejoin="round" /></svg>
                )}
                {ctaLabel}
              </button>

              {checkoutMessage ? <p className="mt-3 text-sm text-white/60" role="alert">{checkoutMessage}</p> : null}

              <TrustRow className="mt-6 border-t border-white/[0.06] pt-5" />

              <Link href="/cart" className="mt-5 inline-flex text-xs text-white/35 transition hover:text-white">
                ← Back to cart
              </Link>
            </div>
          </aside>
        </div>

        {/* Mobile trust row — the desktop rail is hidden here, so trust signals
            still land immediately before the sticky CTA. */}
        <div className="mt-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-5 lg:hidden">
          <TrustRow />
          <Link href="/cart" className="mt-5 inline-flex text-xs text-white/35 transition hover:text-white">← Back to cart</Link>
        </div>
      </main>

      {/* Sticky mobile CTA — the primary action is always within thumb reach. */}
      {isHydrated && items.length > 0 ? (
        <div className="vl-bottom-bar fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.06] bg-[#0a0a0a]/95 px-5 pt-3.5 pb-[max(env(safe-area-inset-bottom),0.875rem)] backdrop-blur-2xl lg:hidden">
          {!checkoutOpen ? (
            <p className="mb-2 text-center text-[11px] text-[color:var(--accent-gold)]">Checkout is opening soon — your cart is saved.</p>
          ) : checkoutMessage ? (
            <p className="mb-2 text-center text-[11px] text-rose-300" role="alert">{checkoutMessage}</p>
          ) : null}
          <div className="mb-2.5 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.24em] text-white/40">Total</span>
            <span className="text-xl font-semibold text-white tabular-nums">{formatCartCurrency(finalTotal)}</span>
          </div>
          <button
            type="button"
            onClick={handleCheckout}
            disabled={ctaDisabled}
            className="vl-focus-ring flex w-full items-center justify-center gap-2.5 rounded-full bg-white px-6 py-4 text-sm font-semibold tracking-wide text-black transition hover:bg-zinc-200 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checkoutState === "loading" ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-black/25 border-t-black" aria-hidden />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" strokeLinejoin="round" /></svg>
            )}
            {ctaLabel}
          </button>
          <p className="mt-2 text-center text-[10px] text-white/25">
            {EXPRESS_CHECKOUT_ENABLED ? "Apple Pay · Visa · Mastercard · Amex · Discover" : "Visa · Mastercard · Amex · Discover"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
