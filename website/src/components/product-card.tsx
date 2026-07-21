"use client";

import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/catalog-types";
import { WishlistButton } from "@/components/wishlist-button";

const STOCK_STYLES: Record<Product["stockStatus"], string> = {
  "In Stock": "border-emerald-300/30 text-emerald-200",
  Limited: "border-amber-300/35 text-amber-200",
  Reserved: "border-white/20 text-white/60",
  "Out of Stock": "border-white/15 text-white/40",
};

const BADGE_LABELS: Record<NonNullable<Product["badge"]>, string> = {
  new: "New",
  best_seller: "Best Seller",
  sale: "Sale",
};

function StockPill({ stockStatus }: { stockStatus: Product["stockStatus"] }) {
  return (
    <span className={`border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${STOCK_STYLES[stockStatus]}`}>
      {stockStatus}
    </span>
  );
}

export function ProductCard({
  product,
  image,
  onAddToCart,
  priority = false,
  initialInWishlist = false,
}: {
  product: Product;
  image: string;
  onAddToCart?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  priority?: boolean;
  initialInWishlist?: boolean;
}) {
  const hasRealImage = Boolean(image) && !image.includes(".svg");
  const dosePreview = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0];

  return (
    <article className="vl2-product-card group relative flex h-full flex-col">
      {/* Kept outside the card <Link> so we don't nest a <button> inside an <a>
          (invalid HTML / hydration + a11y hazard). Positioned to the card. */}
      <WishlistButton
        slug={product.slug}
        initialInWishlist={initialInWishlist}
        className="absolute right-2.5 top-2.5 z-20 inline-flex h-10 w-10 items-center justify-center border border-white/20 bg-black/70 text-white backdrop-blur transition hover:text-rose-300"
      />
      <Link href={`/products/${product.slug}`} className="vl-focus-ring flex flex-1 flex-col">
        <div className="vl-product-card-media border-b border-white/10">
          {product.badge ? (
            <span className="vl2-eyebrow absolute left-3 top-3 z-10 border border-white/20 bg-black/70 px-2.5 py-1 text-[10px] backdrop-blur">
              {BADGE_LABELS[product.badge]}
            </span>
          ) : null}
          {hasRealImage ? (
            <Image
              src={image}
              alt={product.name}
              fill
              priority={priority}
              loading={priority ? undefined : "lazy"}
              sizes="(max-width: 640px) 50vw, (max-width: 1280px) 50vw, 25vw"
              className="object-contain p-4 sm:p-7"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="border border-white/12 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/40">
                Image pending
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col p-3 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="vl2-eyebrow text-[10px] text-white/45">{product.category}</p>
            <StockPill stockStatus={product.stockStatus} />
          </div>

          <h3 className="mt-2.5 line-clamp-2 text-base text-white sm:mt-3 sm:text-lg">{product.name}</h3>
          <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-white/55 sm:mt-2 sm:text-sm sm:leading-6">
            {product.shortDescription ?? product.description}
          </p>

          <div className="mt-3 flex items-end justify-between gap-2 sm:mt-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-lg text-white sm:text-xl">{product.salePrice ?? product.price}</p>
                {product.salePrice && product.compareAtPrice ? (
                  <p className="text-xs text-white/40 line-through sm:text-sm">{product.compareAtPrice}</p>
                ) : null}
              </div>
              <p className="text-xs text-white/45">{dosePreview?.label ?? "Verified lot"}</p>
            </div>
            <span className="hidden shrink-0 border border-white/15 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-white/50 min-[420px]:inline-block">COA Verified</span>
          </div>
        </div>
      </Link>

      <div className="grid gap-2 p-3 pt-0 sm:grid-cols-2 sm:p-5 sm:pt-0">
        {onAddToCart ? (
          <button onClick={onAddToCart} className="vl2-btn-primary vl-focus-ring px-4 py-2.5 text-sm" type="button">
            Add to Cart
          </button>
        ) : null}
        <Link
          href={`/products/${product.slug}`}
          className={`vl2-btn-secondary vl-focus-ring inline-flex items-center justify-center px-4 py-2.5 text-sm ${onAddToCart ? "" : "sm:col-span-2"}`}
        >
          View Details
        </Link>
      </div>
    </article>
  );
}
