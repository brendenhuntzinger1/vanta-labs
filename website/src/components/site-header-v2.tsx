"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCart } from "@/components/cart-context";

const NAV_LINKS = [
  { href: "/products", label: "Products" },
  { href: "/membership", label: "Membership" },
  { href: "/coa-library", label: "COA Library" },
  { href: "/research", label: "Research" },
  { href: "/partner", label: "Partner Program" },
  { href: "/contact", label: "Contact us" },
];

function CartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <circle cx="9" cy="21" r="1" />
      <circle cx="18" cy="21" r="1" />
      <path d="M2.5 3h2l2.2 12.2a2 2 0 0 0 2 1.65h8.1a2 2 0 0 0 2-1.62L21 8H6" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5" />
    </svg>
  );
}

export function SiteHeaderV2() {
  const { itemCount, openCart } = useCart();
  const pathname = usePathname();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 24);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

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
    <header className="vl2-nav" data-scrolled={scrolled}>
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-6 py-5 lg:px-12">
        <Link href="/" className="vl-focus-ring vl2-serif text-lg tracking-[0.08em] text-white" onClick={() => setMobileNavOpen(false)}>
          VANTA LABS
        </Link>

        <nav className="hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? "page" : undefined}
              className="vl-focus-ring text-[0.72rem] font-medium uppercase tracking-[0.16em] text-white/75 transition hover:text-white"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <form onSubmit={handleSearchSubmit} className="hidden items-center lg:flex">
            <div className={`flex items-center overflow-hidden transition-[width] duration-300 ${searchOpen ? "w-48" : "w-0"}`}>
              <input
                ref={searchInputRef}
                type="search"
                aria-label="Search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                onBlur={() => {
                  if (!searchValue.trim()) setSearchOpen(false);
                }}
                placeholder="Search"
                tabIndex={searchOpen ? 0 : -1}
                aria-hidden={!searchOpen}
                className="w-full border-b border-white/25 bg-transparent px-1 py-1.5 text-sm text-white placeholder:text-white/40 focus:outline-none"
              />
            </div>
            <button
              type={searchOpen ? "submit" : "button"}
              onClick={() => {
                if (!searchOpen) setSearchOpen(true);
              }}
              aria-label="Search products"
              className="vl-focus-ring inline-flex h-9 w-9 items-center justify-center text-white/80 transition hover:text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
            </button>
          </form>

          <Link href="/account" aria-label="Your account" className="vl-focus-ring inline-flex h-9 w-9 items-center justify-center text-white/80 transition hover:text-white">
            <AccountIcon />
          </Link>

          <button
            type="button"
            onClick={openCart}
            id="site-cart-trigger"
            aria-label={`Open cart with ${itemCount} items`}
            className="vl-focus-ring relative inline-flex h-9 w-9 items-center justify-center text-white/80 transition hover:text-white"
          >
            <CartIcon />
            {itemCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-semibold text-black" aria-live="polite">
                {itemCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setMobileNavOpen((open) => !open)}
            className="vl-focus-ring inline-flex h-9 w-9 items-center justify-center text-white/80 lg:hidden"
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
          >
            <span className="text-base">{mobileNavOpen ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {mobileNavOpen ? (
        <nav className="border-t border-white/10 bg-black/95 px-6 py-6 backdrop-blur-2xl lg:hidden">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileNavOpen(false)}
                className="vl-focus-ring rounded-lg px-3 py-3 text-sm uppercase tracking-[0.12em] text-white/85 transition hover:bg-white/5 hover:text-white"
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
