"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";
import { TrustBadge } from "@/components/trust-badge";

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
    <div className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] ${active ? "border-white/45 bg-white/14 text-zinc-100" : "border-white/12 bg-white/5 text-zinc-400"}`}>
      {index}. {label}
    </div>
  );
}

export default function CheckoutPage() {
  const {
    items,
    subtotal,
    shipping,
    serviceFee,
    discountAmount,
    total,
    referralCode,
    referralDetails,
    referralError,
    referralSuccess,
    applyReferralCode,
    clearReferralCode,
    isBuy3Get1FreeActive,
  } = useCart();

  const [acknowledgements, setAcknowledgements] = useState<ComplianceAcknowledgements>({
    researchResponsibility: false,
    researchCompliance: false,
    ageLegalConfirmation: false,
  });
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [checkoutState, setCheckoutState] = useState<"idle" | "loading" | "success">("idle");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [referralInput, setReferralInput] = useState("");
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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

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
        expectedTotal: total,
        complianceAcknowledgements: acknowledgements,
      };

      const result = await createSecureCheckoutSession(payload);
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

  return (
    <div className="vl-page-shell min-h-screen text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <section className="rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(10,10,10,0.95),rgba(22,22,22,0.9))] p-5 sm:p-8">
          <p className="vl-eyebrow text-[11px]">Secure Checkout</p>
          <h1 className="vl-display mt-3 text-3xl font-semibold text-white sm:text-4xl">Complete Your Order</h1>
          <p className="vl-copy mt-3 max-w-3xl text-sm leading-7 text-zinc-300 sm:text-base">
            Transparent totals, encrypted payment processing, and full batch traceability from cart to confirmation.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <StepPill index={1} label="Details" active />
            <StepPill index={2} label="Review" active={items.length > 0} />
            <StepPill index={3} label="Payment" active={checkoutState === "loading" || checkoutState === "success"} />
          </div>
        </section>

        <div className="mt-7 grid gap-7 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="vl-panel rounded-[2rem] p-5 sm:p-7">
            <div>
              <p className="vl-eyebrow text-[11px]">Shipping Information</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm text-zinc-300 sm:col-span-2">
                  <span className="mb-2 block">Full name</span>
                  <input value={form.fullName} onChange={(e) => handleFieldChange("fullName", e.target.value)} className="vl-input w-full px-4 py-3" placeholder="Alex Morgan" />
                  {formErrors.fullName ? <span className="mt-1 block text-xs text-rose-300">{formErrors.fullName}</span> : null}
                </label>

                <label className="text-sm text-zinc-300">
                  <span className="mb-2 block">Email</span>
                  <input type="email" value={form.email} onChange={(e) => handleFieldChange("email", e.target.value)} className="vl-input w-full px-4 py-3" placeholder="alex@domain.com" />
                  {formErrors.email ? <span className="mt-1 block text-xs text-rose-300">{formErrors.email}</span> : null}
                </label>

                <label className="text-sm text-zinc-300">
                  <span className="mb-2 block">Country</span>
                  <input value={form.country} onChange={(e) => handleFieldChange("country", e.target.value)} className="vl-input w-full px-4 py-3" placeholder="United States" />
                  {formErrors.country ? <span className="mt-1 block text-xs text-rose-300">{formErrors.country}</span> : null}
                </label>

                <label className="text-sm text-zinc-300 sm:col-span-2">
                  <span className="mb-2 block">Address</span>
                  <input value={form.address} onChange={(e) => handleFieldChange("address", e.target.value)} className="vl-input w-full px-4 py-3" placeholder="88 Meridian Avenue" />
                  {formErrors.address ? <span className="mt-1 block text-xs text-rose-300">{formErrors.address}</span> : null}
                </label>

                <label className="text-sm text-zinc-300">
                  <span className="mb-2 block">City</span>
                  <input value={form.city} onChange={(e) => handleFieldChange("city", e.target.value)} className="vl-input w-full px-4 py-3" placeholder="Austin" />
                  {formErrors.city ? <span className="mt-1 block text-xs text-rose-300">{formErrors.city}</span> : null}
                </label>

                <label className="text-sm text-zinc-300">
                  <span className="mb-2 block">Postal code</span>
                  <input value={form.postalCode} onChange={(e) => handleFieldChange("postalCode", e.target.value)} className="vl-input w-full px-4 py-3" placeholder="78701" />
                  {formErrors.postalCode ? <span className="mt-1 block text-xs text-rose-300">{formErrors.postalCode}</span> : null}
                </label>
              </div>
            </div>

            <div className="mt-8">
              <p className="vl-eyebrow text-[11px]">Billing Information</p>
              <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" checked={sameAsShipping} onChange={(e) => setSameAsShipping(e.target.checked)} className="h-4 w-4 rounded border-zinc-700 bg-zinc-900" />
                Same as shipping address
              </label>

              {!sameAsShipping ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-zinc-300 sm:col-span-2">
                    <span className="mb-2 block">Billing full name</span>
                    <input value={form.billingFullName} onChange={(e) => handleFieldChange("billingFullName", e.target.value)} className="vl-input w-full px-4 py-3" />
                    {formErrors.billingFullName ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingFullName}</span> : null}
                  </label>
                  <label className="text-sm text-zinc-300 sm:col-span-2">
                    <span className="mb-2 block">Billing address</span>
                    <input value={form.billingAddress} onChange={(e) => handleFieldChange("billingAddress", e.target.value)} className="vl-input w-full px-4 py-3" />
                    {formErrors.billingAddress ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingAddress}</span> : null}
                  </label>
                  <label className="text-sm text-zinc-300">
                    <span className="mb-2 block">Billing city</span>
                    <input value={form.billingCity} onChange={(e) => handleFieldChange("billingCity", e.target.value)} className="vl-input w-full px-4 py-3" />
                    {formErrors.billingCity ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingCity}</span> : null}
                  </label>
                  <label className="text-sm text-zinc-300">
                    <span className="mb-2 block">Billing postal code</span>
                    <input value={form.billingPostalCode} onChange={(e) => handleFieldChange("billingPostalCode", e.target.value)} className="vl-input w-full px-4 py-3" />
                    {formErrors.billingPostalCode ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingPostalCode}</span> : null}
                  </label>
                  <label className="text-sm text-zinc-300 sm:col-span-2">
                    <span className="mb-2 block">Billing country</span>
                    <input value={form.billingCountry} onChange={(e) => handleFieldChange("billingCountry", e.target.value)} className="vl-input w-full px-4 py-3" />
                    {formErrors.billingCountry ? <span className="mt-1 block text-xs text-rose-300">{formErrors.billingCountry}</span> : null}
                  </label>
                </div>
              ) : null}
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="vl-panel-soft rounded-xl p-4">
                <p className="vl-eyebrow text-[11px]">Shipping Method</p>
                <p className="mt-2 text-sm font-medium text-zinc-100">Standard secure shipping</p>
                <p className="mt-1 text-xs text-zinc-400">Free at $250+, otherwise flat {formatCartCurrency(15)}.</p>
              </div>
              <div className="vl-panel-soft rounded-xl p-4">
                <p className="vl-eyebrow text-[11px]">Security</p>
                <p className="mt-2 text-sm font-medium text-zinc-100">Encrypted checkout session</p>
                <p className="mt-1 text-xs text-zinc-400">Payment credentials are handled by secure provider flow.</p>
              </div>
            </div>

            <div className="mt-8">
              <p className="vl-eyebrow text-[11px]">Promo / Referral</p>
              {isBuy3Get1FreeActive ? (
                <p className="mt-3 rounded-xl border border-white/24 bg-white/8 px-3 py-2 text-sm text-zinc-100">
                  Buy 3 Get 1 Free is active. Referral discounts cannot be combined with this promotion.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input type="text" value={effectiveReferralInput} onChange={(event) => setReferralInput(event.target.value)} placeholder="VANTA10" className="vl-input w-full flex-1 px-4 py-3 text-sm" />
                  <button type="button" onClick={() => applyReferralCode(effectiveReferralInput)} className="vl-btn-secondary vl-focus-ring px-4 py-3 text-sm">Apply</button>
                </div>
              )}

              {referralSuccess ? <p className="mt-2 text-sm text-emerald-300">{referralSuccess}</p> : null}
              {referralError ? <p className="mt-2 text-sm text-rose-300">{referralError}</p> : null}
              {referralDetails ? <p className="mt-2 text-sm text-zinc-300">Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% discount</p> : null}
              {referralCode && !isBuy3Get1FreeActive ? (
                <button
                  type="button"
                  onClick={() => {
                    clearReferralCode();
                    setReferralInput("");
                  }}
                  className="mt-2 text-sm text-zinc-400 transition hover:text-white"
                >
                  Remove code
                </button>
              ) : null}
            </div>

            <div className="mt-8 space-y-4">
              <p className="vl-eyebrow text-[11px]">Required Confirmations</p>

              <label className="vl-panel-soft flex items-start gap-3 rounded-xl p-4 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={acknowledgements.researchResponsibility}
                  onChange={(event) => handleAcknowledgementChange("researchResponsibility", event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                />
                <span>
                  <span className="block font-medium text-zinc-100">Research Responsibility Statement *</span>
                  <span className="mt-1 block text-zinc-400">
                    The purchaser assumes full responsibility for the proper handling, storage, and use of these laboratory materials. The seller provides products solely as research reference materials and does not provide medical or dosing guidance.
                  </span>
                </span>
              </label>

              <label className="vl-panel-soft flex items-start gap-3 rounded-xl p-4 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={acknowledgements.researchCompliance}
                  onChange={(event) => handleAcknowledgementChange("researchCompliance", event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                />
                <span>
                  <span className="block font-medium text-zinc-100">Research &amp; Compliance Agreement *</span>
                  <span className="mt-1 block text-zinc-400">
                    I acknowledge that the products sold on this website are intended strictly for laboratory research purposes. I confirm that I am purchasing these materials for legitimate research use and not for human or veterinary use. I understand these products are not drugs, dietary supplements, or medical products, and no instructions for preparation, dosage, or administration are provided by the seller.
                  </span>
                </span>
              </label>

              <label className="vl-panel-soft flex items-start gap-3 rounded-xl p-4 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={acknowledgements.ageLegalConfirmation}
                  onChange={(event) => handleAcknowledgementChange("ageLegalConfirmation", event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                />
                <span>
                  <span className="block font-medium text-zinc-100">Age &amp; Legal Confirmation *</span>
                  <span className="mt-1 block text-zinc-400">
                    I confirm that I am 21 years of age or older and legally permitted to purchase laboratory research materials.
                  </span>
                </span>
              </label>
            </div>
          </section>

          <aside className="vl-panel rounded-[2rem] p-5 sm:p-7 lg:sticky lg:top-24">
            <p className="vl-eyebrow text-[11px]">Order Summary</p>

            {items.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-white/16 p-6 text-center text-sm text-zinc-400">No items in cart.</div>
            ) : (
              <div className="mt-5 space-y-4 border-b border-white/10 pb-4">
                {items.map((item) => (
                  <div key={item.key} className="flex items-start gap-3">
                    <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-zinc-900/70">
                      {item.image ? <Image src={item.image} alt={item.name} fill sizes="64px" className="object-cover" /> : <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-500">No image</div>}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
                      <p className="mt-1 text-xs text-zinc-500">Qty {item.quantity}{item.doseLabel ? ` • ${item.doseLabel}` : ""}</p>
                    </div>
                    <p className="text-sm text-zinc-200">{formatCartCurrency(item.price * item.quantity)}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5 space-y-3 text-sm text-zinc-300">
              <div className="flex justify-between"><span>Items</span><span>{orderCount}</span></div>
              <div className="flex justify-between"><span>Subtotal</span><span>{formatCartCurrency(subtotal)}</span></div>
              <div className="flex justify-between"><span>Shipping</span><span>{formatCartCurrency(shipping)}</span></div>
              {serviceFee > 0 ? <div className="flex justify-between"><span>Service fee</span><span>{formatCartCurrency(serviceFee)}</span></div> : null}
              <div className="flex justify-between"><span>Discount</span><span>-{formatCartCurrency(discountAmount)}</span></div>
              <div className="mt-3 flex justify-between border-t border-white/10 pt-3 text-base font-semibold text-white"><span>Total</span><span>{formatCartCurrency(total)}</span></div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2">
              <TrustBadge icon="shield" label="TLS Encrypted" />
              <TrustBadge icon="check" label="Fraud Screened" />
            </div>

            <button
              type="button"
              onClick={handleCheckout}
              disabled={isSubmitting || items.length === 0}
              className="vl-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checkoutState === "loading" ? "Creating secure checkout..." : "Continue to Secure Payment"}
            </button>

            {checkoutMessage ? <p className="mt-3 text-sm text-zinc-300">{checkoutMessage}</p> : null}

            <Link href="/cart" className="mt-4 inline-flex text-sm text-zinc-400 transition hover:text-white">
              Back to cart
            </Link>
          </aside>
        </div>
      </main>
    </div>
  );
}
