"use client";

import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/catalog-types";

const STOCK_STYLES: Record<Product["stockStatus"], string> = {
  "In Stock": "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
  Limited: "border-amber-300/35 bg-amber-300/12 text-amber-100",
  Reserved: "border-zinc-300/35 bg-zinc-300/10 text-zinc-100",
  "Out of Stock": "border-zinc-500/40 bg-zinc-600/15 text-zinc-300",
};

const BADGE_LABELS: Record<NonNullable<Product["badge"]>, string> = {
  new: "New",
  best_seller: "Best Seller",
  sale: "Sale",
};

function StockPill({ stockStatus }: { stockStatus: Product["stockStatus"] }) {
  return (
    <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] ${STOCK_STYLES[stockStatus]}`}>
      {stockStatus}
    </span>
  );
}

export function ProductCard({
  product,
  image,
  onAddToCart,
  priority = false,
}: {
  product: Product;
  image: string;
  onAddToCart?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  priority?: boolean;
}) {
  const hasRealImage = Boolean(image) && !image.includes(".svg");
  const dosePreview = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0];

  return (
    <article className="vl-product-card group flex h-full flex-col">
      <Link href={`/products/${product.slug}`} className="vl-focus-ring flex flex-1 flex-col rounded-[inherit]">
        <div className="vl-product-card-media border-b border-white/10">
          {product.badge ? (
            <span className="vl-eyebrow absolute left-3 top-3 z-10 rounded-full border border-white/25 bg-black/60 px-2.5 py-1 text-[10px] backdrop-blur">
              {BADGE_LABELS[product.badge]}
            </span>
          ) : null}
          {hasRealImage ? (
            <Image
              src={image}
              alt={product.name}
              fill
              priority={priority}
              sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 25vw"
              className="object-contain p-7"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-300">
                Image pending
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="vl-eyebrow text-[10px] text-zinc-500">{product.category}</p>
            <StockPill stockStatus={product.stockStatus} />
          </div>

          <h3 className="mt-3 line-clamp-2 text-lg font-semibold text-white">{product.name}</h3>
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-400">
            {product.shortDescription ?? product.description}
          </p>

          <div className="mt-4 flex items-end justify-between gap-2">
            <div>
              <div className="flex items-baseline gap-2">
                <p className="text-xl font-semibold text-zinc-100">{product.salePrice ?? product.price}</p>
                {product.salePrice && product.compareAtPrice ? (
                  <p className="text-sm text-zinc-500 line-through">{product.compareAtPrice}</p>
                ) : null}
              </div>
              <p className="text-xs text-zinc-500">{dosePreview?.label ?? "Verified lot"}</p>
            </div>
            <span className="vl-chip text-[10px]">COA Verified</span>
          </div>
        </div>
      </Link>

      <div className="grid gap-2 p-5 pt-0 sm:grid-cols-2">
        {onAddToCart ? (
          <button onClick={onAddToCart} className="vl-btn-primary vl-focus-ring px-4 py-2.5 text-sm" type="button">
            Add to Cart
          </button>
        ) : null}
        <Link
          href={`/products/${product.slug}`}
          className={`vl-btn-secondary vl-focus-ring inline-flex items-center justify-center px-4 py-2.5 text-sm ${onAddToCart ? "" : "sm:col-span-2"}`}
        >
          View Details
        </Link>
      </div>
    </article>
  );
}
