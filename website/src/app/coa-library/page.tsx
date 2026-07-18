"use client";

import { useMemo, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import { coaRecords } from "@/lib/demo-data";

const categories = ["All", ...Array.from(new Set(coaRecords.map((record) => record.category)))];

export default function CoaLibraryPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return coaRecords.filter((record) => {
      const matchesCategory = category === "All" || record.category === category;
      const searchableText = `${record.productName} ${record.batchNumber}`.toLowerCase();
      const matchesQuery = normalizedQuery.length === 0 || searchableText.includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [category, query]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">Demo COA archive</p>
          <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">
            Searchable COA library for demo records.
          </h1>
          <p className="mt-6 text-lg leading-8 text-zinc-400">
            Use the filters below to review sample batch documentation. All records are clearly marked as demo data and are not intended to provide instruction or medical claims.
          </p>
        </div>

        <div className="mt-10 rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-6">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <label className="text-sm text-zinc-400">
              <span className="mb-2 block uppercase tracking-[0.3em]">Search by product or batch</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Aurelium or AR-2407A"
                className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
              />
            </label>
            <label className="text-sm text-zinc-400">
              <span className="mb-2 block uppercase tracking-[0.3em]">Filter by category</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="w-full rounded-full border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-white outline-none"
              >
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-10 space-y-4">
          {filteredRecords.map((record) => (
            <article key={record.slug} className="rounded-[1.5rem] border border-zinc-800 bg-zinc-900/70 p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">{record.category}</p>
                  <h2 className="mt-2 text-2xl font-semibold text-white">{record.productName}</h2>
                  <p className="mt-2 text-sm text-zinc-400">Batch {record.batchNumber}</p>
                </div>
                <div className="grid gap-3 text-sm text-zinc-300 sm:grid-cols-2 lg:min-w-[420px]">
                  <div>
                    <p className="text-zinc-500">Purity result</p>
                    <p className="mt-1 text-white">{record.purityResult}</p>
                  </div>
                  <div>
                    <p className="text-zinc-500">Testing date</p>
                    <p className="mt-1 text-white">{record.testingDate}</p>
                  </div>
                  <div>
                    <p className="text-zinc-500">Laboratory</p>
                    <p className="mt-1 text-white">{record.labName}</p>
                  </div>
                  <div>
                    <a
                      href={record.coaUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex rounded-full border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-800"
                    >
                      Open / Download COA
                    </a>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
