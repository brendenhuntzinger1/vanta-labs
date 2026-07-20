"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCartCurrency, getShippingProgress, useCart } from "@/components/cart-context";
import { getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";
import { SiteHeaderV2 } from "@/components/site-header-v2";

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
    isBuy3Get1FreeActive,
  } = useCart();

  const effectiveReferralInput = referralInput || referralCode || "";
  const shippingProgress = getShippingProgress(subtotal);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-[1440px] px-6 pb-20 pt-32 lg:px-12">
        <div className="max-w-2xl">
          <p className="vl2-eyebrow">Shopping Cart</p>
          <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">Review your materials.</h1>
          <p className="mt-4 text-sm leading-7 text-white/60 sm:text-base">
            Your cart persists locally while you review or continue checkout. Approved ambassador referral codes are validated before checkout.
          </p>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-10">
          <div className="space-y-3">
            {items.length === 0 ? (
              <div className="border border-dashed border-white/15 p-10 text-center text-white/55">
                <p className="text-lg text-white">No items yet.</p>
                <p className="mt-3">Visit the catalog to add products.</p>
                <Link href="/products" className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-5 py-3 text-sm">
                  Browse products
                </Link>
              </div>
            ) : (
              items.map((item) => {
                const hasRealImage = Boolean(item.image) && !item.image.includes(".svg");
                return (
                  <div key={item.key} className="border border-white/10 p-4 sm:p-6">
                    <div className="flex items-start gap-4">
                      <div className="relative h-16 w-16 flex-shrink-0 border border-white/10 bg-black/40 sm:h-20 sm:w-20">
                        {hasRealImage ? (
                          <Image src={item.image} alt={item.name} fill sizes="80px" className="object-contain p-2" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[9px] uppercase tracking-[0.14em] text-white/30">No image</div>
                        )}
                      </div>
                      <div className="flex flex-1 items-start justify-between gap-4">
                        <div>
                          <h2 className="text-lg text-white sm:text-xl">{item.name}</h2>
                          <p className="mt-2 text-sm text-white/50">
                            {item.doseLabel ? `${item.doseLabel} • ` : ""}Batch {item.batchNumber}
                          </p>
                        </div>
                        <button type="button" onClick={() => removeFromCart(item.key)} className="text-sm text-white/45 transition hover:text-white">
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-4 sm:mt-6">
                      <div className="flex items-center gap-2 border border-white/15 px-2 py-1.5 text-sm text-white/75 sm:gap-3 sm:px-3 sm:py-2">
                        <button type="button" onClick={() => updateQuantity(item.key, item.quantity - 1)} className="px-2" aria-label="Decrease quantity">−</button>
                        <span>{item.quantity}</span>
                        <button type="button" onClick={() => updateQuantity(item.key, item.quantity + 1)} className="px-2" aria-label="Increase quantity">+</button>
                      </div>
                      <p className="text-base text-white sm:text-lg">{formatCartCurrency(getBundleDiscountedLineTotal(item.price, item.quantity))}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="vl2-glass h-fit p-5 sm:p-7">
            <p className="vl2-eyebrow">Order Summary</p>

            {subtotal > 0 ? (
              <div className="mt-5 border border-white/10 p-4">
                {shippingProgress.isEligibleForFreeShipping ? (
                  <div>
                    <p className="text-sm text-emerald-300">Free shipping unlocked</p>
                    <div className="mt-3 h-[2px] w-full bg-emerald-300/40" />
                  </div>
                ) : (
                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-white/50">Free shipping at $250</span>
                      <span className="text-white">${shippingProgress.amountToFreeShipping.toFixed(2)} away</span>
                    </div>
                    <div className="h-[2px] w-full bg-white/10">
                      <div
                        className="h-full bg-white transition-all duration-500"
                        style={{ width: `${shippingProgress.progressPercentage}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="mt-6 space-y-3 text-sm text-white/70">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatCartCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Estimated shipping</span>
                <span>{formatCartCurrency(shipping)}</span>
              </div>
              {serviceFee > 0 ? (
                <div className="flex justify-between">
                  <span>Service fee</span>
                  <span>{formatCartCurrency(serviceFee)}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span>Applied discount</span>
                <span>-{formatCartCurrency(discountAmount)}</span>
              </div>
              <div className="mt-4 flex justify-between border-t border-white/10 pt-4 text-base text-white">
                <span>Final total</span>
                <span>{formatCartCurrency(total)}</span>
              </div>
            </div>

            {isBuy3Get1FreeActive ? (
              <p className="mt-8 border border-white/20 px-3 py-2 text-sm text-white/75">
                Buy 3 Get 1 Free is active. Referral discounts cannot be combined with this promotion.
              </p>
            ) : (
              <>
                <label className="mt-8 block text-sm text-white/50">
                  <span className="vl2-eyebrow mb-2 block">Referral Code</span>
                  <input
                    type="text"
                    value={effectiveReferralInput}
                    onChange={(event) => setReferralInput(event.target.value)}
                    placeholder="VANTA10"
                    className="w-full border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  />
                </label>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => applyReferralCode(effectiveReferralInput)}
                    className="vl2-btn-primary vl-focus-ring px-4 py-3 text-sm"
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
                      className="vl2-btn-secondary vl-focus-ring px-4 py-3 text-sm"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </>
            )}
            {referralSuccess ? <p className="mt-4 text-sm text-emerald-300">{referralSuccess}</p> : null}
            {referralError ? <p className="mt-4 text-sm text-rose-300">{referralError}</p> : null}
            {referralDetails ? (
              <p className="mt-4 text-sm text-white/60">Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% customer discount</p>
            ) : null}

            <button
              type="button"
              onClick={() => router.push("/checkout")}
              className="vl2-btn-primary vl-focus-ring mt-8 inline-flex w-full justify-center px-5 py-3 text-center text-sm"
            >
              Continue to checkout
            </button>

            <div className="mt-5 flex items-center justify-center gap-6 text-[10px] uppercase tracking-[0.14em] text-white/40">
              <span>Encrypted Checkout</span>
              <span>Fast Dispatch</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
