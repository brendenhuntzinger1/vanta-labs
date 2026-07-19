"use client";

import Link from "next/link";
import { useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";
import type { Product } from "@/lib/demo-data";

function parseDose(slug: string) {
  const match = slug.match(/(\d+(?:\.\d+)?(?:mg|iu|mcg|g|ml))$/i);
  return match ? match[1].toUpperCase() : "";
}

export function ProductDetailClient({ product }: { product: Product }) {
  const { addToCart } = useCart();
  const [message, setMessage] = useState<string | null>(null);

  const handleAddToCart = (sourceElement?: HTMLElement | null) => {
    addToCart(product, 1, sourceElement);
    setMessage(`Added 1 item to the cart.`);
  };

  const hasRealImage = product.image && !product.image.includes(".svg");
  const dose = parseDose(product.slug);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <Link href="/products" className="text-xs uppercase tracking-[0.24em] text-zinc-500 transition hover:text-white sm:text-sm sm:tracking-[0.3em]">
          ← Back to catalog
        </Link>
        <div className="mt-6 grid gap-6 sm:mt-8 sm:gap-8 lg:gap-10 lg:grid-cols-[0.95fr_1.05fr]">
          {/* Product image */}
          <div className="vl-panel relative flex min-h-[300px] items-center justify-center overflow-hidden rounded-[1.5rem] sm:min-h-[360px] sm:rounded-[2rem] lg:min-h-[420px]" style={{ background: "#020205" }}>
            {/* Subtle bottom vignette blending into the card below */}
            <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-zinc-900/60 to-transparent z-10 pointer-events-none rounded-b-[2rem]" />

            {hasRealImage ? (
              <img
                src={product.image}
                alt={product.name}
                  className="h-[300px] w-full object-contain sm:h-[360px] lg:h-[420px]"
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
          <div className="vl-panel rounded-[1.5rem] p-5 sm:rounded-[2rem] sm:p-8">
            <p className="text-sm uppercase tracking-[0.35em] text-zinc-500">Demo record</p>
            <h1 className="mt-3 text-2xl font-semibold text-white sm:text-3xl lg:text-4xl">{product.name}</h1>
            <p className="mt-4 text-base leading-7 text-zinc-400 sm:text-lg sm:leading-8">{product.description}</p>
            <div className="vl-panel-soft mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-4 sm:mt-8 sm:px-5">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Price</p>
                <p className="mt-2 text-xl font-semibold text-white sm:text-2xl">{product.price}</p>
              </div>
              <div className="text-left sm:text-right">
                <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Purity</p>
                <p className="mt-2 text-white">{product.purityResult ?? "Pending"}</p>
              </div>
            </div>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={(event) => handleAddToCart(event.currentTarget)}
                className="vl-btn-primary vl-focus-ring rounded-full px-6 py-3 text-sm"
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
              className="vl-btn-secondary vl-focus-ring mt-8 inline-flex px-5 py-3 text-sm"
            >
              View matching COA
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
