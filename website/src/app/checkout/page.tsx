"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";
import { calculateShipping, isDomesticCountry } from "@/lib/shipping";
import { EXPRESS_CHECKOUT_ENABLED } from "@/lib/express-checkout";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { pointsToDollars } from "@/lib/points-math";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ManualPaymentInstructions } from "@/components/manual-payment-instructions";
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

type CheckoutForm = {
  fullName: string;
  email: string;
  phone: string;
  address: string;
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

function StepPill({
  index,
  label,
  active,
}: {
  index: number;
  label: string;
  active?: boolean;
}) {
  return (
    <div className={`border px-3 py-1.5 text-xs uppercase tracking-[0.16em] ${active ? "border-white bg-white/10 text-white" : "border-white/15 text-white/70"}`}>
      {index}. {label}
    </div>
  );
}

export default function CheckoutPage() {
  const {
    items,
    subtotal,
    discountAmount,
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
    pointsBalance,
    pointsToEarn,
    pointsToRedeem,
    setPointsToRedeem,
    setKnownEmail,
    clearCart,
    bulkSavingsTierReached,
    ambassadorDiscountApplied,
    ambassadorDiscountPercent,
    memberFreeShipping,
    storeCreditBalanceCents,
    storeCreditMinOrderCents,
    taxAmount,
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
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [form, setForm] = useState<CheckoutForm>({
    fullName: "",
    email: "",
    phone: "",
    address: "",
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
  // Lets a failed validation scroll the shopper back up to the form fields
  // (with their inline errors) instead of leaving them at the submit button.
  const shippingSectionRef = useRef<HTMLElement | null>(null);
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
        },
      }),
    );
  }, [items.length, subtotal, total]);

  useEffect(() => {
    if (/^\S+@\S+\.\S+$/.test(form.email)) {
      setKnownEmail(form.email);
    }
  }, [form.email, setKnownEmail]);

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
    setAcknowledgements((prev) => ({ ...prev, [key]: checked }));
  };

  const handleCheckout = async () => {
    if (items.length === 0) {
      setCheckoutMessage("Your cart is empty.");
      return;
    }

    const errors = validateCheckoutForm(form, sameAsShipping);
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      setCheckoutMessage("Please complete all required fields before placing your order.");
      // Bring the shopper back to the fields (and their inline errors); on a
      // long mobile form the generic message sits below the fold otherwise.
      shippingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (Object.values(acknowledgements).some((value) => !value)) {
      setCheckoutMessage("Please confirm all required research and legal acknowledgements before placing the order.");
      return;
    }

    if (isSubmitting || submitLatchRef.current) return;
    submitLatchRef.current = true;

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
        pointsToRedeem: pointsToRedeem > 0 ? pointsToRedeem : undefined,
        shippingProtection: shippingProtectionEnabled,
        marketingOptIn,
        expectedTotal: total,
        paymentMethod: selectedMethodId || undefined,
        complianceAcknowledgements: acknowledgements,
      };

      const result = await createSecureCheckoutSession(payload);

      // Manual (non-card) methods: stay on-page and show the payment
      // instructions panel. None ship enabled today (card only), so this branch
      // is dormant unless a manual method is re-enabled in config.
      if (result.isManualPayment) {
        const method = getPaymentMethodById(paymentMethods, result.paymentMethod) ?? selectedMethod;
        if (method) {
          setCreatedOrder({
            orderId: result.orderId,
            orderNumber: result.orderNumber,
            method,
            amountDue: Number(result.total ?? finalTotal),
          });
          if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
      }

      // Card: continue to the secure processor flow when one is connected.
      // Otherwise (test mode / no live processor) treat the order as placed:
      // clear the cart and send the shopper to the confirmation page so they
      // always get a proper thank-you + order number instead of a dead end.
      if (result.hostedCheckoutUrl) {
        window.location.assign(result.hostedCheckoutUrl);
      } else {
        clearCart();
        window.location.assign(`/order-confirmation/${result.orderId}`);
      }
    } catch (error) {
      setCheckoutState("idle");
      setCheckoutMessage(error instanceof Error ? error.message : "Checkout could not be created.");
    } finally {
      setIsSubmitting(false);
      submitLatchRef.current = false;
    }
  };

  if (createdOrder) {
    return (
      <div className="min-h-screen bg-[#0b0b0b] text-white">
        <SiteHeaderV2 />
        <main className="mx-auto max-w-3xl px-6 pb-20 pt-24 sm:pt-32 lg:px-12">
          <section className="border border-white/10 p-5 sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              <StepPill index={1} label="Cart" active />
              <StepPill index={2} label="Shipping" active />
              <StepPill index={3} label="Payment" active />
              <StepPill index={4} label="Confirmation" />
            </div>
            <p className="vl2-eyebrow mt-5">Almost there</p>
            <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Send your {createdOrder.method.label} payment</h1>
            <p className="mt-3 text-sm leading-7 text-white/60">
              Your order is reserved. Send the exact amount, then submit your payment details below so we can verify and
              ship it.
            </p>
          </section>

          <div className="mt-7">
            <ManualPaymentInstructions
              method={createdOrder.method}
              orderId={createdOrder.orderId}
              orderNumber={createdOrder.orderNumber}
              amountDue={createdOrder.amountDue}
              onSubmitted={() => clearCart()}
            />
          </div>

          <Link href="/products" className="mt-8 inline-flex text-sm text-white/45 transition hover:text-white">
            Continue shopping
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-[1440px] px-4 sm:px-6 pb-20 pt-24 sm:pt-32 lg:px-12">
        <section className="border border-white/10 p-5 sm:p-8">
          <p className="vl2-eyebrow">Secure Checkout</p>
          <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Complete your order</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-white/60 sm:text-base">
            Transparent totals, encrypted payment processing, and full batch traceability from cart to confirmation.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <StepPill index={1} label="Cart" active />
            <StepPill index={2} label="Shipping" active />
            <StepPill index={3} label="Payment" active={checkoutState === "loading" || checkoutState === "success"} />
            <StepPill index={4} label="Confirmation" active={checkoutState === "success"} />
          </div>
        </section>

        <div className="mt-7 grid gap-7 lg:grid-cols-[1.05fr_0.95fr]">
          <section ref={shippingSectionRef} className="border border-white/10 p-5 sm:p-7">
            <div>
              <p className="vl2-eyebrow">Shipping Information</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm text-white/60 sm:col-span-2">
                  <span className="mb-2 block">Full name</span>
                  <input value={form.fullName} onChange={(e) => handleFieldChange("fullName", e.target.value)} autoComplete="shipping name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" placeholder="Alex Morgan" />
                  {formErrors.fullName ? <span className="mt-1 block text-xs text-rose-300">{formErrors.fullName}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Email</span>
                  <input type="email" value={form.email} onChange={(e) => handleFieldChange("email", e.target.value)} readOnly={emailLockedToAccount} aria-readonly={emailLockedToAccount} autoComplete="email" className={emailLockedToAccount ? "w-full cursor-not-allowed border border-white/15 bg-black/60 px-4 py-3 text-white/70 outline-none" : "w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50"} placeholder="alex@domain.com" title={emailLockedToAccount ? "Your order uses your account email" : "Where we'll send your order confirmation"} />
                  {formErrors.email ? <span className="mt-1 block text-xs text-rose-300">{formErrors.email}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Phone</span>
                  <input type="tel" value={form.phone} onChange={(e) => handleFieldChange("phone", e.target.value)} autoComplete="tel" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" placeholder="(555) 123-4567" title="Carriers require a phone number for delivery" />
                  {formErrors.phone ? <span className="mt-1 block text-xs text-rose-300">{formErrors.phone}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Country</span>
                  <select value={form.country} onChange={(e) => handleFieldChange("country", e.target.value)} autoComplete="shipping country-name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition focus:border-white/50">
                    {COUNTRY_OPTIONS.map((c) => (
                      <option key={c} value={c} className="bg-black text-white">{c}</option>
                    ))}
                  </select>
                  {formErrors.country ? <span className="mt-1 block text-xs text-rose-300">{formErrors.country}</span> : null}
                </label>

                <label className="text-sm text-white/60 sm:col-span-2">
                  <span className="mb-2 block">Address</span>
                  <input value={form.address} onChange={(e) => handleFieldChange("address", e.target.value)} autoComplete="shipping street-address" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" placeholder="88 Meridian Avenue" />
                  {formErrors.address ? <span className="mt-1 block text-xs text-rose-300">{formErrors.address}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">City</span>
                  <input value={form.city} onChange={(e) => handleFieldChange("city", e.target.value)} autoComplete="shipping address-level2" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" placeholder="Austin" />
                  {formErrors.city ? <span className="mt-1 block text-xs text-rose-300">{formErrors.city}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">{isUnitedStates(form.country) ? "State" : "State / Province"}</span>
                  {isUnitedStates(form.country) ? (
                    <select value={form.state} onChange={(e) => handleFieldChange("state", e.target.value)} autoComplete="shipping address-level1" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white outline-none transition focus:border-white/50">
                      <option value="" className="bg-black text-white/50">Select…</option>
                      {US_STATE_OPTIONS.map((s) => (
                        <option key={s} value={s} className="bg-black text-white">{s}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={form.state} onChange={(e) => handleFieldChange("state", e.target.value)} autoComplete="shipping address-level1" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" placeholder="Region / Province" />
                  )}
                  {formErrors.state ? <span className="mt-1 block text-xs text-rose-300">{formErrors.state}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Postal code</span>
                  <input value={form.postalCode} onChange={(e) => handleFieldChange("postalCode", e.target.value)} autoComplete="shipping postal-code" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" placeholder="78701" />
                  {formErrors.postalCode ? <span className="mt-1 block text-xs text-rose-300">{formErrors.postalCode}</span> : null}
                </label>
              </div>
            </div>

            <div className="mt-8">
              <p className="vl2-eyebrow">Billing Information</p>
              <label className="mt-3 flex items-center gap-2 text-sm text-white/60">
                <input type="checkbox" checked={sameAsShipping} onChange={(e) => setSameAsShipping(e.target.checked)} className="h-4 w-4 border-white/25 bg-black/40" />
                Same as shipping address
              </label>

              {!sameAsShipping ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-white/60 sm:col-span-2">
                    <span className="mb-2 block">Billing full name</span>
                    <input value={form.billingFullName} onChange={(e) => handleFieldChange("billingFullName", e.target.value)} autoComplete="billing name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                    {formErrors.billingFullName ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingFullName}</span> : null}
                  </label>
                  <label className="text-sm text-white/60 sm:col-span-2">
                    <span className="mb-2 block">Billing address</span>
                    <input value={form.billingAddress} onChange={(e) => handleFieldChange("billingAddress", e.target.value)} autoComplete="billing street-address" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                    {formErrors.billingAddress ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingAddress}</span> : null}
                  </label>
                  <label className="text-sm text-white/60">
                    <span className="mb-2 block">Billing city</span>
                    <input value={form.billingCity} onChange={(e) => handleFieldChange("billingCity", e.target.value)} autoComplete="billing address-level2" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                    {formErrors.billingCity ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingCity}</span> : null}
                  </label>
                  <label className="text-sm text-white/60">
                    <span className="mb-2 block">Billing postal code</span>
                    <input value={form.billingPostalCode} onChange={(e) => handleFieldChange("billingPostalCode", e.target.value)} autoComplete="billing postal-code" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                    {formErrors.billingPostalCode ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingPostalCode}</span> : null}
                  </label>
                  <label className="text-sm text-white/60 sm:col-span-2">
                    <span className="mb-2 block">Billing country</span>
                    <input value={form.billingCountry} onChange={(e) => handleFieldChange("billingCountry", e.target.value)} autoComplete="billing country-name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                    {formErrors.billingCountry ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingCountry}</span> : null}
                  </label>
                </div>
              ) : null}
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="border border-white/10 p-4">
                <p className="vl2-eyebrow">Shipping Method</p>
                <p className="mt-2 text-sm text-white">
                  {isDomesticCountry(form.country) ? "Standard secure shipping" : "Secure Canada shipping"}
                </p>
                <p className="mt-1 text-xs text-white/45">
                  {isDomesticCountry(form.country)
                    ? `Free at ${formatCartCurrency(shippingConfig.freeShippingThreshold)}+, otherwise flat ${formatCartCurrency(shippingConfig.domesticFee)} in the USA.`
                    : `Free at ${formatCartCurrency(shippingConfig.northAmericaFreeShippingThreshold)}+, otherwise flat ${formatCartCurrency(shippingConfig.northAmericaFee)} to Canada.`}
                </p>
              </div>
              <div className="border border-white/10 p-4">
                <p className="vl2-eyebrow">Security</p>
                <p className="mt-2 text-sm text-white">Encrypted checkout session</p>
                <p className="mt-1 text-xs text-white/45">Payment credentials are handled by secure provider flow.</p>
              </div>
            </div>

            <div className="mt-8">
              <p className="vl2-eyebrow">Promo / Referral</p>
              {isBuy3Get1FreeActive ? (
                <p className="mt-3 border border-white/20 px-3 py-2 text-sm text-white/75">
                  Buy 3 Get 1 Free is active. Referral discounts cannot be combined with this promotion.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input type="text" value={effectiveReferralInput} onChange={(event) => setReferralInput(event.target.value)} aria-label="Referral code" placeholder="VANTA10" className="w-full flex-1 border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                  <button type="button" onClick={() => applyReferralCode(effectiveReferralInput)} disabled={isApplyingReferral} className="vl2-btn-secondary vl-focus-ring px-4 py-3 text-sm disabled:opacity-60">{isApplyingReferral ? "Applying…" : "Apply"}</button>
                </div>
              )}

              {referralSuccess ? <p className="mt-2 text-sm text-emerald-300">{referralSuccess}</p> : null}
              {referralError ? <p className="mt-2 text-sm text-rose-300">{referralError}</p> : null}
              {referralDetails ? <p className="mt-2 text-sm text-white/60">Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% discount</p> : null}
              {referralCode && !isBuy3Get1FreeActive ? (
                <button
                  type="button"
                  onClick={() => {
                    clearReferralCode();
                    setReferralInput("");
                  }}
                  className="mt-2 text-sm text-white/45 transition hover:text-white"
                >
                  Remove code
                </button>
              ) : null}
            </div>

            <div className="mt-8">
              <p className="vl2-eyebrow">Coupon Code</p>
              {isBuy3Get1FreeActive ? (
                <p className="mt-3 border border-white/20 px-3 py-2 text-sm text-white/75">
                  Buy 3 Get 1 Free is active. Coupon codes cannot be combined with this promotion.
                </p>
              ) : referralCode ? (
                <p className="mt-3 border border-white/20 px-3 py-2 text-sm text-white/75">
                  A referral code is applied. Remove it to use a coupon instead.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input type="text" value={effectiveCouponInput} onChange={(event) => setCouponInput(event.target.value)} aria-label="Coupon code" placeholder="SAVE10" className="w-full flex-1 border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/60 outline-none transition focus:border-white/50" />
                  <button type="button" onClick={() => applyCouponCode(effectiveCouponInput)} disabled={isApplyingCoupon} className="vl2-btn-secondary vl-focus-ring px-4 py-3 text-sm disabled:opacity-60">{isApplyingCoupon ? "Applying…" : "Apply"}</button>
                </div>
              )}

              {couponSuccess ? <p className="mt-2 text-sm text-emerald-300">{couponSuccess}</p> : null}
              {couponError ? <p className="mt-2 text-sm text-rose-300">{couponError}</p> : null}
              {couponDetails ? (
                <p className="mt-2 text-sm text-white/60">
                  {couponDetails.code} • {couponDetails.discountType === "fixed" ? formatCartCurrency(couponDetails.discountValue) : `${couponDetails.discountValue}%`} off
                </p>
              ) : null}
              {couponCode && !isBuy3Get1FreeActive ? (
                <button
                  type="button"
                  onClick={() => {
                    clearCouponCode();
                    setCouponInput("");
                  }}
                  className="mt-2 text-sm text-white/45 transition hover:text-white"
                >
                  Remove code
                </button>
              ) : null}
            </div>

            {isSignedIn ? (
              <div className="mt-8">
                <p className="vl2-eyebrow">Rewards Points</p>
                <p className="mt-2 text-sm text-white/60">
                  You have <span className="text-white">{pointsBalance.toLocaleString()}</span> points available
                  ({formatCartCurrency(pointsBalance / 100)} value).
                </p>
                {referralDetails ? (
                  <p className="mt-3 border border-white/20 px-3 py-2 text-sm text-white/75">
                    A referral code is applied. Remove it to redeem points on this order.
                  </p>
                ) : pointsBalance > 0 ? (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      type="number"
                      aria-label="Points to redeem"
                      min={0}
                      max={pointsBalance}
                      value={pointsToRedeem || ""}
                      onChange={(event) => setPointsToRedeem(Number(event.target.value) || 0)}
                      placeholder="0"
                      className="w-full border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/60 outline-none transition focus:border-white/50 sm:w-40"
                    />
                    <button
                      type="button"
                      onClick={() => setPointsToRedeem(pointsBalance)}
                      className="vl2-btn-secondary vl-focus-ring px-4 py-2 text-xs"
                    >
                      Use max
                    </button>
                    {pointsToRedeem > 0 ? (
                      <span className="text-xs text-emerald-300">-{formatCartCurrency(pointsRedeemedDiscount)}</span>
                    ) : null}
                  </div>
                ) : null}
                {pointsToEarn > 0 ? (
                  <p className="mt-2 text-xs text-white/70">You&apos;ll earn ~{pointsToEarn.toLocaleString()} points on this order.</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-8 text-xs text-white/70">
                <Link href="/account/login" className="text-white/70 underline-offset-4 hover:underline">Sign in</Link> to earn and redeem rewards points on this order.
              </p>
            )}

            <div className="mt-8 space-y-4">
              <p className="vl2-eyebrow">Required Confirmations</p>

              <label className="flex items-start gap-3 border border-white/10 p-4 text-sm text-white/60">
                <input
                  type="checkbox"
                  checked={acknowledgements.researchResponsibility}
                  onChange={(event) => handleAcknowledgementChange("researchResponsibility", event.target.checked)}
                  className="mt-1 h-4 w-4 border-white/25 bg-black/40"
                />
                <span>
                  <span className="block text-white">Research Responsibility Statement *</span>
                  <span className="mt-1 block text-white/50">
                    The purchaser assumes full responsibility for the proper handling, storage, and use of these laboratory materials. The seller provides products solely as research reference materials and does not provide medical or dosing guidance.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3 border border-white/10 p-4 text-sm text-white/60">
                <input
                  type="checkbox"
                  checked={acknowledgements.researchCompliance}
                  onChange={(event) => handleAcknowledgementChange("researchCompliance", event.target.checked)}
                  className="mt-1 h-4 w-4 border-white/25 bg-black/40"
                />
                <span>
                  <span className="block text-white">Research &amp; Compliance Agreement *</span>
                  <span className="mt-1 block text-white/50">
                    I acknowledge that the products sold on this website are intended strictly for laboratory research purposes. I confirm that I am purchasing these materials for legitimate research use and not for human or veterinary use. I understand these products are not drugs, dietary supplements, or medical products, and no instructions for preparation, dosage, or administration are provided by the seller.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3 border border-white/10 p-4 text-sm text-white/60">
                <input
                  type="checkbox"
                  checked={acknowledgements.ageLegalConfirmation}
                  onChange={(event) => handleAcknowledgementChange("ageLegalConfirmation", event.target.checked)}
                  className="mt-1 h-4 w-4 border-white/25 bg-black/40"
                />
                <span>
                  <span className="block text-white">Age &amp; Legal Confirmation *</span>
                  <span className="mt-1 block text-white/50">
                    I confirm that I am 21 years of age or older and legally permitted to purchase laboratory research materials.
                  </span>
                </span>
              </label>

              <p className="text-xs leading-relaxed text-white/45">
                By placing your order, you agree to our{" "}
                <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="text-white/70 underline underline-offset-2 hover:text-white">
                  Terms &amp; Conditions
                </a>{" "}
                and{" "}
                <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-white/70 underline underline-offset-2 hover:text-white">
                  Privacy Policy
                </a>
                .
              </p>
            </div>
          </section>

          <aside className="vl2-glass h-fit p-5 sm:p-7 lg:sticky lg:top-32">
            <p className="vl2-eyebrow">Order Summary</p>

            {items.length === 0 ? (
              <div className="mt-5 border border-dashed border-white/15 p-6 text-center text-sm text-white/45">No items in cart.</div>
            ) : (
              <div className="mt-5 space-y-4 border-b border-white/10 pb-4">
                {items.map((item) => (
                  <div key={item.key} className="flex items-start gap-3">
                    <div className="relative h-16 w-16 flex-shrink-0 border border-white/10 bg-black/40">
                      {item.image ? <Image src={item.image} alt={item.name} fill sizes="64px" className="object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[10px] text-white/35">No image</div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-white">{item.name}</p>
                      <p className="mt-1 text-xs text-white/70">Qty {item.quantity}{item.doseLabel ? ` • ${item.doseLabel}` : ""}</p>
                    </div>
                    <p className="text-sm text-white/75">{formatCartCurrency(getBundleDiscountedLineTotal(item.price, item.quantity, bundleConfig))}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5 space-y-3 text-sm text-white/70">
              <div className="flex justify-between"><span>Items</span><span>{orderCount}</span></div>
              <div className="flex justify-between"><span>Subtotal</span><span>{formatCartCurrency(subtotal)}</span></div>
              <div className="flex justify-between">
                <span>Shipping</span>
                <span>{shipping === 0 && memberFreeShipping ? "Free (member)" : formatCartCurrency(shipping)}</span>
              </div>
              {taxAmount > 0 ? <div className="flex justify-between"><span>Sales tax</span><span>{formatCartCurrency(taxAmount)}</span></div> : null}
              <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <span className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={shippingProtectionEnabled}
                    onChange={(e) => setShippingProtectionEnabled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-emerald-500"
                    aria-label="Add shipping protection"
                  />
                  <span>
                    <span className="block font-medium text-white">Shipping Protection <span className="font-normal text-white/45">(optional)</span></span>
                    <span className="block text-xs text-white/45">Store-backed: we&apos;ll replace or refund items lost, stolen, or damaged in transit. <a href="/legal/shipping" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-white/70">See terms</a></span>
                  </span>
                </span>
                <span className="whitespace-nowrap text-white/80">+{formatCartCurrency(calculateShippingProtectionFee(subtotal))}</span>
              </label>
              {discountAmount > 0 ? (
                <div className="flex justify-between"><span>{ambassadorDiscountApplied ? `Ambassador ${ambassadorDiscountPercent}% off` : "Discount"}</span><span>-{formatCartCurrency(discountAmount)}</span></div>
              ) : null}
              {storeCreditApplied > 0 ? (
                <div className="flex justify-between text-emerald-300"><span>Member store credit</span><span>-{formatCartCurrency(storeCreditApplied)}</span></div>
              ) : null}
              {pointsRedeemedDiscount > 0 ? (
                <div className="flex justify-between"><span>Points redeemed</span><span>-{formatCartCurrency(pointsRedeemedDiscount)}</span></div>
              ) : null}
              {cardFee.amount > 0 ? (
                <div className="flex justify-between text-white/80">
                  <span>{cardFeeConfig?.label ?? "Card Processing Fee"} ({cardFee.percentage}%)</span>
                  <span>+{formatCartCurrency(cardFee.amount)}</span>
                </div>
              ) : null}
              <div className="mt-3 flex justify-between border-t border-white/10 pt-3 text-base text-white"><span>Total</span><span>{formatCartCurrency(finalTotal)}</span></div>
              {(discountAmount + storeCreditApplied + pointsRedeemedDiscount) > 0 ? (
                <div className="flex justify-between rounded-lg bg-emerald-400/10 px-3 py-2 text-sm font-semibold text-emerald-300"><span>You saved</span><span>{formatCartCurrency(discountAmount + storeCreditApplied + pointsRedeemedDiscount)}</span></div>
              ) : null}
              {selectedMethod && selectedMethod.kind === "manual" ? (
                <p className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-400/5 py-2 text-xs font-medium text-emerald-300">
                  ✅ No processing fee with {selectedMethod.label}
                </p>
              ) : null}
            </div>

            <label className="mt-5 flex cursor-pointer items-start gap-2.5 text-sm text-white/70">
              <input type="checkbox" checked={marketingOptIn} onChange={(e) => setMarketingOptIn(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-500" />
              <span>Email me exclusive offers, coupons &amp; restock alerts. <span className="text-white/45">Optional — unsubscribe anytime.</span></span>
            </label>

            <div className="mt-5 grid grid-cols-1 gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-xs text-white/70">
              <span className="flex items-center gap-2"><span aria-hidden>🔒</span><span>SSL-encrypted secure checkout</span></span>
              <span className="flex items-center gap-2"><span aria-hidden>🧪</span><span>Third-party lab tested — COAs published</span></span>
              <span className="flex items-center gap-2"><span aria-hidden>🇺🇸</span><span>Ships from the USA</span></span>
              <span className="flex items-center gap-2"><span aria-hidden>📦</span><span>Same-day dispatch before daily cutoff</span></span>
              <span className="flex items-center gap-2"><span aria-hidden>⭐</span><span>Premium customer support</span></span>
            </div>

            {!checkoutOpen ? (
              <div className="mt-6 rounded-xl border border-amber-300/30 bg-amber-300/[0.06] p-4 text-sm text-amber-100/90" role="status">
                <p className="font-semibold text-amber-100">Checkout is opening soon</p>
                <p className="mt-1 text-amber-100/70">
                  We&apos;re finalizing secure payment setup. You can browse and build your cart now —
                  it&apos;ll be saved — and complete your order as soon as checkout opens. No charge is made until then.
                </p>
              </div>
            ) : null}

            <button
              type="button"
              onClick={handleCheckout}
              disabled={isSubmitting || items.length === 0 || !checkoutOpen}
              className="vl2-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {!checkoutOpen
                ? "Checkout opening soon"
                : checkoutState === "loading"
                  ? "Creating secure checkout..."
                  : selectedMethod && selectedMethod.kind === "manual"
                    ? `Continue to ${selectedMethod.label}`
                    : "Continue to Secure Payment"}
            </button>

            {checkoutMessage ? <p className="mt-3 text-sm text-white/65">{checkoutMessage}</p> : null}

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {["Visa", "Mastercard", "Amex", "Discover", ...(EXPRESS_CHECKOUT_ENABLED ? ["Apple Pay"] : [])].map((brand) => (
                <span key={brand} className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/60">{brand}</span>
              ))}
            </div>

            <Link href="/cart" className="mt-4 inline-flex text-sm text-white/45 transition hover:text-white">
              Back to cart
            </Link>
          </aside>
        </div>
      </main>
    </div>
  );
}
