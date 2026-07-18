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

export default function CheckoutPage() {
  const {
    items,
    subtotal,
    shipping,
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

  const orderCount = useMemo(() => items.reduce((sum, item) => sum + item.quantity, 0), [items]);

  const handleCheckout = async () => {
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
          email: "demo@example.com",
          fullName: "Demo Customer",
          address: "88 Meridian Avenue",
          city: "Austin",
          postalCode: "78701",
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">Checkout</p>
          <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">Secure checkout for research-use orders.</h1>
          <p className="mt-6 text-lg leading-8 text-zinc-400">Your order summary is validated server-side before checkout is created. Approved ambassador referral codes receive a fixed 10% customer discount.</p>
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6 rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-6">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Contact information</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">Full name</span>
                  <input className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none" placeholder="Alex Morgan" />
                </label>
                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">Email</span>
                  <input className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none" placeholder="alex@demo.org" />
                </label>
              </div>
            </div>
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Shipping address</p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm text-zinc-400 sm:col-span-2">
                  <span className="mb-2 block">Address</span>
                  <input className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none" placeholder="88 Meridian Avenue" />
                </label>
                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">City</span>
                  <input className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none" placeholder="Austin" />
                </label>
                <label className="text-sm text-zinc-400">
                  <span className="mb-2 block">Postal code</span>
                  <input className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none" placeholder="78701" />
                </label>
              </div>
            </div>
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Referral code</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <input
                  type="text"
                  defaultValue={referralCode ?? ""}
                  placeholder="VANTA10"
                  className="flex-1 rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
                />
                <button type="button" onClick={() => {
                  const input = document.querySelector<HTMLInputElement>("[placeholder='VANTA10']");
                  if (input) {
                    applyReferralCode(input.value);
                  }
                }} className="rounded-full border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800">
                  Apply
                </button>
              </div>
              {referralSuccess ? <p className="mt-3 text-sm text-emerald-400">{referralSuccess}</p> : null}
              {referralError ? <p className="mt-3 text-sm text-rose-400">{referralError}</p> : null}
              {referralDetails ? (
                <p className="mt-3 text-sm text-zinc-300">Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% discount</p>
              ) : null}
              {referralCode ? (
                <button type="button" onClick={clearReferralCode} className="mt-3 text-sm text-zinc-400 transition hover:text-white">
                  Remove referral code
                </button>
              ) : null}
            </div>
            <label className="flex items-start gap-3 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/70 p-4 text-sm text-zinc-300">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900" />
              <span>I acknowledge that these products are intended only for lawful laboratory research purposes and not for human use.</span>
            </label>
          </div>

          <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-6">
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Order summary</p>
            
            {/* Detailed items list with images */}
            <div className="mt-6 space-y-4 border-b border-zinc-800 pb-4">
              {items.map((item) => (
                <div key={item.slug} className="flex gap-4 items-start pb-4 last:pb-0 border-b border-zinc-800/50 last:border-b-0">
                  {/* Product image */}
                  <div className="h-24 w-24 flex-shrink-0 rounded-lg border border-zinc-700 bg-zinc-950/50 overflow-hidden flex items-center justify-center">
                    {item.image ? (
                      <img src={item.image} alt={item.name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="text-xs text-zinc-500">No image</div>
                    )}
                  </div>
                  
                  {/* Product details */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-white text-sm">{item.name}</p>
                    <p className="text-xs text-zinc-500 mt-1">Batch {item.batchNumber}</p>
                    <div className="flex items-center justify-between mt-3">
                      <div>
                        <p className="text-xs text-zinc-400">Qty: <span className="text-white font-medium">{item.quantity}</span></p>
                        <p className="text-xs text-zinc-400">Price: <span className="text-white font-medium">${item.price}</span></p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-white">{formatCartCurrency(item.price * item.quantity)}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Order totals */}
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
                <span>Shipping</span>
                <span>{formatCartCurrency(shipping)}</span>
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
            <button
              type="button"
              onClick={handleCheckout}
              disabled={isSubmitting}
              className="mt-8 w-full rounded-full border border-zinc-600 bg-white px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checkoutState === "loading" ? "Creating secure checkout..." : "Place Order"}
            </button>
            {checkoutMessage ? <p className="mt-4 text-sm text-zinc-300">{checkoutMessage}</p> : null}
            <p className="mt-4 text-sm text-zinc-400">Checkout creation is validated server-side before the provider is invoked.</p>
            <Link href="/cart" className="mt-4 inline-flex text-sm text-zinc-400 transition hover:text-white">← Back to cart</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
