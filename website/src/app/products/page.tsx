import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { products } from "@/lib/demo-data";

export default function ProductsPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">Demo catalog</p>
          <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">
            Premium research materials for controlled laboratory workflows.
          </h1>
          <p className="mt-6 text-lg leading-8 text-zinc-400">
            All listed products and documents below are sample records intended for presentation and evaluation only. No dosage guidance, therapeutic language, or human-use claims are included.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <article key={product.slug} className="overflow-hidden rounded-[1.75rem] border border-zinc-800 bg-zinc-900/70">
              <img src={product.image} alt={product.name} className="h-48 w-full object-cover" />
              <div className="p-6">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">{product.category}</p>
                  <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300">
                    {product.stockStatus}
                  </span>
                </div>
                <h2 className="mt-4 text-2xl font-semibold text-white">{product.name}</h2>
                <dl className="mt-5 space-y-2 text-sm text-zinc-400">
                  <div className="flex justify-between">
                    <dt>Price</dt>
                    <dd className="text-white">{product.price}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Batch</dt>
                    <dd className="text-white">{product.batchNumber}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Purity</dt>
                    <dd className="text-white">{product.purityResult ?? "Pending"}</dd>
                  </div>
                </dl>
                <div className="mt-6 flex flex-col gap-3">
                  <Link
                    href={`/products/${product.slug}`}
                    className="rounded-full border border-zinc-600 bg-white px-4 py-2 text-center text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
                  >
                    View Product
                  </Link>
                  <a
                    href={product.coaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-zinc-700 px-4 py-2 text-center text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800"
                  >
                    View COA
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
