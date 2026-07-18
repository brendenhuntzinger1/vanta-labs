"use client";

import Link from "next/link";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";

export default function CartPage() {
  const {
    items,
    updateQuantity,
    removeFromCart,
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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">Shopping cart</p>
          <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">Review your selected materials.</h1>
          <p className="mt-6 text-lg leading-8 text-zinc-400">Your cart persists locally while you review or continue checkout. Approved ambassador referral codes are validated with Supabase before checkout.</p>
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            {items.length === 0 ? (
              <div className="rounded-[2rem] border border-dashed border-zinc-700 bg-zinc-900/70 p-10 text-center text-zinc-400">
                <p className="text-xl text-white">No items yet.</p>
                <p className="mt-3">Visit the catalog to add sample products.</p>
                <Link href="/products" className="mt-6 inline-flex rounded-full border border-zinc-600 bg-white px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200">
                  Browse products
                </Link>
              </div>
            ) : (
              items.map((item) => (
                <div key={item.slug} className="rounded-[1.5rem] border border-zinc-800 bg-zinc-900/70 p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-semibold text-white">{item.name}</h2>
                      <p className="mt-2 text-sm text-zinc-400">Batch {item.batchNumber}</p>
                    </div>
                    <button type="button" onClick={() => removeFromCart(item.slug)} className="text-sm text-zinc-500 transition hover:text-white">
                      Remove
                    </button>
                  </div>
                  <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3 rounded-full border border-zinc-700 px-3 py-2 text-sm text-zinc-300">
                      <button type="button" onClick={() => updateQuantity(item.slug, item.quantity - 1)} className="px-2">−</button>
                      <span>{item.quantity}</span>
                      <button type="button" onClick={() => updateQuantity(item.slug, item.quantity + 1)} className="px-2">+</button>
                    </div>
                    <p className="text-lg font-semibold text-white">{formatCartCurrency(item.price * item.quantity)}</p>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-6">
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Order summary</p>
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
                defaultValue={referralCode ?? ""}
                placeholder="VANTA10"
                className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
              />
            </label>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  const input = document.querySelector<HTMLInputElement>("[placeholder='VANTA10']");
                  if (input) {
                    applyReferralCode(input.value);
                  }
                }}
                className="rounded-full border border-zinc-600 bg-white px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
              >
                Apply code
              </button>
              {referralCode ? (
                <button type="button" onClick={clearReferralCode} className="rounded-full border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800">
                  Clear
                </button>
              ) : null}
            </div>
            {referralSuccess ? <p className="mt-4 text-sm text-emerald-400">{referralSuccess}</p> : null}
            {referralError ? <p className="mt-4 text-sm text-rose-400">{referralError}</p> : null}
            {referralDetails ? (
              <p className="mt-4 text-sm text-zinc-300">Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% customer discount</p>
            ) : null}

            <Link href="/checkout" className="mt-8 inline-flex w-full justify-center rounded-full border border-zinc-600 bg-white px-5 py-3 text-center text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200">
              Continue to checkout
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
