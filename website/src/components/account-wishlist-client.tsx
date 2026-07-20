"use client";

import { useCart } from "@/components/cart-context";
import { ProductCard } from "@/components/product-card";
import type { Product } from "@/lib/catalog-types";

export function AccountWishlistClient({ products }: { products: Product[] }) {
  const { addToCart } = useCart();

  if (products.length === 0) {
    return (
      <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-400">
        Nothing saved yet. Tap the heart icon on any product to add it here.
      </section>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((product) => (
        <ProductCard
          key={product.slug}
          product={product}
          image={product.image}
          initialInWishlist
          onAddToCart={(event) => addToCart(product, 1, event.currentTarget)}
        />
      ))}
    </div>
  );
}
