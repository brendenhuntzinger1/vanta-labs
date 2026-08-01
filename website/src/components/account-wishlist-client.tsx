"use client";

import { useCart } from "@/components/cart-context";
import { ProductCard } from "@/components/product-card";
import { BackInStockForm } from "@/components/back-in-stock-form";
import type { Product } from "@/lib/catalog-types";

const SOLD_OUT = new Set(["Out of Stock", "Reserved"]);

export function AccountWishlistClient({ products, email }: { products: Product[]; email?: string }) {
  const { addToCart } = useCart();

  if (products.length === 0) {
    return (
      <section className="vl-panel rounded-2xl p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/12 bg-white/[0.03] text-2xl">♡</div>
        <h2 className="mt-5 text-lg font-semibold text-white">Your wishlist is empty</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">Tap the heart on any product to save it here — we&apos;ll even alert you if a saved item sells out and comes back.</p>
        <a href="/products" className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-6 py-3 text-sm">Browse products</a>
      </section>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((product) => {
        const soldOut = SOLD_OUT.has(product.stockStatus);
        return (
          <div key={product.slug} className="flex flex-col gap-3">
            <ProductCard
              product={product}
              image={product.image}
              initialInWishlist
              onAddToCart={(event) => addToCart(product, 1, event.currentTarget)}
            />
            {soldOut ? <BackInStockForm productSlug={product.slug} initialEmail={email} /> : null}
          </div>
        );
      })}
    </div>
  );
}
