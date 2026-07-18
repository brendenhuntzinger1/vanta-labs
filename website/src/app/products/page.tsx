"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { useCart } from "@/components/cart-context";
import { products } from "@/lib/demo-data";

// ── Types ─────────────────────────────────────────────────────────────────────

type SortKey = "default" | "price-asc" | "price-desc" | "name-asc" | "purity";
type StockFilter = "All" | "In Stock" | "Limited" | "Reserved";

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = [
  "All",
  "Analytical Reference",
  "Calibration Series",
  "Research Peptides",
  "Growth Factors",
  "Cognitive Research",
  "Metabolic Research",
  "Solvents & Solutions",
];

// CATEGORY_COLORS kept for future use
const CATEGORY_COLORS: Record<string, { accent: string; glow: string; text: string }> = {
  "Analytical Reference": { accent: "#6366f1", glow: "rgba(99, 102, 241, 0.2)", text: "from-indigo-500 to-indigo-300" },
  "Calibration Series": { accent: "#8b5cf6", glow: "rgba(139, 92, 246, 0.2)", text: "from-violet-500 to-violet-300" },
  "Research Peptides": { accent: "#06b6d4", glow: "rgba(6, 182, 212, 0.2)", text: "from-cyan-500 to-cyan-300" },
  "Growth Factors": { accent: "#ec4899", glow: "rgba(236, 72, 153, 0.2)", text: "from-pink-500 to-pink-300" },
  "Cognitive Research": { accent: "#f59e0b", glow: "rgba(245, 158, 11, 0.2)", text: "from-amber-500 to-amber-300" },
  "Metabolic Research": { accent: "#10b981", glow: "rgba(16, 185, 129, 0.2)", text: "from-emerald-500 to-emerald-300" },
  "Solvents & Solutions": { accent: "#64748b", glow: "rgba(100, 116, 139, 0.2)", text: "from-slate-500 to-slate-300" },
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "default", label: "Featured" },
  { value: "price-asc", label: "Price: Low → High" },
  { value: "price-desc", label: "Price: High → Low" },
  { value: "name-asc", label: "Name: A → Z" },
  { value: "purity", label: "Purity: Highest" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePrice(price: string): number {
  return Number(price.replace(/[^0-9.]/g, "")) || 0;
}

function parsePurity(purity?: string): number {
  return Number((purity ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function ShieldCheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 3 6v6c0 5.25 3.75 10.15 9 11.25C17.25 22.15 21 17.25 21 12V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function FlaskIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6" />
      <path d="M8.5 3 5 14.5a2.5 2.5 0 0 0 2.5 3h9a2.5 2.5 0 0 0 2.5-3L15.5 3" />
      <path d="M5.5 13h13" />
    </svg>
  );
}

function TruckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="3" width="15" height="13" rx="1" />
      <path d="M16 8h4l3 3v5h-7V8z" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  );
}

