"use client";

import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/catalog-types";
import { WishlistButton } from "@/components/wishlist-button";
import { formatCartCurrency, useCart } from "@/components/cart-context";
import { bestPaidTier, parsePriceValue, quoteMemberPrice } from "@/lib/member-pricing";
import { hasCoa } from "@/lib/coa-url";
import { COA_SHORT } from "@/lib/trust-claims";

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
  // Out of stock is honored only when inventory enforcement is on (the
  // catalog resolves everything to "In Stock" otherwise), so this simply
  // reflects what fulfillment reports. A sold-out card can't be added to the
  // cart — the shopper opens the product to sign up for a restock alert.
  const soldOut = product.stockStatus === "Out of Stock" || product.stockStatus === "Reserved";

  // Member pricing — dollars first. Members see THEIR real price; everyone else
  // sees the STRONGEST paid tier's price, which is the biggest discount the
  // catalog can honestly advertise. A member is never shown a lower tier's
  // price they can't actually get, and never a higher one they'd have to
  // upgrade for — `memberDiscountPercent` is their own.
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
        className="vl-card-fav absolute right-2.5 top-2.5 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full text-white/70 backdrop-blur-md hover:text-rose-300"
      />
      <Link href={`/products/${product.slug}`} className="vl-focus-ring flex flex-1 flex-col">
        <div className="vl-product-card-media border-b border-white/10">
          {product.isBestSeller ? (
            <span className="vl-card-badge absolute left-3 top-3 z-10">
              <span aria-hidden="true" className="text-[color:var(--accent-gold-bright)]">★</span> Best Seller
            </span>
          ) : product.badge ? (
            <span className="vl-card-badge absolute left-3 top-3 z-10">
              {BADGE_LABELS[product.badge]}
            </span>
          ) : null}
          {soldOut ? (
            <span className="absolute right-3 top-3 z-10 rounded-full border border-white/[0.09] bg-black/60 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-white/45 backdrop-blur-md">
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

          <h3 className="mt-1.5 line-clamp-2 text-[0.9375rem] font-medium leading-snug tracking-[-0.005em] text-white sm:mt-2 sm:text-xl">{product.name}</h3>

          <div className="mt-2 flex items-baseline gap-x-2 sm:mt-3">
            <p className="text-lg font-semibold tracking-tight text-white sm:text-2xl">{product.salePrice ?? product.price}</p>
            {product.salePrice && product.compareAtPrice ? (
              <p className="text-xs text-white/55 line-through sm:text-sm">{product.compareAtPrice}</p>
            ) : null}
          </div>
          {/* The member price used to be one line of small grey-gold text that
              read past. The saving is the strongest thing on the card after the
              price itself, so it gets the price's weight and a percent chip —
              and the tier is NAMED, because "member price" alone doesn't tell a
              shopper which membership actually buys it. */}
          {showMemberPricing && memberQuote ? (
            <div className="mt-1.5">
              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <span className="text-base font-semibold tracking-tight text-[color:var(--accent-gold)] sm:text-lg">
                  {formatCartCurrency(memberQuote.memberPrice)}
                </span>
                <span className="rounded-full border border-[color:var(--accent-gold)]/35 bg-[color:var(--accent-gold)]/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[color:var(--accent-gold)]">
                  −{memberQuote.percent}%
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-tight text-[#a3a3a3] sm:text-xs">
                {isMember ? "Your member price" : `With ${upsellTier?.name ?? "membership"}`}
                {" · save "}
                <span className="text-white/75">{formatCartCurrency(memberQuote.savings)}</span>
              </p>
            </div>
          ) : null}
          {/* Trust badges — data-driven, so they only appear when the real
              purity / COA / batch data is entered in Admin (no fabricated claims). */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px] leading-none">
            {product.purityResult ? (
              <span className="rounded-full border border-[color:var(--accent-gold)]/30 bg-[color:var(--accent-gold)]/[0.08] px-2 py-1 font-medium text-[color:var(--accent-gold)]">
                {product.purityResult.includes("%") ? product.purityResult : `${product.purityResult} pure`}
              </span>
            ) : null}
            {/* hasCoa(), NOT truthiness — the same guard the COA link forty
                lines below already uses, and for the reason spelled out there:
                " ", "pending" and "TBD" are all truthy. This badge asserted
                that a document EXISTS while the link on the same card, gated
                properly, offered nothing to open. A card that claims a COA and
                cannot show one is worse than a card that claims nothing.

                COA_SHORT rather than a local "COA verified" for the same
                reason the drawer's labels moved: one wording per claim. */}
            {hasCoa(product.coaUrl) ? (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-medium text-[#a3a3a3]">
                {COA_SHORT}
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

      {/* ONE action per card on a phone, two-up from sm.
          Two side-by-side buttons in a 2-up catalog grid leaves ~71px of button
          width at 390px, so "Add to Cart" wrapped onto three lines — taller than
          the stacking this layout was meant to avoid, and it looked broken.
          The secondary button is the one to drop: the whole card is already a
          link to the product page, so "View Details" duplicates the tap target
          surrounding it. It returns at sm where there's room.

          The mobile-hidden button is wrapped rather than given `hidden`
          directly: .vl2-btn-* sets `display:inline-flex` and is defined after
          the utilities, so `hidden` on the button itself loses the cascade and
          does nothing. The wrapper isn't a button, so it wins. */}
      <div className="grid grid-cols-2 gap-1.5 p-3 pt-0 sm:gap-2 sm:p-5 sm:pt-0">
        {soldOut ? (
          // Sold out: no working Add button. "Get restock alert" sends them to
          // the product page, which carries the notify-me signup form. The
          // disabled pill restates the corner badge, so on a phone the badge
          // carries the state alone and the alert takes the full width.
          <>
            <div className="hidden sm:block">
              <button type="button" disabled aria-disabled className="vl2-btn-secondary vl-focus-ring w-full cursor-not-allowed px-4 py-2.5 text-sm opacity-50" title="Out of stock">
                Out of Stock
              </button>
            </div>
            <Link
              href={`/products/${product.slug}`}
              className="vl2-btn-primary vl-focus-ring col-span-2 whitespace-nowrap px-2 py-2.5 text-xs sm:col-span-1 sm:px-4 sm:text-sm"
            >
              Get restock alert
            </Link>
          </>
        ) : onAddToCart ? (
          <>
            <button onClick={onAddToCart} className="vl2-btn-primary vl-focus-ring col-span-2 whitespace-nowrap px-2 py-2.5 text-xs sm:col-span-1 sm:px-4 sm:text-sm" type="button">
              Add to Cart
            </button>
            <div className="hidden sm:block">
              <Link href={`/products/${product.slug}`} className="vl2-btn-secondary vl-focus-ring w-full px-4 py-2.5 text-sm">
                View Details
              </Link>
            </div>
          </>
        ) : (
          // No Add button — View Details is the card's only action and must stay
          // visible at every width.
          <Link
            href={`/products/${product.slug}`}
            className="vl2-btn-secondary vl-focus-ring col-span-2 whitespace-nowrap px-2 py-2.5 text-xs sm:px-4 sm:text-sm"
          >
            View Details
          </Link>
        )}
        {/* Third-party testing is the strongest honest signal this store has,
            and it was one tap too deep: you had to open the product and find
            it. This is the same document the product page links, surfaced on
            the card.

            hasCoa() is the guard, not plain truthiness. The stored value is
            free text typed in admin, so " ", "pending" and "TBD" all read as
            true and would advertise a document that opens nothing — worse
            than admitting the COA is not ready. Today 4 of 93 active products
            clear it, so this action is rare by design.

            It sits OUTSIDE the card-wide <Link> — this block is after its
            closing tag — because an anchor inside an anchor is invalid and
            the browser would drop one of them. */}
        {hasCoa(product.coaUrl) ? (
          <a
            href={product.coaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="vl-focus-ring col-span-2 -mb-1 inline-flex min-h-6 items-center justify-center gap-1.5 py-1.5 text-[11px] text-[color:var(--accent-gold)]/75 underline-offset-4 transition hover:text-[color:var(--accent-gold)] hover:underline"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            View COA
          </a>
        ) : null}
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
