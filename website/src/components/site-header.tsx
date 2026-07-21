"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCart } from "@/components/cart-context";

const SHOP_LINKS = [
  { href: "/products", label: "All Products", detail: "Full research catalog" },
  { href: "/coa-library", label: "COA Library", detail: "Certificates of analysis" },
];

const PRIMARY_LINKS = [
  { href: "/membership", label: "Membership" },
  { href: "/partner", label: "Partner Program" },
  { href: "/ambassador", label: "Ambassador" },
  { href: "/contact", label: "Contact" },
];

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function SiteHeader() {
  const { itemCount, openCart } = useCart();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [shopMenuOpen, setShopMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const shopMenuRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!shopMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (shopMenuRef.current && !shopMenuRef.current.contains(event.target as Node)) {
        setShopMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [shopMenuOpen]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const query = searchValue.trim();
    router.push(query ? `/products?search=${encodeURIComponent(query)}` : "/products");
    setSearchOpen(false);
    setMobileNavOpen(false);
  };

  const isActive = (href: string) => pathname === href;

  return (
    <header className="sticky top-0 z-50 border-b border-white/12 bg-black/80 backdrop-blur-2xl">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.1),transparent_38%,transparent_62%,rgba(255,255,255,0.14))]" />
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="vl-focus-ring vl-display relative truncate text-sm font-semibold tracking-[0.25em] text-white sm:text-base sm:tracking-[0.32em]"
          onClick={() => setMobileNavOpen(false)}
        >
          Vanta Labs
        </Link>

        <nav className="hidden items-center gap-7 text-sm md:flex">
          <div ref={shopMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setShopMenuOpen((open) => !open)}
              className="vl-nav-link vl-focus-ring flex items-center gap-1.5 py-2"
              aria-expanded={shopMenuOpen}
              aria-haspopup="true"
            >
              Shop
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 transition-transform ${shopMenuOpen ? "rotate-180" : ""}`}>
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {shopMenuOpen ? (
              <div className="vl-panel absolute left-0 top-full mt-2 w-64 rounded-2xl p-2">
                {SHOP_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setShopMenuOpen(false)}
                    className="vl-focus-ring block rounded-xl px-3 py-2.5 transition hover:bg-white/8"
                  >
                    <span className="block text-sm font-medium text-zinc-100">{link.label}</span>
                    <span className="block text-xs text-zinc-500">{link.detail}</span>
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          {PRIMARY_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? "page" : undefined}
              className="vl-nav-link vl-focus-ring py-2"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <form onSubmit={handleSearchSubmit} className="hidden items-center sm:flex">
            <div className={`flex items-center overflow-hidden transition-[width] duration-300 ${searchOpen ? "w-52" : "w-0"}`}>
              <input
                ref={searchInputRef}
                type="search"
                aria-label="Search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                onBlur={() => {
                  if (!searchValue.trim()) setSearchOpen(false);
                }}
                placeholder="Search compounds…"
                className="vl-search-input w-full px-4 py-2 text-sm"
              />
            </div>
            <button
              type={searchOpen ? "submit" : "button"}
              onClick={() => {
                if (!searchOpen) setSearchOpen(true);
              }}
              aria-label="Search products"
              className="vl-btn-secondary vl-focus-ring inline-flex h-10 w-10 items-center justify-center"
            >
              <SearchIcon />
            </button>
          </form>

          <Link
            href="/account"
            aria-label="Your account"
            className="vl-btn-secondary vl-focus-ring inline-flex h-10 w-10 items-center justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <circle cx="12" cy="8" r="3.5" />
              <path d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5" />
            </svg>
          </Link>
          <button
            type="button"
            onClick={openCart}
            id="site-cart-trigger"
            aria-label={`Open cart with ${itemCount} items`}
            className="vl-btn-secondary vl-focus-ring inline-flex items-center gap-2 px-3 py-2 text-xs sm:px-4 sm:text-sm"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <circle cx="9" cy="21" r="1.2" />
              <circle cx="18" cy="21" r="1.2" />
              <path d="M2.5 3h2l2.2 12.2a2 2 0 0 0 2 1.65h8.1a2 2 0 0 0 2-1.62L21 8H6" />
            </svg>
            <span className="hidden sm:inline">Cart</span>
            <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white" aria-live="polite">
              {itemCount}
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
        <nav className="border-t border-white/10 bg-black/95 px-4 py-4 md:hidden">
          <div className="mx-auto flex max-w-7xl flex-col gap-4">
            <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
              <input
                type="search"
                aria-label="Search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Search compounds…"
                className="vl-search-input w-full px-4 py-2.5 text-sm"
              />
              <button type="submit" aria-label="Search" className="vl-btn-secondary vl-focus-ring inline-flex h-10 w-10 flex-shrink-0 items-center justify-center">
                <SearchIcon />
              </button>
            </form>

            <div className="flex flex-col gap-2">
              <p className="vl-eyebrow px-2 text-[10px] text-zinc-500">Shop</p>
              {SHOP_LINKS.map((link) => (
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

            <div className="flex flex-col gap-2">
              <Link
                href="/account"
                onClick={() => setMobileNavOpen(false)}
                className="vl-panel-soft vl-focus-ring px-4 py-3 text-sm text-zinc-200 transition hover:border-white/25 hover:text-white"
              >
                Account
              </Link>
              {PRIMARY_LINKS.map((link) => (
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
          </div>
        </nav>
      ) : null}
    </header>
  );
}
