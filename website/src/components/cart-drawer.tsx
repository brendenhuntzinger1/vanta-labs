"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCartCurrency, useCart, getShippingProgress } from "@/components/cart-context";

export function CartDrawer() {
  const router = useRouter();
  const [referralInput, setReferralInput] = useState("");
  const {
    items,
    isCartOpen,
    closeCart,
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
    isBuy3Get1FreeEligible,
  } = useCart();

  const shippingProgress = getShippingProgress(subtotal);

  const effectiveReferralInput = referralInput || referralCode || "";

  const handleContinueToCheckout = () => {
    closeCart();
    router.push("/checkout");
  };

  if (!isCartOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end px-0 py-0 sm:px-4 sm:py-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px] animate-[vl-fade-backdrop_0.28s_ease-out]"
        aria-label="Close cart drawer"
        onClick={closeCart}
      />

      <div className="vl-panel relative z-10 flex h-full w-full max-w-xl flex-col rounded-none p-4 shadow-2xl animate-[vl-drawer-in-mobile_0.32s_cubic-bezier(0.2,0.8,0.2,1)] sm:rounded-[2rem] sm:p-6 sm:animate-[vl-drawer-in-desktop_0.32s_cubic-bezier(0.2,0.8,0.2,1)]">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Cart</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Your order</h2>
          </div>
          <button type="button" onClick={closeCart} className="text-sm text-zinc-400 transition hover:text-white">
            Close
          </button>
        </div>

        <div className="mt-5 flex-1 overflow-y-auto pr-1 sm:pr-2">
          {items.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-zinc-700 bg-zinc-900/70 p-8 text-center text-zinc-400">
              <p className="text-lg text-white">Your cart is currently empty.</p>
              <p className="mt-3">Add products to begin building an order.</p>
            </div>
          ) : (
              <div className="space-y-3 sm:space-y-4">
              {items.map((item) => (
                <div key={item.slug} className="vl-panel-soft rounded-[1.25rem] p-3.5 sm:p-4">
                  <div className="flex gap-3 items-start justify-between mb-3">
                    {/* Product image */}
                    <div className="h-14 w-14 flex-shrink-0 rounded-lg border border-zinc-700 bg-zinc-950/50 overflow-hidden flex items-center justify-center sm:h-16 sm:w-16">
                      {item.image ? (
                        <img src={item.image} alt={item.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="text-xs text-zinc-500">No image</div>
                      )}
                    </div>
                    
                    <div className="flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-xs font-semibold text-white sm:text-sm">{item.name}</h3>
                          <p className="mt-1 text-xs text-zinc-400">Batch {item.batchNumber}</p>
                        </div>
                        <button type="button" onClick={() => removeFromCart(item.slug)} className="text-xs text-zinc-500 transition hover:text-white flex-shrink-0">
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 rounded-full border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 sm:px-3 sm:py-2">
                      <button type="button" onClick={() => updateQuantity(item.slug, item.quantity - 1)} className="px-2" aria-label="Decrease quantity">−</button>
                      <span>{item.quantity}</span>
                      <button type="button" onClick={() => updateQuantity(item.slug, item.quantity + 1)} className="px-2" aria-label="Increase quantity">+</button>
                    </div>
                    <p className="text-xs font-medium text-white sm:text-sm">{formatCartCurrency(item.price * item.quantity)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 space-y-3 border-t border-zinc-800 pt-4 sm:space-y-4">
          {/* Buy 3 Get 1 Free Promotion - Show when 3+ items in cart */}
          {isBuy3Get1FreeEligible && (
            <div className="rounded-[1.25rem] border border-emerald-800 bg-emerald-950/40 p-4">
              <p className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
                🎁 Buy 3 Get 1 Free Active
              </p>
              <p className="text-xs text-emerald-300 mt-2">
                Your cheapest item ({`$${Math.min(...items.map(i => i.price)).toFixed(2)}`}) is free! 
              </p>
              <p className="text-xs text-emerald-300/70 mt-1">
                Exclusive summer offer
              </p>
            </div>
          )}

          {/* Referral Code Section - Only show if buy 3 get 1 free is NOT active */}
          {!isBuy3Get1FreeEligible && (
            <label className="block text-sm text-zinc-400">
              <span className="mb-2 block uppercase tracking-[0.3em]">Referral code</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={effectiveReferralInput}
                  onChange={(event) => setReferralInput(event.target.value)}
                  placeholder="VANTA10"
                  className="vl-input flex-1 rounded-full px-4 py-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => applyReferralCode(effectiveReferralInput)}
                  className="vl-btn-secondary vl-focus-ring rounded-full px-4 py-3 text-sm"
                >
                  Apply
                </button>
              </div>
            </label>
          )}
          {referralSuccess ? <p className="text-sm text-emerald-400">{referralSuccess}</p> : null}
          {referralError ? <p className="text-sm text-rose-400">{referralError}</p> : null}
          {referralDetails ? (
            <p className="text-sm text-zinc-300">
              Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% off
            </p>
          ) : null}
          {subtotal > 0 && (
            <div className="vl-panel-soft rounded-[1.25rem] p-4">
              {shippingProgress.isEligibleForFreeShipping ? (
                <div className="text-center">
                  <p className="text-sm font-semibold text-emerald-400 flex items-center justify-center gap-2">
                    🎉 Congratulations free shipping!
                  </p>
                  <div className="mt-3 w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-300"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-zinc-400">Free shipping at $200</span>
                    <span className="text-white font-semibold">${shippingProgress.amountToFreeShipping.toFixed(2)} more</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-300"
                      style={{ width: `${shippingProgress.progressPercentage}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 mt-2">{Math.round(shippingProgress.progressPercentage)}% to free shipping</p>
                </div>
              )}
            </div>
          )}

          <div className="vl-panel-soft rounded-[1.25rem] p-4 text-sm text-zinc-300">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>{formatCartCurrency(subtotal)}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span>Shipping</span>
              <span>{formatCartCurrency(shipping)}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span>Service fee</span>
              <span>{formatCartCurrency(serviceFee)}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span>Applied discount</span>
              <span>-{formatCartCurrency(discountAmount)}</span>
            </div>
            <div className="mt-3 flex justify-between border-t border-zinc-800 pt-3 text-base font-semibold text-white">
              <span>Final total</span>
              <span>{formatCartCurrency(total)}</span>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleContinueToCheckout}
              className="vl-btn-primary vl-focus-ring flex-1 px-4 py-3 text-center text-sm"
            >
              Continue to checkout
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
                Remove code
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
