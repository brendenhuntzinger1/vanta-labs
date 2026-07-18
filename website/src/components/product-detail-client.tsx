"use client";

import Link from "next/link";
import { useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";
import type { Product } from "@/lib/demo-data";

const VIAL_COLORS = [
  { primary: "#06b6d4", secondary: "#0891b2", glow: "rgba(6,182,212,0.45)", label: "#cffafe" },
  { primary: "#8b5cf6", secondary: "#7c3aed", glow: "rgba(139,92,246,0.45)", label: "#ede9fe" },
  { primary: "#10b981", secondary: "#059669", glow: "rgba(16,185,129,0.45)", label: "#d1fae5" },
  { primary: "#f59e0b", secondary: "#d97706", glow: "rgba(245,158,11,0.45)", label: "#fef3c7" },
  { primary: "#ec4899", secondary: "#db2777", glow: "rgba(236,72,153,0.45)", label: "#fce7f3" },
  { primary: "#6366f1", secondary: "#4f46e5", glow: "rgba(99,102,241,0.45)", label: "#e0e7ff" },
  { primary: "#14b8a6", secondary: "#0d9488", glow: "rgba(20,184,166,0.45)", label: "#ccfbf1" },
  { primary: "#f97316", secondary: "#ea580c", glow: "rgba(249,115,22,0.45)", label: "#ffedd5" },
  { primary: "#a855f7", secondary: "#9333ea", glow: "rgba(168,85,247,0.45)", label: "#f3e8ff" },
  { primary: "#3b82f6", secondary: "#2563eb", glow: "rgba(59,130,246,0.45)", label: "#dbeafe" },
  { primary: "#84cc16", secondary: "#65a30d", glow: "rgba(132,204,22,0.45)", label: "#ecfccb" },
  { primary: "#e11d48", secondary: "#be123c", glow: "rgba(225,29,72,0.45)",  label: "#ffe4e6" },
];

function slugColorIndex(slug: string) {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0;
  return Math.abs(hash) % VIAL_COLORS.length;
}

function parseDose(slug: string) {
  const match = slug.match(/(\d+(?:\.\d+)?(?:mg|iu|mcg|g|ml))$/i);
  return match ? match[1].toUpperCase() : "";
}

export function ProductDetailClient({ product }: { product: Product }) {
  const { addToCart } = useCart();
  const [message, setMessage] = useState<string | null>(null);

  const handleAddToCart = () => {
    addToCart(product, 1);
    setMessage(`Added 1 item to the cart.`);
  };

  const hasRealImage = product.image && !product.image.includes(".svg");
  const dose = parseDose(product.slug);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <Link href="/products" className="text-sm uppercase tracking-[0.3em] text-zinc-500 transition hover:text-white">
          ← Back to catalog
        </Link>
        <div className="mt-8 grid gap-10 lg:grid-cols-[0.95fr_1.05fr]">
          {/* Product image */}
          <div className="relative overflow-hidden rounded-[2rem] border border-zinc-800 min-h-[420px] flex items-center justify-center" style={{ background: "#020205" }}>
            {/* Subtle bottom vignette blending into the card below */}
            <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-zinc-900/60 to-transparent z-10 pointer-events-none rounded-b-[2rem]" />

            {hasRealImage ? (
              <img
                src={product.image}
                alt={product.name}
                className="h-[420px] w-full object-contain"
                style={{ mixBlendMode: "multiply", padding: "24px" }}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-16 w-full">
                {/* Fallback vial — no photo uploaded yet */}
                <div className="relative w-36 h-64 rounded-b-[4rem] rounded-t-2xl overflow-hidden flex flex-col shadow-2xl"
                  style={{ background: "linear-gradient(160deg, rgba(100,120,255,0.15) 0%, rgba(80,100,220,0.3) 100%)", border: "1.5px solid rgba(150,170,255,0.25)" }}>
                  <div className="h-7 w-full flex-shrink-0" style={{ background: "linear-gradient(180deg, rgba(150,170,255,0.7), rgba(100,130,255,0.5))" }} />
                  <div className="absolute left-3 top-8 w-3 h-28 rounded-full opacity-20" style={{ background: "linear-gradient(180deg, white, transparent)" }} />
                  <div className="mx-2 mt-2 flex-1 rounded-xl flex flex-col items-center justify-center gap-2 px-2 py-3 bg-black/50">
                    <p className="text-[9px] font-black tracking-[0.3em] text-white/50 uppercase">VANTA LABS</p>
                    <div className="w-full h-px bg-white/20" />
                    <p className="text-lg font-black text-white text-center leading-tight">{product.name}</p>
                    <p className="text-sm font-bold text-white/60">{dose}</p>
                    <div className="w-full h-px bg-white/20" />
                    <p className="text-[7px] font-semibold tracking-widest text-white/40 uppercase">Research Use Only</p>
                  </div>
                  <div className="h-10 w-full flex-shrink-0 rounded-b-[4rem]" style={{ background: "linear-gradient(180deg, rgba(80,100,220,0.4), rgba(100,130,255,0.6))" }} />
                </div>
                <p className="mt-6 text-xs text-zinc-500 tracking-widest uppercase">Upload your photo in Admin → Products</p>
              </div>
            )}
          </div>
          <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-8">
            <p className="text-sm uppercase tracking-[0.35em] text-zinc-500">Demo record</p>
            <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">{product.name}</h1>
            <p className="mt-4 text-lg leading-8 text-zinc-400">{product.description}</p>
            <div className="mt-8 flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950/70 px-5 py-4">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Price</p>
                <p className="mt-2 text-2xl font-semibold text-white">{product.price}</p>
              </div>
              <div className="text-right">
                <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Stock</p>
                <p className="mt-2 text-white">{product.stockStatus}</p>
              </div>
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={handleAddToCart}
                className="rounded-full border border-zinc-600 bg-white px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
              >
                Add 1 to Cart
              </button>
            </div>
            {message ? <p className="mt-4 text-sm text-emerald-400">{message}</p> : null}

            <dl className="mt-8 space-y-3 text-sm text-zinc-400">
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <dt>Batch number</dt>
                <dd className="text-white">{product.batchNumber}</dd>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <dt>Purity result</dt>
                <dd className="text-white">{product.purityResult ?? "Pending"}</dd>
              </div>
              {product.molecularFormula && (
                <div className="flex justify-between border-b border-zinc-800 pb-3">
                  <dt>Molecular formula</dt>
                  <dd className="text-white">{product.molecularFormula}</dd>
                </div>
              )}
            </dl>

            <a
              href={product.coaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-flex rounded-full border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800"
            >
              View matching COA
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
