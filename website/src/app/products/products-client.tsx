"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ProductCard } from "@/components/product-card";
import { useCart } from "@/components/cart-context";
import type { Product } from "@/lib/catalog-types";
import { CatalogTrustRail } from "@/components/catalog-trust-rail";
import { hasCoa } from "@/lib/coa-url";

type SortKey = "default" | "price-asc" | "price-desc" | "name-asc" | "purity";

// shortLabel is for the phone, where the select shares a row with the Filters
// button -- "Best Sellers First" truncated to "Best Sellers Firs" there.
const SORT_OPTIONS: Array<{ value: SortKey; label: string; shortLabel: string }> = [
  { value: "default", label: "Best Sellers First", shortLabel: "Best Sellers" },
  { value: "price-asc", label: "Price: Low to High", shortLabel: "Price ↑" },
  { value: "price-desc", label: "Price: High to Low", shortLabel: "Price ↓" },
  { value: "name-asc", label: "Name: A to Z", shortLabel: "Name A–Z" },
  { value: "purity", label: "Purity: Highest", shortLabel: "Purity" },
];

function parsePrice(price: string) {
  return Number(price.replace(/[^0-9.]/g, "")) || 0;
}

function parsePurity(purity?: string) {
  return Number((purity ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

function ProductsPageContent() {
  const searchParams = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [sort, setSort] = useState<SortKey>("default");
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("search") ?? "");
  const [selectedCategory, setSelectedCategory] = useState(() => searchParams.get("category") ?? "All");
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [stockFilter, setStockFilter] = useState(false);
  const [bestSellersOnly, setBestSellersOnly] = useState(false);
  const { addToCart } = useCart();

  // Re-sync filters from the URL when it changes (header search, a homepage
  // category link) without clobbering in-progress on-page filter edits.
  // Adjusting state during render, per React's guidance, instead of an
  // effect: https://react.dev/learn/you-might-not-need-an-effect
  const searchParamsKey = searchParams.toString();
  const [lastSearchParamsKey, setLastSearchParamsKey] = useState(searchParamsKey);
  if (searchParamsKey !== lastSearchParamsKey) {
    setLastSearchParamsKey(searchParamsKey);
    const paramSearch = searchParams.get("search");
    if (paramSearch !== null) {
      setSearchQuery(paramSearch);
    }
    const paramCategory = searchParams.get("category");
    if (paramCategory !== null) {
      setSelectedCategory(paramCategory);
    }
  }

  useEffect(() => {
    fetch("/product-images.json")
      .then((response) => response.json())
      .then((data) => setImageOverrides(data))
      .catch(() => setImageOverrides({}));
  }, []);

  useEffect(() => {
    fetch("/api/catalog/products", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (json?.success && Array.isArray(json.products)) {
          setProducts(json.products as Product[]);
          setLoadError(false);
        } else {
          setProducts([]);
          setLoadError(true);
        }
      })
      .catch(() => {
        // Distinguish a real load failure from an empty catalog so the page can
        // show a retry instead of a misleading "no products" state.
        setProducts([]);
        setLoadError(true);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const categories = useMemo(() => {
    const productCategories = Array.from(new Set(products.map((product) => product.category))).sort();
    return ["All", ...productCategories];
  }, [products]);

  // Only surface the Best Sellers tab when there actually are best sellers.
  // isBestSeller is computed from real sales (units sold), so this stays current
  // automatically as buying patterns change.
  const hasBestSellers = useMemo(
    () => products.some((product) => product.isBestSeller),
    [products],
  );

  const visibleProducts = useMemo(() => {
    let result = [...products];

    if (selectedCategory !== "All") {
      result = result.filter((product) => product.category === selectedCategory);
    }

    if (bestSellersOnly) {
      result = result.filter((product) => product.isBestSeller);
    }

    if (stockFilter) {
      result = result.filter((product) => product.stockStatus === "In Stock" || product.stockStatus === "Limited");
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      result = result.filter((product) => {
        const doseMatch = (product.doses ?? []).some(
          (dose) =>
            (dose.sku ?? "").toLowerCase().includes(query) ||
            (dose.batchNumber ?? "").toLowerCase().includes(query) ||
            (dose.label ?? "").toLowerCase().includes(query),
        );
        return (
          product.name.toLowerCase().includes(query) ||
          product.category.toLowerCase().includes(query) ||
          product.description.toLowerCase().includes(query) ||
          (product.batchNumber ?? "").toLowerCase().includes(query) ||
          doseMatch
        );
      });
    }

    switch (sort) {
      case "price-asc":
        result.sort((a, b) => parsePrice(a.price) - parsePrice(b.price));
        break;
      case "price-desc":
        result.sort((a, b) => parsePrice(b.price) - parsePrice(a.price));
        break;
      case "name-asc":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "purity":
        result.sort((a, b) => parsePurity(b.purityResult) - parsePurity(a.purityResult));
        break;
      case "default":
      default:
        // Best sellers rise to the top; everything else keeps its catalog
        // order (the sort is stable, so ties stay in position order).
        result.sort((a, b) => {
          const aRank = a.isBestSeller ? 0 : 1;
          const bRank = b.isBestSeller ? 0 : 1;
          return aRank - bRank;
        });
        break;
    }

    return result;
  }, [products, searchQuery, selectedCategory, stockFilter, bestSellersOnly, sort]);

  // One number drives the mobile Filters badge and whether the desktop chip
  // rail renders at all, so the two can never disagree about "is anything on".
  const activeFilterCount =
    (selectedCategory !== "All" ? 1 : 0) +
    (searchQuery.trim() ? 1 : 0) +
    (stockFilter ? 1 : 0) +
    (bestSellersOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSelectedCategory("All");
    setSearchQuery("");
    setStockFilter(false);
    setBestSellersOnly(false);
  };

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="vl-nav-clearance vl-catalog-ground mx-auto max-w-[1440px] px-4 sm:px-6 pb-14 pt-16 sm:pb-20 sm:pt-32 lg:px-12">
        {/* The catalogue header carries the quality claim, so it gets the one
            piece of real emphasis on this page. The glow is a wide, very low
            opacity champagne radial behind the type -- it reads as light on a
            dark surface rather than as a coloured block, which is what keeps it
            expensive next to the vial photography below. */}
        <header className="vl-catalog-header relative max-w-3xl">
          <p className="vl2-eyebrow relative">Vanta Labs Catalog</p>

          {/* Sans display, matching the wordmark directly above it. The
              Cormorant serif read as editorial on a page whose job is to sell
              laboratory supply; its own tracking is set in .vl2-display, so the
              override here is dropped rather than fighting it. */}
          <h1 className="vl2-serif vl-catalog-title relative mt-2.5 text-[2.35rem] leading-[1.06] sm:mt-3 sm:text-[3.6rem] sm:leading-[1.02] lg:text-[4.25rem]">
            Premium Research Peptides
          </h1>

          {/* The rule sits ABOVE the copy rather than beside it. As a hanging
              element it indented the paragraph, making it the only thing on the
              page not aligned to the headline and the chips below. */}
          <span aria-hidden="true" className="vl-catalog-rule relative mt-6 hidden h-px w-14 sm:block" />

          {/* The explanatory paragraph and the three-claim line that used to sit
              here are gone. The trust rail carries the same meaning in a
              fraction of the height, and the opening reads as a catalogue
              rather than an About page. The rail itself now renders BELOW the
              product grid — see the note there — so nothing but the title and
              the filters stands between a visitor and something to buy. */}
        </header>


        {/* THE COUPON BANNER THAT WAS HERE MOVED TO THE TOP OF THE PAGE.
            StorefrontOffersBar (rendered in the root layout) now carries every
            live offer, including this coupon. Keeping this copy as well put the
            same headline and the same code twice in one phone viewport, a few
            hundred pixels apart. One offer, stated once, at the top. */}

        {/* ONE BAR.
            This was a search field, a category dropdown, a duplicate row of
            category chips, a Best Sellers toggle, an In Stock toggle and a
            chip rail -- six controls competing before a single product was
            visible. Desktop now gets a single horizontal row; the phone gets a
            search field and one Filters button that carries a count. */}
        <section className="mt-10">
          <div className="flex flex-col gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-2.5 backdrop-blur-xl sm:flex-row sm:items-center sm:gap-2 sm:p-2">
            <label className="relative flex-1">
              <span className="sr-only">Search products</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="pointer-events-none absolute left-3.5 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-white/30">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
              </svg>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search compounds"
                className="h-11 w-full rounded-xl border border-white/[0.07] bg-black/25 pl-10 pr-3 text-[16px] text-white placeholder:text-white/30 outline-none transition-colors duration-200 focus:border-[color:var(--accent-gold)]/45 focus:bg-black/40 sm:text-sm"
              />
            </label>

            {/* Desktop controls */}
            <div className="hidden items-center gap-2 sm:flex">
              <select
                value={selectedCategory}
                aria-label="Filter by category"
                onChange={(event) => setSelectedCategory(event.target.value)}
                className="vl-filter-select h-11 rounded-xl border border-white/[0.07] bg-black/25 pl-3.5 pr-9 text-sm text-white outline-none transition-colors duration-200 focus:border-[color:var(--accent-gold)]/45"
              >
                {categories.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>

              <select
                value={sort}
                aria-label="Sort products"
                onChange={(event) => setSort(event.target.value as SortKey)}
                className="vl-filter-select h-11 rounded-xl border border-white/[0.07] bg-black/25 pl-3.5 pr-9 text-sm text-white outline-none transition-colors duration-200 focus:border-[color:var(--accent-gold)]/45"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>

              {hasBestSellers ? (
                <button
                  type="button"
                  aria-pressed={bestSellersOnly}
                  onClick={() => setBestSellersOnly((prev) => !prev)}
                  className={`vl-filter-toggle h-11 ${bestSellersOnly ? "is-on" : ""}`}
                >
                  Best Sellers
                </button>
              ) : null}

              <button
                type="button"
                aria-pressed={stockFilter}
                onClick={() => setStockFilter((prev) => !prev)}
                className={`vl-filter-toggle h-11 ${stockFilter ? "is-on" : ""}`}
              >
                In Stock
              </button>
            </div>

            {/* Mobile controls — sort stays inline because it is the one
                control people reach for constantly; everything else collapses. */}
            <div className="grid grid-cols-2 gap-2 sm:hidden">
              <button
                type="button"
                onClick={() => setFiltersOpen(true)}
                aria-expanded={filtersOpen}
                className="vl-filter-toggle h-11 justify-center gap-2"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-4 w-4">
                  <path d="M3 6h18M6 12h12M10 18h4" />
                </svg>
                Filters
                {activeFilterCount > 0 ? (
                  <span className="ml-0.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[color:var(--accent-gold)]/20 px-1.5 text-[11px] font-semibold text-[color:var(--accent-gold)]">
                    {activeFilterCount}
                  </span>
                ) : null}
              </button>
              <select
                value={sort}
                aria-label="Sort products"
                onChange={(event) => setSort(event.target.value as SortKey)}
                className="vl-filter-select h-11 w-full rounded-xl border border-white/[0.07] bg-black/25 pl-3.5 pr-9 text-[16px] text-white outline-none"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.shortLabel}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Active filters, desktop only. On a phone the count on the Filters
              button already says this, and a chip rail would push the products
              below the fold again. */}
          {activeFilterCount > 0 ? (
            <div className="mt-3 hidden flex-wrap items-center gap-2 sm:flex">
              {bestSellersOnly ? (
                <button type="button" onClick={() => setBestSellersOnly(false)} className="vl-filter-chip">Best Sellers<span aria-hidden="true">×</span></button>
              ) : null}
              {selectedCategory !== "All" ? (
                <button type="button" onClick={() => setSelectedCategory("All")} className="vl-filter-chip">{selectedCategory}<span aria-hidden="true">×</span></button>
              ) : null}
              {searchQuery.trim() ? (
                <button type="button" onClick={() => setSearchQuery("")} className="vl-filter-chip">&ldquo;{searchQuery}&rdquo;<span aria-hidden="true">×</span></button>
              ) : null}
              {stockFilter ? (
                <button type="button" onClick={() => setStockFilter(false)} className="vl-filter-chip">In Stock<span aria-hidden="true">×</span></button>
              ) : null}
              <button type="button" onClick={clearAllFilters} className="ml-1 text-[11px] uppercase tracking-[0.16em] text-white/40 transition-colors hover:text-white">
                Clear all
              </button>
            </div>
          ) : null}
        </section>

        {/* Mobile filter drawer */}
        {filtersOpen ? (
          <div className="fixed inset-0 z-[70] sm:hidden">
            <button
              type="button"
              aria-label="Close filters"
              onClick={() => setFiltersOpen(false)}
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            />
            <div className="vl-filter-sheet absolute inset-x-0 bottom-0 rounded-t-[22px] p-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
              <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-white/15" />
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-white">Filters</h2>
                <button type="button" onClick={clearAllFilters} className="text-[11px] uppercase tracking-[0.16em] text-white/40 transition-colors hover:text-white">
                  Clear all
                </button>
              </div>

              <p className="mt-5 text-[11px] uppercase tracking-[0.18em] text-white/35">Category</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setSelectedCategory(category)}
                    className={`vl-filter-toggle h-10 ${selectedCategory === category ? "is-on" : ""}`}
                  >
                    {category}
                  </button>
                ))}
              </div>

              <p className="mt-6 text-[11px] uppercase tracking-[0.18em] text-white/35">Show</p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {hasBestSellers ? (
                  <button type="button" aria-pressed={bestSellersOnly} onClick={() => setBestSellersOnly((prev) => !prev)} className={`vl-filter-toggle h-10 ${bestSellersOnly ? "is-on" : ""}`}>
                    Best Sellers
                  </button>
                ) : null}
                <button type="button" aria-pressed={stockFilter} onClick={() => setStockFilter((prev) => !prev)} className={`vl-filter-toggle h-10 ${stockFilter ? "is-on" : ""}`}>
                  In Stock
                </button>
              </div>

              <button type="button" onClick={() => setFiltersOpen(false)} className="vl2-btn-primary vl-focus-ring mt-7 w-full px-6 py-3.5 text-sm">
                Show {visibleProducts.length} product{visibleProducts.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        ) : null}

        <section className="mt-8">
          <div className="mb-5 flex items-center justify-between">
            <p className="text-sm text-white/45">
              {isLoading ? "Loading catalog…" : `${visibleProducts.length} product${visibleProducts.length === 1 ? "" : "s"}`}
            </p>
            {/* Clearing lives with the active-filter chips above and, on a
                phone, inside the drawer. A third copy here was noise. */}
          </div>

          {isLoading ? (
            <CatalogGridSkeleton />
          ) : loadError ? (
            <div className="border border-white/10 p-10 text-center">
              <h2 className="vl2-serif text-xl text-white">We couldn&apos;t load the catalog</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-white/55">
                Something went wrong reaching our servers. This is usually temporary — please try again.
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="vl2-btn-primary vl-focus-ring mt-6 px-5 py-2.5 text-sm"
              >
                Try again
              </button>
            </div>
          ) : visibleProducts.length === 0 ? (
            <div className="border border-white/10 p-10 text-center">
              <h2 className="vl2-serif text-xl text-white">No products matched your filters</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-white/55">
                Try a broader category or reset your search terms. The catalog updates as new batches are published.
              </p>
              <button
                type="button"
                onClick={clearAllFilters}
                className="vl2-btn-secondary vl-focus-ring mt-6 px-5 py-2.5 text-sm"
              >
                Reset Filters
              </button>
            </div>
          ) : (
            // Each card titles itself with an h3. Without a section heading
            // between them and the page h1, the outline jumps h1 → h3, and a
            // screen reader navigating by heading loses the grouping.
            <section aria-labelledby="catalog-grid-heading">
            <h2 id="catalog-grid-heading" className="sr-only">Products</h2>
            <div className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-4">
              {visibleProducts.map((product) => {
                const productImage = imageOverrides[product.slug] || product.coverImage || product.image;
                return (
                  <ProductCard
                    key={product.slug}
                    product={product}
                    image={productImage}
                    onAddToCart={(event) => addToCart(product, 1, event.currentTarget)}
                  />
                );
              })}
            </div>
            </section>
          )}
        </section>

        {/* THE TRUST RAIL SITS BELOW THE GRID, NOT IN FRONT OF IT.
            It used to be the last thing between a visitor and the products.
            On a phone that cost 102px of the only screen they see: measured
            2026-08-28 at 375x548 and 393x664, the first product card sat at
            y=733 with the rail above it. Every in-app visitor lands here —
            the age gate sends them, because the hero cannot play in a social
            WebView — so this page opening with nothing to buy on screen was
            the whole storefront opening that way.

            The copy is unchanged and still reads: "should I trust these
            people" is a better question once the visitor has found something
            worth asking it about. */}
        {/* The COA claim is decided by the catalogue that actually loaded, not
            hard-coded. See catalogTrustRail() — the coverage wording appears
            only when every product on the page has a document.

            Deliberately conservative in two ways. An empty/loading list is not
            treated as coverage, and `coaUrl` does not see a COA that exists
            only as a `coa_records` row, so the rail can under-claim but never
            over-claim. Under-claiming costs a weaker word; over-claiming is an
            unsupported testing statement on every catalogue page. */}
        <CatalogTrustRail
          everyProductHasCoa={products.length > 0 && products.every((product) => hasCoa(product.coaUrl))}
        />
      </main>
    </div>
  );
}

