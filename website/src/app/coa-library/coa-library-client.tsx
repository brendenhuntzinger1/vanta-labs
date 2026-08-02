"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { CoaLibraryNotice } from "@/components/coa-library-notice";
import type { CoaRecord } from "@/lib/catalog-types";

export function CoaLibraryPageClient() {
  const [coaRecords, setCoaRecords] = useState<CoaRecord[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [isLoading, setIsLoading] = useState(true);

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
      })
      .finally(() => setIsLoading(false));
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

  // Until real COA records exist, present a clean "coming soon + contact"
  // state instead of an empty search box. The moment COAs are added in admin,
  // this page automatically switches back to the searchable library.
  const hasRecords = coaRecords.length > 0;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-[1200px] px-5 sm:px-6 pb-20 pt-24 lg:px-10">
        <CoaLibraryNotice className="mb-8" />

        <div className="max-w-2xl">
          <p className="vl2-eyebrow">COA Archive</p>
          <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">
            {hasRecords ? "Searchable COA library." : "Certificates of Analysis."}
          </h1>
          <p className="mt-4 text-sm leading-7 text-white/60 sm:text-base">
            {hasRecords
              ? "Use the filters below to review batch documentation, laboratory validation, and quality records."
              : "Every Vanta Labs batch is third-party tested. Our full Certificate of Analysis library is being finalized and will be published here soon."}
          </p>
        </div>

        {!isLoading && !hasRecords ? (
          <div className="vl2-glass mt-10 rounded-2xl p-8 text-center sm:p-12">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] text-2xl">
              🧪
            </div>
            <h2 className="vl2-serif mt-6 text-2xl text-white sm:text-3xl">COAs coming soon</h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-white/60 sm:text-base">
              We&apos;re finalizing the third-party Certificate of Analysis for each batch. In the meantime,
              contact us and our team will provide the specific COA or quality documentation you need.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/contact" className="vl-btn-primary vl-focus-ring w-full px-8 py-3.5 text-sm sm:w-auto">
                Contact for more information
              </Link>
              <a href="mailto:support@vantalabsresearch.com" className="vl-btn-secondary vl-focus-ring w-full px-8 py-3.5 text-sm sm:w-auto">
                Email support
              </a>
            </div>
          </div>
        ) : null}

        {hasRecords ? (
          <div className="vl2-glass mt-10 rounded-2xl p-5">
            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <label className="text-sm text-white/50">
                <span className="vl2-eyebrow mb-2 block">Search by product or batch</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Aurelium or AR-2407A"
                  className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/60 outline-none transition focus:border-white/50"
                />
              </label>
              <label className="text-sm text-white/50">
                <span className="vl2-eyebrow mb-2 block">Filter by category</span>
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-black/40 px-4 py-3 text-sm text-white outline-none transition focus:border-white/50"
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
        ) : null}

        <div className="mt-8 space-y-4 sm:mt-10">
          {isLoading ? (
            <div className="border border-white/10 p-10 text-center">
              <h2 className="vl2-serif text-xl text-white">Loading COA records…</h2>
              <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-white/55">
                Fetching the latest batch documentation and laboratory validation records.
              </p>
            </div>
          ) : hasRecords && filteredRecords.length === 0 ? (
            <div className="rounded-2xl border border-white/10 p-10 text-center">
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
                className="vl2-btn-secondary vl-focus-ring mt-6 rounded-full px-5 py-2.5 text-sm"
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
                    <p className="text-white/70">Purity result</p>
                    <p className="mt-1 text-white">{record.purityResult}</p>
                  </div>
                  <div>
                    <p className="text-white/70">Testing date</p>
                    <p className="mt-1 text-white">{record.testingDate}</p>
                  </div>
                  <div>
                    <p className="text-white/70">Laboratory</p>
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
                      <span className="inline-flex px-4 py-2 text-sm text-white/70">COA coming soon</span>
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
