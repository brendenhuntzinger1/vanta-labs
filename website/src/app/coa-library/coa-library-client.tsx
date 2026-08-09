"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { CoaTestingDisclosure } from "@/components/coa-testing-disclosure";
import { coaSearchHaystack, formatCoaTestDate, matchesCoaSearch } from "@/lib/coa-format";
import type { CoaLibraryProduct, CoaLibrarySnapshot, PublicCoaDocument } from "@/lib/coa-types";

const SEARCH_PLACEHOLDER = "Search product, batch, or lot number";

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/**
 * The hero's trust row, built from what is actually documented.
 *
 * A COA page is the one surface where a decorative claim is a lie: "Third-Party
 * Tested" printed above an empty archive says a thing the site cannot show. So
 * every badge here is derived from published records, and when there are none
 * the row simply doesn't render.
 */
function buildTrustIndicators(snapshot: CoaLibrarySnapshot): string[] {
  if (snapshot.totalDocumentCount === 0) {
    return [];
  }

  const indicators = ["Third-Party Tested"];
  indicators.push(
    snapshot.totalDocumentCount === 1
      ? "1 Batch Record Published"
      : `${snapshot.totalDocumentCount} Batch Records Published`,
  );

  if (snapshot.hasIdentityVerification) {
    indicators.push("Identity & Purity Verification");
  } else if (snapshot.hasLabAttribution) {
    indicators.push("Named Testing Laboratory");
  }

  return indicators;
}

function StatusChip({ documented }: { documented: boolean }) {
  if (documented) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--accent-gold)]/30 bg-[color:var(--accent-gold)]/[0.07] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent-gold)]">
        <CheckIcon className="h-3 w-3" />
        COA Available
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">
      Documentation Pending
    </span>
  );
}

