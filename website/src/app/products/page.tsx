"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ProductCard } from "@/components/product-card";
import { useCart } from "@/components/cart-context";
import type { Product } from "@/lib/catalog-types";

type SortKey = "default" | "price-asc" | "price-desc" | "name-asc" | "purity";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "default", label: "Featured" },
  { value: "price-asc", label: "Price: Low to High" },
  { value: "price-desc", label: "Price: High to Low" },
  { value: "name-asc", label: "Name: A to Z" },
  { value: "purity", label: "Purity: Highest" },
];

function parsePrice(price: string) {
  return Number(price.replace(/[^0-9.]/g, "")) || 0;
}

function parsePurity(purity?: string) {
  return Number((purity ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

function ProductsPageContent() {
  const searchParams = useSearchParams();
  const [products, setProducts] = useState<Product[]>([]);
  const [sort, setSort] = useState<SortKey>("default");
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("search") ?? "");
  const [selectedCategory, setSelectedCategory] = useState(() => searchParams.get("category") ?? "All");
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [stockFilter, setStockFilter] = useState(false);
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
        } else {
          setProducts([]);
        }
      })
      .catch(() => setProducts([]))
      .finally(() => setIsLoading(false));
  }, []);

  const categories = useMemo(() => {
    const productCategories = Array.from(new Set(products.map((product) => product.category))).sort();
    return ["All", ...productCategories];
  }, [products]);

  const visibleProducts = useMemo(() => {
    let result = [...products];

    if (selectedCategory !== "All") {
      result = result.filter((product) => product.category === selectedCategory);
    }

    if (stockFilter) {
      result = result.filter((product) => product.stockStatus === "In Stock" || product.stockStatus === "Limited");
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      result = result.filter((product) => {
        return (
          product.name.toLowerCase().includes(query) ||
          product.category.toLowerCase().includes(query) ||
          product.description.toLowerCase().includes(query)
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
        break;
    }

    return result;
  }, [products, searchQuery, selectedCategory, stockFilter, sort]);

  return (
    <div className="vl-page-shell min-h-screen text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(10,10,10,0.95),rgba(20,20,20,0.9))] px-5 py-10 sm:px-8 sm:py-12">
          <div className="pointer-events-none absolute inset-0 vl-grid-overlay" />
          <div className="pointer-events-none absolute -right-20 -top-20 h-60 w-60 rounded-full bg-white/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 left-[30%] h-52 w-52 rounded-full bg-white/10 blur-3xl" />

          <div className="relative max-w-3xl">
            <p className="vl-eyebrow text-[11px]">Vanta Labs Catalog</p>
            <h1 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Research Storefront</h1>
            <p className="vl-copy mt-4 text-base leading-8 text-zinc-300 sm:text-lg">
              Explore documented compounds with transparent purity records, mapped lot metadata, and streamlined fulfillment.
            </p>
          </div>
        </section>

        <section className="sticky top-[68px] z-40 mt-6 rounded-2xl border border-white/10 bg-zinc-950/82 p-3 backdrop-blur-xl sm:p-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto]">
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search compounds, categories, or notes"
              className="vl-input w-full px-4 py-3 text-sm"
            />

            <select
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
              className="vl-input w-full px-3 py-3 text-sm lg:w-56"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="vl-input w-full px-3 py-3 text-sm lg:w-52">
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {categories.slice(0, 6).map((category) => (
              <button
                key={category}
                onClick={() => setSelectedCategory(category)}
                type="button"
                className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.16em] transition ${
                  selectedCategory === category
                    ? "border-white/45 bg-white/14 text-zinc-100"
                    : "border-white/12 bg-white/5 text-zinc-300 hover:border-white/25 hover:text-white"
                }`}
              >
                {category}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setStockFilter((prev) => !prev)}
              className={`ml-auto rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.16em] transition ${
                stockFilter
                  ? "border-emerald-300/40 bg-emerald-300/12 text-emerald-200"
                  : "border-white/12 bg-white/5 text-zinc-400 hover:text-white"
              }`}
            >
              {stockFilter ? "✓ In Stock Only" : "In Stock Only"}
            </button>
          </div>

          {(selectedCategory !== "All" || searchQuery.trim() || stockFilter) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">Active:</span>
              {selectedCategory !== "All" && (
                <span className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs text-zinc-200">
                  {selectedCategory}
                  <button type="button" onClick={() => setSelectedCategory("All")} className="text-zinc-400 hover:text-white">×</button>
                </span>
              )}
              {searchQuery.trim() && (
                <span className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs text-zinc-200">
                  &ldquo;{searchQuery}&rdquo;
                  <button type="button" onClick={() => setSearchQuery("")} className="text-zinc-400 hover:text-white">×</button>
                </span>
              )}
              {stockFilter && (
                <span className="flex items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-300/8 px-2.5 py-1 text-xs text-emerald-200">
                  In Stock
                  <button type="button" onClick={() => setStockFilter(false)} className="text-emerald-400 hover:text-emerald-100">×</button>
                </span>
              )}
              <button
                type="button"
                onClick={() => { setSelectedCategory("All"); setSearchQuery(""); setStockFilter(false); }}
                className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 transition hover:text-zinc-200"
              >
                Clear all
              </button>
            </div>
          )}
        </section>

        <section className="mt-8">
          <div className="mb-5 flex items-center justify-between">
            <p className="text-sm text-zinc-400">
              {isLoading ? "Loading catalog…" : `${visibleProducts.length} product${visibleProducts.length === 1 ? "" : "s"}`}
            </p>
            {(selectedCategory !== "All" || searchQuery || stockFilter) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory("All");
                  setSearchQuery("");
                  setStockFilter(false);
                }}
                className="text-xs uppercase tracking-[0.2em] text-zinc-300 transition hover:text-white"
              >
                Clear Filters
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="vl-panel animate-pulse overflow-hidden rounded-[1.65rem]">
                  <div className="h-64 border-b border-white/10 bg-white/5" />
                  <div className="space-y-3 p-5">
                    <div className="h-3 w-24 rounded bg-white/10" />
                    <div className="h-5 w-3/4 rounded bg-white/12" />
                    <div className="h-3 w-full rounded bg-white/10" />
                    <div className="h-3 w-2/3 rounded bg-white/10" />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleProducts.length === 0 ? (
            <div className="vl-panel rounded-[1.8rem] p-10 text-center">
              <h2 className="text-xl font-semibold text-white">No products matched your filters</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-300">
                Try a broader category or reset your search terms. The catalog updates as new batches are published.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory("All");
                  setSearchQuery("");
                  setStockFilter(false);
                }}
                className="vl-btn-secondary vl-focus-ring mt-6 px-5 py-2.5 text-sm"
              >
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
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
          )}
        </section>
      </main>
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={null}>
      <ProductsPageContent />
    </Suspense>
  );
}