function HeartIcon({ filled = false, size = 20 }: { filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}
      stroke="currentColor" strokeWidth={filled ? "0" : "1.5"} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function SearchIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

// ── Consistent card image background (no per-product colors) ─────────────────

const CARD_IMG_BG = "linear-gradient(135deg, #08090f 0%, #0d0f1c 50%, #0a0c16 100%)";

function parseDoseFromSlug(slug: string): string {
  const match = slug.match(/(\d+(?:\.\d+)?(?:mg|iu|mcg|g|ml))$/i);
  return match ? match[1].toUpperCase() : "";
}

// ── Product Image Card Visual ─────────────────────────────────────────────────

function ProductImagePanel({ name, dose, image }: { name: string; dose: string; image?: string }) {
  const hasRealImage = image && !image.includes(".svg");
  return (
    <div
      className="relative w-full h-64 rounded-t-2xl overflow-hidden flex items-center justify-center"
      style={{ background: "#020205" }}
    >
      {/* Subtle bottom vignette */}
      <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-[#0d0f1c] to-transparent z-10 pointer-events-none" />

      {hasRealImage ? (
        <img
          src={image}
          alt={name}
          className="h-full w-full object-contain"
          style={{ mixBlendMode: "multiply", padding: "8px" }}
        />
      ) : (
        /* Fallback SVG vial if no photo uploaded */
        <div className="relative flex flex-col items-center justify-center h-full w-full">
          <div
            className="w-20 h-48 rounded-b-[3rem] rounded-t-xl flex flex-col overflow-hidden shadow-2xl"
            style={{ background: "linear-gradient(160deg, rgba(100,120,255,0.15) 0%, rgba(80,100,220,0.3) 100%)", border: "1px solid rgba(150,170,255,0.25)" }}
          >
            <div className="h-5 w-full" style={{ background: "linear-gradient(180deg, rgba(150,170,255,0.6), rgba(100,130,255,0.4))" }} />
            <div className="flex-1 mx-1.5 mt-1.5 rounded-lg flex flex-col items-center justify-center gap-1 px-1 bg-black/40">
              <p className="text-[7px] font-black tracking-[0.25em] text-white/50">VANTA LABS</p>
              <p className="text-[11px] font-black text-white text-center leading-tight">{name}</p>
              <p className="text-[10px] font-bold text-white/60">{dose}</p>
            </div>
            <div className="h-8 rounded-b-[3rem]" style={{ background: "linear-gradient(180deg, rgba(80,100,220,0.4), rgba(100,130,255,0.6))" }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Trust Banner ──────────────────────────────────────────────────────────────

type TrustItem =
  | { kind: "icon"; IconComponent: typeof ShieldCheckIcon; label: string; sub: string }
  | { kind: "flag"; label: string; sub: string };

const TRUST_ITEMS: TrustItem[] = [
  { kind: "icon", IconComponent: ShieldCheckIcon, label: "99%+ PURITY",             sub: "Third-party verified every batch"    },
  { kind: "flag",                                 label: "MADE IN USA",              sub: "American-manufactured compounds"     },
  { kind: "icon", IconComponent: FlaskIcon,       label: "BATCH TESTED EVERY ORDER", sub: "COA included with every shipment"   },
  { kind: "icon", IconComponent: TruckIcon,       label: "FAST & DISCREET SHIPPING", sub: "Same-day dispatch on eligible orders" },
];

const ITEM_BORDER: string[] = [
  "",
  "border-l border-white/10",
  "border-t border-white/10 sm:border-t-0 sm:border-l",
  "border-l border-white/10 border-t border-white/10 sm:border-t-0",
];

function TrustBanner() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#060a16]">
      {/* Red glow */}
      <div className="pointer-events-none absolute inset-y-0 -left-16 w-56 bg-gradient-to-r from-red-600/14 to-transparent" />
      {/* Blue glow */}
      <div className="pointer-events-none absolute inset-y-0 -right-16 w-56 bg-gradient-to-l from-blue-600/14 to-transparent" />
      {/* Top reflection */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/22 to-transparent" />
      {/* Frosted glass */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.04] to-transparent" />

      <div className="relative grid grid-cols-2 sm:grid-cols-4">
        {TRUST_ITEMS.map((item, i) => (
          <div
            key={item.label}
            className={[
              "group flex cursor-default flex-col items-center gap-1.5 p-3 text-center",
              "transition-colors duration-200 hover:bg-white/[0.04]",
              "sm:flex-row sm:items-center sm:gap-3.5 sm:px-5 sm:py-4 sm:text-left",
              ITEM_BORDER[i] ?? "",
            ].join(" ")}
          >
            <div className="shrink-0 text-white/70 transition-colors duration-200 group-hover:text-white">
              {item.kind === "flag" ? (
                <span className="block text-[1.6rem] leading-none sm:text-2xl" style={{ filter: "drop-shadow(0 0 5px rgba(255,255,255,0.3))" }}>
                  🇺🇸
                </span>
              ) : (
                <item.IconComponent size={20} />
              )}
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase leading-tight tracking-widest text-white sm:text-[11px]">
                {item.label}
              </p>
              <p className="mt-0.5 hidden text-[10px] leading-snug text-zinc-400 sm:block">
                {item.sub}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Page Component ───────────────────────────────────────────────────────

export default function ProductsPage() {
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState<SortKey>("default");
  const [stockFilter, setStockFilter] = useState<StockFilter>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    // Load favorites from localStorage during initialization
    if (typeof window === "undefined") return new Set();
    const stored = localStorage.getItem("vl-favorites");
    if (stored) {
      try {
        return new Set(JSON.parse(stored));
      } catch {}
    }
    return new Set();
  });
  const [imageOverrides, setImageOverrides] = useState<Record<string, string>>({});
  const { addToCart } = useCart();

  // Load per-product image overrides uploaded via admin
  useEffect(() => {
    fetch("/product-images.json")
      .then((r) => r.json())
      .then((data) => setImageOverrides(data))
      .catch(() => {});
  }, []);

  // Save favorites to localStorage
  const toggleFavorite = (slug: string) => {
    const updated = new Set(favorites);
    if (updated.has(slug)) {
      updated.delete(slug);
    } else {
      updated.add(slug);
    }
    setFavorites(updated);
    localStorage.setItem("vl-favorites", JSON.stringify(Array.from(updated)));
  };

  const displayProducts = useMemo(() => {
    let result = [...products];

    if (category !== "All") {
      result = result.filter((p) => p.category === category);
    }
    if (stockFilter !== "All") {
      result = result.filter((p) => p.stockStatus === stockFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((p) => 
        p.name.toLowerCase().includes(q) || 
        p.category.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
      );
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
    }

    return result;
  }, [category, sort, stockFilter, searchQuery]);

  const isFiltered = category !== "All" || stockFilter !== "All" || searchQuery;
  const heading = category === "All" ? "ALL RESEARCH PEPTIDES" : `${category.toUpperCase()}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-950 via-[#0a0a1a] to-zinc-950 text-zinc-100 vl-moving-bg">
      <SiteHeader />

      {/* ── Floating Particles Background ─────────────────────────────────── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-20 left-10 w-2 h-2 bg-indigo-500 rounded-full vl-particle-1 opacity-30" />
        <div className="absolute top-40 right-20 w-1.5 h-1.5 bg-violet-500 rounded-full vl-particle-2 opacity-20" />
        <div className="absolute bottom-40 left-1/4 w-2 h-2 bg-cyan-500 rounded-full vl-particle-3 opacity-25" />
        <div className="absolute top-1/3 right-1/4 w-1 h-1 bg-pink-500 rounded-full vl-particle-4 opacity-15" />
      </div>

      {/* ── Trust Banner ──────────────────────────────────────────────────── */}
      <div className="relative border-b border-zinc-800/60 bg-gradient-to-b from-zinc-950 to-[#0a0a1a] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <TrustBanner />
        </div>
      </div>

      {/* ── Main Content ──────────────────────────────────────────────────── */}
      <main className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">

        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black uppercase tracking-widest text-white mb-2">
            {heading}
          </h1>
          <p className="text-sm text-zinc-400">
            {displayProducts.length} {displayProducts.length === 1 ? "product" : "products"}
            {isFiltered && <span className="ml-2 inline-block px-2.5 py-1 rounded-full bg-white/5 text-[11px] font-semibold tracking-wide">FILTERED</span>}
          </p>
        </div>

        {/* Search Bar */}
        <div className="mb-6 relative max-w-md">
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">
              <SearchIcon size={18} />
            </div>
            <input
              type="text"
              placeholder="Search peptides, compounds..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-white/10 bg-white/5 text-white placeholder-zinc-500 transition focus:bg-white/10 focus:border-white/20 focus:outline-none text-sm"
            />
          </div>
        </div>

        {/* Controls Row */}
        <div className="mb-8 flex flex-col sm:flex-row gap-4 items-start sm:items-center">
          {/* Category tabs */}
          <div className="flex gap-2 overflow-x-auto pb-2 sm:pb-0 flex-1">
            {CATEGORIES.map((cat) => {
              const count = cat === "All"
                ? products.length
                : products.filter((p) => p.category === cat).length;
              return (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={[
                    "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-all whitespace-nowrap",
                    category === cat
                      ? "bg-white/20 text-white border border-white/40"
                      : "border border-white/10 text-zinc-400 hover:border-white/30 hover:text-white",
                  ].join(" ")}
                >
                  {cat}
                  <span className="ml-1 text-[9px] opacity-60">({count})</span>
                </button>
              );
            })}
          </div>

          {/* Sort and Filter */}
          <div className="flex gap-3 w-full sm:w-auto">
            <select
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value as StockFilter)}
              className="flex-1 sm:flex-initial rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 transition hover:border-white/20 focus:border-white/30 focus:outline-none"
            >
              <option value="All">Stock: All</option>
              <option value="In Stock">In Stock</option>
              <option value="Limited">Limited</option>
              <option value="Reserved">Reserved</option>
            </select>

            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="flex-1 sm:flex-initial rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-300 transition hover:border-white/20 focus:border-white/30 focus:outline-none"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Product Grid or Empty State */}
        {displayProducts.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-4 text-center">
            <p className="text-zinc-400">No products match your search.</p>
            <button
              onClick={() => { setCategory("All"); setStockFilter("All"); setSearchQuery(""); }}
              className="text-sm text-zinc-300 underline underline-offset-4 hover:text-white transition"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {displayProducts.map((product, productIndex) => {
              const dose = parseDoseFromSlug(product.slug);
              const isFav = favorites.has(product.slug);
              const productImage = imageOverrides[product.slug] || product.image;
              return (
                <div key={product.slug} className="group h-full">
                  <div className="relative h-full flex flex-col rounded-2xl overflow-hidden border border-white/10 hover:border-white/25 transition-all duration-300 bg-[#0d0f1c]">

                    {/* Favorite button */}
                    <button
                      onClick={() => toggleFavorite(product.slug)}
                      className="absolute top-3 right-3 z-10 text-zinc-500 hover:text-red-400 transition bg-black/30 rounded-full p-1.5 backdrop-blur-sm"
                      aria-label="Add to favorites"
                    >
                      <HeartIcon filled={isFav} size={16} />
                    </button>

                    {/* Category badge */}
                    <div className="absolute top-3 left-3 z-10">
                      <span className="text-[8px] font-bold uppercase tracking-widest text-white/50 bg-black/40 backdrop-blur-sm px-2 py-1 rounded-full">
                        {product.category.replace("Research ", "").replace(" Research", "")}
                      </span>
                    </div>

                    {/* Large product image */}
                    <ProductImagePanel name={product.name} dose={dose} image={productImage} />

                    {/* Info section */}
                    <div className="flex flex-col flex-1 p-4 gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-white leading-tight">{product.name}</h3>
                        <p className="text-xs text-zinc-500 mt-0.5">{dose} • {product.purityResult || "99.5%"} Purity</p>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-lg font-black text-white">{product.price}</span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          product.stockStatus === "In Stock"
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25"
                            : product.stockStatus === "Limited"
                            ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                            : "bg-red-500/15 text-red-400 border border-red-500/25"
                        }`}>{product.stockStatus}</span>
                      </div>

                      <div className="mt-auto flex flex-col gap-2">
                        <button
                          onClick={() => addToCart(product, 1)}
                          className="w-full rounded-lg bg-white px-3 py-2.5 text-xs font-bold text-zinc-950 transition hover:bg-zinc-100 active:scale-95"
                        >
                          Add to Cart
                        </button>
                        <Link
                          href={`/products/${product.slug}`}
                          className="block rounded-lg border border-white/15 px-3 py-2 text-center text-xs font-semibold text-zinc-400 transition hover:border-white/30 hover:text-white"
                        >
                          View Details
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

