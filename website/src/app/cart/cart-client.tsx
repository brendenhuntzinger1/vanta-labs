"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCartCurrency, getShippingProgress, useCart, type CartItem } from "@/components/cart-context";
import { getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { BacWaterCartCheckboxes } from "@/components/bac-water-upsell";

export function CartPageClient() {
  const router = useRouter();
  const [referralInput, setReferralInput] = useState("");
  // What live inventory said about this cart, if anything. Set by the
  // re-validation below; drives the per-line notices and the checkout button.
  const [stockNotices, setStockNotices] = useState<string[]>([]);
  const [isValidatingStock, setIsValidatingStock] = useState(false);
  const {
    items,
    isHydrated,
    bundleConfig,
    updateQuantity,
    removeFromCart,
    subtotal,
    shipping,
    discountAmount,
    appliedDiscountLabel,
    autoBestDiscountApplied,
    total,
    referralCode,
    referralDetails,
    referralError,
    referralSuccess,
    applyReferralCode,
    clearReferralCode,
    isApplyingReferral,
    isBuy3Get1FreeActive,
    bulkSavingsApplied,
    bulkSavingsPercent,
    bulkSavingsProgress,
    shippingConfig,
    shippingProtectionEnabled,
    setShippingProtectionEnabled,
    shippingProtectionFee,
  } = useCart();

  /**
   * Re-check the cart against live inventory.
   *
   * A cart is a snapshot in localStorage; by the time it is opened the stock it
   * was built from may be gone. This trims any line that no longer fits and
   * tells the shopper exactly what changed, HERE, where a quantity can be
   * edited — instead of letting them fill in an address and get refused at the
   * payment step. It is advisory only: the binding check is still the atomic
   * reservation taken when the order is created.
   *
   * Returns true when the cart is safe to take to checkout.
   */
  const revalidateStock = useCallback(
    async (current: CartItem[], showSpinner: boolean) => {
      if (current.length === 0) {
        setStockNotices([]);
        return true;
      }

      // Only the button press shows a pending state. The page-entry check runs
      // quietly so the cart does not flash "Checking availability…" on load.
      if (showSpinner) setIsValidatingStock(true);
      try {
        const response = await fetch("/api/cart/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: current.map((item) => ({
              key: item.key,
              slug: item.slug,
              variantId: item.variantId ?? null,
              quantity: item.quantity,
            })),
          }),
        });
        const payload = await response.json();
        if (!payload?.success || !payload.tracking || !Array.isArray(payload.lines)) {
          // Tracking off, or the check degraded — nothing to correct.
          setStockNotices([]);
          return true;
        }

        const notices: string[] = [];
        for (const line of payload.lines as Array<{ key: string; allowed: number; requested: number; name: string | null }>) {
          if (line.allowed >= line.requested) continue;
          const item = current.find((candidate) => candidate.key === line.key);
          const label = item?.name ?? line.name ?? "An item in your cart";
          if (line.allowed <= 0) {
            removeFromCart(line.key);
            notices.push(`${label} just sold out and was removed from your cart.`);
          } else {
            updateQuantity(line.key, line.allowed);
            // States that the line changed, never how much is left. The new
            // quantity is visible on the line itself, so nothing is hidden from
            // the shopper — the shelf depth simply isn't published.
            notices.push(`We've reduced ${label} to the quantity we can ship right now.`);
          }
        }

        setStockNotices(notices);
        return notices.length === 0;
      } catch {
        // Never block checkout on this check failing; the reservation still gates.
        setStockNotices([]);
        return true;
      } finally {
        if (showSpinner) setIsValidatingStock(false);
      }
    },
    [removeFromCart, updateQuantity],
  );

  // Reconcile once, as soon as the cart has hydrated, so a cart reopened days
  // later is corrected before the shopper starts reading totals off it. Guarded
  // by a ref rather than a dependency list because the reconciliation itself
  // edits `items`, and re-running on that edit would loop.
  const hasReconciledRef = useRef(false);
  useEffect(() => {
    if (!isHydrated || hasReconciledRef.current) return;
    hasReconciledRef.current = true;
    const snapshot = items;
    // Deferred off the effect body: the corrections land in a later task, so
    // this never cascades a render synchronously with the effect.
    void Promise.resolve().then(() => revalidateStock(snapshot, false));
  }, [isHydrated, items, revalidateStock]);

  const handleContinueToCheckout = async () => {
    // Last look before leaving the page. If anything was trimmed, stay put and
    // let the shopper see the corrected cart rather than silently proceeding.
    const unchanged = await revalidateStock(items, true);
    if (!unchanged) return;
    router.push("/checkout");
  };

  const effectiveReferralInput = referralInput || referralCode || "";
  const freeShipThreshold = shippingConfig.freeShippingThreshold;
  const shippingProgress = getShippingProgress(subtotal, freeShipThreshold);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      {/* pt-20 / mt-6 on phones (was pt-24 / mt-10). On a short in-app-browser
          viewport (~664px once the host app's chrome is subtracted) the empty
          cart's only way out — "Browse products" — landed at y=473, inside the
          consent banner sitting at y=464. Reclaiming 32px lifts it clear.
          Desktop spacing is unchanged. */}
      <main className="mx-auto max-w-[1440px] px-4 sm:px-6 pb-20 pt-20 sm:pt-32 lg:px-12">
        <div className="max-w-2xl">
          <p className="vl2-eyebrow">Shopping Cart</p>
          <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">Review your materials.</h1>
          <p className="mt-4 text-sm leading-7 text-white/60 sm:text-base">
            Your cart persists locally while you review or continue checkout. Approved ambassador referral codes are validated before checkout.
          </p>
        </div>

        <div className="mt-6 sm:mt-10 grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-10">
          <div className="space-y-3">
            {isHydrated && items.length === 0 ? (
              /* p-6 on phones (p-10 stays from sm up). 40px of padding around
                 an EMPTY panel is what pushed "Browse products" — the only exit
                 from an empty cart — down into the consent banner on a short
                 in-app-browser viewport. */
              <div className="border border-dashed border-white/15 p-6 sm:p-10 text-center text-white/55">
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
                          <div className="flex h-full w-full items-center justify-center text-[9px] uppercase tracking-[0.14em] text-white/60">No image</div>
                        )}
                      </div>
                      <div className="flex flex-1 items-start justify-between gap-4">
                        <div>
                          <h2 className="text-lg text-white sm:text-xl">{item.name}</h2>
                          <p className="mt-2 text-sm text-white/50">
                            {item.doseLabel ? `${item.doseLabel}${item.batchNumber ? " • " : ""}` : ""}{item.batchNumber ? `Batch ${item.batchNumber}` : ""}
                          </p>
                        </div>
                        <button type="button" onClick={() => removeFromCart(item.key)} className="-my-2 px-1 py-2 text-sm text-white/45 transition hover:text-white">
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-4 sm:mt-6">
                      <div className="flex items-center gap-1 border border-white/15 text-sm text-white/75">
                        <button type="button" onClick={() => updateQuantity(item.key, item.quantity - 1)} className="inline-flex h-11 w-11 items-center justify-center text-base" aria-label="Decrease quantity">−</button>
                        <span className="min-w-6 text-center tabular-nums">{item.quantity}</span>
                        <button type="button" onClick={() => updateQuantity(item.key, item.quantity + 1)} className="inline-flex h-11 w-11 items-center justify-center text-base" aria-label="Increase quantity">+</button>
                      </div>
                      <p className="text-base text-white sm:text-lg">{formatCartCurrency(getBundleDiscountedLineTotal(item.price, item.quantity, bundleConfig))}</p>
                    </div>
                  </div>
                );
              })
            )}

            {isHydrated && items.length > 0 ? <BacWaterCartCheckboxes /> : null}
          </div>

          <div className="vl2-glass h-fit p-5 sm:p-7">
            <p className="vl2-eyebrow">Order Summary</p>

            {subtotal > 0 ? (
              <div className="mt-5 border border-white/10 p-4">
                {shippingProgress.isEligibleForFreeShipping ? (
                  <div>
                    <p className="text-sm text-[color:var(--accent-gold)]">Free shipping unlocked</p>
                    <div className="mt-3 h-[2px] w-full bg-[color:var(--accent-gold)]/40" />
                  </div>
                ) : (
                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="text-white/50">Free shipping at {formatCartCurrency(freeShipThreshold)}</span>
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

            {bulkSavingsApplied ? (
              <div className="mt-4 border border-amber-700/60 bg-amber-950/30 p-4">
                <p className="text-sm font-semibold text-amber-300">
                  Congratulations! Your exclusive member bulk discount has been applied.
                </p>
                <p className="mt-1 text-xs text-amber-200/80">{bulkSavingsPercent}% off this order.</p>
              </div>
            ) : bulkSavingsProgress ? (
              <div className="mt-4 border border-white/10 p-4">
                <p className="text-sm text-white/70">
                  You&apos;re only {formatCartCurrency(bulkSavingsProgress.amountRemaining)} away from unlocking{" "}
                  {bulkSavingsProgress.nextPercent}% OFF your order.
                </p>
              </div>
            ) : null}

            {subtotal > 0 ? (
              <label className="mt-6 flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm">
                <span className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={shippingProtectionEnabled}
                    onChange={(e) => setShippingProtectionEnabled(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-[color:var(--accent-gold)]"
                    aria-label="Add shipping protection"
                  />
                  <span>
                    <span className="block font-medium text-white">Shipping Protection <span className="font-normal text-[color:var(--accent-gold)]">(Recommended)</span> <span className="font-normal text-white/45">· optional</span></span>
                    <span className="block text-xs text-white/45">Replace or refund items lost, stolen, or damaged in transit.</span>
                  </span>
                </span>
                <span className="whitespace-nowrap text-white/80">+{formatCartCurrency(shippingProtectionFee || 0)}</span>
              </label>
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
              {discountAmount > 0 ? (
                <div className="flex justify-between text-emerald-300">
                  <span>{appliedDiscountLabel ?? "Discount"}</span>
                  <span>-{formatCartCurrency(discountAmount)}</span>
                </div>
              ) : null}
              {shippingProtectionFee > 0 ? (
                <div className="flex justify-between">
                  <span>Shipping protection</span>
                  <span>+{formatCartCurrency(shippingProtectionFee)}</span>
                </div>
              ) : null}
              <div className="flex justify-between text-white/40">
                <span>Sales tax</span>
                <span>Calculated at checkout</span>
              </div>
              <div className="mt-4 flex justify-between border-t border-white/10 pt-4 text-base text-white">
                <span>Final total</span>
                <span>{formatCartCurrency(total)}</span>
              </div>
              {autoBestDiscountApplied ? (
                <p className="text-xs text-emerald-300/80">✓ We&apos;ve automatically applied your best available discount.</p>
              ) : null}
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
                    className="w-full border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/60 outline-none transition focus:border-white/50"
                  />
                </label>
                <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => applyReferralCode(effectiveReferralInput)}
                    disabled={isApplyingReferral}
                    className="vl2-btn-primary vl-focus-ring px-4 py-3 text-sm disabled:opacity-60"
                  >
                    {isApplyingReferral ? "Applying…" : "Apply code"}
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

            {stockNotices.length > 0 ? (
              <div role="alert" className="mt-6 rounded-xl border border-[color:var(--accent-gold)]/40 bg-[var(--accent-gold-soft)] p-3.5 text-sm leading-6 text-white/85">
                {stockNotices.map((notice) => (
                  <p key={notice}>{notice}</p>
                ))}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => void handleContinueToCheckout()}
              disabled={(isHydrated && items.length === 0) || isValidatingStock}
              className="vl2-btn-primary vl-focus-ring mt-8 inline-flex w-full justify-center px-5 py-3 text-center text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isHydrated && items.length === 0
                ? "Your cart is empty"
                : isValidatingStock
                  ? "Checking availability…"
                  : "Continue to checkout"}
            </button>

            <div className="mt-5 flex items-center justify-center gap-6 text-[10px] uppercase tracking-[0.14em] text-white/70">
              <span>Encrypted Checkout</span>
              <span>Fast Dispatch</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
