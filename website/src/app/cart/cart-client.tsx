"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCartCurrency, getShippingProgress, useCart, type CartItem } from "@/components/cart-context";
import { getBundleDiscountedLineTotal } from "@/lib/bundle-pricing";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { BacWaterCartCheckboxes } from "@/components/bac-water-upsell";
import { CHECKOUT_SHORT, DESTINATIONS_SENTENCE, FULFILMENT_SENTENCE, FULFILMENT_SHORT, TRACKING_SENTENCE } from "@/lib/trust-claims";
import { cartTotalLabel, pendingChargeNotice } from "@/lib/cart-total-disclosure";
import type { CardProcessingFeeConfig } from "@/lib/payment-methods";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";

/**
 * The body of the empty-cart panel.
 *
 * Shared, and rendered TWICE: once for real when the cart is known to be empty,
 * and once hidden as the pre-hydration placeholder that reserves this column's
 * height. Sharing it is the point — the placeholder is exactly as tall as what
 * replaces it because it *is* what replaces it, so editing this copy cannot
 * silently reintroduce the layout jump.
 */
const EMPTY_CART_PANEL_CONTENT = (
  <>
    <p className="text-lg text-white">No items yet.</p>
    <p className="mt-3">Visit the catalog to add products.</p>
    <Link href="/products" className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-5 py-3 text-sm">
      Browse products
    </Link>
  </>
);

