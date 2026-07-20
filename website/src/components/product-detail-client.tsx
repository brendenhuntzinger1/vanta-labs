"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ProductCard } from "@/components/product-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { WishlistButton } from "@/components/wishlist-button";
import type { Product } from "@/lib/catalog-types";
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
] as const;

const PRODUCT_FAQ = [
  {
    q: "Is this product intended for human consumption?",
    a: "No. All compounds sold by Vanta Labs are strictly for legitimate laboratory research purposes and are not intended for human or veterinary use.",
  },
  {
    q: "How do I access the Certificate of Analysis?",
    a: "Each product page links directly to the batch-matched COA. You can also browse all records in the COA Library.",
  },
  {
    q: "What is your shipping timeline?",
    a: "Most in-stock orders are prepared within one business day. You will receive secure tracking information after dispatch.",
  },
  {
    q: "Can I combine referral codes with promotions?",
    a: "Referral discounts cannot be combined with Buy 3 Get 1 Free offers. Only one discount type applies per order.",
  },
];

function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className="mt-3 divide-y divide-white/8">
      {PRODUCT_FAQ.map((item, idx) => (
        <div key={idx}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 py-4 text-left text-sm text-white transition hover:text-white/80"
            onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
          >
            <span className="font-medium">{item.q}</span>
            <span className={`shrink-0 text-white/40 transition-transform duration-200 ${openIndex === idx ? "rotate-180" : ""}`}>▼</span>
          </button>
          {openIndex === idx && (
            <p className="pb-4 text-sm leading-7 text-white/55">{item.a}</p>
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
}: {
  product: Product;
  relatedProducts?: Product[];
}) {
  const { addToCart } = useCart();
  const defaultDose = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0] ?? null;
  const [selectedDoseId, setSelectedDoseId] = useState<string | null>(defaultDose?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [subscribeSelected, setSubscribeSelected] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("description");

  const selectedDose = product.doses?.find((dose) => dose.id === selectedDoseId) ?? defaultDose;

  const selectedPrice = selectedDose?.salePrice ?? selectedDose?.price ?? product.price;
  const selectedCompareAtPrice = selectedDose?.compareAtPrice ?? product.compareAtPrice;
  const selectedBatchNumber = selectedDose?.batchNumber ?? product.batchNumber;
  const selectedPurity = selectedDose?.purityResult ?? product.purityResult;
  const selectedCoaUrl = selectedDose?.coaUrl ?? product.coaUrl;
  const selectedStockStatus = selectedDose?.stockStatus ?? product.stockStatus;
  const isOutOfStock = selectedStockStatus === "Out of Stock" || selectedStockStatus === "Reserved";
  const unitPrice = toPriceNumber(selectedPrice);

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
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-[1440px] px-6 pb-16 pt-28 lg:px-12 lg:pt-32">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-white/40">
          <Link href="/" className="transition hover:text-white/70">Home</Link>
          <span>/</span>
          <Link href="/products" className="transition hover:text-white/70">Products</Link>
          <span>/</span>
          <span className="text-white/70">{product.name}</span>
        </nav>

        <section className="mt-6 grid min-w-0 gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          <div className="min-w-0">
            <div className="vl2-hairline overflow-hidden bg-[#111]">
              <div className="relative min-h-[340px] sm:min-h-[460px]">
                {hasRealImage ? (
                  <Image
                    src={imageToDisplay as string}
                    alt={product.name}
                    fill
                    sizes="(max-width: 1024px) 100vw, 55vw"
                    className="object-contain p-8 sm:p-12"
                    priority
                  />
                ) : (
                  <div className="flex h-full min-h-[340px] items-center justify-center">
                    <div className="border border-white/15 px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-white/45">Image pending</div>
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
                    className={`relative overflow-hidden border bg-[#111] transition ${item.imageUrl === imageToDisplay ? "border-white/50" : "border-white/10 hover:border-white/25"}`}
                  >
                    <div className="relative aspect-square">
                      <Image src={item.imageUrl} alt={item.altText} fill sizes="90px" className="object-cover" />
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-8">
              <div className="flex gap-1 border border-white/10 p-1">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`min-w-0 flex-1 px-2 py-2 text-[11px] font-medium uppercase tracking-[0.1em] transition sm:px-3 sm:text-xs sm:tracking-[0.16em] ${activeTab === tab.key ? "bg-white/10 text-white" : "text-white/45 hover:text-white/70"}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {activeTab === "description" && (
                  <div className="vl2-hairline p-5">
                    <p className="text-sm leading-7 text-white/65">{product.longDescription ?? product.description}</p>
                    {product.molecularFormula && (
                      <p className="mt-4 text-xs text-white/40">Molecular Formula: <span className="text-white/70">{product.molecularFormula}</span></p>
                    )}
                    <div className="mt-5 border border-white/10 p-4 text-xs leading-6 text-white/55">
                      <strong className="text-white">Research Use Only.</strong> This compound is intended strictly for laboratory research purposes. Not for human or veterinary use.
                    </div>
                  </div>
                )}

                {activeTab === "specs" && (
                  <div className="vl2-hairline p-5">
                    <dl className="space-y-3 text-sm">
                      {[
                        ["Batch Number", selectedBatchNumber],
                        ["Purity Result", selectedPurity ?? "Pending"],
                        ["Molecular Formula", product.molecularFormula ?? "See COA"],
                        ["Testing Lab", product.labName],
                        ["Testing Date", product.testingDate],
                        ["Category", product.category],
                        ["SKU", selectedDose?.sku ?? "N/A"],
                      ].map(([label, value]) => (
                        <div key={label} className="flex justify-between border-b border-white/8 pb-2 last:border-0">
                          <dt className="text-white/40">{label}</dt>
                          <dd className="font-medium text-white">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                {activeTab === "coa" && (
                  <div className="vl2-hairline p-5">
                    <p className="text-sm leading-7 text-white/65">
                      Every product lot is linked to a third-party Certificate of Analysis. The COA includes purity percentage, testing methodology, batch traceability, and lab information. Download the report matching your selected dose below.
                    </p>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="border border-white/10 p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Purity</p>
                        <p className="mt-1.5 text-xl font-semibold text-white">{selectedPurity ?? "Pending"}</p>
                      </div>
                      <div className="border border-white/10 p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/40">Batch</p>
                        <p className="mt-1.5 text-sm font-medium text-white">{selectedBatchNumber}</p>
                      </div>
                    </div>
                    {selectedCoaUrl && (
                      <a
                        href={selectedCoaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="vl2-btn-secondary vl-focus-ring mt-5 inline-flex items-center gap-2 px-5 py-2.5"
                      >
                        <span>↗</span> Download COA PDF
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-8">
              <p className="vl2-eyebrow">Frequently Asked Questions</p>
              <FaqAccordion />
            </div>
          </div>

          <aside className="lg:sticky lg:top-28 space-y-4">
            <div className="vl2-hairline p-6 sm:p-7">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.3em] text-white/40">{product.category}</p>
                  <h1 className="vl2-serif mt-2 text-3xl text-white">{product.name}</h1>
                </div>
                <span className="shrink-0 border border-white/15 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-white/60">{selectedStockStatus}</span>
              </div>

              {doseFromSlug && (
                <p className="mt-1 text-xs text-white/40">{doseFromSlug} · {product.labName}</p>
              )}

              {selectedPurity && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="border border-white/15 px-3 py-1 text-xs font-medium text-white/80">
                    {selectedPurity} Purity Verified
                  </span>
                  <span className="border border-white/10 px-3 py-1 text-xs text-white/40">
                    Batch {selectedBatchNumber}
                  </span>
                </div>
              )}

              {product.doses && product.doses.length > 0 && (
                <div className="mt-6">
                  <p className="vl2-eyebrow">Dosage</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {product.doses.map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setSelectedDoseId(variant.id)}
                        className={`border px-4 py-2 text-sm transition ${
                          selectedDose?.id === variant.id
                            ? "border-white bg-white text-black"
                            : "border-white/15 text-white/70 hover:border-white/35 hover:text-white"
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
                <p className="text-4xl font-semibold text-white">{selectedPrice}</p>
                {selectedCompareAtPrice && (
                  <p className="mb-1 text-base text-white/40 line-through">{selectedCompareAtPrice}</p>
                )}
              </div>

              <div className="mt-6">
                <p className="vl2-eyebrow">Quantity</p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {BUNDLE_OPTIONS.map((option) => {
                    const isSelected = option.quantity === 3 ? quantity >= 3 : quantity === option.quantity;
                    return (
                      <button
                        key={option.quantity}
                        type="button"
                        onClick={() => setQuantity(option.quantity)}
                        className={`relative border px-2 py-3 text-center transition ${isSelected ? "border-white bg-white/10" : "border-white/12 hover:border-white/30"}`}
                      >
                        {option.badge ? (
                          <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap bg-white px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-black">
                            {option.badge}
                          </span>
                        ) : null}
                        <span className="block text-sm text-white">{option.label}</span>
                        <span className="mt-1 block text-xs text-white/45">{formatUsd(unitPrice * option.quantity)}</span>
                      </button>
                    );
                  })}
                </div>
                {quantity > 3 ? (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      className="h-8 w-8 border border-white/15 text-white/70 transition hover:border-white/35"
                    >−</button>
                    <span className="text-sm text-white">{quantity} bottles</span>
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.min(10, q + 1))}
                      className="h-8 w-8 border border-white/15 text-white/70 transition hover:border-white/35"
                    >+</button>
                  </div>
                ) : null}
              </div>

              <label className="mt-5 flex items-start gap-3 border border-white/10 p-3.5 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={subscribeSelected}
                  onChange={(event) => setSubscribeSelected(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-white/25 bg-transparent"
                />
                <span>
                  <span className="block font-medium text-white">Subscribe &amp; Save</span>
                  <span className="mt-0.5 block text-xs text-white/40">Recurring orders aren&apos;t live yet — this places a one-time order for now.</span>
                </span>
              </label>

              <div className="mt-5 flex gap-2">
                <button
                  onClick={(event) => handleAddToCart(event.currentTarget)}
                  type="button"
                  disabled={isOutOfStock}
                  className="vl2-btn-primary vl-focus-ring flex-1 px-5 py-3.5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isOutOfStock ? "Currently Unavailable" : `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`}
                </button>
                <WishlistButton
                  slug={product.slug}
                  className="vl2-btn-secondary vl-focus-ring inline-flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center"
                />
              </div>

              {selectedCoaUrl && (
                <a
                  href={selectedCoaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="vl2-btn-secondary vl-focus-ring mt-2 flex w-full items-center justify-center gap-2 px-5 py-2.5"
                >
                  View COA
                </a>
              )}

              {message && (
                <p className="mt-3 text-sm text-white/70">{message}</p>
              )}

              <div className="mt-6 space-y-2 border-t border-white/10 pt-5">
                {TRUST_ROW.map((item) => (
                  <div key={item.label} className="flex items-center gap-3 text-white/60">
                    <span aria-hidden="true">{item.icon}</span>
                    <span className="text-xs">
                      <span className="font-medium text-white/80">{item.label}</span> — {item.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>

        {relatedProducts.length > 0 && (
          <ScrollReveal className="mt-16">
            <section>
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
      </main>

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-[#0b0b0b]/95 px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="truncate text-xs font-medium text-white">{product.name}</p>
            <p className="text-sm font-semibold text-white/80">{selectedPrice}</p>
          </div>
          <button
            onClick={(event) => handleAddToCart(event.currentTarget)}
            type="button"
            disabled={isOutOfStock}
            className="vl2-btn-primary vl-focus-ring shrink-0 px-6 py-2.5 text-sm disabled:opacity-50"
          >
            {isOutOfStock ? "Unavailable" : "Add to Cart"}
          </button>
        </div>
      </div>
    </div>
  );
}
