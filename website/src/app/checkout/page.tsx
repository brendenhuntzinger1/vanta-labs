"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";

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
  } = useCart();

  const [acknowledged, setAcknowledged] = useState(false);
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

  const handleFieldChange = (key: keyof CheckoutForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (formErrors[key]) {
      setFormErrors((prev) => ({ ...prev, [key]: undefined }));
    }
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

    if (!acknowledged) {
      setCheckoutMessage("Please acknowledge the research-use statement before placing the order.");
      return;
    }

    if (isSubmitting) {
      return;
    }

    setCheckoutState("loading");
    setCheckoutMessage(null);
    setIsSubmitting(true);

    try {
      const payload = {
        items: items.map((item) => ({ id: item.slug, quantity: item.quantity })),
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
    <div className="vl-page-shell min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <div className="max-w-3xl">
          <p className="vl-kicker">Checkout</p>
          <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl lg:text-5xl">Fast, secure checkout</h1>
          <p className="mt-4 text-base leading-7 text-zinc-400 sm:text-lg">
            Complete your order in one step with secure processing, clear pricing, and full order verification.
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:mt-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-8">
          <section className="vl-panel space-y-6 rounded-[1.5rem] p-4 sm:rounded-[2rem] sm:p-6">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Shipping information</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm text-zinc-400 sm:col-span-2">
                  <span className="mb-2 block">Full name</span>
                  <input
                    value={form.fullName}
                    onChange={(e) => handleFieldChange("fullName", e.target.value)}
                    className="vl-input w-full px-4 py-3"
                    placeholder="Alex Morgan"
                  />
                  {formErrors.fullName ? <span className="mt-1 block text-xs text-rose-400">{formErrors.fullName}</span> : null}
                </label>

                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">Email</span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => handleFieldChange("email", e.target.value)}
                    className="vl-input w-full px-4 py-3"
                    placeholder="alex@domain.com"
                  />
                  {formErrors.email ? <span className="mt-1 block text-xs text-rose-400">{formErrors.email}</span> : null}
                </label>

                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">Country</span>
                  <input
                    value={form.country}
                    onChange={(e) => handleFieldChange("country", e.target.value)}
                    className="vl-input w-full px-4 py-3"
                    placeholder="United States"
                  />
                  {formErrors.country ? <span className="mt-1 block text-xs text-rose-400">{formErrors.country}</span> : null}
                </label>

                <label className="text-sm text-zinc-400 sm:col-span-2">
                  <span className="mb-2 block">Address</span>
                  <input
                    value={form.address}
                    onChange={(e) => handleFieldChange("address", e.target.value)}
                    className="vl-input w-full px-4 py-3"
                    placeholder="88 Meridian Avenue"
                  />
                  {formErrors.address ? <span className="mt-1 block text-xs text-rose-400">{formErrors.address}</span> : null}
                </label>

                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">City</span>
                  <input
                    value={form.city}
                    onChange={(e) => handleFieldChange("city", e.target.value)}
                    className="vl-input w-full px-4 py-3"
                    placeholder="Austin"
                  />
                  {formErrors.city ? <span className="mt-1 block text-xs text-rose-400">{formErrors.city}</span> : null}
                </label>

                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">Postal code</span>
                  <input
                    value={form.postalCode}
                    onChange={(e) => handleFieldChange("postalCode", e.target.value)}
                    className="vl-input w-full px-4 py-3"
                    placeholder="78701"
                  />
                  {formErrors.postalCode ? <span className="mt-1 block text-xs text-rose-400">{formErrors.postalCode}</span> : null}
                </label>
              </div>
            </div>

            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Billing information</p>
              <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={sameAsShipping}
                  onChange={(e) => setSameAsShipping(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                />
                Same as shipping address
              </label>

              {!sameAsShipping ? (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-zinc-400 sm:col-span-2">
                    <span className="mb-2 block">Billing full name</span>
                    <input
                      value={form.billingFullName}
                      onChange={(e) => handleFieldChange("billingFullName", e.target.value)}
                      className="vl-input w-full px-4 py-3"
                    />
                    {formErrors.billingFullName ? <span className="mt-1 block text-xs text-rose-400">{formErrors.billingFullName}</span> : null}
                  </label>

                  <label className="text-sm text-zinc-400 sm:col-span-2">
                    <span className="mb-2 block">Billing address</span>
                    <input
                      value={form.billingAddress}
                      onChange={(e) => handleFieldChange("billingAddress", e.target.value)}
                      className="vl-input w-full px-4 py-3"
                    />
                    {formErrors.billingAddress ? <span className="mt-1 block text-xs text-rose-400">{formErrors.billingAddress}</span> : null}
                  </label>

                  <label className="text-sm text-zinc-400">
                    <span className="mb-2 block">Billing city</span>
                    <input
                      value={form.billingCity}
                      onChange={(e) => handleFieldChange("billingCity", e.target.value)}
                      className="vl-input w-full px-4 py-3"
                    />
                    {formErrors.billingCity ? <span className="mt-1 block text-xs text-rose-400">{formErrors.billingCity}</span> : null}
                  </label>

                  <label className="text-sm text-zinc-400">
                    <span className="mb-2 block">Billing postal code</span>
                    <input
                      value={form.billingPostalCode}
                      onChange={(e) => handleFieldChange("billingPostalCode", e.target.value)}
                      className="vl-input w-full px-4 py-3"
                    />
                    {formErrors.billingPostalCode ? <span className="mt-1 block text-xs text-rose-400">{formErrors.billingPostalCode}</span> : null}
                  </label>

                  <label className="text-sm text-zinc-400 sm:col-span-2">
                    <span className="mb-2 block">Billing country</span>
                    <input
                      value={form.billingCountry}
                      onChange={(e) => handleFieldChange("billingCountry", e.target.value)}
                      className="vl-input w-full px-4 py-3"
                    />
                    {formErrors.billingCountry ? <span className="mt-1 block text-xs text-rose-400">{formErrors.billingCountry}</span> : null}
                  </label>
                </div>
              ) : null}
            </div>

            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Shipping method</p>
              <div className="vl-panel-soft mt-4 rounded-xl p-3">
                <p className="text-sm font-semibold text-white">Standard shipping</p>
                <p className="text-xs text-zinc-400">2-5 business days • {formatCartCurrency(shipping)}</p>
              </div>
            </div>

            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Promo / referral code</p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  value={effectiveReferralInput}
                  onChange={(event) => setReferralInput(event.target.value)}
                  placeholder="VANTA10"
                  className="vl-input w-full flex-1 px-4 py-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => applyReferralCode(effectiveReferralInput)}
                  className="vl-btn-secondary vl-focus-ring px-4 py-3 text-sm"
                >
                  Apply
                </button>
              </div>
              {referralSuccess ? <p className="mt-3 text-sm text-emerald-400">{referralSuccess}</p> : null}
              {referralError ? <p className="mt-3 text-sm text-rose-400">{referralError}</p> : null}
              {referralDetails ? (
                <p className="mt-3 text-sm text-zinc-300">
                  Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% discount
                </p>
              ) : null}
              {referralCode ? (
                <button
                  type="button"
                  onClick={() => {
                    clearReferralCode();
                    setReferralInput("");
                  }}
                  className="mt-3 text-sm text-zinc-400 transition hover:text-white"
                >
                  Remove code
                </button>
              ) : null}
            </div>

            <label className="vl-panel-soft flex items-start gap-3 rounded-[1.25rem] p-4 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900"
              />
              <span>I acknowledge that these products are intended only for lawful laboratory research purposes and not for human use.</span>
            </label>
          </section>

          <aside className="vl-panel rounded-[1.5rem] p-4 sm:rounded-[2rem] sm:p-6">
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Order summary</p>

            {items.length === 0 ? (
              <div className="mt-6 rounded-xl border border-dashed border-zinc-700 p-5 text-center text-sm text-zinc-400">
                No items in cart.
              </div>
            ) : (
              <div className="mt-6 space-y-4 border-b border-zinc-800 pb-4">
                {items.map((item) => (
                  <div key={item.slug} className="flex items-start gap-3 border-b border-zinc-800/50 pb-4 last:border-b-0 last:pb-0">
                    <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950/50 sm:h-20 sm:w-20">
                      {item.image ? (
                        <img src={item.image} alt={item.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">No image</div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white sm:text-base">{item.name}</p>
                      <p className="mt-1 text-xs text-zinc-500">Qty {item.quantity} • Batch {item.batchNumber}</p>
                      <p className="mt-2 text-sm font-medium text-zinc-200">{formatCartCurrency(item.price * item.quantity)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 space-y-3 text-sm text-zinc-300">
              <div className="flex justify-between">
                <span>Items</span>
                <span>{orderCount}</span>
              </div>
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCartCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Shipping estimate</span>
                <span>{formatCartCurrency(shipping)}</span>
              </div>
              <div className="flex justify-between">
                <span>Service fee</span>
                <span>{formatCartCurrency(serviceFee)}</span>
              </div>
              <div className="flex justify-between">
                <span>Discount</span>
                <span>-{formatCartCurrency(discountAmount)}</span>
              </div>
              <div className="mt-4 flex justify-between border-t border-zinc-800 pt-4 text-base font-semibold text-white">
                <span>Final total</span>
                <span>{formatCartCurrency(total)}</span>
              </div>
            </div>

            <div className="vl-panel-soft mt-5 rounded-xl p-4">
              <p className="text-sm font-semibold text-white">Secure payment</p>
              <p className="mt-1 text-xs text-zinc-400">256-bit encrypted checkout. We never store your payment credentials on this site.</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-300">
                <span className="vl-chip">PCI-ready</span>
                <span className="vl-chip">TLS encrypted</span>
                <span className="vl-chip">Fraud screened</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCheckout}
              disabled={isSubmitting || items.length === 0}
              className="vl-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checkoutState === "loading" ? "Creating secure checkout..." : "Continue to Secure Payment"}
            </button>

            {checkoutMessage ? <p className="mt-4 text-sm text-zinc-300">{checkoutMessage}</p> : null}

            <Link href="/cart" className="mt-4 inline-flex text-sm text-zinc-400 transition hover:text-white">
              ← Back to cart
            </Link>
          </aside>
        </div>
      </main>
    </div>
  );
}
