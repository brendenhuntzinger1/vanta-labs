"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCart } from "@/components/cart-context";
import type { Product } from "@/lib/catalog-types";
import {
  BAC_WATER_SLUG,
  bacWaterAddOptions,
  getBacWaterDoseOffers,
  isBacWater,
  isFeaturedBacWaterOffer,
  type BacWaterDoseOffer,
} from "@/lib/bac-water";

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

// -------------------------------------------------------------------------
// Shared fetch for client-only surfaces (cart checkboxes, nudge popup).
// Module-level cache: the drawer, cart page, and popup can all mount in one
// session and the catalog is only hit once. The product-page surfaces skip
// this entirely — they get BAC Water via SSR props.
// -------------------------------------------------------------------------
let cachedOffer: Product | null | undefined;
let pendingFetch: Promise<Product | null> | null = null;

function fetchBacWater(): Promise<Product | null> {
  if (cachedOffer !== undefined) return Promise.resolve(cachedOffer);
  if (!pendingFetch) {
    pendingFetch = fetch("/api/catalog/bac-water", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const result = await response.json() as { success: boolean; product?: Product };
        return result.success && result.product ? result.product : null;
      })
      .catch(() => null)
      .then((product) => {
        cachedOffer = product;
        return product;
      });
  }
  return pendingFetch;
}

