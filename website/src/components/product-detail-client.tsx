"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";
import type { Product } from "@/lib/catalog-types";

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

export function ProductDetailClient({ product }: { product: Product }) {
  const { addToCart } = useCart();
  const defaultDose = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0] ?? null;
  const [selectedDoseId, setSelectedDoseId] = useState<string | null>(defaultDose?.id ?? null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedDose = product.doses?.find((dose) => dose.id === selectedDoseId) ?? defaultDose;

  const selectedPrice = selectedDose?.salePrice ?? selectedDose?.price ?? product.price;
  const selectedCompareAtPrice = selectedDose?.compareAtPrice ?? product.compareAtPrice;
  const selectedBatchNumber = selectedDose?.batchNumber ?? product.batchNumber;
  const selectedPurity = selectedDose?.purityResult ?? product.purityResult;
  const selectedCoaUrl = selectedDose?.coaUrl ?? product.coaUrl;
  const selectedStockStatus = selectedDose?.stockStatus ?? product.stockStatus;

  const galleryItems = useMemo<GalleryItem[]>(() => {
    const fromGallery = (product.galleryImages ?? []).map((image) => ({
      id: image.id,
      imageUrl: image.imageUrl,
      altText: image.altText ?? product.name,
    }));

    const fallback = [
      selectedDose?.imageUrl,
      product.coverImage,
      product.image,
    ]
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
    if (!galleryItems.length) {
      return null;
    }

    if (selectedImageUrl && galleryItems.some((item) => item.imageUrl === selectedImageUrl)) {
      return selectedImageUrl;
    }

    return galleryItems[0]?.imageUrl ?? null;
  }, [galleryItems, selectedImageUrl]);
  const hasRealImage = Boolean(imageToDisplay);
  const doseFromSlug = parseDose(product.slug);

  const stockTone =
    selectedStockStatus === "In Stock"
      ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-100"
      : selectedStockStatus === "Limited"
        ? "border-zinc-300/35 bg-zinc-300/12 text-zinc-100"
        : selectedStockStatus === "Reserved"
          ? "border-zinc-300/35 bg-zinc-300/12 text-zinc-100"
          : "border-zinc-500/35 bg-zinc-500/10 text-zinc-200";

  const handleAddToCart = (sourceElement?: HTMLElement | null) => {
    addToCart(product, 1, sourceElement, {
      variantId: selectedDose?.id,
      doseLabel: selectedDose?.label,
      sku: selectedDose?.sku,
      priceOverride: toPriceNumber(selectedPrice),
      imageOverride: imageToDisplay ?? product.image,
      batchNumberOverride: selectedBatchNumber,
      stockStatusOverride: selectedStockStatus,
    });

    setMessage(`Added 1 item (${selectedDose?.label ?? "default"}) to cart.`);
  };

  return (
    <div className="vl-page-shell min-h-screen text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <Link href="/products" className="text-xs uppercase tracking-[0.24em] text-zinc-400 transition hover:text-white">
          Back to catalog
        </Link>

        <section className="mt-6 grid gap-7 lg:grid-cols-[1.12fr_0.88fr] lg:items-start">
          <div>
            <div className="vl-panel overflow-hidden rounded-[2rem]">
              <div className="relative min-h-[360px] bg-[radial-gradient(circle_at_40%_8%,rgba(255,255,255,0.12),transparent_62%)] sm:min-h-[460px]">
                {hasRealImage ? (
                  <Image
                    src={imageToDisplay as string}
                    alt={product.name}
                    fill
                    sizes="(max-width: 1024px) 100vw, 58vw"
                    className="object-contain p-8 sm:p-10"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <div className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-zinc-300">Image pending</div>
                  </div>
                )}
              </div>
            </div>

            {galleryItems.length > 1 ? (
              <div className="mt-4 grid grid-cols-4 gap-3 sm:grid-cols-6">
                {galleryItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedImageUrl(item.imageUrl)}
                    className={`relative overflow-hidden rounded-xl border ${
                      item.imageUrl === imageToDisplay ? "border-white/45" : "border-white/12"
                    } bg-zinc-900/80`}
                  >
                    <div className="relative aspect-square">
                      <Image src={item.imageUrl} alt={item.altText} fill sizes="120px" className="object-cover" />
                    </div>
                  </button>
                ))}
              </div>
            ) : null}

            <section className="mt-7 grid gap-4 md:grid-cols-2">
              <article className="vl-panel rounded-2xl p-5">
                <h2 className="text-sm uppercase tracking-[0.22em] text-zinc-400">Specifications</h2>
                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between border-b border-white/10 pb-2">
                    <dt className="text-zinc-400">Batch number</dt>
                    <dd className="text-zinc-100">{selectedBatchNumber}</dd>
                  </div>
                  <div className="flex justify-between border-b border-white/10 pb-2">
                    <dt className="text-zinc-400">Purity result</dt>
                    <dd className="text-zinc-100">{selectedPurity ?? "Pending"}</dd>
                  </div>
                  <div className="flex justify-between border-b border-white/10 pb-2">
                    <dt className="text-zinc-400">Formula</dt>
                    <dd className="text-zinc-100">{product.molecularFormula ?? "Provided in COA"}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-zinc-400">Lab</dt>
                    <dd className="text-zinc-100">{product.labName}</dd>
                  </div>
                </dl>
              </article>

              <article className="vl-panel rounded-2xl p-5">
                <h2 className="text-sm uppercase tracking-[0.22em] text-zinc-400">Quality Notes</h2>
                <p className="mt-4 text-sm leading-7 text-zinc-300">
                  Each lot is documented and linked to testing records before release. For complete analysis, use the matching COA for the selected dose.
                </p>
                <a href={selectedCoaUrl} target="_blank" rel="noopener noreferrer" className="vl-btn-secondary vl-focus-ring mt-5 inline-flex px-4 py-2 text-sm">
                  View COA
                </a>
              </article>
            </section>
          </div>

          <aside className="lg:sticky lg:top-24">
            <div className="vl-panel rounded-[2rem] p-6 sm:p-7">
              <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Research Compound</p>
              <h1 className="mt-3 text-3xl font-semibold text-white">{product.name}</h1>
              <p className="mt-4 text-sm leading-7 text-zinc-300">{product.longDescription ?? product.description}</p>

              <div className="mt-5 flex items-center gap-2">
                <span className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.2em] ${stockTone}`}>{selectedStockStatus}</span>
                {doseFromSlug ? <span className="vl-chip text-[10px]">{doseFromSlug}</span> : null}
              </div>

              {product.doses && product.doses.length > 0 ? (
                <div className="mt-7">
                  <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Dose Selection</p>
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
                        }`}
                      >
                        {variant.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="vl-panel-soft mt-7 rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Price</p>
                <div className="mt-2 flex items-center gap-2">
                  <p className="text-3xl font-semibold text-zinc-100">{selectedPrice}</p>
                  {selectedCompareAtPrice ? <p className="text-sm text-zinc-500 line-through">{selectedCompareAtPrice}</p> : null}
                </div>
              </div>

              <button onClick={(event) => handleAddToCart(event.currentTarget)} type="button" className="vl-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm">
                Add 1 to Cart
              </button>

              {message ? <p className="mt-3 text-sm text-emerald-300">{message}</p> : null}

              <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Testing Date</p>
                  <p className="mt-1 text-xs text-zinc-200">{product.testingDate}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">COA</p>
                  <p className="mt-1 text-xs text-zinc-200">Batch matched</p>
                </div>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
