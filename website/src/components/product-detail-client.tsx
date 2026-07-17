"use client";

import Link from "next/link";
import { useState } from "react";
import { useCart } from "@/components/cart-context";
import { SiteHeader } from "@/components/site-header";
import type { Product } from "@/lib/demo-data";

export function ProductDetailClient({ product }: { product: Product }) {
  const { addToCart } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState<string | null>(null);

  const handleAddToCart = () => {
    addToCart(product, quantity);
    setMessage(`Added ${quantity} ${quantity === 1 ? "item" : "items"} to the cart.`);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <Link href="/products" className="text-sm uppercase tracking-[0.3em] text-zinc-500 transition hover:text-white">
          ← Back to catalog
        </Link>
        <div className="mt-8 grid gap-10 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="overflow-hidden rounded-[2rem] border border-zinc-800 bg-zinc-900/70">
            <img src={product.image} alt={product.name} className="h-[420px] w-full object-cover" />
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
              <div className="flex items-center rounded-full border border-zinc-700 px-4 py-2 text-sm text-zinc-300">
                <label className="mr-3">Qty</label>
                <select
                  value={quantity}
                  onChange={(event) => setQuantity(Number(event.target.value))}
                  className="bg-transparent outline-none"
                >
                  <option className="bg-zinc-900" value="1">1</option>
                  <option className="bg-zinc-900" value="2">2</option>
                  <option className="bg-zinc-900" value="3">3</option>
                </select>
              </div>
              <button
                type="button"
                onClick={handleAddToCart}
                className="rounded-full border border-zinc-600 bg-white px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
              >
                Add to Cart
              </button>
            </div>
            {message ? <p className="mt-4 text-sm text-emerald-400">{message}</p> : null}

            <dl className="mt-8 space-y-3 text-sm text-zinc-400">
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <dt>Batch number</dt>
                <dd className="text-white">{product.batchNumber}</dd>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <dt>Testing date</dt>
                <dd className="text-white">{product.testingDate}</dd>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <dt>Laboratory</dt>
                <dd className="text-white">{product.labName}</dd>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <dt>Purity result</dt>
                <dd className="text-white">{product.purityResult ?? "Pending"}</dd>
              </div>
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
