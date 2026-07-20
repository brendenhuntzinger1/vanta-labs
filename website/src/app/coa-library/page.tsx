"use client";

import { useEffect, useMemo, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import type { CoaRecord } from "@/lib/catalog-types";

export default function CoaLibraryPage() {
  const [coaRecords, setCoaRecords] = useState<CoaRecord[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  useEffect(() => {
    fetch("/api/catalog/coa-records", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (json?.success && Array.isArray(json.records)) {
          setCoaRecords(json.records as CoaRecord[]);
        }
      })
      .catch(() => {
        setCoaRecords([]);
      });
  }, []);

  const categories = useMemo(
    () => ["All", ...Array.from(new Set(coaRecords.map((record) => record.category)))],
    [coaRecords],
  );

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return coaRecords.filter((record) => {
      const matchesCategory = category === "All" || record.category === category;
      const searchableText = `${record.productName} ${record.batchNumber}`.toLowerCase();
      const matchesQuery = normalizedQuery.length === 0 || searchableText.includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [category, coaRecords, query]);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <div className="max-w-3xl">
          <p className="vl-eyebrow text-xs sm:text-sm">COA Archive</p>
          <h1 className="vl-display mt-3 text-3xl font-semibold text-white sm:text-4xl lg:text-5xl">
            Searchable COA library for verified product batches.
          </h1>
          <p className="vl-copy mt-4 text-base leading-7 text-zinc-400 sm:mt-6 sm:text-lg sm:leading-8">
            Use the filters below to review batch documentation, laboratory validation, and quality records.
          </p>
        </div>

        <div className="vl-panel mt-8 rounded-[1.5rem] p-4 sm:mt-10 sm:rounded-[2rem] sm:p-6">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <label className="text-sm text-zinc-400">
              <span className="vl-eyebrow mb-2 block text-[11px]">Search by product or batch</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Aurelium or AR-2407A"
                className="vl-input w-full rounded-full px-4 py-3 text-sm"
              />
            </label>
            <label className="text-sm text-zinc-400">
              <span className="vl-eyebrow mb-2 block text-[11px]">Filter by category</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="vl-input w-full rounded-full px-4 py-3 text-sm"
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

        <div className="mt-8 space-y-4 sm:mt-10">
          {filteredRecords.length === 0 ? (
            <div className="vl-panel rounded-[1.8rem] p-10 text-center">
              <h2 className="text-xl font-semibold text-white">No COA records matched your filters</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-zinc-300">
                Try a broader category or a different product or batch number.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setCategory("All");
                }}
                className="vl-btn-secondary vl-focus-ring mt-6 px-5 py-2.5 text-sm"
              >
                Reset Filters
              </button>
            </div>
          ) : null}
          {filteredRecords.map((record) => (
            <article key={record.slug} className="vl-panel vl-elevate-hover rounded-[1.25rem] p-4 sm:rounded-[1.5rem] sm:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="vl-eyebrow text-[11px]">{record.category}</p>
                  <h2 className="mt-2 text-xl font-semibold text-white sm:text-2xl">{record.productName}</h2>
                  <p className="mt-2 text-sm text-zinc-400">Batch {record.batchNumber}</p>
                </div>
                <div className="grid gap-3 text-sm text-zinc-300 sm:grid-cols-2 lg:w-[420px] lg:min-w-0">
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
                      className="vl-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-sm"
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
