"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCart } from "@/components/cart-context";

const NAV_LINKS = [
  { href: "/products", label: "Products" },
  { href: "/membership", label: "Membership" },
  { href: "/wholesale", label: "Wholesale" },
  { href: "/partner", label: "Partner Program" },
  { href: "/contact", label: "Contact us" },
  { href: "/coa-library", label: "COA Library" },
];

// One treatment for every link. Membership used to sit in a filled white pill
// and COA Library was dimmed to a "quiet reference"; both were asked to match
// their neighbours, so the row now has no per-link styling at all.
const DESKTOP_LINK_CLASS =
  "vl-focus-ring rounded-full px-3.5 py-2 text-[0.72rem] font-medium uppercase tracking-[0.16em] text-white/75 transition hover:text-white";
const MOBILE_LINK_CLASS =
  "vl-focus-ring flex min-h-[44px] items-center rounded-lg px-3 py-3 text-sm uppercase tracking-[0.12em] text-white/85 transition hover:bg-white/5 hover:text-white";

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

  // Lock the page behind the open mobile menu so the body doesn't scroll under
  // it, and let Escape close it (keyboard users can dismiss without tabbing to
  // the toggle).
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileNavOpen]);

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const query = searchValue.trim();
    router.push(query ? `/products?search=${encodeURIComponent(query)}` : "/products");
    setSearchOpen(false);
    setMobileNavOpen(false);
  };

  // Match the exact page and any sub-page (e.g. /products/bpc-157 highlights
  // Products). None of the nav hrefs are the home route, so prefix matching
  // never over-highlights.
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // Somewhere to go back TO, and somewhere worth leaving. The home page is the
  // root of the site, so a back control there would only take a visitor out of
  // it — which in an app's browser means back to the feed. history.length is
  // the only signal available for "this tab has been somewhere else"; it is
  // read after mount so the server and client agree on the first render.
  const [hasHistory, setHasHistory] = useState(false);
  useEffect(() => {
    // Next frame, so this is not a synchronous setState inside the effect body.
    const id = requestAnimationFrame(() => setHasHistory(window.history.length > 1));
    return () => cancelAnimationFrame(id);
  }, [pathname]);
  const canGoBack = hasHistory && pathname !== "/";

  return (
    <header className="vl2-nav" data-scrolled={scrolled}>
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6 sm:py-5 lg:px-12">
        <div className="flex items-center gap-1">
          {/* OUR OWN BACK CONTROL.
              An app's embedded browser gives the page no browser UI worth
              using — TikTok's chrome offers a back arrow that leaves the site
              entirely, and there is no in-page way to retrace a step. A
              visitor who opens a product from the catalog can get stuck there.
              Shown only when there is somewhere to go back to, and only below
              lg where the full navigation row is hidden. */}
          {canGoBack ? (
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(false);
                router.back();
              }}
              aria-label="Go back"
              className="vl-focus-ring -ml-1 inline-flex h-11 w-9 items-center justify-center text-white/70 transition hover:text-white lg:hidden"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          ) : null}
          <Link href="/" className="vl-focus-ring vl2-serif text-lg tracking-[0.08em] text-white" onClick={() => setMobileNavOpen(false)}>
            VANTA LABS
          </Link>
        </div>

        <nav className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? "page" : undefined}
              className={DESKTOP_LINK_CLASS}
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
                className="w-full border-b border-white/25 bg-transparent px-1 py-1.5 text-sm text-white placeholder:text-white/70 focus:outline-none"
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

          <Link href="/account" aria-label="Your account" className="vl-focus-ring inline-flex h-10 w-10 items-center justify-center text-white/80 transition hover:text-white">
            <AccountIcon />
          </Link>

          <button
            type="button"
            onClick={openCart}
            id="site-cart-trigger"
            aria-label={`Open cart with ${itemCount} items`}
            className="vl-focus-ring relative inline-flex h-10 w-10 items-center justify-center text-white/80 transition hover:text-white"
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
            className="vl-focus-ring inline-flex h-10 w-10 items-center justify-center text-white/80 lg:hidden"
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
          >
            <span className="text-base">{mobileNavOpen ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {mobileNavOpen ? (
        <nav className="max-h-[calc(100svh-64px)] overflow-y-auto border-t border-white/10 bg-black/95 px-4 py-5 backdrop-blur-2xl lg:hidden">
          <form onSubmit={handleSearchSubmit} className="mb-4 flex items-center gap-2">
            <input
              type="search"
              aria-label="Search products"
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder="Search products"
              className="vl-input min-w-0 flex-1 px-3 py-3 text-white placeholder:text-white/70"
            />
            <button type="submit" aria-label="Search" className="vl2-btn-secondary vl-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
            </button>
          </form>
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileNavOpen(false)}
                aria-current={isActive(link.href) ? "page" : undefined}
                className={MOBILE_LINK_CLASS}
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/account"
              onClick={() => setMobileNavOpen(false)}
              className="vl-focus-ring mt-1 flex min-h-[44px] items-center gap-2 rounded-lg border-t border-white/10 px-3 pt-4 text-sm uppercase tracking-[0.12em] text-white/85 transition hover:text-white"
            >
              <AccountIcon /> Your account
            </Link>
          </div>
        </nav>
      ) : null}
    </header>
  );
}
