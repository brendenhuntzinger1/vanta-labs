"use client";

import Link from "next/link";
import { useState } from "react";
import { useCart } from "@/components/cart-context";

export function SiteHeader() {
  const { itemCount, openCart } = useCart();
  const displayItemCount = itemCount;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navLinks = [
    { href: "/products", label: "Products" },
    { href: "/coa-library", label: "COA Library" },
    { href: "/cart", label: "Cart" },
    { href: "/checkout", label: "Checkout" },
    { href: "/partner", label: "Partner Program" },
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-white/20 bg-zinc-900/62 backdrop-blur-2xl">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.15),transparent_38%,transparent_62%,rgba(255,255,255,0.15))]" />
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" className="vl-focus-ring relative truncate text-sm font-semibold tracking-[0.25em] text-white sm:text-base sm:tracking-[0.32em]" onClick={() => setMobileNavOpen(false)}>
          VANTA LABS
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-zinc-300 md:flex">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="vl-focus-ring relative transition hover:text-white after:absolute after:-bottom-1 after:left-0 after:h-px after:w-0 after:bg-white/80 after:transition-all hover:after:w-full">
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openCart}
            id="site-cart-trigger"
            aria-label={`Open cart with ${displayItemCount} items`}
            className="vl-btn-secondary vl-focus-ring inline-flex items-center gap-2 px-3 py-2 text-xs sm:px-4 sm:text-sm"
          >
            <span className="text-sm sm:text-base">🛒</span>
            <span>Cart</span>
            <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white" aria-live="polite">
              {displayItemCount}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMobileNavOpen((open) => !open)}
            className="vl-btn-secondary vl-focus-ring inline-flex h-10 w-10 items-center justify-center text-zinc-100 md:hidden"
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
          >
            <span className="text-base">{mobileNavOpen ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {mobileNavOpen ? (
        <nav className="border-t border-white/10 bg-zinc-950/95 px-4 py-3 md:hidden">
          <div className="mx-auto flex max-w-7xl flex-col gap-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileNavOpen(false)}
                className="vl-panel-soft vl-focus-ring px-4 py-3 text-sm text-zinc-200 transition hover:border-white/25 hover:text-white"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      ) : null}
    </header>
  );
}
