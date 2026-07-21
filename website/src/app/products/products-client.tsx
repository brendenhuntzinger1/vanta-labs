"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
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
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-[1440px] px-4 sm:px-6 pb-20 pt-32 lg:px-12">
        <div className="max-w-2xl">
          <p className="vl2-eyebrow">Vanta Labs Catalog</p>
          <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">Research storefront</h1>
          <p className="mt-4 text-sm leading-7 text-white/60 sm:text-base">
            Documented compounds with transparent purity records, mapped lot metadata, and streamlined fulfillment.
          </p>
        </div>

        <section className="vl2-glass static z-40 mt-10 p-4 lg:sticky lg:top-[92px]">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto]">
            <input
              type="search"
              aria-label="Search products"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search compounds, categories, or notes"
              className="border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/35 outline-none transition focus:border-white/50"
            />

            <select
              value={selectedCategory}
              aria-label="Filter by category"
              onChange={(event) => setSelectedCategory(event.target.value)}
              className="border border-white/15 bg-black/40 px-3 py-3 text-sm text-white outline-none transition focus:border-white/50 lg:w-56"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <select value={sort} aria-label="Sort products" onChange={(event) => setSort(event.target.value as SortKey)} className="border border-white/15 bg-black/40 px-3 py-3 text-sm text-white outline-none transition focus:border-white/50 lg:w-52">
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
                className={`border px-3 py-2.5 text-xs uppercase tracking-[0.14em] transition ${
                  selectedCategory === category
                    ? "border-white bg-white/10 text-white"
                    : "border-white/15 text-white/55 hover:border-white/35 hover:text-white"
                }`}
              >
                {category}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setStockFilter((prev) => !prev)}
              className={`ml-auto border px-3 py-2.5 text-xs uppercase tracking-[0.14em] transition ${
                stockFilter
                  ? "border-emerald-300/40 text-emerald-200"
                  : "border-white/15 text-white/45 hover:text-white"
              }`}
            >
              {stockFilter ? "✓ In Stock Only" : "In Stock Only"}
            </button>
          </div>

          {(selectedCategory !== "All" || searchQuery.trim() || stockFilter) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
              <span className="text-[10px] uppercase tracking-[0.18em] text-white/35">Active:</span>
              {selectedCategory !== "All" && (
                <span className="flex items-center gap-1.5 border border-white/15 px-2.5 py-1 text-xs text-white/75">
                  {selectedCategory}
                  <button type="button" aria-label="Clear category filter" onClick={() => setSelectedCategory("All")} className="-mr-1 inline-flex h-6 w-6 items-center justify-center text-white/45 hover:text-white">×</button>
                </span>
              )}
              {searchQuery.trim() && (
                <span className="flex items-center gap-1.5 border border-white/15 px-2.5 py-1 text-xs text-white/75">
                  &ldquo;{searchQuery}&rdquo;
                  <button type="button" aria-label="Clear search" onClick={() => setSearchQuery("")} className="-mr-1 inline-flex h-6 w-6 items-center justify-center text-white/45 hover:text-white">×</button>
                </span>
              )}
              {stockFilter && (
                <span className="flex items-center gap-1.5 border border-emerald-300/25 px-2.5 py-1 text-xs text-emerald-200">
                  In Stock
                  <button type="button" aria-label="Clear in-stock filter" onClick={() => setStockFilter(false)} className="-mr-1 inline-flex h-6 w-6 items-center justify-center text-emerald-300/70 hover:text-emerald-100">×</button>
                </span>
              )}
              <button
                type="button"
                onClick={() => { setSelectedCategory("All"); setSearchQuery(""); setStockFilter(false); }}
                className="text-[10px] uppercase tracking-[0.18em] text-white/40 transition hover:text-white"
              >
                Clear all
              </button>
            </div>
          )}
        </section>

        <section className="mt-8">
          <div className="mb-5 flex items-center justify-between">
            <p className="text-sm text-white/45">
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
                className="text-xs uppercase tracking-[0.18em] text-white/55 transition hover:text-white"
              >
                Clear Filters
              </button>
            )}
          </div>

          {isLoading ? (
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
          ) : visibleProducts.length === 0 ? (
            <div className="border border-white/10 p-10 text-center">
              <h2 className="vl2-serif text-xl text-white">No products matched your filters</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-white/55">
                Try a broader category or reset your search terms. The catalog updates as new batches are published.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory("All");
                  setSearchQuery("");
                  setStockFilter(false);
                }}
                className="vl2-btn-secondary vl-focus-ring mt-6 px-5 py-2.5 text-sm"
              >
                Reset Filters
              </button>
            </div>
          ) : (
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
          )}
        </section>
      </main>
    </div>
  );
}

export function ProductsPageClient() {
  return (
    <Suspense fallback={null}>
      <ProductsPageContent />
    </Suspense>
  );
}
