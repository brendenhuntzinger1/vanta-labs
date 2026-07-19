"use client";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
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

function parseDoseFromSlug(slug: string): string {
  const match = slug.match(/(\d+(?:\.\d+)?(?:mg|iu|mcg|g|ml))$/i);
  return match ? match[1].toUpperCase() : "";
}

function StockPill({ stockStatus }: { stockStatus: Product["stockStatus"] }) {
  const styles: Record<Product["stockStatus"], string> = {
    "In Stock": "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
    Limited: "border-zinc-300/40 bg-zinc-300/14 text-zinc-100",
    Reserved: "border-zinc-300/35 bg-zinc-300/10 text-zinc-100",
    "Out of Stock": "border-zinc-500/40 bg-zinc-600/15 text-zinc-300",
  };

  return <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] ${styles[stockStatus]}`}>{stockStatus}</span>;
}

function ProductCard({
  product,
  image,
  onAddToCart,
}: {
  product: Product;
  image: string;
  onAddToCart: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const dose = parseDoseFromSlug(product.slug);
  const hasRealImage = image && !image.includes(".svg");

  return (
    <article className="vl-panel vl-elevate-hover group overflow-hidden rounded-[1.65rem]">
      <div className="relative h-64 border-b border-white/10 bg-[radial-gradient(circle_at_40%_10%,rgba(186,230,253,0.22),transparent_62%)]">
        {hasRealImage ? (
          <Image
            src={image}
            alt={product.name}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 25vw"
            className="object-contain p-7 transition duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-300">Image pending</div>
          </div>
        )}
      </div>

      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{product.category}</p>
          <StockPill stockStatus={product.stockStatus} />
        </div>

        <h2 className="mt-3 line-clamp-2 text-lg font-semibold text-white">{product.name}</h2>
        <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-300">{product.shortDescription ?? product.description}</p>

        <div className="mt-4 flex items-end justify-between gap-2">
          <div>
            <p className="text-xl font-semibold text-zinc-100">{product.price}</p>
            <p className="text-xs text-zinc-500">{dose ? `${dose} dose` : "Verified lot"}</p>
          </div>
          <span className="vl-chip text-[10px]">COA VERIFIED</span>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button onClick={onAddToCart} className="vl-btn-primary vl-focus-ring px-4 py-2.5 text-sm" type="button">
            Add to Cart
          </button>
          <Link href={`/products/${product.slug}`} className="vl-btn-secondary vl-focus-ring inline-flex items-center justify-center px-4 py-2.5 text-sm">
            View Details
          </Link>
        </div>
      </div>
    </article>
  );
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sort, setSort] = useState<SortKey>("default");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const { addToCart } = useCart();

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
  }, [products, searchQuery, selectedCategory, sort]);

  return (
    <div className="vl-page-shell min-h-screen text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(10,10,10,0.95),rgba(20,20,20,0.9))] px-5 py-10 sm:px-8 sm:py-12">
          <div className="pointer-events-none absolute inset-0 vl-grid-overlay" />
          <div className="pointer-events-none absolute -right-20 -top-20 h-60 w-60 rounded-full bg-white/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 left-[30%] h-52 w-52 rounded-full bg-white/10 blur-3xl" />

          <div className="relative max-w-3xl">
            <p className="text-[11px] uppercase tracking-[0.34em] text-zinc-400">Vanta Labs Catalog</p>
            <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">Research Storefront</h1>
            <p className="mt-4 text-base leading-8 text-zinc-300 sm:text-lg">
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

          <div className="mt-3 flex flex-wrap gap-2">
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
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-5 flex items-center justify-between">
            <p className="text-sm text-zinc-400">{visibleProducts.length} products available</p>
            {(selectedCategory !== "All" || searchQuery) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory("All");
                  setSearchQuery("");
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