function ProductCoaCard({
  product,
  onOpen,
}: {
  product: CoaLibraryProduct;
  onOpen: (product: CoaLibraryProduct) => void;
}) {
  const documents = product.documents;
  const documented = documents.length > 0;
  const latest = documents[0];
  const hasRealImage = Boolean(product.imageUrl) && !product.imageUrl.includes(".svg");

  return (
    <article className="vl2-product-card flex flex-col overflow-hidden">
      <div className="relative aspect-[4/3] overflow-hidden rounded-t-[18px] bg-black">
        {hasRealImage ? (
          <Image
            src={product.imageUrl}
            alt={product.name}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-contain p-6"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <span className="border border-white/[0.08] px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-white/35">
              Image pending
            </span>
          </div>
        )}
        <div className="absolute left-4 top-4">
          <StatusChip documented={documented} />
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">{product.category}</p>
        <h3 className="mt-2 flex flex-wrap items-baseline gap-x-2 text-lg text-white sm:text-xl">
          {product.name}
          {product.strength ? <span className="text-sm text-white/40">{product.strength}</span> : null}
        </h3>

        {documented ? (
          <dl className="mt-4 space-y-2 text-[13px]">
            {latest.purity ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-white/35">Purity</dt>
                <dd className="font-semibold text-white">{latest.purity}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-white/35">Batch</dt>
              <dd className="min-w-0 truncate font-mono text-[12px] text-white/80">{latest.batchNumber}</dd>
            </div>
            {latest.testDate ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-white/35">Tested</dt>
                <dd className="text-white/80">{formatCoaTestDate(latest.testDate)}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-4 text-[13px] leading-6 text-white/40">
            Batch documentation for this compound has not been published yet.
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-3 pt-5">
          <Link
            href={`/products/${product.slug}`}
            className="vl-focus-ring inline-flex min-h-[44px] items-center rounded-lg text-[13px] text-white/45 transition hover:text-white"
          >
            View product
          </Link>
          {documented ? (
            <button
              type="button"
              onClick={() => onOpen(product)}
              className="vl-focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-lg px-1 text-[13px] font-semibold text-[color:var(--accent-gold)] transition hover:text-[color:var(--accent-gold-strong)]"
            >
              {documents.length > 1 ? `View COAs (${documents.length})` : "View COA"}
              <ArrowIcon className="h-4 w-4" />
            </button>
          ) : (
            <Link
              href="/contact"
              className="vl-focus-ring inline-flex min-h-[44px] items-center rounded-lg text-[13px] text-white/45 transition hover:text-white"
            >
              Request documentation
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

function DocumentPreview({ document: doc }: { document: PublicCoaDocument }) {
  const fileUrl = `/api/coa/${doc.id}/file`;

  // The document only loads once the dialog is open — a grid of lab reports
  // rendered behind a closed modal is the fastest way to ruin this page's LCP.
  if (doc.fileKind === "pdf") {
    return (
      <iframe
        src={fileUrl}
        title={`Certificate of Analysis — batch ${doc.batchNumber}`}
        className="h-[46vh] w-full rounded-xl border border-white/10 bg-white sm:h-[62vh]"
      />
    );
  }

  if (doc.fileKind === "image") {
    /* Deliberately a plain <img>. next/image would route this through the
       optimizer, which caches the fetched bytes — and these bytes sit behind a
       publish check, so a cached copy would keep serving a COA after it was
       unpublished. */
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={fileUrl}
        alt={`Certificate of Analysis for batch ${doc.batchNumber}`}
        className="max-h-[62vh] w-full rounded-xl border border-white/10 bg-white object-contain"
        loading="lazy"
      />
    );
  }

  return (
    <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/12 px-6 text-center">
      <p className="text-sm text-white/55">This report is hosted externally and opens in a new tab.</p>
    </div>
  );
}

function CoaDialog({
  product,
  onClose,
}: {
  product: CoaLibraryProduct;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState(product.documents[0]?.id ?? "");
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeDocument = product.documents.find((doc) => doc.id === activeId) ?? product.documents[0];

  useEffect(() => {
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);

    // Freeze the page behind the dialog so a scroll gesture over the backdrop
    // doesn't drag the grid along with it.
    //
    // BOTH elements, not just <body>. globals.css puts `overflow-x: clip` on
    // <html>, which makes <html> the scrolling element — so locking the body
    // alone left the grid scrolling happily underneath the open dialog.
    const root = window.document.documentElement;
    const { body } = window.document;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [onClose]);

  if (!activeDocument) {
    return null;
  }

  const fileUrl = `/api/coa/${activeDocument.id}/file`;
  const specs: Array<[string, string | null]> = [
    ["Product", product.name],
    ["Strength", activeDocument.strength ?? product.strength],
    ["Batch", activeDocument.batchNumber],
    ["Lot", activeDocument.lotNumber],
    ["Testing laboratory", activeDocument.labName],
    ["Test date", formatCoaTestDate(activeDocument.testDate)],
    ["Reported purity", activeDocument.purity],
    ["Identity result", activeDocument.identityResult],
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close Certificate of Analysis"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/80 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="coa-dialog-title"
        className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0d0d0d] shadow-[0_-20px_60px_-30px_rgba(0,0,0,0.9)] sm:max-h-[90vh] sm:max-w-4xl sm:rounded-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0">
            <p className="vl2-eyebrow">Certificate of Analysis</p>
            <h2 id="coa-dialog-title" className="vl2-serif mt-1.5 truncate text-2xl text-white sm:text-3xl">
              {product.name}
              {product.strength ? <span className="ml-2 text-base text-white/40">{product.strength}</span> : null}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="vl-focus-ring -mr-1 inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-white/10 text-white/60 transition hover:border-white/25 hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-4 w-4" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        {product.documents.length > 1 ? (
          <div className="flex gap-2 overflow-x-auto border-b border-white/[0.07] px-5 py-3 sm:px-7">
            {product.documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => setActiveId(doc.id)}
                aria-pressed={doc.id === activeDocument.id}
                className={`vl-focus-ring inline-flex min-h-[40px] flex-shrink-0 items-center rounded-full border px-4 text-xs font-medium transition ${
                  doc.id === activeDocument.id
                    ? "border-[color:var(--accent-gold)]/45 bg-[color:var(--accent-gold)]/[0.08] text-white"
                    : "border-white/10 text-white/50 hover:border-white/25 hover:text-white"
                }`}
              >
                <span className="font-mono">{doc.batchNumber}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <DocumentPreview document={activeDocument} />

          {/* An inline PDF viewer is unreliable on mobile browsers and a stored
              file can go missing. Rather than detect either, always point at the
              button that definitely works. */}
          {activeDocument.fileKind === "link" ? null : (
            <p className="mt-2.5 text-center text-[11px] text-white/30">
              Preview not loading? Open the full document below.
            </p>
          )}

          <dl className="mt-6 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {specs
              .filter((entry): entry is [string, string] => Boolean(entry[1]))
              .map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 border-b border-white/[0.05] pb-2">
                  <dt className="text-[13px] text-white/35">{label}</dt>
                  <dd className="min-w-0 break-words text-right text-[13px] font-medium text-white">{value}</dd>
                </div>
              ))}
          </dl>
        </div>

        <footer className="flex flex-col gap-2.5 border-t border-white/[0.07] px-5 py-4 sm:flex-row sm:px-7">
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="vl2-btn-primary vl-focus-ring w-full px-6 sm:w-auto"
          >
            View full COA
          </a>
          {activeDocument.fileKind === "link" ? null : (
            <a
              href={`${fileUrl}?download=1`}
              className="vl2-btn-secondary vl-focus-ring w-full px-6 sm:w-auto"
            >
              Download COA
            </a>
          )}
        </footer>
      </div>
    </div>
  );
}

export function CoaLibraryPageClient({ snapshot }: { snapshot: CoaLibrarySnapshot }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [openProductId, setOpenProductId] = useState<string | null>(null);

  const trustIndicators = useMemo(() => buildTrustIndicators(snapshot), [snapshot]);

  const categories = useMemo(() => {
    const found = Array.from(new Set(snapshot.products.map((product) => product.category))).filter(Boolean).sort();
    return ["All", ...found];
  }, [snapshot.products]);

  const visibleProducts = useMemo(() => {
    return snapshot.products.filter((product) => {
      if (category !== "All" && product.category !== category) return false;
      return matchesCoaSearch(coaSearchHaystack(product), query);
    });
  }, [category, query, snapshot.products]);

  const openProduct = useMemo(
    () => snapshot.products.find((product) => product.productId === openProductId) ?? null,
    [openProductId, snapshot.products],
  );

  const closeDialog = useCallback(() => setOpenProductId(null), []);

  // Two product shots, dimmed almost to nothing, sitting behind the hero. Enough
  // to say "these are vials of something real" without turning the headline into
  // a collage. Desktop only — on a phone they would crowd the copy.
  const heroImages = useMemo(
    () =>
      snapshot.products
        .filter((product) => Boolean(product.imageUrl) && !product.imageUrl.includes(".svg"))
        .slice(0, 2),
    [snapshot.products],
  );

  const hasAnyProducts = snapshot.products.length > 0;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <SiteHeaderV2 />

      <main>
        <section className="relative overflow-hidden border-b border-white/[0.06]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 50% at 50% -10%, rgba(199, 174, 94, 0.07), transparent 62%)",
            }}
          />
          {heroImages.map((product, index) => (
            <div
              key={product.productId}
              aria-hidden
              className={`pointer-events-none absolute top-24 hidden h-72 w-72 opacity-[0.13] blur-[1px] lg:block xl:h-80 xl:w-80 ${
                index === 0 ? "left-[-3rem] -rotate-12" : "right-[-3rem] rotate-12"
              }`}
            >
              <Image
                src={product.imageUrl}
                alt=""
                fill
                sizes="320px"
                className="object-contain"
                priority={false}
              />
            </div>
          ))}

          <div className="relative mx-auto max-w-[1180px] px-5 pb-14 pt-28 text-center sm:px-6 sm:pb-20 sm:pt-36 lg:px-10">
            <p className="vl2-eyebrow">Independent Testing</p>
            <h1 className="vl2-serif mx-auto mt-5 max-w-4xl text-[2.5rem] leading-[1.04] text-white sm:text-6xl lg:text-[4.25rem]">
              Certificates of Analysis
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-[0.9375rem] leading-7 text-white/55 sm:text-base">
              Explore available third-party testing and batch documentation for Vanta Labs research
              products.
            </p>

            {trustIndicators.length > 0 ? (
              <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2.5 sm:mt-10 sm:gap-x-4">
                {trustIndicators.map((indicator) => (
                  <li
                    key={indicator}
                    className="inline-flex items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.02] px-3.5 py-2 text-[11px] font-medium tracking-[0.04em] text-white/70 sm:text-xs"
                  >
                    <CheckIcon className="h-3.5 w-3.5 text-[color:var(--accent-gold)]" />
                    {indicator}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mx-auto mt-8 max-w-lg text-[13px] leading-6 text-white/40">
                Batch records are published here as testing is completed. Contact our team for
                documentation on a specific batch in the meantime.
              </p>
            )}
          </div>
        </section>

        {hasAnyProducts ? (
          <>
            <section className="mx-auto max-w-[1180px] px-5 pt-10 sm:px-6 sm:pt-14 lg:px-10">
              <label className="relative mx-auto block max-w-2xl">
                <span className="sr-only">{SEARCH_PLACEHOLDER}</span>
                <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/30" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={SEARCH_PLACEHOLDER}
                  className="vl-focus-ring h-[52px] w-full rounded-full border border-white/10 bg-white/[0.03] pl-12 pr-4 text-[15px] text-white outline-none transition placeholder:text-white/35 focus:border-white/25 sm:h-14"
                />
              </label>

              {categories.length > 2 ? (
                <div className="mx-auto mt-4 flex max-w-3xl flex-wrap justify-center gap-2">
                  {categories.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setCategory(item)}
                      aria-pressed={category === item}
                      className={`vl-focus-ring inline-flex min-h-[40px] items-center rounded-full border px-4 text-xs font-medium transition ${
                        category === item
                          ? "border-[color:var(--accent-gold)]/40 bg-[color:var(--accent-gold)]/[0.07] text-white"
                          : "border-white/[0.08] text-white/45 hover:border-white/20 hover:text-white"
                      }`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="mx-auto max-w-[1180px] px-5 pb-20 pt-8 sm:px-6 sm:pt-10 lg:px-10">
              {visibleProducts.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 lg:gap-6">
                  {visibleProducts.map((product) => (
                    <ProductCoaCard key={product.productId} product={product} onOpen={(item) => setOpenProductId(item.productId)} />
                  ))}
                </div>
              ) : (
                <div className="mx-auto max-w-lg rounded-2xl border border-white/[0.07] px-6 py-14 text-center">
                  <h2 className="vl2-serif text-xl text-white sm:text-2xl">No matching records</h2>
                  <p className="mt-3 text-sm leading-7 text-white/45">
                    Nothing matched “{query.trim() || category}”. Try a product name, a batch number, or
                    clear the filters.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setCategory("All");
                    }}
                    className="vl2-btn-secondary vl-focus-ring mt-6 px-6"
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="mx-auto max-w-[1180px] px-5 pb-20 pt-14 sm:px-6 lg:px-10">
            <div className="mx-auto max-w-xl rounded-2xl border border-white/[0.07] px-6 py-16 text-center">
              <h2 className="vl2-serif text-2xl text-white sm:text-3xl">The archive is being prepared</h2>
              <p className="mt-4 text-sm leading-7 text-white/50">
                Batch documentation will be published here as it is released. Contact our team and we
                will provide the testing records available for the batch you are researching.
              </p>
              <Link href="/contact" className="vl2-btn-primary vl-focus-ring mt-8 inline-flex px-7">
                Contact support
              </Link>
            </div>
          </section>
        )}

        <CoaTestingDisclosure hasPublishedRecords={snapshot.totalDocumentCount > 0} />
      </main>

      {openProduct ? <CoaDialog product={openProduct} onClose={closeDialog} /> : null}
    </div>
  );
}