function useBacWaterProduct() {
  const [product, setProduct] = useState<Product | null>(cachedOffer ?? null);
  useEffect(() => {
    let cancelled = false;
    fetchBacWater().then((fetched) => {
      if (!cancelled) setProduct(fetched);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return product;
}

// -------------------------------------------------------------------------
// Product page — "Recommended Accessories", right below Add to Cart.
// Light lab theme. Hidden on the BAC Water page itself.
// -------------------------------------------------------------------------
export function BacWaterAccessoryBlock({ bacWater, hostSlug }: { bacWater: Product | null; hostSlug: string }) {
  const { addToCart } = useCart();
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const offers = useMemo(() => getBacWaterDoseOffers(bacWater), [bacWater]);

  if (!bacWater || isBacWater(hostSlug) || offers.length === 0) return null;

  const handleAdd = (offer: BacWaterDoseOffer, sourceElement: HTMLElement | null) => {
    addToCart(bacWater, 1, sourceElement, bacWaterAddOptions(bacWater, offer));
    setAddedKey(offer.cartKey);
    setTimeout(() => setAddedKey((current) => (current === offer.cartKey ? null : current)), 2500);
  };

  return (
    <div className="mt-5 rounded-2xl border border-white/[0.08] bg-[#141414] p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-gold)]">
        Frequently purchased together
      </p>
      <div className="mt-4 space-y-2.5">
        {offers.map((offer) => (
          <button
            key={offer.cartKey}
            type="button"
            onClick={(event) => handleAdd(offer, event.currentTarget)}
            className="vl-focus-ring flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-left transition duration-200 hover:border-[color:var(--accent-gold)]/40 hover:bg-white/[0.04] active:scale-[0.99]"
          >
            <span className="min-w-0 text-sm">
              <span className="font-medium text-white">BAC Water {offer.sizeLabel}</span>
              <span className="ml-1.5 text-[#a3a3a3]">+{offer.displayPrice}</span>
              {isFeaturedBacWaterOffer(offer) ? (
                <span className="ml-2 inline-flex items-center align-middle text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)]">
                  Most popular
                </span>
              ) : null}
            </span>
            <span
              className={`shrink-0 text-xs font-semibold uppercase tracking-[0.1em] transition-colors duration-200 ${
                addedKey === offer.cartKey ? "text-[color:var(--accent-gold)]" : "text-[color:var(--accent-gold)]"
              }`}
            >
              {/* Green here is genuine success feedback, not branding. */}
              {addedKey === offer.cartKey ? "Added ✓" : "Add"}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3.5 text-xs leading-5 text-[#a3a3a3]">
        Over 70% of customers add BAC Water to complete their order.
      </p>
    </div>
  );
}

// -------------------------------------------------------------------------
// Product page — "Frequently Bought Together" section under the peptide.
// Pairs the current product (its selected dose) with a chosen BAC size.
// -------------------------------------------------------------------------
export function FrequentlyBoughtTogether({
  product,
  selectedDoseId,
  bacWater,
}: {
  product: Product;
  selectedDoseId: string | null;
  bacWater: Product | null;
}) {
  const { addToCart } = useCart();
  const offers = useMemo(() => getBacWaterDoseOffers(bacWater), [bacWater]);
  const [selectedOfferKey, setSelectedOfferKey] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  if (!bacWater || isBacWater(product.slug) || offers.length === 0) return null;

  // 30mL is the spotlighted size, so it's the pre-selected pairing.
  const defaultOffer = offers.find(isFeaturedBacWaterOffer) ?? offers[0];
  const selectedOffer = offers.find((offer) => offer.cartKey === selectedOfferKey) ?? defaultOffer;
  const productDose = product.doses?.find((dose) => dose.id === selectedDoseId)
    ?? product.doses?.find((dose) => dose.isDefault)
    ?? product.doses?.[0]
    ?? null;
  const productPriceLabel = productDose?.salePrice ?? productDose?.price ?? product.salePrice ?? product.price;
  const productUnitPrice = Number((productPriceLabel ?? "").replace(/[^0-9.]/g, "")) || 0;
  const isHostOutOfStock = (productDose?.stockStatus ?? product.stockStatus) === "Out of Stock";
  const comboTotal = productUnitPrice + selectedOffer.unitPrice;

  const handleAddBoth = (sourceElement: HTMLElement | null) => {
    addToCart(product, 1, sourceElement, {
      variantId: productDose?.id,
      doseLabel: productDose?.label,
      sku: productDose?.sku,
      priceOverride: productUnitPrice,
      imageOverride: productDose?.imageUrl ?? product.image,
      batchNumberOverride: productDose?.batchNumber ?? product.batchNumber,
      stockStatusOverride: productDose?.stockStatus ?? product.stockStatus,
    });
    addToCart(bacWater, 1, null, bacWaterAddOptions(bacWater, selectedOffer));
    setConfirmation(`Added ${product.name}${productDose ? ` (${productDose.label})` : ""} + BAC Water ${selectedOffer.sizeLabel} to cart.`);
    setTimeout(() => setConfirmation(null), 3000);
  };

  return (
    <section className="vl2-lab-panel mt-10 p-5 sm:p-7">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--accent-gold)]">Frequently bought together</p>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-[#a3a3a3]">
          <span className="min-w-0 truncate font-medium text-white">
            {product.name}
            {productDose ? ` · ${productDose.label}` : ""}
            <span className="ml-1.5 font-normal text-[#a3a3a3]">{productPriceLabel}</span>
          </span>
          <span aria-hidden="true" className="text-white/35">+</span>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-white">BAC Water</span>
            {offers.map((offer) => (
              <button
                key={offer.cartKey}
                type="button"
                onClick={() => setSelectedOfferKey(offer.cartKey)}
                aria-pressed={selectedOffer.cartKey === offer.cartKey}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  selectedOffer.cartKey === offer.cartKey
                    ? "border-[color:var(--accent-gold)] bg-[color:var(--accent-gold)]/15 text-[color:var(--accent-gold)]"
                    : "border-white/[0.08] text-[#a3a3a3] hover:border-white/20 hover:text-white"
                }`}
              >
                {offer.sizeLabel} · {offer.displayPrice}
              </button>
            ))}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <p className="text-lg font-semibold text-white tabular-nums">{formatUsd(comboTotal)}</p>
          <button
            type="button"
            disabled={isHostOutOfStock}
            onClick={(event) => handleAddBoth(event.currentTarget)}
            className="vl2-btn-primary vl-focus-ring rounded-full px-6 py-3 text-xs"
          >
            Add Both to Cart
          </button>
        </div>
      </div>
      {confirmation ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-[color:var(--success)]">{confirmation}</p>
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------------------
// Cart (drawer + /cart page) — quick-add checkboxes. Dark theme. Checked
// means "this size is in the cart"; unticking removes that line.
// -------------------------------------------------------------------------
export function BacWaterCartCheckboxes() {
  const { items, addToCart, removeFromCart } = useCart();
  const bacWater = useBacWaterProduct();
  const offers = useMemo(() => getBacWaterDoseOffers(bacWater), [bacWater]);

  if (!bacWater || offers.length === 0) return null;

  return (
    <div className="vl-panel-soft rounded-[1.25rem] p-4">
      <p className="text-sm font-medium text-white">Complete your order</p>
      <div className="mt-2.5 space-y-2">
        {offers.map((offer) => {
          const inCart = items.some((item) => item.key === offer.cartKey);
          return (
            <label key={offer.cartKey} className="flex cursor-pointer items-center justify-between gap-3">
              <span className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={inCart}
                  onChange={(event) => {
                    if (event.target.checked) {
                      addToCart(bacWater, 1, null, bacWaterAddOptions(bacWater, offer));
                    } else {
                      removeFromCart(offer.cartKey);
                    }
                  }}
                  className="h-4 w-4 accent-emerald-500"
                  aria-label={`Add ${offer.sizeLabel} BAC Water`}
                />
                <span className="text-sm text-white">Add {offer.sizeLabel} BAC Water</span>
              </span>
              <span className="whitespace-nowrap text-sm text-[#a3a3a3]">+{offer.displayPrice}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Global "Don't forget BAC Water" popup. Mounted once in the root layout;
// listens for the add_to_cart analytics event every add already fires, and
// shows at most once per browser session — never when BAC Water is the item
// being added or is already in the cart.
// -------------------------------------------------------------------------
const NUDGE_SESSION_KEY = "vl-bac-water-nudge-shown";

export function BacWaterAddedPopup() {
  const { items, addToCart } = useCart();
  const bacWater = useBacWaterProduct();
  const offers = useMemo(() => getBacWaterDoseOffers(bacWater), [bacWater]);
  const [isOpen, setIsOpen] = useState(false);
  const dismissButtonRef = useRef<HTMLButtonElement | null>(null);

  // Refs so the (single, stable) event listener always sees current state.
  const itemsRef = useRef(items);
  const bacWaterRef = useRef(bacWater);
  useEffect(() => {
    itemsRef.current = items;
    bacWaterRef.current = bacWater;
  }, [items, bacWater]);

  useEffect(() => {
    const handleAnalytics = (event: Event) => {
      const detail = (event as CustomEvent<{ eventType?: string; productSlug?: string }>).detail;
      if (detail?.eventType !== "add_to_cart") return;
      if (!detail.productSlug || detail.productSlug === BAC_WATER_SLUG) return;
      if (!bacWaterRef.current) return;
      if (itemsRef.current.some((item) => item.slug === BAC_WATER_SLUG)) return;
      try {
        if (window.sessionStorage.getItem(NUDGE_SESSION_KEY)) return;
        window.sessionStorage.setItem(NUDGE_SESSION_KEY, "1");
      } catch {
        // Session storage unavailable — still show it this once.
      }
      // Let the fly-to-cart animation land before the popup appears.
      setTimeout(() => setIsOpen(true), 700);
    };

    window.addEventListener("vanta:analytics", handleAnalytics as EventListener);
    return () => window.removeEventListener("vanta:analytics", handleAnalytics as EventListener);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    dismissButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (!isOpen || !bacWater || offers.length === 0) return null;

  const image = bacWater.coverImage ?? bacWater.image;
  const hasRealImage = Boolean(image) && !image.includes(".svg");

  const handleAdd = (offer: BacWaterDoseOffer) => {
    addToCart(bacWater, 1, null, bacWaterAddOptions(bacWater, offer));
    setIsOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center px-4 pb-6 sm:items-center sm:pb-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Dismiss reminder"
        onClick={() => setIsOpen(false)}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bac-water-nudge-title"
        className="vl-panel relative z-10 w-full max-w-md rounded-[1.5rem] p-5 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {hasRealImage ? (
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-black/40">
                <Image src={image} alt={bacWater.name} fill sizes="56px" className="object-cover" />
              </div>
            ) : null}
            <div>
              <p id="bac-water-nudge-title" className="text-base font-semibold text-white">Don&apos;t forget BAC Water</p>
              <p className="mt-1 text-xs leading-5 text-[#a3a3a3]">
                Lyophilized compounds require a sterile diluent for reconstitution.
              </p>
            </div>
          </div>
          <button
            ref={dismissButtonRef}
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close"
            className="-mr-1 -mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center text-[#a3a3a3] transition hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-4 w-4"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {offers.map((offer) => (
            <button
              key={offer.cartKey}
              type="button"
              onClick={() => handleAdd(offer)}
              className="vl-focus-ring flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-left transition hover:border-[color:var(--accent-gold)]/40"
            >
              <span className="text-sm text-white">
                BAC Water {offer.sizeLabel}
                {isFeaturedBacWaterOffer(offer) ? (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)]">
                    <span aria-hidden="true">★</span> Most Popular
                  </span>
                ) : null}
              </span>
              <span className="text-sm font-semibold text-[color:var(--accent-gold)]">+{offer.displayPrice}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="mt-3 w-full py-2 text-center text-xs text-[#a3a3a3] transition hover:text-white"
        >
          No thanks, continue shopping
        </button>
      </div>
    </div>
  );
}
