"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";
import { calculateShipping, isDomesticCountry } from "@/lib/shipping";
import { pointsToDollars } from "@/lib/points-math";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { PaymentMethodPicker } from "@/components/payment-method-picker";
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
  address: string;
  city: string;
  postalCode: string;
  country: string;
  billingFullName: string;
  billingAddress: string;
  billingCity: string;
  billingPostalCode: string;
  billingCountry: string;
};

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
  if (!form.address.trim()) errors.address = "Shipping address is required.";
  if (!form.city.trim()) errors.city = "City is required.";
  if (!form.postalCode.trim()) errors.postalCode = "Postal code is required.";
  if (!form.country.trim()) errors.country = "Country is required.";

  if (!sameAsShipping) {
    if (!form.billingFullName.trim()) errors.billingFullName = "Billing name is required.";
    if (!form.billingAddress.trim()) errors.billingAddress = "Billing address is required.";
    if (!form.billingCity.trim()) errors.billingCity = "Billing city is required.";
    if (!form.billingPostalCode.trim()) errors.billingPostalCode = "Billing postal code is required.";
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
    <div className={`border px-3 py-1.5 text-xs uppercase tracking-[0.16em] ${active ? "border-white bg-white/10 text-white" : "border-white/15 text-white/40"}`}>
      {index}. {label}
    </div>
  );
}

