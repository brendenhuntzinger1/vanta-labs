"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/components/cart-context";
import { bestPaidTier, quoteMemberPrice } from "@/lib/member-pricing";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { CouponPromoBanner, type FeaturedCoupon } from "@/components/coupon-promo-banner";
import { ProductCard } from "@/components/product-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { WishlistButton } from "@/components/wishlist-button";
import { BackInStockForm } from "@/components/back-in-stock-form";
import { SubscribeSave } from "@/components/subscribe-save";
import { bundleDiscountRate, getBundleDiscountedLineTotal, DEFAULT_BUNDLE_CONFIG, type BundleConfig } from "@/lib/bundle-pricing";
import type { Product, ProductDose, ProductFaqItem } from "@/lib/catalog-types";
import { isBacWater } from "@/lib/bac-water";
import { MAX_UNITS_PER_ORDER_LINE } from "@/lib/purchase-limits";
// Free-shipping threshold comes from the shared shipping module so the "Free
// Ship" badge can never disagree with what checkout actually charges.
import { FREE_SHIPPING_THRESHOLD } from "@/lib/shipping";
import { RecentlyViewed } from "@/components/recently-viewed";
import { BacWaterAccessoryBlock, FrequentlyBoughtTogether } from "@/components/bac-water-upsell";
import { CoaLibraryNotice } from "@/components/coa-library-notice";
import { formatCoaTestDate } from "@/lib/coa-format";
import type { PublicCoaDocument } from "@/lib/coa-types";
import Image from "next/image";
import { FULFILMENT_DETAIL, FULFILMENT_SENTENCE, FULFILMENT_SHORT, TESTING_DETAIL } from "@/lib/trust-claims";

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
  { quantity: 1, label: "1 Vial", badge: null },
  { quantity: 2, label: "2 Vials", badge: null },
  { quantity: 3, label: "3 Vials", badge: null },
  { quantity: 5, label: "5 Vials", badge: "Most Popular" },
  { quantity: 10, label: "10 Vials", badge: "Best Value" },
] as const;

/** The largest bundle the quantity controls offer; also the "+" button's ceiling. */
const MAX_BUNDLE_QUANTITY = MAX_UNITS_PER_ORDER_LINE;

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
    label: FULFILMENT_SHORT,
    detail: FULFILMENT_DETAIL,
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
    detail: TESTING_DETAIL,
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d="M9 2h6M10 2v6.2a2 2 0 0 1-.34 1.12L4.9 17.2A2.4 2.4 0 0 0 6.9 21h10.2a2.4 2.4 0 0 0 2-3.8l-4.76-7.88A2 2 0 0 1 14 8.2V2" />
      </svg>
    ),
    label: "Based in the USA",
    detail: "U.S.-based fulfillment & support",
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
    answer: `${FULFILMENT_SENTENCE} You will receive secure tracking information after dispatch.`,
  },
  {
    question: "Can I combine discounts, codes, or member pricing?",
    answer: "No — exactly one discount applies per order. Membership pricing, promo codes, ambassador codes, bundle pricing, and promotions never combine. You don't have to figure out which is best: checkout automatically applies whichever single discount saves you the most.",
  },
];