export function CartPageClient() {
  const router = useRouter();
  const [referralInput, setReferralInput] = useState("");
  // What live inventory said about this cart, if anything. Set by the
  // re-validation below; drives the per-line notices and the checkout button.
  const [stockNotices, setStockNotices] = useState<string[]>([]);
  // The card service fee is decided server-side and applied at checkout. The
  // cart never computes it — it reads the config purely so it can DISCLOSE it,
  // instead of showing a "Final total" that grows by 3% one screen later.
  const [cardFee, setCardFee] = useState<CardProcessingFeeConfig | null>(null);
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
    referralError,
    referralSuccess,
    referralStatusText,
    referralNeedsMoreToQualify,
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
    let cancelled = false;
    fetch("/api/catalog/payment-methods", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((result: { cardProcessingFee?: CardProcessingFeeConfig | null } | null) => {
        if (!cancelled) setCardFee(result?.cardProcessingFee ?? null);
      })
      .catch(() => {
        // Disclosure is best-effort: a failed read must never block the cart.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      <main className="vl-nav-clearance mx-auto max-w-[1440px] px-4 sm:px-6 pb-20 pt-20 sm:pt-32 lg:px-12">
        <div className="max-w-2xl">
          <p className="vl2-eyebrow">Shopping Cart</p>
          <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">Review your materials.</h1>
          <p className="mt-4 text-sm leading-7 text-white/60 sm:text-base">
            Your cart persists locally while you review or continue checkout. Approved ambassador referral codes are validated before checkout.
          </p>
        </div>

        <div className="mt-6 sm:mt-10 grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-10">
          <div className="space-y-3">
            {!isHydrated ? (
              /* PRE-HYDRATION PLACEHOLDER — reserves the space the real content
                 is about to take.

                 The cart lives in localStorage, so the server cannot know what
                 is in it and renders this column empty. Both real branches below
                 then appear at once, and everything under them jumps down.
                 Measured on the harness at 390x844: "Order Summary" started at
                 y=557 — above the fold — and landed at y=745 165ms later. A
                 188px jump, on the page a shopper is reading.

                 Chromium's layout-shift API scored that 0.0000, because React
                 replaces these nodes during hydration rather than moving them,
                 so the entry never fires. A CLS number is not evidence that this
                 page is stable; the y-position trace is.

                 It renders the SAME children as the empty-cart panel, hidden
                 with `invisible` (visibility: hidden keeps the box, unlike
                 `hidden`), so the reserved height is the real height by
                 construction. Deliberately not a stack of fixed-height skeleton
                 bars: that version measured 178px against the panel's 184 and
                 left a 10px jump, and it would drift again the next time anyone
                 edits this copy. Nothing here has to be kept in sync.

                 The text is not merely transparent — visibility:hidden takes the
                 link out of the tab order too, and aria-hidden takes the whole
                 block off the accessibility tree, so a screen reader never meets
                 "No items yet" on a cart that has items. That flash is the
                 failure the checkout summary's own comment warns about.

                 A cart WITH items still grows past this, which no server render
                 can prevent without knowing the item count, but it grows from a
                 reserved floor instead of from zero. */
              <div
                className="vl-skeleton border border-dashed border-white/10 p-6 text-center sm:p-10"
                aria-hidden="true"
                data-testid="cart-items-placeholder"
              >
                <div className="invisible">{EMPTY_CART_PANEL_CONTENT}</div>
              </div>
            ) : items.length === 0 ? (
              /* p-6 on phones (p-10 stays from sm up). 40px of padding around
                 an EMPTY panel is what pushed "Browse products" — the only exit
                 from an empty cart — down into the consent banner on a short
                 in-app-browser viewport. */
              <div className="border border-dashed border-white/15 p-6 sm:p-10 text-center text-white/55">
                {EMPTY_CART_PANEL_CONTENT}
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
                {/* The PROSPECTIVE fee, not the applied one. `shippingProtectionFee`
                    is 0 while the box is unticked — which it is for every shopper
                    still deciding — so this row offered a paid add-on at +$0.00 and
                    only revealed the price after they had agreed to it. The drawer
                    and checkout already priced it this way. */}
                <span className="whitespace-nowrap text-white/80">+{formatCartCurrency(calculateShippingProtectionFee(subtotal))}</span>
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
                {/* "Final total" is only accurate once nothing further will be
                    added. Tax is always outstanding here, and on a card order
                    so is the service fee — this said "Final total" and then
                    grew by 3% at checkout. */}
                <span>{cartTotalLabel({ taxPending: true, cardFeeApplies: Boolean(cardFee?.enabled && cardFee.percentage > 0) })}</span>
                <span>{formatCartCurrency(total)}</span>
              </div>
              {pendingChargeNotice({ cardFee, taxPending: false }) ? (
                <p className="text-xs text-white/40">{pendingChargeNotice({ cardFee, taxPending: false })}</p>
              ) : null}
              {autoBestDiscountApplied ? (
                <p className="text-xs text-emerald-300/80">✓ We&apos;ve automatically applied your best available discount.</p>
              ) : null}
            </div>

            {/* WHAT SHIPPING ACTUALLY MEANS, BEFORE COMMITTING TO CHECKOUT.
                Every line here is read from configuration or from a statement
                the store already publishes; nothing new is promised.

                  * Destinations: quote-order.ts rejects anything outside the
                    US and Canada with "We currently ship only to the United
                    States and Canada." Until now a customer learned that only
                    after entering checkout and filling in an address, which is
                    a dead end at the worst possible moment.
                  * Free shipping: the threshold comes from the same
                    shippingConfig the server totals use, never a literal.
                  * One business day is PREPARATION, not delivery. It is worded
                    as processing and explicitly separated from carrier transit,
                    because the store controls the first and not the second.
                    This is the wording already on the product page.

                No delivery date, no transit estimate and no guarantee is
                stated, because none is configured anywhere in this codebase. */}
            <ul className="mt-5 space-y-1.5 border-t border-white/10 pt-4 text-xs leading-5 text-white/45">
              <li>{DESTINATIONS_SENTENCE}</li>
              <li>
                Free shipping on orders over {formatCartCurrency(freeShipThreshold)}.
              </li>
              <li>{FULFILMENT_SENTENCE}</li>
              <li>{TRACKING_SENTENCE}</li>
            </ul>

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
            {referralStatusText ? (
              <p className={`mt-4 text-sm ${referralNeedsMoreToQualify ? "text-amber-300/80" : "text-white/60"}`}>
                {referralStatusText}
              </p>
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
              <span>{CHECKOUT_SHORT}</span>
              <span>{FULFILMENT_SHORT}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
