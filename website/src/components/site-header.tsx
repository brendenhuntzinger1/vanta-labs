"use client";

import Link from "next/link";
import { useCart } from "@/components/cart-context";

export function SiteHeader() {
  const { itemCount, openCart } = useCart();
  const displayItemCount = itemCount;

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
        <Link href="/" className="text-lg font-semibold tracking-[0.35em] text-white">
          VANTA LABS
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-zinc-300 md:flex">
          <Link href="/products" className="transition hover:text-white">
            Products
          </Link>
          <Link href="/coa-library" className="transition hover:text-white">
            COA Library
          </Link>
          <Link href="/cart" className="transition hover:text-white">
            Cart
          </Link>
          <Link href="/checkout" className="transition hover:text-white">
            Checkout
          </Link>
          <Link href="/ambassador" className="transition hover:text-white">
            Ambassador
          </Link>
        </nav>
        <button
          type="button"
          onClick={openCart}
          className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800"
        >
          <span className="mr-2 text-base">🛒</span>
          Cart ({displayItemCount})
        </button>
      </div>
    </header>
  );
}