export default function CheckoutPage() {
  const {
    items,
    subtotal,
    serviceFee,
    discountAmount,
    referralCode,
    referralDetails,
    referralError,
    referralSuccess,
    applyReferralCode,
    clearReferralCode,
    couponCode,
    couponDetails,
    couponError,
    couponSuccess,
    applyCouponCode,
    clearCouponCode,
    isBuy3Get1FreeActive,
    isSignedIn,
    pointsBalance,
    pointsToEarn,
    pointsToRedeem,
    setPointsToRedeem,
    setKnownEmail,
    clearCart,
    bulkSavingsTierReached,
    taxAmount,
    shippingConfig,
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
  const [createdOrder, setCreatedOrder] = useState<CreatedManualOrder | null>(null);
  const [referralInput, setReferralInput] = useState("");
  const [couponInput, setCouponInput] = useState("");
  const [sameAsShipping, setSameAsShipping] = useState(true);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof CheckoutForm, string>>>({});
  const [form, setForm] = useState<CheckoutForm>({
    fullName: "",
    email: "",
    address: "",
    city: "",
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
    () => (bulkSavingsTierReached ? 0 : calculateShipping(subtotal, form.country, shippingConfig)),
    [bulkSavingsTierReached, subtotal, form.country, shippingConfig],
  );
  const totalBeforePoints = Math.max(0, subtotal + shipping + serviceFee + taxAmount - discountAmount);
  const pointsRedeemedDiscount = useMemo(
    () => (referralDetails ? 0 : Math.min(pointsToDollars(pointsToRedeem), totalBeforePoints)),
    [referralDetails, pointsToRedeem, totalBeforePoints],
  );
  // `total` is the pre-payment-method total sent to the server as
  // expectedTotal (matches the server's own recompute exactly). The card
  // processing fee is then added ON TOP for the card method only; manual
  // methods pay `total`.
  const total = Math.max(0, totalBeforePoints - pointsRedeemedDiscount);

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
        };
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
      return;
    }

    if (Object.values(acknowledgements).some((value) => !value)) {
      setCheckoutMessage("Please confirm all required research and legal acknowledgements before placing the order.");
      return;
    }

    if (isSubmitting) return;

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
          postalCode: form.postalCode.trim(),
          country: form.country.trim(),
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
        expectedTotal: total,
        paymentMethod: selectedMethodId || undefined,
        complianceAcknowledgements: acknowledgements,
      };

      const result = await createSecureCheckoutSession(payload);

      // Manual methods (Cash App / Zelle / PayPal): stay on-page and show the
      // premium payment instructions panel with the order number + QR.
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

      // Card: continue to the secure processor flow, exactly as before.
      if (result.hostedCheckoutUrl) {
        window.location.assign(result.hostedCheckoutUrl);
      } else {
        setCheckoutState("success");
        setCheckoutMessage("Payment integration is in test mode. No real payment will be processed.");
      }
    } catch (error) {
      setCheckoutState("idle");
      setCheckoutMessage(error instanceof Error ? error.message : "Checkout could not be created.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (createdOrder) {
    return (
      <div className="min-h-screen bg-[#0b0b0b] text-white">
        <SiteHeaderV2 />
        <main className="mx-auto max-w-3xl px-6 pb-20 pt-32 lg:px-12">
          <section className="border border-white/10 p-5 sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              <StepPill index={1} label="Details" active />
              <StepPill index={2} label="Review" active />
              <StepPill index={3} label="Payment" active />
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

      <main className="mx-auto max-w-[1440px] px-6 pb-20 pt-32 lg:px-12">
        <section className="border border-white/10 p-5 sm:p-8">
          <p className="vl2-eyebrow">Secure Checkout</p>
          <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Complete your order</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-white/60 sm:text-base">
            Transparent totals, encrypted payment processing, and full batch traceability from cart to confirmation.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <StepPill index={1} label="Details" active />
            <StepPill index={2} label="Review" active={items.length > 0} />
            <StepPill index={3} label="Payment" active={checkoutState === "loading" || checkoutState === "success"} />
          </div>
        </section>

        <div className="mt-7 grid gap-7 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="border border-white/10 p-5 sm:p-7">
            <div>
              <p className="vl2-eyebrow">Shipping Information</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm text-white/60 sm:col-span-2">
                  <span className="mb-2 block">Full name</span>
                  <input value={form.fullName} onChange={(e) => handleFieldChange("fullName", e.target.value)} autoComplete="shipping name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="Alex Morgan" />
                  {formErrors.fullName ? <span className="mt-1 block text-xs text-rose-300">{formErrors.fullName}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Email</span>
                  <input type="email" value={form.email} readOnly aria-readonly autoComplete="email" className="w-full cursor-not-allowed border border-white/15 bg-black/60 px-4 py-3 text-white/70 outline-none" placeholder="alex@domain.com" title="Your order uses your account email" />
                  {formErrors.email ? <span className="mt-1 block text-xs text-rose-300">{formErrors.email}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Country</span>
                  <input value={form.country} onChange={(e) => handleFieldChange("country", e.target.value)} autoComplete="shipping country-name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="United States" />
                  {formErrors.country ? <span className="mt-1 block text-xs text-rose-300">{formErrors.country}</span> : null}
                </label>

                <label className="text-sm text-white/60 sm:col-span-2">
                  <span className="mb-2 block">Address</span>
                  <input value={form.address} onChange={(e) => handleFieldChange("address", e.target.value)} autoComplete="shipping street-address" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="88 Meridian Avenue" />
                  {formErrors.address ? <span className="mt-1 block text-xs text-rose-300">{formErrors.address}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">City</span>
                  <input value={form.city} onChange={(e) => handleFieldChange("city", e.target.value)} autoComplete="shipping address-level2" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="Austin" />
                  {formErrors.city ? <span className="mt-1 block text-xs text-rose-300">{formErrors.city}</span> : null}
                </label>

                <label className="text-sm text-white/60">
                  <span className="mb-2 block">Postal code</span>
                  <input value={form.postalCode} onChange={(e) => handleFieldChange("postalCode", e.target.value)} autoComplete="shipping postal-code" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="78701" />
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
                    <input value={form.billingFullName} onChange={(e) => handleFieldChange("billingFullName", e.target.value)} autoComplete="billing name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                    {formErrors.billingFullName ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingFullName}</span> : null}
                  </label>
                  <label className="text-sm text-white/60 sm:col-span-2">
                    <span className="mb-2 block">Billing address</span>
                    <input value={form.billingAddress} onChange={(e) => handleFieldChange("billingAddress", e.target.value)} autoComplete="billing street-address" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                    {formErrors.billingAddress ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingAddress}</span> : null}
                  </label>
                  <label className="text-sm text-white/60">
                    <span className="mb-2 block">Billing city</span>
                    <input value={form.billingCity} onChange={(e) => handleFieldChange("billingCity", e.target.value)} autoComplete="billing address-level2" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                    {formErrors.billingCity ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingCity}</span> : null}
                  </label>
                  <label className="text-sm text-white/60">
                    <span className="mb-2 block">Billing postal code</span>
                    <input value={form.billingPostalCode} onChange={(e) => handleFieldChange("billingPostalCode", e.target.value)} autoComplete="billing postal-code" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                    {formErrors.billingPostalCode ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingPostalCode}</span> : null}
                  </label>
                  <label className="text-sm text-white/60 sm:col-span-2">
                    <span className="mb-2 block">Billing country</span>
                    <input value={form.billingCountry} onChange={(e) => handleFieldChange("billingCountry", e.target.value)} autoComplete="billing country-name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                    {formErrors.billingCountry ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingCountry}</span> : null}
                  </label>
                </div>
              ) : null}
            </div>

            {paymentMethods.length > 0 ? (
              <div className="mt-8">
                <p className="vl2-eyebrow">Payment Method</p>
                <div className="mt-4">
                  <PaymentMethodPicker
                    methods={paymentMethods}
                    cardFeeConfig={cardFeeConfig}
                    baseTotal={total}
                    selectedMethodId={selectedMethodId}
                    onSelect={setSelectedMethodId}
                  />
                </div>
              </div>
            ) : null}

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="border border-white/10 p-4">
                <p className="vl2-eyebrow">Shipping Method</p>
                <p className="mt-2 text-sm text-white">
                  {isDomesticCountry(form.country) ? "Standard secure shipping" : "Secure international shipping, fast arrival"}
                </p>
                <p className="mt-1 text-xs text-white/45">
                  {isDomesticCountry(form.country)
                    ? `Free at $250+, otherwise flat ${formatCartCurrency(15)} in the USA.`
                    : `Free at $600+, otherwise flat ${formatCartCurrency(60)} for international orders.`}
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
                  <input type="text" value={effectiveReferralInput} onChange={(event) => setReferralInput(event.target.value)} aria-label="Referral code" placeholder="VANTA10" className="w-full flex-1 border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                  <button type="button" onClick={() => applyReferralCode(effectiveReferralInput)} className="vl2-btn-secondary vl-focus-ring px-4 py-3 text-sm">Apply</button>
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
                  <input type="text" value={effectiveCouponInput} onChange={(event) => setCouponInput(event.target.value)} aria-label="Coupon code" placeholder="SAVE10" className="w-full flex-1 border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50" />
                  <button type="button" onClick={() => applyCouponCode(effectiveCouponInput)} className="vl2-btn-secondary vl-focus-ring px-4 py-3 text-sm">Apply</button>
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
                      className="w-full border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50 sm:w-40"
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
                  <p className="mt-2 text-xs text-white/40">You&apos;ll earn ~{pointsToEarn.toLocaleString()} points on this order.</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-8 text-xs text-white/40">
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
                      <p className="mt-1 text-xs text-white/40">Qty {item.quantity}{item.doseLabel ? ` • ${item.doseLabel}` : ""}</p>
                    </div>
                    <p className="text-sm text-white/75">{formatCartCurrency(getBundleDiscountedLineTotal(item.price, item.quantity))}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5 space-y-3 text-sm text-white/70">
              <div className="flex justify-between"><span>Items</span><span>{orderCount}</span></div>
              <div className="flex justify-between"><span>Subtotal</span><span>{formatCartCurrency(subtotal)}</span></div>
              <div className="flex justify-between"><span>Shipping</span><span>{formatCartCurrency(shipping)}</span></div>
              {serviceFee > 0 ? <div className="flex justify-between"><span>Service fee</span><span>{formatCartCurrency(serviceFee)}</span></div> : null}
              {taxAmount > 0 ? <div className="flex justify-between"><span>Tax</span><span>{formatCartCurrency(taxAmount)}</span></div> : null}
              <div className="flex justify-between"><span>Discount</span><span>-{formatCartCurrency(discountAmount)}</span></div>
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
              {selectedMethod && selectedMethod.kind === "manual" ? (
                <p className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-400/5 py-2 text-xs font-medium text-emerald-300">
                  ✅ No processing fee with {selectedMethod.label}
                </p>
              ) : null}
            </div>

            <div className="mt-5 flex items-center justify-center gap-6 text-[10px] uppercase tracking-[0.14em] text-white/40">
              <span>TLS Encrypted</span>
              <span>Fraud Screened</span>
            </div>

            <button
              type="button"
              onClick={handleCheckout}
              disabled={isSubmitting || items.length === 0}
              className="vl2-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checkoutState === "loading"
                ? "Creating secure checkout..."
                : selectedMethod && selectedMethod.kind === "manual"
                  ? `Continue to ${selectedMethod.label}`
                  : "Continue to Secure Payment"}
            </button>

            {checkoutMessage ? <p className="mt-3 text-sm text-white/65">{checkoutMessage}</p> : null}

            <Link href="/cart" className="mt-4 inline-flex text-sm text-white/45 transition hover:text-white">
              Back to cart
            </Link>
          </aside>
        </div>
      </main>
    </div>
  );
}
