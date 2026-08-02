"use client";

import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/catalog-types";
import { WishlistButton } from "@/components/wishlist-button";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { bestPaidTier, parsePriceValue, quoteMemberPrice } from "@/lib/member-pricing";

const BADGE_LABELS: Record<NonNullable<Product["badge"]>, string> = {
  new: "New",
  best_seller: "Best Seller",
  sale: "Sale",
};

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
  // Out of stock is honored only when the 3PL inventory feed is live (the
  // catalog resolves everything to "In Stock" otherwise), so this simply
  // reflects what fulfillment reports. A sold-out card can't be added to the
  // cart — the shopper opens the product to sign up for a restock alert.
  const soldOut = product.stockStatus === "Out of Stock" || product.stockStatus === "Reserved";

  // Member pricing — dollars first. Members see THEIR price; everyone else
  // sees what the strongest paid tier would charge, with the exact savings.
  const { membershipTiers, memberDiscountPercent } = useCart();
  const numericPrice = parsePriceValue(product.salePrice ?? product.price);
  const isMember = memberDiscountPercent > 0;
  const upsellTier = isMember ? null : bestPaidTier(membershipTiers);
  const memberQuote = numericPrice > 0
    ? (isMember
      ? quoteMemberPrice(numericPrice, memberDiscountPercent)
      : upsellTier
        ? quoteMemberPrice(numericPrice, upsellTier.discountPercent)
        : null)
    : null;
  const showMemberPricing = Boolean(memberQuote && memberQuote.savings > 0);

  return (
    <article className="vl2-product-card group relative flex h-full flex-col">
      {/* Kept outside the card <Link> so we don't nest a <button> inside an <a>
          (invalid HTML / hydration + a11y hazard). Positioned to the card. */}
      <WishlistButton
        slug={product.slug}
        initialInWishlist={initialInWishlist}
        className="absolute right-2.5 top-2.5 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white shadow-sm backdrop-blur-md transition hover:scale-105 hover:text-rose-300 active:scale-95"
      />
      <Link href={`/products/${product.slug}`} className="vl-focus-ring flex flex-1 flex-col">
        <div className="vl-product-card-media border-b border-white/10">
          {product.isBestSeller ? (
            <span className="vl2-eyebrow absolute left-3 top-3 z-10 rounded-full border border-[color:var(--accent-gold)]/40 bg-black/70 px-2.5 py-1 text-[10px] text-[color:var(--accent-gold)] shadow-sm backdrop-blur-md">
              ★ Best Seller
            </span>
          ) : product.badge ? (
            <span className="vl2-eyebrow absolute left-3 top-3 z-10 rounded-full border border-white/20 bg-black/70 px-2.5 py-1 text-[10px] shadow-sm backdrop-blur-md">
              {BADGE_LABELS[product.badge]}
            </span>
          ) : null}
          {soldOut ? (
            <span className="absolute right-3 top-3 z-10 rounded-full border border-white/20 bg-black/75 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-white/80 shadow-sm backdrop-blur-md">
              Out of Stock
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
              className={`object-cover ${soldOut ? "opacity-45 grayscale" : ""}`}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="border border-white/12 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/70">
                Image pending
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col p-3 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="vl2-eyebrow text-[10px] text-white/45">{product.category}</p>
          </div>

          <h3 className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-white sm:mt-2 sm:text-lg">{product.name}</h3>

          <div className="mt-2 flex items-baseline gap-x-2 sm:mt-3">
            <p className="text-lg font-semibold tracking-tight text-white sm:text-2xl">{product.salePrice ?? product.price}</p>
            {product.salePrice && product.compareAtPrice ? (
              <p className="text-xs text-white/55 line-through sm:text-sm">{product.compareAtPrice}</p>
            ) : null}
          </div>
          {showMemberPricing && memberQuote ? (
            <p className="mt-1 text-xs text-[color:var(--accent-gold)] sm:text-sm">
              {isMember ? "Your member price " : "Member price "}
              <span className="font-semibold">{formatCartCurrency(memberQuote.memberPrice)}</span>
              <span className="text-[#a3a3a3]"> · save {formatCartCurrency(memberQuote.savings)}</span>
            </p>
          ) : null}
          {/* Trust badges — data-driven, so they only appear when the real
              purity / COA / batch data is entered in Admin (no fabricated claims). */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px] leading-none">
            {product.purityResult ? (
              <span className="rounded-full border border-[color:var(--accent-gold)]/30 bg-[color:var(--accent-gold)]/[0.08] px-2 py-1 font-medium text-[color:var(--accent-gold)]">
                {product.purityResult.includes("%") ? product.purityResult : `${product.purityResult} pure`}
              </span>
            ) : null}
            {product.coaUrl ? (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-medium text-[#a3a3a3]">
                COA verified
              </span>
            ) : null}
            {product.batchNumber ? (
              <span className="rounded-full border border-white/15 px-2 py-1 text-white/50">
                Batch {product.batchNumber}
              </span>
            ) : null}
            <span className="text-white/70">{dosePreview?.label ?? "Verified lot"}</span>
          </div>
        </div>
      </Link>

      {/* Side-by-side compact buttons on phones (stacking them doubled the
          card height); full-size two-up from sm. */}
      <div className="grid grid-cols-2 gap-1.5 p-3 pt-0 sm:gap-2 sm:p-5 sm:pt-0">
        {soldOut ? (
          // Sold out: no working Add button. The disabled pill makes the state
          // obvious and "Get restock alert" sends them to the product page,
          // which carries the notify-me signup form.
          <>
            <button type="button" disabled aria-disabled className="vl2-btn-secondary vl-focus-ring cursor-not-allowed px-2 py-2 text-xs opacity-50 sm:px-4 sm:py-2.5 sm:text-sm" title="Out of stock">
              Out of Stock
            </button>
            <Link
              href={`/products/${product.slug}`}
              className="vl2-btn-primary vl-focus-ring inline-flex items-center justify-center px-2 py-2 text-xs sm:px-4 sm:py-2.5 sm:text-sm"
            >
              Get restock alert
            </Link>
          </>
        ) : (
          <>
            {onAddToCart ? (
              <button onClick={onAddToCart} className="vl2-btn-primary vl-focus-ring px-2 py-2 text-xs sm:px-4 sm:py-2.5 sm:text-sm" type="button">
                Add to Cart
              </button>
            ) : null}
            <Link
              href={`/products/${product.slug}`}
              className={`vl2-btn-secondary vl-focus-ring inline-flex items-center justify-center px-2 py-2 text-xs sm:px-4 sm:py-2.5 sm:text-sm ${onAddToCart ? "" : "col-span-2"}`}
            >
              View Details
            </Link>
          </>
        )}
        {!soldOut && showMemberPricing && memberQuote && !isMember ? (
          <Link
            href="/membership"
            className="vl-focus-ring col-span-2 -mb-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] text-[color:var(--accent-gold)]/70 transition hover:text-[color:var(--accent-gold)]"
          >
            Become a member &amp; save {formatCartCurrency(memberQuote.savings)} today →
          </Link>
        ) : null}
      </div>
    </article>
  );
}
