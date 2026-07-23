"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ProductCard } from "@/components/product-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { WishlistButton } from "@/components/wishlist-button";
import { BackInStockForm } from "@/components/back-in-stock-form";
import { SubscribeSave } from "@/components/subscribe-save";
import { bundleDiscountRate, getBundleDiscountedLineTotal, DEFAULT_BUNDLE_CONFIG, type BundleConfig } from "@/lib/bundle-pricing";
import type { Product, ProductFaqItem } from "@/lib/catalog-types";
import { RecentlyViewed } from "@/components/recently-viewed";
import Image from "next/image";

function parseDose(slug: string) {
  const match = slug.match(/(\d+(?:\.\d+)?(?:mg|iu|mcg|g|ml))$/i);
  return match ? match[1].toUpperCase() : "";
}

type GalleryItem = {
  id: string;
  imageUrl: string;
  altText: string;
};

function toPriceNumber(value?: string) {
  if (!value) return 0;
  return Number(value.replace(/[^0-9.]/g, "")) || 0;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

const BUNDLE_OPTIONS = [
  { quantity: 1, label: "1 Bottle", badge: null },
  { quantity: 2, label: "2 Bottles", badge: "Most Popular" },
  { quantity: 3, label: "3+ Bottles", badge: "Best Value" },
] as const;

const TRUST_ROW = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M2 8h11v8H2z" />
        <path d="M13 11h4l4 3v2h-8z" />
        <circle cx="6.5" cy="18.5" r="1.6" />
        <circle cx="17" cy="18.5" r="1.6" />
      </svg>
    ),
    label: "Fast Dispatch",
    detail: "Ships within one business day",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
    label: "Secure Checkout",
    detail: "Encrypted payment session",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.4 2.4L16 9.6" />
      </svg>
    ),
    label: "COA Verified",
    detail: "Third-party batch testing",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M9 2h6M10 2v6.2a2 2 0 0 1-.34 1.12L4.9 17.2A2.4 2.4 0 0 0 6.9 21h10.2a2.4 2.4 0 0 0 2-3.8l-4.76-7.88A2 2 0 0 1 14 8.2V2" />
      </svg>
    ),
    label: "USA Sourced",
    detail: "Among the purest sources available",
  },
] as const;

// Default FAQ used when a product has no admin-authored FAQ of its own. Kept in
// the {question, answer} shape so per-product and default FAQs are interchangeable.
const DEFAULT_PRODUCT_FAQ: ProductFaqItem[] = [
  {
    question: "Is this product intended for human consumption?",
    answer: "No. All compounds sold by Vanta Labs are strictly for legitimate laboratory research purposes and are not intended for human or veterinary use.",
  },
  {
    question: "How do I access the Certificate of Analysis?",
    answer: "Each product page links directly to the batch-matched COA. You can also browse all records in the COA Library.",
  },
  {
    question: "What is your shipping timeline?",
    answer: "Most in-stock orders are prepared within one business day. You will receive secure tracking information after dispatch.",
  },
  {
    question: "Can I combine referral codes with promotions?",
    answer: "Referral discounts cannot be combined with Buy 3 Get 1 Free offers. Only one discount type applies per order.",
  },
];

function FaqAccordion({ items }: { items?: ProductFaqItem[] }) {
  const faqItems = items && items.length > 0 ? items : DEFAULT_PRODUCT_FAQ;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className="mt-3 divide-y divide-zinc-200">
      {faqItems.map((item, idx) => (
        <div key={idx}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 py-4 text-left text-sm text-[#111] transition hover:text-zinc-600"
            onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
          >
            <span className="font-medium">{item.question}</span>
            <span className={`shrink-0 text-zinc-400 transition-transform duration-200 ${openIndex === idx ? "rotate-180" : ""}`}>▼</span>
          </button>
          {openIndex === idx && (
            <p className="pb-4 text-sm leading-7 text-zinc-500">{item.answer}</p>
          )}
        </div>
      ))}
    </div>
  );
}

type TabKey = "description" | "specs" | "coa";

