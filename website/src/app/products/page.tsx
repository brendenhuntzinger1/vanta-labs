"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { useCart } from "@/components/cart-context";
import { products } from "@/lib/demo-data";

// ── Types ─────────────────────────────────────────────────────────────────────

type SortKey = "default" | "price-asc" | "price-desc" | "name-asc" | "purity";

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
    <div className="relative overflow-hidden rounded-2xl border border-cyan-500/20 bg-[linear-gradient(130deg,#060a16_0%,#0b1324_55%,#0f172a_100%)]">
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
  }, [category, sort, searchQuery]);

  const isFiltered = category !== "All" || searchQuery;
  const heading = category === "All" ? "ALL RESEARCH PEPTIDES" : `${category.toUpperCase()}`;

  return (
    <div className="vl-page-shell min-h-screen bg-gradient-to-br from-zinc-950 via-[#0a0a1a] to-zinc-950 text-zinc-100 vl-moving-bg">
      <SiteHeader />

      {/* ── Floating Particles Background ─────────────────────────────────── */}
      <div className="pointer-events-none fixed inset-0 hidden overflow-hidden sm:block">
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
      <main className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8">

        {/* Page header */}
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-black uppercase tracking-[0.12em] text-white sm:text-4xl sm:tracking-widest lg:text-5xl">
            {heading}
          </h1>
          <div className="h-1 w-28 rounded-full bg-gradient-to-r from-cyan-400 via-blue-400 to-violet-400" />
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
              className="vl-input w-full py-2.5 pl-10 pr-4 text-sm placeholder-zinc-500"
            />
          </div>
        </div>

        {/* Controls Row */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {/* Category tabs */}
          <div className="flex w-full gap-2 overflow-x-auto pb-2 sm:pb-0 sm:flex-1">
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
                      ? "border border-white/35 bg-white/20 text-white"
                      : "border border-white/10 text-zinc-400 hover:border-white/30 hover:text-white",
                  ].join(" ")}
                >
                  {cat}
                  <span className="ml-1 text-[9px] opacity-60">({count})</span>
                </button>
              );
            })}
          </div>

          {/* Sort */}
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="vl-input w-full rounded-lg px-3 py-2 text-xs text-zinc-300 sm:w-auto"
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
              onClick={() => { setCategory("All"); setSearchQuery(""); }}
              className="text-sm text-zinc-300 underline underline-offset-4 hover:text-white transition"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {displayProducts.map((product) => {
              const dose = parseDoseFromSlug(product.slug);
              const isFav = favorites.has(product.slug);
              const productImage = imageOverrides[product.slug] || product.image;
              return (
                <div key={product.slug} className="group h-full">
                  <div className="vl-panel vl-elevate-hover relative flex h-full flex-col overflow-hidden rounded-2xl bg-gradient-to-b from-[#101530] via-[#0f1221] to-[#0c0f1a]">

                    {/* Favorite button */}
                    <button
                      onClick={() => toggleFavorite(product.slug)}
                      className="vl-focus-ring absolute top-3 right-3 z-10 rounded-full bg-black/30 p-1.5 text-zinc-500 backdrop-blur-sm transition hover:text-red-400"
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
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border border-cyan-400/30 bg-cyan-400/10 text-cyan-200">
                          COA Verified
                        </span>
                      </div>

                      <div className="mt-auto flex flex-col gap-2">
                        <button
                          onClick={(event) => addToCart(product, 1, event.currentTarget)}
                          className="vl-focus-ring w-full rounded-lg bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-3 py-2.5 text-xs font-bold text-zinc-950 shadow-[0_8px_24px_rgba(59,130,246,0.25)] transition hover:brightness-105 active:scale-95"
                        >
                          Add to Cart
                        </button>
                        <Link
                          href={`/products/${product.slug}`}
                          className="vl-btn-secondary vl-focus-ring block rounded-lg px-3 py-2 text-center text-xs"
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