function FaqAccordion({ items }: { items?: ProductFaqItem[] }) {
  const faqItems = items && items.length > 0 ? items : DEFAULT_PRODUCT_FAQ;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <div className="mt-3 divide-y divide-white/[0.08]">
      {faqItems.map((item, idx) => (
        <div key={idx}>
          <button
            type="button"
            aria-expanded={openIndex === idx}
            className="flex w-full items-center justify-between gap-4 py-4 text-left text-sm text-white transition hover:text-[#a3a3a3]"
            onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
          >
            <span className="font-medium">{item.question}</span>
            <span className={`shrink-0 text-white/45 transition-transform duration-200 ${openIndex === idx ? "rotate-180" : ""}`}>▼</span>
          </button>
          {openIndex === idx && (
            <p className="pb-4 text-sm leading-7 text-[#a3a3a3]">{item.answer}</p>
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
  bacWater = null,
  coaDocuments = [],
  // Resolved by the server page. Left optional so the component keeps working
  // unchanged for any caller that does not pass it (the banner then fetches for
  // itself, exactly as before).
  featuredCoupon,
}: {
  product: Product;
  relatedProducts?: Product[];
  promoBuy3Get1Enabled?: boolean;
  bundleConfig?: BundleConfig;
  bacWater?: Product | null;
  coaDocuments?: PublicCoaDocument[];
  featuredCoupon?: FeaturedCoupon | null;
}) {
  const { addToCart, membershipTiers, memberDiscountPercent } = useCart();
  const defaultDose = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0] ?? null;
  const [selectedDoseId, setSelectedDoseId] = useState<string | null>(defaultDose?.id ?? null);
  // The shopper's chosen quantity, BEFORE it is clamped to what is on the
  // shelf. Read `quantity` (derived below), never this — switching to a dose
  // with less stock must not carry the old number over.
  const [requestedQuantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<string | null>(null);
  // Collapsed by default — no panel is shown until the shopper taps a tab.
  const [activeTab, setActiveTab] = useState<TabKey | null>(null);

  const selectedDose = product.doses?.find((dose) => dose.id === selectedDoseId) ?? defaultDose;

  const selectedPrice = selectedDose?.salePrice ?? selectedDose?.price ?? product.price;
  const selectedCompareAtPrice = selectedDose?.compareAtPrice ?? product.compareAtPrice;
  const selectedBatchNumber = selectedDose?.batchNumber ?? product.batchNumber;
  const selectedPurity = selectedDose?.purityResult ?? product.purityResult;
  const selectedCoaUrl = selectedDose?.coaUrl ?? product.coaUrl;
  // Only assert testing/purity when there is a real purity value AND a COA on
  // file for this batch — never claim "third-party tested / ≥99%" for a product
  // whose data is absent or "Pending". Keeps on-page claims substantiated.
  const hasVerifiedTesting = Boolean(selectedCoaUrl) && Boolean(selectedPurity) && selectedPurity !== "Pending";
  const selectedStockStatus = selectedDose?.stockStatus ?? product.stockStatus;
  const unitPrice = toPriceNumber(selectedPrice);

  // Units the shopper can buy of the dose they have selected, net of what
  // in-flight checkouts are holding AND clamped to the per-line order ceiling
  // before it ever leaves the server — so this is "how many may I offer", not
  // "how deep is the shelf". `null` means availability is not being counted at
  // all (tracking is off store-wide), which is NOT the same as zero and must
  // not cap anything. Never rendered: it only gates controls.
  const availableQuantity = selectedDose
    ? selectedDose.availableQuantity ?? null
    : product.availableQuantity ?? null;
  const isTrackingAvailability = typeof availableQuantity === "number";
  // The ceiling for the quantity controls. Uncounted stock keeps the existing
  // 10-vial bundle ceiling; counted stock can never be ordered beyond what is
  // on the shelf, so the shopper is stopped here rather than at the payment
  // step after entering their card.
  const maxSelectableQuantity = isTrackingAvailability
    ? Math.min(MAX_BUNDLE_QUANTITY, Math.max(0, availableQuantity))
    : MAX_BUNDLE_QUANTITY;

  // Clamped at render rather than corrected in an effect: switching doses
  // changes the ceiling, and a render that briefly shows the old, too-large
  // number is a render that can be clicked. At zero the value stays 1 so the
  // price copy still reads sensibly — the buttons are disabled either way.
  const quantity = maxSelectableQuantity > 0
    ? Math.min(requestedQuantity, maxSelectableQuantity)
    : 1;

  // Two independent reasons a purchase control is dead: the stored status says
  // so, or there is genuinely nothing left to sell. The second is stated
  // explicitly rather than relied upon through the status string, so a stale or
  // hand-edited "In Stock" on a zero-count line can never leave the buttons live.
  const isOutOfStock =
    selectedStockStatus === "Out of Stock" ||
    selectedStockStatus === "Reserved" ||
    (isTrackingAvailability && availableQuantity <= 0);

  const currentBundleRate = bundleDiscountRate(quantity, bundleConfig);

  // Member pricing on the selected dose — members see their price; everyone
  // else sees the strongest paid tier's price with exact dollar savings.
  const isMember = memberDiscountPercent > 0;
  const pdpUpsellTier = isMember ? null : bestPaidTier(membershipTiers);
  const memberQuote = unitPrice > 0
    ? (isMember
      ? quoteMemberPrice(unitPrice, memberDiscountPercent)
      : pdpUpsellTier
        ? quoteMemberPrice(unitPrice, pdpUpsellTier.discountPercent)
        : null)
    : null;

  // Which dose gets the "★ Most Popular" badge. GLP-3 spotlights its 30mg; the
  // other GLP lines keep their 10mg badge; BAC Water highlights the 30mL; every
  // other two-dose product highlights its higher-priced dose.
  const mostPopularDoseId = useMemo(() => {
    const doses = product.doses ?? [];
    if (doses.length < 2) return null;
    const normalized = (dose: ProductDose) => (dose.slugSuffix || dose.label || "").toLowerCase().replace(/\s+/g, "");
    if (isBacWater(product.slug)) {
      return doses.find((dose) => normalized(dose) === "30ml")?.id ?? null;
    }
    const slug = product.slug.toLowerCase();
    if (slug.startsWith("glp-")) {
      const spotlight = slug === "glp-3" ? "30mg" : "10mg";
      return doses.find((dose) => normalized(dose) === spotlight)?.id ?? null;
    }
    if (doses.length === 2) {
      const price = (dose: ProductDose) => toPriceNumber(dose.salePrice ?? dose.price);
      return [...doses].sort((a, b) => price(b) - price(a))[0]?.id ?? null;
    }
    return null;
  }, [product.doses, product.slug]);

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

      <main className="relative mx-auto max-w-[1440px] px-4 sm:px-6 pb-12 pt-24 sm:pb-16 sm:pt-28 lg:px-12 lg:pt-32">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-[#a3a3a3]">
          {/* min-h-6 lifts these to a 24px tap target (WCAG 2.2 AA 2.5.8). At
              text-xs the breadcrumb links were 16px tall — the standalone
              navigation back out of a product, and the hardest thing on the
              page to hit on a phone. Only the hit area changes. */}
          <Link href="/" className="inline-flex min-h-6 items-center transition hover:text-white">Home</Link>
          <span>/</span>
          <Link href="/products" className="inline-flex min-h-6 items-center transition hover:text-white">Products</Link>
          <span>/</span>
          <span className="text-white">{product.name}</span>
        </nav>

        <CouponPromoBanner initialCoupon={featuredCoupon} />

        {promoBuy3Get1Enabled ? (
          <div className="vl2-lab-panel mt-6 flex flex-wrap items-center gap-2 border-white/[0.06] bg-[#141414] px-5 py-3.5 text-sm text-white">
            <span aria-hidden="true">🎁</span>
            <span className="font-medium">Buy 3, Get 1 Free</span>
            <span className="text-[#a3a3a3]">— the lowest-priced item in your cart is automatically free at checkout.</span>
          </div>
        ) : null}

        <section className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-start lg:gap-10">
          {/* Block A — product image. Mobile order 1; desktop top-left. */}
          <div className="order-1 min-w-0 lg:col-start-1 lg:row-start-1">
            {/* The frame follows the photograph, not the grid.
                It used to be a min-height box as wide as its column, so a tall
                narrow vial floated in the middle of a wide landscape panel with
                empty charcoal either side — the product looked small and the
                page unfinished. A portrait ratio matched to the photography,
                capped in width and centred, means the vial fills its frame at
                every breakpoint without being stretched or cropped: the image
                is still object-contain, and no asset changed.
                On a phone the cap also stops a full-bleed square pushing the
                price and Add to Cart below the fold. */}
            <div className="vl2-lab-panel mx-auto w-full max-w-[340px] overflow-hidden sm:max-w-[420px] lg:max-w-none">
              <div className="relative aspect-[4/5] bg-[#141414]">
                {hasRealImage ? (
                  <Image
                    src={imageToDisplay as string}
                    alt={product.name}
                    fill
                    sizes="(max-width: 640px) 340px, (max-width: 1024px) 420px, 42vw"
                    className="object-contain"
                    priority
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="border border-white/[0.08] px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-white/45">Image pending</div>
                  </div>
                )}
              </div>
            </div>

            {/* BATCH + COA, IN THE OPEN.
                This lived behind a "COA & Quality" tab, which is the one thing
                a research buyer scans for before anything else. It only renders
                where there is real data -- no strip at all beats a strip that
                says "Pending" three times. */}
            {(selectedCoaUrl || selectedBatchNumber || (selectedPurity && selectedPurity !== "Pending")) ? (
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] border border-white/[0.06] bg-white/[0.02] px-5 py-4">
                {selectedPurity && selectedPurity !== "Pending" ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">Purity</p>
                    <p className="mt-1 text-[0.9375rem] font-semibold text-white">{selectedPurity}</p>
                  </div>
                ) : null}
                {selectedBatchNumber ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">Batch</p>
                    <p className="mt-1 font-mono text-[0.8125rem] text-white/85">{selectedBatchNumber}</p>
                  </div>
                ) : null}
                {selectedCoaUrl ? (
                  <a
                    href={selectedCoaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="vl-article-link vl-focus-ring ml-auto rounded-[8px]"
                  >
                    View COA
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                    </svg>
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveTab("coa")}
                    className="vl-article-link vl-focus-ring ml-auto rounded-[8px]"
                  >
                    Batch results
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                )}
              </div>
            ) : null}

            {galleryItems.length > 1 && (
              <div className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-7">
                {galleryItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedImageUrl(item.imageUrl)}
                    className={`relative overflow-hidden border bg-[#141414] transition ${item.imageUrl === imageToDisplay ? "border-[color:var(--accent-gold)]" : "border-white/[0.08] hover:border-white/[0.16]"}`}
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
              <div className="vl2-lab-panel flex gap-1 rounded-full p-1">
                {TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab((current) => (current === tab.key ? null : tab.key))}
                    aria-expanded={activeTab === tab.key}
                    className={`min-w-0 flex-1 rounded-full px-2 py-2.5 text-[11px] font-medium uppercase tracking-normal transition sm:px-3 sm:text-xs sm:tracking-[0.16em] ${activeTab === tab.key ? "bg-[#111] text-white shadow-sm" : "text-[#a3a3a3] hover:text-white"}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {activeTab === "description" && (
                  <div className="vl2-lab-panel p-5">
                    <p className="text-sm leading-7 text-[#a3a3a3]">{product.longDescription ?? product.description}</p>
                    {product.molecularFormula && (
                      <p className="mt-4 text-xs text-white/45">Molecular Formula: <span className="text-white">{product.molecularFormula}</span></p>
                    )}
                    <div className="mt-5 border border-white/[0.08] bg-[#141414] p-4 text-xs leading-6 text-[#a3a3a3]">
                      <strong className="text-white">Research Use Only.</strong> This compound is intended strictly for laboratory research purposes. Not for human or veterinary use.
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
                          <div key={label} className="flex justify-between gap-3 border-b border-white/[0.06] pb-2 last:border-0">
                            <dt className="text-white/45">{label}</dt>
                            <dd className="min-w-0 break-words text-right font-medium text-white">{value}</dd>
                          </div>
                        ))}
                    </dl>
                    {product.peptideSequence && product.peptideSequence.trim().length > 0 && (
                      <div className="mt-4 border-t border-white/[0.06] pt-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/45">Amino Acid Sequence</p>
                        <div className="mt-2 overflow-x-auto">
                          <code className="block whitespace-pre-wrap break-all font-mono text-xs leading-6 text-white">{product.peptideSequence}</code>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "coa" && (
                  <div className="vl2-lab-panel p-5">
                    {/* The notice explains that batch-specific COAs are still
                        being prepared. Once this product HAS published batch
                        records, that is no longer true of it — showing both
                        would have the page contradict itself. */}
                    {coaDocuments.length === 0 ? <CoaLibraryNotice className="mb-5" /> : null}
                    {/* Only describe a downloadable COA when one actually
                        exists. This paragraph used to render unconditionally —
                        "Every product lot is linked to a third-party
                        Certificate of Analysis… Download the report below" —
                        directly under a notice saying Vanta-branded COAs are
                        still being prepared, with no download beneath it. Two
                        contradictory claims, stacked. */}
                    {selectedCoaUrl ? (
                      <p className="text-sm leading-relaxed text-[#a3a3a3]">
                        This lot is linked to a third-party Certificate of Analysis covering purity, testing
                        methodology, batch traceability, and lab information. Download the report for your
                        selected dose below.
                      </p>
                    ) : null}
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="border border-white/[0.08] p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/45">Purity</p>
                        <p className="mt-1.5 text-xl font-semibold text-white">{selectedPurity ?? "Pending"}</p>
                      </div>
                      <div className="border border-white/[0.08] p-4">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/45">Batch</p>
                        <p className="mt-1.5 text-sm font-medium text-white">{selectedBatchNumber}</p>
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

                    {/* Per-batch documentation from Admin → COA Library. One
                        product accumulates one of these per production run, so
                        the newest sits first and the rest stay reachable. */}
                    {coaDocuments.length > 0 ? (
                      <div className="mt-6 border-t border-white/[0.08] pt-5">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-white/45">
                          Published batch records
                        </p>
                        <ul className="mt-3 space-y-2">
                          {coaDocuments.map((doc) => (
                            <li
                              key={doc.id}
                              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border border-white/[0.08] px-4 py-3"
                            >
                              <div className="min-w-0">
                                <p className="font-mono text-[13px] text-white">{doc.batchNumber}</p>
                                <p className="mt-0.5 text-xs text-white/45">
                                  {[doc.strength, doc.purity, formatCoaTestDate(doc.testDate), doc.labName]
                                    .filter(Boolean)
                                    .join(" · ") || "Certificate of Analysis"}
                                </p>
                              </div>
                              <a
                                href={`/api/coa/${doc.id}/file`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="vl-article-link vl-focus-ring rounded-[8px]"
                              >
                                View COA
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                  <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                                </svg>
                              </a>
                            </li>
                          ))}
                        </ul>
                        <Link
                          href="/coa-library"
                          className="vl-article-link vl-focus-ring mt-4 inline-flex rounded-[8px]"
                        >
                          Browse the full COA library
                          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                            <path d="M5 12h14M13 6l6 6-6 6" />
                          </svg>
                        </Link>
                      </div>
                    ) : null}
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
                  <p className="text-[11px] uppercase tracking-[0.3em] text-white/45">{product.category}</p>
                  <h1 className="vl2-serif mt-2 text-3xl text-white">{product.name}</h1>
                </div>
                {/* Only shown when inventory enforcement is on and stock is sold out —
                    never an "In Stock" badge, per product spec. */}
                {isOutOfStock ? (
                  <span className="shrink-0 border border-white/[0.12] bg-[#1a1a1a] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#a3a3a3]">Out of Stock</span>
                ) : null}
              </div>

              {doseFromSlug && (
                <p className="mt-1 text-xs text-white/45">{doseFromSlug} · {product.labName}</p>
              )}

              {(product.shortDescription ?? product.description) ? (
                <p className="mt-4 text-sm leading-6 text-[#a3a3a3]">{product.shortDescription ?? product.description}</p>
              ) : null}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {hasVerifiedTesting && (
                  <span className="rounded-full border border-white/[0.08] bg-[#141414] px-3 py-1 text-xs font-medium text-[color:var(--accent-gold)]">
                    {selectedPurity} Purity Verified
                  </span>
                )}
                {selectedBatchNumber && (
                  <span className="border border-white/[0.08] bg-[#141414] px-3 py-1 text-xs text-[#a3a3a3]">
                    Batch {selectedBatchNumber}
                  </span>
                )}
                <span className="border border-white/[0.08] bg-[#141414] px-3 py-1 text-xs font-medium text-white">
                  Research Use Only
                </span>
              </div>

              {/* Trust row — third-party proof + guarantee, right next to the
                  buy decision (not hidden inside a tab). */}
              <div className={`mt-4 grid grid-cols-1 gap-3 ${hasVerifiedTesting ? "sm:grid-cols-2" : ""}`}>
                {/* Purity card only renders once this batch actually has a
                    published COA. There is no "COA pending" state on the buy
                    panel — an unverified batch simply says nothing here rather
                    than advertising a gap. */}
                {hasVerifiedTesting ? (
                  <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-[#141414] px-4 py-3.5">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-5 w-5 flex-shrink-0 text-[color:var(--accent-gold)]">
                      <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
                      <path d="m9 12 2 2 4-4" />
                    </svg>
                    <div>
                      <p className="text-xs font-semibold text-white">{selectedPurity} purity</p>
                      <p className="text-[11px] leading-4 text-[#a3a3a3]">Third-party batch tested</p>
                    </div>
                  </div>
                ) : null}
                <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-[#141414] px-4 py-3.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-5 w-5 flex-shrink-0 text-[color:var(--accent-gold)]">
                    <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
                    <path d="M12 8v4" />
                    <path d="M12 16h.01" />
                  </svg>
                  <div>
                    <p className="text-xs font-semibold text-white">Damaged or incorrect? Made right.</p>
                    <p className="text-[11px] leading-4 text-[#a3a3a3]">Discreet, tracked U.S. shipping</p>
                  </div>
                </div>
              </div>

              {product.doses && product.doses.length > 0 && (
                <div className="mt-6">
                  <p className="vl2-lab-eyebrow">Vial Size</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {product.doses.map((variant) => {
                      const isMostPopular = variant.id === mostPopularDoseId;
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          onClick={() => setSelectedDoseId(variant.id)}
                          className={`relative rounded-full border px-4 py-2 text-sm transition active:scale-95 ${
                            selectedDose?.id === variant.id
                              ? "border-[#111] bg-[#111] text-white shadow-sm"
                              : "border-white/[0.08] text-[#a3a3a3] hover:border-white/[0.16] hover:text-white"
                          } ${variant.stockStatus === "Out of Stock" ? "opacity-40" : ""}`}
                        >
                          {variant.label}
                          {isMostPopular && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)]">
                              <span aria-hidden="true">★</span> Most Popular
                            </span>
                          )}
                          {variant.stockStatus === "Out of Stock" && <span className="ml-1 text-[9px]">sold out</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="mt-6 flex items-end gap-3">
                <p className="text-4xl font-semibold text-white">{selectedPrice}</p>
                {selectedCompareAtPrice && (
                  <p className="mb-1 text-base text-white/45 line-through">{selectedCompareAtPrice}</p>
                )}
              </div>

              {/* Member pricing — dollars, not percentages. Members see their
                  price on this exact vial; everyone else sees precisely what
                  joining would save them today, linking to the membership
                  page. Display only — checkout applies the real discount. */}
              {memberQuote && memberQuote.savings > 0 ? (
                isMember ? (
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-semibold text-white">Your member price: <span className="tabular-nums">{formatUsd(memberQuote.memberPrice)}</span></span>
                    <span className="text-[#a3a3a3]">you save {formatUsd(memberQuote.savings)} ({memberQuote.percent}%)</span>
                  </div>
                ) : (
                  <Link
                    href="/membership"
                    className="group mt-6 block rounded-2xl border border-[color:var(--accent-gold)]/20 bg-gradient-to-b from-[#161616] to-[#121212] p-6 shadow-[0_10px_30px_-20px_rgba(0,0,0,0.9)] transition duration-200 hover:border-[color:var(--accent-gold)]/40"
                  >
                    <span className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" className="h-4 w-4 text-[color:var(--accent-gold)]" aria-hidden>
                        <path d="m12 3.5 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.9l6.1-.8z" />
                      </svg>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--accent-gold)]">Member pricing</span>
                    </span>

                    <span className="mt-4 block text-[11px] uppercase tracking-[0.2em] text-[#a3a3a3]">Today&apos;s price</span>
                    <span className="mt-1 block text-[2.25rem] font-semibold leading-none tracking-tight text-white tabular-nums">
                      {formatUsd(memberQuote.memberPrice)}
                    </span>
                    <span className="mt-2 block text-xs text-[#a3a3a3]">
                      Regular price <span className="line-through">{formatUsd(memberQuote.regularPrice)}</span>
                      <span className="ml-2 text-[color:var(--accent-gold)]">Save {formatUsd(memberQuote.savings)} today</span>
                    </span>

                    <span className="mt-4 block text-xs leading-relaxed text-[#a3a3a3]">
                      Become a member for lower pricing, free shipping, and monthly store credit.
                    </span>

                    {/* Secondary by design: the page's one bright-gold action is
                        Add to Cart. This is a refined outline button. */}
                    <span className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--accent-gold)]/35 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--accent-gold)] transition duration-200 group-hover:border-[color:var(--accent-gold)]/60 group-hover:bg-[color:var(--accent-gold)]/[0.06]">
                      Join membership
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    </span>
                  </Link>
                )
              ) : null}

              {/* OUT OF STOCK is the only stock statement a customer ever sees.
                  Counts, "only N left" and low-stock warnings are deliberately
                  absent: stock depth is commercial information for the owner,
                  not merchandising copy. Everything below still respects the
                  real count, it simply never names it. */}
              {isOutOfStock ? (
                <p className="mt-5 text-sm" aria-live="polite">
                  <span className="font-semibold uppercase tracking-[0.08em] text-[#e5484d]">Out of stock</span>
                </p>
              ) : null}

              <div className="mt-6">
                <p className="vl2-lab-eyebrow">Quantity</p>
                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {BUNDLE_OPTIONS.map((option) => {
                    const isSelected = option.quantity === 10 ? quantity >= 10 : quantity === option.quantity;
                    // A bundle bigger than the shelf is not an offer, it is a
                    // failed checkout three steps later. Disabled, not hidden,
                    // so the shopper can see the tier exists and why it is off.
                    const exceedsStock = option.quantity > maxSelectableQuantity;
                    const rate = bundleDiscountRate(option.quantity, bundleConfig);
                    const lineTotal = getBundleDiscountedLineTotal(unitPrice, option.quantity, bundleConfig);
                    const freeShip = lineTotal >= FREE_SHIPPING_THRESHOLD;
                    return (
                      <button
                        key={option.quantity}
                        type="button"
                        disabled={exceedsStock}
                        onClick={() => setQuantity(option.quantity)}
                        className={`relative rounded-xl border px-2 py-3.5 text-center transition duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${isSelected ? "border-[color:var(--accent-gold)]/70 bg-[#181818] text-white shadow-[0_8px_20px_-12px_rgba(0,0,0,0.9)]" : "border-white/[0.06] bg-[#121212] text-white hover:border-white/20"}`}
                      >
                        {option.badge ? (
                          <span className={`absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border px-1.5 py-[0.1rem] text-[9px] font-medium uppercase tracking-[0.1em] ${option.badge === "Best Value" ? "border-[color:var(--accent-gold)]/50 bg-[#0f0f0f] text-white" : "border-[color:var(--accent-gold)]/30 bg-[#0f0f0f] text-[color:var(--accent-gold)]"}`}>
                            {option.badge}
                          </span>
                        ) : null}
                        {isSelected ? (
                          <span className="absolute right-1.5 top-1.5 text-[color:var(--accent-gold)]" aria-hidden>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="M20 6 9 17l-5-5" /></svg>
                          </span>
                        ) : null}
                        <span className="block text-sm font-medium">{option.label}</span>
                        <span className={`mt-1 block text-xs tabular-nums ${isSelected ? "text-white" : "text-[#a3a3a3]"}`}>{formatUsd(lineTotal)}</span>
                        {rate > 0 ? (
                          <span className="mt-0.5 block text-[10px] font-semibold text-[color:var(--accent-gold)]">Save {Math.round(rate * 100)}%</span>
                        ) : null}
                        {freeShip ? (
                          <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-[#a3a3a3]">Free ship</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {quantity > 3 ? (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      // Steps from the DISPLAYED quantity, not the stored one.
                      // They differ whenever the stored value is above what the
                      // selected dose can supply — and stepping down from the
                      // stored value then produced no visible change at all, so
                      // the button looked broken.
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      className="inline-flex h-11 w-11 items-center justify-center border border-white/[0.08] text-lg text-[#a3a3a3] transition hover:border-white/[0.16]"
                    >−</button>
                    <span className="text-sm text-white" aria-live="polite">{quantity} vials</span>
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      disabled={quantity >= maxSelectableQuantity}
                      onClick={() => setQuantity(Math.min(maxSelectableQuantity, quantity + 1))}
                      className="inline-flex h-11 w-11 items-center justify-center border border-white/[0.08] text-lg text-[#a3a3a3] transition hover:border-white/[0.16] disabled:cursor-not-allowed disabled:opacity-40"
                    >+</button>
                    {currentBundleRate > 0 ? (
                      <span className="text-xs font-medium text-[color:var(--accent-gold)]">Save {Math.round(currentBundleRate * 100)}% <span className="text-white tabular-nums">— {formatUsd(getBundleDiscountedLineTotal(unitPrice, quantity, bundleConfig))} total</span></span>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {currentBundleRate > 0 ? (
                <div className="mt-4 flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#141414] px-4 py-3.5">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[color:var(--accent-gold)]">{quantity}-Vial Bundle</p>
                    <p className="text-sm text-white">You save {formatUsd(unitPrice * quantity - getBundleDiscountedLineTotal(unitPrice, quantity, bundleConfig))} · {Math.round(currentBundleRate * 100)}% off</p>
                  </div>
                  <p className="text-xl font-semibold text-white tabular-nums">{formatUsd(getBundleDiscountedLineTotal(unitPrice, quantity, bundleConfig))}</p>
                </div>
              ) : null}

              <div className="mt-5 flex gap-2">
                <button
                  onClick={(event) => handleAddToCart(event.currentTarget)}
                  type="button"
                  disabled={isOutOfStock}
                  // The one bright-gold element on the page. Everything else is
                  // champagne or charcoal so this reads as THE action.
                  className="vl-focus-ring flex-1 rounded-2xl bg-[color:var(--accent-gold-bright)] px-5 py-4 text-sm font-semibold uppercase tracking-[0.08em] text-black shadow-[0_10px_26px_-16px_rgba(199,174,94,0.55)] transition duration-200 hover:-translate-y-px hover:bg-[color:var(--accent-gold-bright-hover)] hover:shadow-[0_14px_32px_-16px_rgba(199,174,94,0.6)] active:translate-y-0 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:hover:translate-y-0"
                >
                  {isOutOfStock ? "Currently Unavailable" : `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`}
                </button>
                <WishlistButton
                  slug={product.slug}
                  className="vl2-lab-btn-secondary vl-focus-ring inline-flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center"
                />
              </div>

              <BacWaterAccessoryBlock bacWater={bacWater} hostSlug={product.slug} />

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
                <p role="status" aria-live="polite" className="mt-3 text-sm text-[#a3a3a3]">{message}</p>
              )}

              <div className="mt-6 space-y-2 border-t border-white/[0.08] pt-5">
                {TRUST_ROW.map((item) => (
                  <div key={item.label} className="flex items-center gap-3 text-[#a3a3a3]">
                    <span aria-hidden="true">{item.icon}</span>
                    <span className="text-xs">
                      <span className="font-medium text-white">{item.label}</span> — {item.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>

        <FrequentlyBoughtTogether
          product={product}
          selectedDoseId={selectedDose?.id ?? null}
          bacWater={bacWater}
        />

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
                {/* Same 24px floor — standalone section link, was 16px tall. */}
                <Link href="/products" className="inline-flex min-h-6 items-center text-xs uppercase tracking-[0.16em] text-white/50 transition hover:text-white">
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

      {/* Sticky add-to-cart: charcoal bar under a thin gold hairline, so it
          reads as part of the brand rather than a floating utility strip. */}
      <div className="vl-bottom-bar fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--accent-gold)]/20 bg-[#141414]/95 px-5 pt-4 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl lg:hidden">
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[#a3a3a3]">{product.name}</p>
            <p className="mt-0.5 text-lg font-semibold leading-none text-white tabular-nums">{selectedPrice}</p>
          </div>
          <button
            onClick={(event) => handleAddToCart(event.currentTarget)}
            type="button"
            disabled={isOutOfStock}
            className="vl2-btn-primary vl-focus-ring shrink-0 rounded-full px-7 py-3.5 text-xs"
          >
            {isOutOfStock ? "Unavailable" : `Add ${quantity > 1 ? `${quantity} × ` : ""}to Cart`}
          </button>
        </div>
      </div>
    </div>
  );
}
