"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";
import { ProductCard } from "@/components/product-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { TrustBadge, type TrustBadgeIcon } from "@/components/trust-badge";
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

const TRUST_BADGES: Array<{ icon: TrustBadgeIcon; label: string }> = [
  { icon: "flask", label: "Third-Party Tested" },
  { icon: "shield", label: "Encrypted Checkout" },
  { icon: "check", label: "COA Included" },
  { icon: "truck", label: "Fast Dispatch" },
];

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
            className="flex w-full items-center justify-between gap-4 py-4 text-left text-sm text-zinc-100 transition hover:text-white"
            onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
          >
            <span className="font-medium">{item.q}</span>
            <span className={`shrink-0 text-zinc-400 transition-transform duration-200 ${openIndex === idx ? "rotate-180" : ""}`}>▼</span>
          </button>
          {openIndex === idx && (
            <p className="pb-4 text-sm leading-7 text-zinc-400">{item.a}</p>
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

  const stockTone =
    selectedStockStatus === "In Stock"
      ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-100"
      : selectedStockStatus === "Limited"
        ? "border-amber-300/35 bg-amber-300/10 text-amber-100"
        : selectedStockStatus === "Reserved"
          ? "border-zinc-300/35 bg-zinc-300/12 text-zinc-100"
          : "border-zinc-500/35 bg-zinc-500/10 text-zinc-200";

  const handleAddToCart = (sourceElement?: HTMLElement | null) => {
    addToCart(product, quantity, sourceElement, {
      variantId: selectedDose?.id,
      doseLabel: selectedDose?.label,
      sku: selectedDose?.sku,
      priceOverride: toPriceNumber(selectedPrice),
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
    <div className="vl-page-shell min-h-screen text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-zinc-500">
          <Link href="/" className="hover:text-zinc-300 transition">Home</Link>
          <span>/</span>
          <Link href="/products" className="hover:text-zinc-300 transition">Products</Link>
          <span>/</span>
          <span className="text-zinc-300">{product.name}</span>
        </nav>

        <section className="mt-6 grid min-w-0 gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
          {/* ── Left column: image + tabs ── */}
          <div className="min-w-0">
            {/* Main image */}
            <div className="vl-panel overflow-hidden rounded-[2rem]">
              <div className="relative min-h-[320px] bg-[radial-gradient(circle_at_40%_8%,rgba(255,255,255,0.12),transparent_62%)] sm:min-h-[440px]">
                {hasRealImage ? (
                  <Image
                    src={imageToDisplay as string}
                    alt={product.name}
                    fill
                    sizes="(max-width: 1024px) 100vw, 58vw"
                    className="object-contain p-8 sm:p-10"
                    priority
                  />
                ) : (
                  <div className="flex h-full min-h-[320px] items-center justify-center">
                    <div className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-zinc-300">Image pending</div>
                  </div>
                )}
              </div>
            </div>

            {/* Thumbnail strip */}
            {galleryItems.length > 1 && (
              <div className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-7">
                {galleryItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedImageUrl(item.imageUrl)}
                    className={`relative overflow-hidden rounded-xl border transition ${item.imageUrl === imageToDisplay ? "border-white/45 ring-1 ring-white/25" : "border-white/12 hover:border-white/28"} bg-zinc-900/80`}
                  >
                    <div className="relative aspect-square">
                      <Image src={item.imageUrl} alt={item.altText} fill sizes="90px" className="object-cover" />
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Info tabs */}
            <div className="mt-8">
              <div className="flex gap-1 rounded-xl border border-white/10 bg-white/5 p-1">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`min-w-0 flex-1 rounded-lg px-2 py-2 text-[11px] font-medium uppercase tracking-[0.08em] transition sm:px-3 sm:text-xs sm:tracking-[0.14em] ${activeTab === tab.key ? "bg-white/14 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {activeTab === "description" && (
                  <div className="vl-panel rounded-2xl p-5">
                    <p className="text-sm leading-7 text-zinc-300">{product.longDescription ?? product.description}</p>
                    {product.molecularFormula && (
                      <p className="mt-4 text-xs text-zinc-500">Molecular Formula: <span className="text-zinc-300">{product.molecularFormula}</span></p>
                    )}
                    <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-6 text-amber-200/80">
                      <strong className="text-amber-200">Research Use Only.</strong> This compound is intended strictly for laboratory research purposes. Not for human or veterinary use.
                    </div>
                  </div>
                )}

                {activeTab === "specs" && (
                  <div className="vl-panel rounded-2xl p-5">
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
                          <dt className="text-zinc-500">{label}</dt>
                          <dd className="text-zinc-100 font-medium">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                {activeTab === "coa" && (
                  <div className="vl-panel rounded-2xl p-5">
                    <p className="text-sm leading-7 text-zinc-300">
                      Every product lot is linked to a third-party Certificate of Analysis. The COA includes purity percentage, testing methodology, batch traceability, and lab information. Download the report matching your selected dose below.
                    </p>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Purity</p>
                        <p className="mt-1.5 text-xl font-semibold text-emerald-300">{selectedPurity ?? "Pending"}</p>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Batch</p>
                        <p className="mt-1.5 text-sm font-medium text-zinc-100">{selectedBatchNumber}</p>
                      </div>
                    </div>
                    {selectedCoaUrl && (
                      <a
                        href={selectedCoaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="vl-btn-secondary vl-focus-ring mt-5 inline-flex items-center gap-2 px-5 py-2.5 text-sm"
                      >
                        <span>↗</span> Download COA PDF
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* FAQ */}
            <div className="mt-8">
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Frequently Asked Questions</p>
              <FaqAccordion />
            </div>
          </div>

          {/* ── Right column: buy panel ── */}
          <aside className="lg:sticky lg:top-24 space-y-4">
            <div className="vl-panel rounded-[2rem] p-6 sm:p-7">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">{product.category}</p>
                  <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">{product.name}</h1>
                </div>
                <span className={`shrink-0 rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em] ${stockTone}`}>{selectedStockStatus}</span>
              </div>

              {doseFromSlug && (
                <p className="mt-1 text-xs text-zinc-500">{doseFromSlug} · {product.labName}</p>
              )}

              {/* Purity badge */}
              {selectedPurity && (
                <div className="mt-4 flex items-center gap-2">
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-xs font-medium text-emerald-200">
                    ✓ {selectedPurity} Purity Verified
                  </span>
                  <span className="rounded-full border border-white/12 bg-white/5 px-3 py-1 text-xs text-zinc-400">
                    Batch {selectedBatchNumber}
                  </span>
                </div>
              )}

              {/* Dose selection */}
              {product.doses && product.doses.length > 0 && (
                <div className="mt-6">
                  <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Select Dose</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {product.doses.map((variant) => (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setSelectedDoseId(variant.id)}
                        className={`rounded-full border px-4 py-2 text-sm transition ${
                          selectedDose?.id === variant.id
                            ? "border-white/45 bg-white/14 text-zinc-100"
                            : "border-white/12 bg-white/5 text-zinc-300 hover:border-white/25 hover:text-white"
                        } ${variant.stockStatus === "Out of Stock" ? "opacity-40" : ""}`}
                      >
                        {variant.label}
                        {variant.stockStatus === "Out of Stock" && <span className="ml-1 text-[9px] text-zinc-500">sold out</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Price */}
              <div className="mt-6 flex items-end gap-3">
                <p className="text-4xl font-semibold text-zinc-100">{selectedPrice}</p>
                {selectedCompareAtPrice && (
                  <p className="mb-1 text-base text-zinc-500 line-through">{selectedCompareAtPrice}</p>
                )}
              </div>

              {/* Quantity */}
              <div className="mt-5">
                <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Quantity</p>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    className="h-9 w-9 rounded-xl border border-white/15 bg-white/5 text-lg text-zinc-200 transition hover:bg-white/10 disabled:opacity-30"
                    disabled={quantity <= 1}
                  >−</button>
                  <span className="w-8 text-center text-base font-semibold text-zinc-100">{quantity}</span>
                  <button
                    type="button"
                    onClick={() => setQuantity((q) => Math.min(10, q + 1))}
                    className="h-9 w-9 rounded-xl border border-white/15 bg-white/5 text-lg text-zinc-200 transition hover:bg-white/10 disabled:opacity-30"
                    disabled={quantity >= 10}
                  >+</button>
                </div>
              </div>

              {/* CTA */}
              <div className="mt-6 flex gap-2">
                <button
                  onClick={(event) => handleAddToCart(event.currentTarget)}
                  type="button"
                  disabled={isOutOfStock}
                  className="vl-btn-primary vl-focus-ring flex-1 px-5 py-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isOutOfStock ? "Currently Unavailable" : `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`}
                </button>
                <WishlistButton
                  slug={product.slug}
                  className="vl-btn-secondary vl-focus-ring inline-flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center"
                />
              </div>

              {selectedCoaUrl && (
                <a
                  href={selectedCoaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="vl-btn-secondary vl-focus-ring mt-2 flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm"
                >
                  View COA
                </a>
              )}

              {message && (
                <p className="mt-3 text-sm text-emerald-300">{message}</p>
              )}

              {/* Trust badges */}
              <div className="mt-6 grid grid-cols-2 gap-2">
                {TRUST_BADGES.map((badge) => (
                  <TrustBadge key={badge.label} icon={badge.icon} label={badge.label} />
                ))}
              </div>

              {/* Quick spec strip */}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">Tested</p>
                  <p className="mt-1 text-xs font-medium text-zinc-300">{product.testingDate}</p>
                </div>
                <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">Lab</p>
                  <p className="mt-1 text-xs font-medium text-zinc-300">{product.labName}</p>
                </div>
              </div>
            </div>
          </aside>
        </section>

        {/* Related products */}
        {relatedProducts.length > 0 && (
          <ScrollReveal className="mt-16">
            <section>
              <div className="flex items-center justify-between">
                <div>
                  <p className="vl-eyebrow text-[10px]">You May Also Need</p>
                  <h2 className="mt-1 text-lg font-semibold text-zinc-100">Related Products</h2>
                </div>
                <Link href="/products" className="text-xs uppercase tracking-[0.22em] text-zinc-400 transition hover:text-white">
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

      {/* Sticky mobile Add to Cart */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-zinc-950/95 px-4 py-3 backdrop-blur-xl lg:hidden">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-xs font-medium text-zinc-100 truncate">{product.name}</p>
            <p className="text-sm font-semibold text-zinc-200">{selectedPrice}</p>
          </div>
          <button
            onClick={(event) => handleAddToCart(event.currentTarget)}
            type="button"
            disabled={isOutOfStock}
            className="vl-btn-primary vl-focus-ring shrink-0 px-6 py-2.5 text-sm disabled:opacity-50"
          >
            {isOutOfStock ? "Unavailable" : "Add to Cart"}
          </button>
        </div>
      </div>
    </div>
  );
}
