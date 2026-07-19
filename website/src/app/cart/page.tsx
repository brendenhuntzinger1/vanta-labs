"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCartCurrency, getShippingProgress, useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";

export default function CartPage() {
  const router = useRouter();
  const [referralInput, setReferralInput] = useState("");
  const {
    items,
    updateQuantity,
    removeFromCart,
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

  const effectiveReferralInput = referralInput || referralCode || "";
  const shippingProgress = getShippingProgress(subtotal);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <div className="max-w-3xl">
          <p className="text-xs uppercase tracking-[0.35em] text-zinc-500 sm:text-sm sm:tracking-[0.4em]">Shopping cart</p>
          <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl lg:text-5xl">Review your selected materials.</h1>
          <p className="mt-4 text-base leading-7 text-zinc-400 sm:mt-6 sm:text-lg sm:leading-8">Your cart persists locally while you review or continue checkout. Approved ambassador referral codes are validated with Supabase before checkout.</p>
        </div>

        <div className="mt-8 grid gap-6 lg:mt-10 lg:gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            {items.length === 0 ? (
              <div className="vl-panel rounded-[1.5rem] border-dashed p-6 text-center text-zinc-400 sm:rounded-[2rem] sm:p-10">
                <p className="text-lg text-white sm:text-xl">No items yet.</p>
                <p className="mt-3">Visit the catalog to add sample products.</p>
                <Link href="/products" className="vl-btn-primary vl-focus-ring mt-6 inline-flex px-5 py-3 text-sm">
                  Browse products
                </Link>
              </div>
            ) : (
              items.map((item) => (
                <div key={item.slug} className="vl-panel rounded-[1.25rem] p-4 sm:rounded-[1.5rem] sm:p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold text-white sm:text-xl">{item.name}</h2>
                      <p className="mt-2 text-sm text-zinc-400">Batch {item.batchNumber}</p>
                    </div>
                    <button type="button" onClick={() => removeFromCart(item.slug)} className="text-sm text-zinc-500 transition hover:text-white">
                      Remove
                    </button>
                  </div>
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-4 sm:mt-6">
                    <div className="flex items-center gap-2 rounded-full border border-zinc-700 px-2 py-1.5 text-sm text-zinc-300 sm:gap-3 sm:px-3 sm:py-2">
                      <button type="button" onClick={() => updateQuantity(item.slug, item.quantity - 1)} className="px-2" aria-label="Decrease quantity">−</button>
                      <span>{item.quantity}</span>
                      <button type="button" onClick={() => updateQuantity(item.slug, item.quantity + 1)} className="px-2" aria-label="Increase quantity">+</button>
                    </div>
                    <p className="text-base font-semibold text-white sm:text-lg">{formatCartCurrency(item.price * item.quantity)}</p>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="vl-panel rounded-[1.5rem] p-4 sm:rounded-[2rem] sm:p-6">
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Order summary</p>

            {subtotal > 0 ? (
              <div className="vl-panel-soft mt-5 rounded-xl p-4">
                {shippingProgress.isEligibleForFreeShipping ? (
                  <div>
                    <p className="text-sm font-semibold text-emerald-400">Free shipping unlocked</p>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
                      <div className="h-full w-full bg-gradient-to-r from-emerald-500 to-emerald-300" />
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-zinc-400">Free shipping at $200</span>
                      <span className="font-semibold text-white">${shippingProgress.amountToFreeShipping.toFixed(2)} away</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-500"
                        style={{ width: `${shippingProgress.progressPercentage}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="mt-6 space-y-3 text-sm text-zinc-300">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCartCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Estimated shipping</span>
                <span>{formatCartCurrency(shipping)}</span>
              </div>
              <div className="flex justify-between">
                <span>Service fee</span>
                <span>{formatCartCurrency(serviceFee)}</span>
              </div>
              <div className="flex justify-between">
                <span>Applied discount</span>
                <span>-{formatCartCurrency(discountAmount)}</span>
              </div>
              <div className="mt-4 flex justify-between border-t border-zinc-800 pt-4 text-base font-semibold text-white">
                <span>Final total</span>
                <span>{formatCartCurrency(total)}</span>
              </div>
            </div>

            <label className="mt-8 block text-sm text-zinc-400">
              <span className="mb-2 block uppercase tracking-[0.3em]">Referral code</span>
              <input
                type="text"
                value={effectiveReferralInput}
                onChange={(event) => setReferralInput(event.target.value)}
                placeholder="VANTA10"
                className="vl-input w-full rounded-full px-4 py-3 text-sm"
              />
            </label>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => applyReferralCode(effectiveReferralInput)}
                className="vl-btn-primary vl-focus-ring rounded-full px-4 py-3 text-sm"
              >
                Apply code
              </button>
              {referralCode ? (
                <button
                  type="button"
                  onClick={() => {
                    clearReferralCode();
                    setReferralInput("");
                  }}
                  className="vl-btn-secondary vl-focus-ring rounded-full px-4 py-3 text-sm"
                >
                  Clear
                </button>
              ) : null}
            </div>
            {referralSuccess ? <p className="mt-4 text-sm text-emerald-400">{referralSuccess}</p> : null}
            {referralError ? <p className="mt-4 text-sm text-rose-400">{referralError}</p> : null}
            {referralDetails ? (
              <p className="mt-4 text-sm text-zinc-300">Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% customer discount</p>
            ) : null}

            <button
              type="button"
              onClick={() => router.push("/checkout")}
              className="vl-btn-primary vl-focus-ring mt-8 inline-flex w-full justify-center px-5 py-3 text-center text-sm"
            >
              Continue to checkout
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