/**
 * The eight-card loading grid. Shared by the Suspense fallback below and by the
 * component's own `isLoading` state so the two can never drift into showing
 * different things at the same moment in the same load.
 */
function CatalogGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="animate-pulse border border-white/10">
          <div className="aspect-square border-b border-white/10 bg-white/5" />
          <div className="space-y-3 p-5">
            <div className="h-3 w-24 bg-white/10" />
            <div className="h-5 w-3/4 bg-white/12" />
            <div className="h-3 w-full bg-white/10" />
            <div className="h-3 w-2/3 bg-white/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * SERVER-RENDERED PLACEHOLDER — this is what fixes the catalog "jumping".
 *
 * ProductsPageContent calls useSearchParams(), which opts it out of
 * server-rendering: Next renders THIS fallback into the HTML instead. It used
 * to be `null`, so the catalog page shipped an empty body — the footer landed
 * at the top of the viewport, and then everything slammed down when the client
 * fetch resolved. Measured cumulative layout shift was 1.04 on a phone and
 * 0.61 on desktop, where anything above 0.25 is classed "poor". It is the most
 * visible instability on the site.
 *
 * The fallback therefore reserves the same space the real page occupies. The
 * header block is a fixed-height spacer rather than a copy of the real
 * catalogue header: duplicating that copy would guarantee it drifts out of
 * sync, and it is replaced within a frame of hydration anyway.
 *
 * The site nav is `position: fixed` (out of flow), so it is deliberately not
 * repeated here — including it would change nothing about the layout.
 */
function CatalogFallback() {
  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <main className="vl-nav-clearance mx-auto max-w-[1440px] px-4 sm:px-6 pb-14 pt-16 sm:pb-20 sm:pt-32 lg:px-12">
        {/* Stands in for the catalogue header + filter row. */}
        <div className="h-[13.5rem] sm:h-[15.5rem]" aria-hidden="true" />
        <section className="mt-8">
          <div className="mb-5 h-5" aria-hidden="true" />
          <CatalogGridSkeleton />
        </section>
      </main>
    </div>
  );
}

export function ProductsPageClient() {
  return (
    <Suspense fallback={<CatalogFallback />}>
      <ProductsPageContent />
    </Suspense>
  );
}
