"use client";

import { useEffect, useMemo, useState } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";
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
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-[1440px] px-6 pb-20 pt-32 lg:px-12">
        <div className="max-w-2xl">
          <p className="vl2-eyebrow">COA Archive</p>
          <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">
            Searchable COA library.
          </h1>
          <p className="mt-4 text-sm leading-7 text-white/60 sm:text-base">
            Use the filters below to review batch documentation, laboratory validation, and quality records.
          </p>
        </div>

        <div className="vl2-glass mt-10 p-5">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <label className="text-sm text-white/50">
              <span className="vl2-eyebrow mb-2 block">Search by product or batch</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Aurelium or AR-2407A"
                className="w-full border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
              />
            </label>
            <label className="text-sm text-white/50">
              <span className="vl2-eyebrow mb-2 block">Filter by category</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="w-full border border-white/15 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-white/50"
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
            <div className="border border-white/10 p-10 text-center">
              <h2 className="vl2-serif text-xl text-white">No COA records matched your filters</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-white/55">
                Try a broader category or a different product or batch number.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setCategory("All");
                }}
                className="vl2-btn-secondary vl-focus-ring mt-6 px-5 py-2.5 text-sm"
              >
                Reset Filters
              </button>
            </div>
          ) : null}
          {filteredRecords.map((record) => (
            <article key={record.slug} className="border border-white/10 p-4 transition hover:border-white/25 sm:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="vl2-eyebrow">{record.category}</p>
                  <h2 className="mt-2 text-xl text-white sm:text-2xl">{record.productName}</h2>
                  <p className="mt-2 text-sm text-white/45">Batch {record.batchNumber}</p>
                </div>
                <div className="grid gap-3 text-sm text-white/70 sm:grid-cols-2 lg:w-[420px] lg:min-w-0">
                  <div>
                    <p className="text-white/40">Purity result</p>
                    <p className="mt-1 text-white">{record.purityResult}</p>
                  </div>
                  <div>
                    <p className="text-white/40">Testing date</p>
                    <p className="mt-1 text-white">{record.testingDate}</p>
                  </div>
                  <div>
                    <p className="text-white/40">Laboratory</p>
                    <p className="mt-1 text-white">{record.labName}</p>
                  </div>
                  <div>
                    {record.coaUrl ? (
                      <a
                        href={record.coaUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-sm"
                      >
                        Open / Download COA
                      </a>
                    ) : (
                      <span className="inline-flex px-4 py-2 text-sm text-white/40">COA coming soon</span>
                    )}
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