export function ProductDetailClient({
  product,
  relatedProducts = [],
  promoBuy3Get1Enabled = false,
  bundleConfig = DEFAULT_BUNDLE_CONFIG,
}: {
  product: Product;
  relatedProducts?: Product[];
  promoBuy3Get1Enabled?: boolean;
  bundleConfig?: BundleConfig;
}) {
  const { addToCart } = useCart();
  const defaultDose = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0] ?? null;
  const [selectedDoseId, setSelectedDoseId] = useState<string | null>(defaultDose?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  // Collapsed by default — no panel is shown until the shopper taps a tab.
  const [activeTab, setActiveTab] = useState<TabKey | null>(null);

  const selectedDose = product.doses?.find((dose) => dose.id === selectedDoseId) ?? defaultDose;

  const selectedPrice = selectedDose?.salePrice ?? selectedDose?.price ?? product.price;
  const selectedCompareAtPrice = selectedDose?.compareAtPrice ?? product.compareAtPrice;
  const selectedBatchNumber = selectedDose?.batchNumber ?? product.batchNumber;
  const selectedPurity = selectedDose?.purityResult ?? product.purityResult;
  const selectedCoaUrl = selectedDose?.coaUrl ?? product.coaUrl;
  const selectedStockStatus = selectedDose?.stockStatus ?? product.stockStatus;
  const isOutOfStock = selectedStockStatus === "Out of Stock" || selectedStockStatus === "Reserved";
  const unitPrice = toPriceNumber(selectedPrice);
  const currentBundleRate = bundleDiscountRate(quantity, bundleConfig);

  const galleryItems = useMemo<GalleryItem[]>(() => {
    const fromGallery = (product.galleryImages ?? []).map((image) => ({
      id: image.id,
      imageUrl: image.imageUrl,
      altText: image.altText ?? product.name,
    }));

    const fallback = [selectedDose?.imageUrl, product.coverImage, product.image]
      .filter(Boolean)
      .map((imageUrl, index) => ({
        id: `fallback-${index}`,
        imageUrl: imageUrl as string,
        altText: product.name,
      }));

    const merged = [...fromGallery, ...fallback].filter((item) => item.imageUrl && !item.imageUrl.includes(".svg"));
    const seen = new Set<string>();
    return merged.filter((item) => {
      if (seen.has(item.imageUrl)) return false;
      seen.add(item.imageUrl);
      return true;
    });
  }, [product.coverImage, product.galleryImages, product.image, product.name, selectedDose?.imageUrl]);

  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(galleryItems[0]?.imageUrl ?? null);

  const imageToDisplay = useMemo(() => {
    if (!galleryItems.length) return null;
    if (selectedImageUrl && galleryItems.some((item) => item.imageUrl === selectedImageUrl)) return selectedImageUrl;
    return galleryItems[0]?.imageUrl ?? null;
  }, [galleryItems, selectedImageUrl]);

  const hasRealImage = Boolean(imageToDisplay);
  const doseFromSlug = parseDose(product.slug);

  const handleAddToCart = (sourceElement?: HTMLElement | null) => {
    addToCart(product, quantity, sourceElement, {
      variantId: selectedDose?.id,
      doseLabel: selectedDose?.label,
      sku: selectedDose?.sku,
      priceOverride: unitPrice,
      imageOverride: imageToDisplay ?? product.image,
      batchNumberOverride: selectedBatchNumber,
      stockStatusOverride: selectedStockStatus,
    });
    setMessage(`Added ${quantity} × ${selectedDose?.label ?? "item"} to cart.`);
    setTimeout(() => setMessage(null), 3000);
  };

  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: "description", label: "Description" },
    { key: "specs", label: "Specifications" },
    { key: "coa", label: "COA & Quality" },
  ];

  return (
    <div className="vl2-lab-page min-h-screen pb-24 lg:pb-0">
      <div className="vl2-lab-sweep" aria-hidden="true" />
      <div className="vl2-lab-orb vl2-lab-orb-a" aria-hidden="true" />
      <div className="vl2-lab-orb vl2-lab-orb-b" aria-hidden="true" />

      <SiteHeaderV2 />

      <main className="relative mx-auto max-w-[1440px] px-4 sm:px-6 pb-16 pt-28 lg:px-12 lg:pt-32">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-zinc-500">
          <Link href="/" className="transition hover:text-[#111]">Home</Link>
          <span>/</span>
          <Link href="/products" className="transition hover:text-[#111]">Products</Link>
          <span>/</span>
          <span className="text-zinc-700">{product.name}</span>
        </nav>

        {promoBuy3Get1Enabled ? (
          <div className="vl2-lab-panel mt-6 flex flex-wrap items-center gap-2 border-emerald-200 bg-emerald-50 px-5 py-3 text-sm text-emerald-900">
            <span aria-hidden="true">🎁</span>
            <span className="font-medium">Buy 3, Get 1 Free</span>
            <span className="text-emerald-700">— the lowest-priced item in your cart is automatically free at checkout.</span>
          </div>
        ) : null}

        <section className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-start lg:gap-10">
          {/* Block A — product image. Mobile order 1; desktop top-left. */}
          <div className="order-1 min-w-0 lg:col-start-1 lg:row-start-1">
            <div className="vl2-lab-panel overflow-hidden">
              <div className="relative min-h-[260px] sm:min-h-[460px]">
                {hasRealImage ? (
                  <Image
                    src={imageToDisplay as string}
                    alt={product.name}
                    fill
                    sizes="(max-width: 1024px) 100vw, 55vw"
                    className="object-contain p-6 sm:p-12"
                    priority
                  />
                ) : (
                  <div className="flex h-full min-h-[260px] items-center justify-center">
                    <div className="border border-zinc-200 px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-zinc-400">Image pending</div>
                  </div>
                )}
              </div>
            </div>

            {galleryItems.length > 1 && (
              <div className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-7">
                {galleryItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedImageUrl(item.imageUrl)}
                    className={`relative overflow-hidden border bg-white transition ${item.imageUrl === imageToDisplay ? "border-zinc-900" : "border-zinc-200 hover:border-zinc-400"}`}
                  >
                    <div className="relative aspect-square">
                      <Image src={item.imageUrl} alt={item.altText} fill sizes="90px" className="object-cover" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Block C — details/COA/FAQ. Mobile order 3 (below the buy panel);
              desktop bottom-left, under the image. */}
          <div className="order-3 min-w-0 lg:col-start-1 lg:row-start-2 lg:order-none">
            <div className="mt-2 lg:mt-0">
              <div className="vl2-lab-panel flex gap-1 p-1">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab((current) => (current === tab.key ? null : tab.key))}
                    aria-expanded={activeTab === tab.key}
                    className={`min-w-0 flex-1 px-2 py-2.5 text-[11px] font-medium uppercase tracking-normal transition sm:px-3 sm:text-xs sm:tracking-[0.16em] ${activeTab === tab.key ? "bg-[#111] text-white" : "text-zinc-500 hover:text-[#111]"}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {activeTab === "description" && (
                  <div className="vl2-lab-panel p-5">
                    <p className="text-sm leading-7 text-zinc-600">{product.longDescription ?? product.description}</p>
                    {product.molecularFormula && (
                      <p className="mt-4 text-xs text-zinc-400">Molecular Formula: <span className="text-zinc-700">{product.molecularFormula}</span></p>
                    )}
                    <div className="mt-5 border border-zinc-200 bg-zinc-50 p-4 text-xs leading-6 text-zinc-600">
                      <strong className="text-[#111]">Research Use Only.</strong> This compound is intended strictly for laboratory research purposes. Not for human or veterinary use.
                    </div>
                  </div>
                )}

                {activeTab === "specs" && (
                  <div className="vl2-lab-panel p-5">
                    <dl className="space-y-3 text-sm">
                      {([
                        ["Batch Number", selectedBatchNumber],
                        ["Purity Result", selectedPurity ?? "Pending"],
                        ["Molecular Formula", product.molecularFormula],
                        ["Molecular Weight", product.molecularWeight],
                        ["CAS Number", product.casNumber],
                        ["Storage", product.storageRecommendation],
                        ["Reconstitution", product.reconstitutionNote],
                        ["Testing Lab", product.labName],
                        ["Testing Date", product.testingDate],
                        ["Category", product.category],
                        ["SKU", selectedDose?.sku ?? "N/A"],
                      ] as Array<[string, string | undefined]>)
                        .filter(([, value]) => value && String(value).trim().length > 0)
                        .map(([label, value]) => (
                          <div key={label} className="flex justify-between gap-3 border-b border-zinc-100 pb-2 last:border-0">
                            <dt className="text-zinc-400">{label}</dt>
                            <dd className="min-w-0 break-words text-right font-medium text-[#111]">{value}</dd>
                          </div>
                        ))}
                    </dl>
                    {product.peptideSequence && product.peptideSequence.trim().length > 0 && (
                      <div className="mt-4 border-t border-zinc-100 pt-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-400">Amino Acid Sequence</p>
                        <div className="mt-2 overflow-x-auto">
                          <code className="block whitespace-pre-wrap break-all font-mono text-xs leading-6 text-[#111]">{product.peptideSequence}</code>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "coa" && (
                  <div className="vl2-lab-panel p-5">
                    <p className="text-sm leading-7 text-zinc-600">
                      Every product lot is linked to a third-party Certificate of Analysis. The COA includes purity percentage, testing methodology, batch traceability, and lab information. Download the report matching your selected dose below.
                    </p>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="border border-zinc-200 p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-400">Purity</p>
                        <p className="mt-1.5 text-xl font-semibold text-[#111]">{selectedPurity ?? "Pending"}</p>
                      </div>
                      <div className="border border-zinc-200 p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-400">Batch</p>
                        <p className="mt-1.5 text-sm font-medium text-[#111]">{selectedBatchNumber}</p>
                      </div>
                    </div>
                    {selectedCoaUrl && (
                      <a
                        href={selectedCoaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="vl2-lab-btn-secondary vl-focus-ring mt-5 inline-flex items-center gap-2 px-5 py-2.5"
                      >
                        <span>↗</span> Download COA PDF
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-8">
              <p className="vl2-lab-eyebrow">Frequently Asked Questions</p>
              <FaqAccordion items={product.faq} />
            </div>
          </div>

          {/* Block B — buy panel. Mobile order 2 (right under the image, so
              price + bundle + Add to Cart are visible without scrolling past
              the description); desktop it's the sticky right column. */}
          <aside className="order-2 space-y-4 lg:order-none lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky lg:top-28">
            <div className="vl2-lab-panel p-6 sm:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-400">{product.category}</p>
                  <h1 className="vl2-serif mt-2 text-3xl text-[#111]">{product.name}</h1>
                </div>
                {/* Only shown when the 3PL has reported the item as sold out —
                    never an "In Stock" badge, per product spec. */}
                {isOutOfStock ? (
                  <span className="shrink-0 border border-zinc-300 bg-zinc-100 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-zinc-600">Out of Stock</span>
                ) : null}
              </div>

              {doseFromSlug && (
                <p className="mt-1 text-xs text-zinc-400">{doseFromSlug} · {product.labName}</p>
              )}

              {(product.shortDescription ?? product.description) ? (
                <p className="mt-4 text-sm leading-6 text-zinc-600">{product.shortDescription ?? product.description}</p>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {selectedPurity && (
                  <span className="border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                    {selectedPurity} Purity Verified
                  </span>
                )}
                {selectedBatchNumber && (
                  <span className="border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-500">
                    Batch {selectedBatchNumber}
                  </span>
                )}
                <span className="border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700">
                  Research Use Only
                </span>
              </div>

              {/* Prominent, always-visible COA callout — third-party proof right
                  next to the buy decision, not hidden inside a tab. */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-emerald-200 bg-emerald-50/70 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-emerald-600">
                    <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                  <span className="text-xs font-medium text-emerald-800">Third-party tested · COA on every batch</span>
                </div>
                {selectedCoaUrl ? (
                  <a
                    href={selectedCoaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 whitespace-nowrap border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
                  >
                    Download COA <span aria-hidden="true">↓</span>
                  </a>
                ) : (
                  <Link href="/coa-library" className="whitespace-nowrap text-xs font-semibold text-emerald-700 underline underline-offset-2 hover:text-emerald-900">
                    View COA Library →
                  </Link>
                )}
              </div>

              {product.doses && product.doses.length > 0 && (
                <div className="mt-6">
                  <p className="vl2-lab-eyebrow">Vial Size</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {product.doses.map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setSelectedDoseId(variant.id)}
                        className={`border px-4 py-2 text-sm transition ${
                          selectedDose?.id === variant.id
                            ? "border-[#111] bg-[#111] text-white"
                            : "border-zinc-200 text-zinc-600 hover:border-zinc-400 hover:text-[#111]"
                        } ${variant.stockStatus === "Out of Stock" ? "opacity-40" : ""}`}
                      >
                        {variant.label}
                        {variant.stockStatus === "Out of Stock" && <span className="ml-1 text-[9px]">sold out</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6 flex items-end gap-3">
                <p className="text-4xl font-semibold text-[#111]">{selectedPrice}</p>
                {selectedCompareAtPrice && (
                  <p className="mb-1 text-base text-zinc-400 line-through">{selectedCompareAtPrice}</p>
                )}
              </div>

              <div className="mt-6">
                <p className="vl2-lab-eyebrow">Quantity</p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {BUNDLE_OPTIONS.map((option) => {
                    const isSelected = option.quantity === 3 ? quantity >= 3 : quantity === option.quantity;
                    const rate = bundleDiscountRate(option.quantity, bundleConfig);
                    const lineTotal = getBundleDiscountedLineTotal(unitPrice, option.quantity, bundleConfig);
                    return (
                      <button
                        key={option.quantity}
                        type="button"
                        onClick={() => setQuantity(option.quantity)}
                        className={`relative border px-2 py-3 text-center transition ${isSelected ? "border-[#111] bg-zinc-50" : "border-zinc-200 hover:border-zinc-400"}`}
                      >
                        {option.badge ? (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap bg-[#111] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white">
                            {option.badge}
                          </span>
                        ) : null}
                        <span className="block text-sm text-[#111]">{option.label}</span>
                        <span className="mt-1 block text-xs text-zinc-500">{formatUsd(lineTotal)}</span>
                        {rate > 0 ? (
                          <span className="mt-0.5 block text-[10px] font-medium text-emerald-600">Save {Math.round(rate * 100)}%</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {quantity > 3 ? (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      className="inline-flex h-11 w-11 items-center justify-center border border-zinc-200 text-lg text-zinc-600 transition hover:border-zinc-400"
                    >−</button>
                    <span className="text-sm text-[#111]">{quantity} bottles</span>
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.min(10, q + 1))}
                      className="inline-flex h-11 w-11 items-center justify-center border border-zinc-200 text-lg text-zinc-600 transition hover:border-zinc-400"
                    >+</button>
                    {currentBundleRate > 0 ? (
                      <span className="text-xs font-medium text-emerald-600">Save {Math.round(currentBundleRate * 100)}% — {formatUsd(getBundleDiscountedLineTotal(unitPrice, quantity, bundleConfig))} total</span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="mt-5 flex gap-2">
                <button
                  onClick={(event) => handleAddToCart(event.currentTarget)}
                  type="button"
                  disabled={isOutOfStock}
                  className="vl2-lab-btn-primary vl-focus-ring flex-1 px-5 py-3.5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isOutOfStock ? "Currently Unavailable" : `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`}
                </button>
                <WishlistButton
                  slug={product.slug}
                  className="vl2-lab-btn-secondary vl-focus-ring inline-flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center"
                />
              </div>

              {isOutOfStock ? (
                <div className="mt-4">
                  <BackInStockForm productSlug={product.slug} variantId={selectedDose?.id} />
                </div>
              ) : (
                <SubscribeSave productSlug={product.slug} variantId={selectedDose?.id} />
              )}

              {selectedCoaUrl && (
                <a
                  href={selectedCoaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="vl2-lab-btn-secondary vl-focus-ring mt-2 flex w-full items-center justify-center gap-2 px-5 py-2.5"
                >
                  View COA
                </a>
              )}

              {message && (
                <p className="mt-3 text-sm text-zinc-600">{message}</p>
              )}

              <div className="mt-6 space-y-2 border-t border-zinc-200 pt-5">
                {TRUST_ROW.map((item) => (
                  <div key={item.label} className="flex items-center gap-3 text-zinc-500">
                    <span aria-hidden="true">{item.icon}</span>
                    <span className="text-xs">
                      <span className="font-medium text-zinc-700">{item.label}</span> — {item.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>

        {relatedProducts.length > 0 && (
          <ScrollReveal className="mt-16">
            {/* ProductCard is styled for the site's dark theme everywhere
                else, so related products get their own dark panel here
                rather than sitting directly on this page's white lab
                background where they'd be nearly invisible. */}
            <section className="bg-[#0b0b0b] p-6 sm:p-10">
              <div className="flex items-center justify-between">
                <div>
                  <p className="vl2-eyebrow">You May Also Need</p>
                  <h2 className="vl2-serif mt-2 text-2xl text-white">Related Products</h2>
                </div>
                <Link href="/products" className="text-xs uppercase tracking-[0.16em] text-white/50 transition hover:text-white">
                  View all
                </Link>
              </div>
              <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {relatedProducts.map((related) => (
                  <ProductCard
                    key={related.slug}
                    product={related}
                    image={related.coverImage ?? related.image}
                    onAddToCart={(event) => addToCart(related, 1, event.currentTarget)}
                  />
                ))}
              </div>
            </section>
          </ScrollReveal>
        )}

        <RecentlyViewed
          current={{
            slug: product.slug,
            name: product.name,
            price: selectedPrice,
            image: product.coverImage ?? product.image,
          }}
        />
      </main>

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="truncate text-xs font-medium text-[#111]">{product.name}</p>
            <p className="text-sm font-semibold text-zinc-600">{selectedPrice}</p>
          </div>
          <button
            onClick={(event) => handleAddToCart(event.currentTarget)}
            type="button"
            disabled={isOutOfStock}
            className="vl2-lab-btn-primary vl-focus-ring shrink-0 px-6 py-3.5 text-sm disabled:opacity-50"
          >
            {isOutOfStock ? "Unavailable" : `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`}
          </button>
        </div>
      </div>
    </div>
  );
}
