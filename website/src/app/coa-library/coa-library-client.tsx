"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { CoaTestingDisclosure } from "@/components/coa-testing-disclosure";
import { coaSearchHaystack, formatCoaTestDate, matchesCoaSearch } from "@/lib/coa-format";
import type { CoaLibraryProduct, CoaLibrarySnapshot, PublicCoaDocument } from "@/lib/coa-types";
import { PLACEHOLDER_IMAGE_PATHS } from "@/lib/product-image";

const SEARCH_PLACEHOLDER = "Search product, compound, batch, or lot number";

/**
 * A placeholder is not product photography, so a card carrying one falls
 * through to its own lit empty state rather than rendering a picture of
 * nothing. The list is shared with the rest of the app — see
 * `@/lib/product-image`, which also keeps the retired screenshot recognised so
 * a product row still storing that path resolves rather than 404s.
 */

function isRealProductPhoto(url: string | null | undefined): boolean {
  const value = String(url ?? "").trim();
  if (!value) return false;
  if (value.endsWith(".svg")) return false;
  return !PLACEHOLDER_IMAGE_PATHS.some((placeholder) => value.endsWith(placeholder));
}

type StatusFilter = "all" | "verified" | "pending";

// "Documentation Pending" is wide enough to claim a whole row to itself on a
// phone, pushing the archive another 60px down. The short label carries the
// same meaning next to "Verified", and the full wording is still on the cards.
const STATUS_FILTERS: Array<{ key: StatusFilter; label: string; shortLabel: string }> = [
  { key: "all", label: "All", shortLabel: "All" },
  { key: "verified", label: "Verified", shortLabel: "Verified" },
  { key: "pending", label: "Documentation Pending", shortLabel: "Pending" },
];

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
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

/**
 * Shown when a product has no photograph.
 *
 * The brand mark, not a drawn vial. Two attempts at a line-art vial both read
 * as a milk bottle at card size — the silhouette of a 2R vial is too close to a
 * bottle to survive being reduced to one hairline. The monogram is
 * unmistakably deliberate, which is the whole job of an empty state.
 */
function BrandMarkPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center" aria-hidden>
      <svg viewBox="0 0 120 120" fill="none" className="h-[42%] w-auto">
        <circle cx="60" cy="60" r="47" stroke="currentColor" strokeWidth="1" className="text-white/[0.09]" />
        <path
          d="M38 45 L60 82 L82 45"
          stroke="currentColor"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white/[0.16]"
        />
      </svg>
    </div>
  );
}

/**
 * The hero's trust row, built only from what is actually documented.
 *
 * A COA page is the one surface where a decorative claim is a lie: "Third-Party
 * Tested" set above an empty archive says a thing the site cannot show. Every
 * badge is derived from published records, and with none the row doesn't render.
 */
function buildTrustIndicators(snapshot: CoaLibrarySnapshot): string[] {
  if (snapshot.totalDocumentCount === 0) return [];

  const indicators = ["Third-Party Tested"];
  indicators.push(
    snapshot.totalDocumentCount === 1
      ? "1 Batch Record Published"
      : `${snapshot.totalDocumentCount} Batch Records Published`,
  );
  if (snapshot.hasIdentityVerification) {
    indicators.push("Identity & Purity Verified");
  } else if (snapshot.hasLabAttribution) {
    indicators.push("Named Testing Laboratory");
  }
  return indicators;
}

function StatusBadge({ verified }: { verified: boolean }) {
  return (
    <span
      data-verified={verified}
      className="vl-coa-badge px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.13em]"
    >
      {verified ? <CheckIcon className="h-3 w-3" /> : null}
      {verified ? "Verified" : "Documentation Pending"}
    </span>
  );
}

function SpecCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.15em] text-white/32">{label}</dt>
      <dd className="mt-1 truncate text-[13px] font-medium text-white/90">{value}</dd>
    </div>
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
  const verified = documents.length > 0;
  const latest = documents[0];
  const showPhoto = isRealProductPhoto(product.imageUrl);

  const specs: Array<[string, string | null]> = verified
    ? [
        ["Batch", latest.batchNumber],
        ["Tested", formatCoaTestDate(latest.testDate)],
        ["Laboratory", latest.labName],
        ["Purity", latest.purity],
      ]
    : [];

  return (
    <article data-pending={!verified} className="vl-coa-card flex flex-col overflow-hidden">
      {/* 4:5 and object-cover, not 4:3 and object-contain. Contained, the photo
          sat letterboxed inside the well and its own border showed as a pasted
          rectangle; filling the well means the only edge left is the vignette.
          Portrait suits vial photography, so the crop takes a few pixels off the
          sides rather than cutting the object. */}
      <div className="vl-coa-media relative aspect-[4/5] text-white">
        {showPhoto ? (
          <Image
            src={product.imageUrl}
            alt={product.name}
            fill
            sizes="(max-width: 640px) 92vw, (max-width: 1024px) 46vw, 31vw"
            className="vl-coa-vial object-cover"
            loading="lazy"
          />
        ) : (
          <BrandMarkPlaceholder />
        )}
        <div className="vl-coa-media-shadow" />
        <div className="absolute left-4 top-4 z-[1]">
          <StatusBadge verified={verified} />
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/32">{product.category}</p>
        <h3 className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[1.15rem] leading-snug text-white sm:text-xl">
          {product.name}
          {product.strength ? <span className="text-sm text-white/40">{product.strength}</span> : null}
        </h3>

        {verified ? (
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3.5">
            {specs
              .filter((entry): entry is [string, string] => Boolean(entry[1]))
              .map(([label, value]) => (
                <SpecCell key={label} label={label} value={value} />
              ))}
          </dl>
        ) : (
          <p className="mt-5 text-[13px] leading-6 text-white/38">
            Batch documentation has not been published yet.
          </p>
        )}

        <div className="mt-auto pt-6">
          {verified ? (
            <>
              <button type="button" onClick={() => onOpen(product)} className="vl-coa-cta vl-focus-ring">
                {documents.length > 1 ? `View COAs (${documents.length})` : "View COA"}
              </button>
              <Link
                href={`/products/${product.slug}`}
                className="vl-focus-ring mt-3 flex min-h-[36px] items-center justify-center rounded-lg text-[12px] text-white/38 transition hover:text-white/80"
              >
                View product
              </Link>
            </>
          ) : (
            <>
              <Link href={`/products/${product.slug}`} data-quiet="true" className="vl-coa-cta vl-focus-ring">
                View product
              </Link>
              <Link
                href="/contact"
                className="vl-focus-ring mt-3 flex min-h-[36px] items-center justify-center rounded-lg text-[12px] text-white/38 transition hover:text-white/80"
              >
                Request documentation
              </Link>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

const ZOOM_STEPS = [1, 1.5, 2, 3];

function CoaViewer({
  product,
  onClose,
}: {
  product: CoaLibraryProduct;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState(product.documents[0]?.id ?? "");
  const [zoomIndex, setZoomIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeDocument = product.documents.find((doc) => doc.id === activeId) ?? product.documents[0];

  useEffect(() => {
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);

    // Freeze the page behind the viewer. BOTH elements: globals.css puts
    // `overflow-x: clip` on <html>, which makes <html> the scrolling element,
    // so locking <body> alone leaves the grid scrolling underneath.
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

  // A new batch is a new document — carrying the previous zoom into it would
  // open it mid-pan on an unrelated region. Reset at the event rather than in
  // an effect, so switching batches is one render instead of a cascade.
  const selectDocument = (id: string) => {
    setActiveId(id);
    setZoomIndex(0);
  };

  if (!activeDocument) return null;

  const fileUrl = `/api/coa/${activeDocument.id}/file`;
  const zoom = ZOOM_STEPS[zoomIndex];
  const canZoom = activeDocument.fileKind === "image";

  const specs: Array<[string, string | null]> = [
    ["Product", product.name],
    ["Strength", activeDocument.strength ?? product.strength],
    ["Batch", activeDocument.batchNumber],
    ["Lot", activeDocument.lotNumber],
    ["Laboratory", activeDocument.labName],
    ["Test date", formatCoaTestDate(activeDocument.testDate)],
    ["Reported purity", activeDocument.purity],
    ["Identity result", activeDocument.identityResult],
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Close Certificate of Analysis"
        onClick={onClose}
        className="vl-coa-scrim absolute inset-0 h-full w-full cursor-default"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="coa-viewer-title"
        className={`vl-coa-modal relative flex w-full flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl ${
          expanded ? "max-h-[96vh] sm:h-[94vh] sm:max-w-[1400px]" : "max-h-[92vh] sm:max-h-[90vh] sm:max-w-4xl"
        }`}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0">
            <p className="vl2-eyebrow">Certificate of Analysis</p>
            <h2 id="coa-viewer-title" className="vl2-serif mt-1.5 truncate text-2xl text-white sm:text-3xl">
              {product.name}
              {product.strength ? <span className="ml-2 text-base text-white/40">{product.strength}</span> : null}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="vl-coa-tool vl-focus-ring -mr-1 h-11 w-11 flex-shrink-0 rounded-full"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" className="h-4 w-4" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>

        <div className="vl-coa-seam" />

        {product.documents.length > 1 ? (
          <>
            <div className="flex gap-2 overflow-x-auto px-5 py-3 sm:px-7">
              {product.documents.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => selectDocument(doc.id)}
                  data-active={doc.id === activeDocument.id}
                  aria-pressed={doc.id === activeDocument.id}
                  className="vl-coa-pill vl-focus-ring min-h-[38px] flex-shrink-0 px-4 font-mono text-xs"
                >
                  {doc.batchNumber}
                </button>
              ))}
            </div>
            <div className="vl-coa-seam" />
          </>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {canZoom ? (
                <>
                  <button
                    type="button"
                    onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
                    disabled={zoomIndex === 0}
                    aria-label="Zoom out"
                    className="vl-coa-tool vl-focus-ring h-9 w-9"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden>
                      <path d="M6 12h12" />
                    </svg>
                  </button>
                  <span className="min-w-[3.25rem] text-center font-mono text-xs text-white/45">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
                    disabled={zoomIndex === ZOOM_STEPS.length - 1}
                    aria-label="Zoom in"
                    className="vl-coa-tool vl-focus-ring h-9 w-9"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden>
                      <path d="M12 6v12M6 12h12" />
                    </svg>
                  </button>
                </>
              ) : null}
            </div>

            {/* Shown at every width. It was `hidden sm:inline-flex`, which did
                nothing: .vl-coa-tool declares `display` and is defined after
                Tailwind's utilities, so it beat `.hidden` at equal specificity
                and the control appeared on phones regardless. Keeping it
                everywhere is also the better answer — a small screen is where a
                taller document view helps most. */}
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="vl-coa-tool vl-focus-ring h-9 px-3 text-[11px] font-semibold uppercase tracking-[0.12em]"
            >
              {expanded ? "Reduce" : "Expand"}
            </button>
          </div>

          <CoaDocument document={activeDocument} fileUrl={fileUrl} zoom={zoom} expanded={expanded} />

          {activeDocument.fileKind === "link" ? null : (
            <p className="mt-2.5 text-center text-[11px] text-white/28">
              Preview not loading? Open the full document below.
            </p>
          )}

          <dl className="mt-7 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {specs
              .filter((entry): entry is [string, string] => Boolean(entry[1]))
              .map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 border-b border-white/[0.055] pb-2.5">
                  <dt className="text-[12px] uppercase tracking-[0.12em] text-white/32">{label}</dt>
                  <dd className="min-w-0 break-words text-right text-[13px] font-medium text-white">{value}</dd>
                </div>
              ))}
          </dl>
        </div>

        <div className="vl-coa-seam" />

        <footer className="flex flex-col gap-2.5 px-5 py-4 sm:flex-row sm:px-7">
          <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="vl-coa-cta vl-focus-ring px-6 sm:w-auto sm:min-w-[13rem]">
            Open full size
          </a>
          {activeDocument.fileKind === "link" ? null : (
            <a href={`${fileUrl}?download=1`} data-quiet="true" className="vl-coa-cta vl-focus-ring px-6 sm:w-auto sm:min-w-[13rem]">
              Download document
            </a>
          )}
        </footer>
      </div>
    </div>
  );
}

function CoaDocument({
  document: doc,
  fileUrl,
  zoom,
  expanded,
}: {
  document: PublicCoaDocument;
  fileUrl: string;
  zoom: number;
  expanded: boolean;
}) {
  // The document loads only once the viewer is open — a grid of full-resolution
  // lab reports behind a closed modal is the fastest way to ruin this page.
  const height = expanded ? "h-[62vh] sm:h-[68vh]" : "h-[46vh] sm:h-[58vh]";

  if (doc.fileKind === "pdf") {
    return (
      <div className={`vl-coa-doc-frame ${height}`}>
        <iframe
          src={fileUrl}
          title={`Certificate of Analysis — batch ${doc.batchNumber}`}
          className="h-full w-full border-0"
        />
      </div>
    );
  }

  if (doc.fileKind === "image") {
    return (
      <div className={`vl-coa-doc-frame ${height}`}>
        {/* Width-based zoom rather than a transform: the frame's own scrollbars
            then pan the document, which is what a reader actually needs.
            Plain <img> on purpose — next/image would route this through the
            optimizer, and those bytes sit behind a publish check that a cached
            copy would outlive. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={fileUrl}
          alt={`Certificate of Analysis for batch ${doc.batchNumber}`}
          style={{ width: `${zoom * 100}%` }}
          className="block max-w-none"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div className="flex h-36 items-center justify-center rounded-2xl border border-dashed border-white/12 px-6 text-center">
      <p className="text-sm text-white/50">This report is hosted externally and opens in a new tab.</p>
    </div>
  );
}

export function CoaLibraryPageClient({ snapshot }: { snapshot: CoaLibrarySnapshot }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [category, setCategory] = useState("All");
  const [openProductId, setOpenProductId] = useState<string | null>(null);

  const trustIndicators = useMemo(() => buildTrustIndicators(snapshot), [snapshot]);

  const categories = useMemo(() => {
    const found = Array.from(new Set(snapshot.products.map((product) => product.category))).filter(Boolean).sort();
    return ["All", ...found];
  }, [snapshot.products]);

  const visibleProducts = useMemo(
    () =>
      snapshot.products.filter((product) => {
        const verified = product.documents.length > 0;
        if (status === "verified" && !verified) return false;
        if (status === "pending" && verified) return false;
        if (category !== "All" && product.category !== category) return false;
        return matchesCoaSearch(coaSearchHaystack(product), query);
      }),
    [category, query, snapshot.products, status],
  );

  const openProduct = useMemo(
    () => snapshot.products.find((product) => product.productId === openProductId) ?? null,
    [openProductId, snapshot.products],
  );

  const closeViewer = useCallback(() => setOpenProductId(null), []);

  // Two real product shots, masked out of their rectangles and dimmed almost to
  // nothing, framing the headline. The catalog placeholder is excluded — it is a
  // screenshot, and it would read as a white tile floating in the hero.
  const heroVials = useMemo(
    () => snapshot.products.filter((product) => isRealProductPhoto(product.imageUrl)).slice(0, 2),
    [snapshot.products],
  );

  const hasAnyProducts = snapshot.products.length > 0;
  const pendingCount = snapshot.products.length - snapshot.documentedProductCount;

  return (
    <div className="vl-coa-page min-h-screen">
      <SiteHeaderV2 />

      <main>
        {/* ——— Hero ——————————————————————————————————————————————————— */}
        <section className="relative overflow-hidden">
          <div className="vl-coa-aurora" aria-hidden />

          {heroVials.map((product, index) => (
            <div
              key={product.productId}
              aria-hidden
              className={`pointer-events-none absolute top-1/2 hidden h-[26rem] w-[19rem] -translate-y-1/2 lg:block xl:h-[30rem] xl:w-[22rem] ${
                index === 0 ? "left-[-3rem] xl:left-[-1rem]" : "right-[-3rem] xl:right-[-1rem]"
              }`}
            >
              <div
                className="absolute inset-[16%] rounded-full"
                style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(196,216,244,0.11), transparent 70%)" }}
              />
              {/* Atmosphere, not merchandising. Thrown out of focus as well as
                  dimmed: at 15% opacity alone the label text was still legible,
                  and a reader who can read "99% PURITY" in the background is
                  reading the background instead of the headline. Depth of field
                  is what makes these read as objects in the room. */}
              <Image
                src={product.imageUrl}
                alt=""
                fill
                sizes="22rem"
                className={`vl-coa-vial object-cover opacity-[0.13] blur-[3px] ${index === 0 ? "-rotate-6" : "rotate-6"}`}
              />
            </div>
          ))}

          <div className="relative mx-auto max-w-[1180px] px-5 pb-12 pt-28 text-center sm:px-6 sm:pb-16 sm:pt-36 lg:px-10">
            <p className="vl2-eyebrow">Independent Testing</p>
            <h1
              className="vl2-serif mx-auto mt-5 max-w-4xl text-[2.65rem] leading-[1.02] text-white sm:text-6xl lg:text-[4.5rem]"
              style={{ textShadow: "0 0 60px rgba(226,236,252,0.16)" }}
            >
              Certificates of Analysis
            </h1>
            <p className="mx-auto mt-6 max-w-[34rem] text-[0.9375rem] leading-7 text-white/50 sm:text-base">
              Independent third-party analytical documentation and batch verification for Vanta Labs
              research products.
            </p>

            {trustIndicators.length > 0 ? (
              <ul className="mt-9 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-2.5 sm:mt-11 sm:gap-x-3">
                {trustIndicators.map((indicator) => (
                  <li
                    key={indicator}
                    className="inline-flex items-center gap-2 rounded-full border border-white/[0.085] bg-white/[0.022] px-3.5 py-2 text-[11px] font-medium tracking-[0.04em] text-white/65 sm:text-xs"
                  >
                    <CheckIcon className="h-3 w-3 text-[color:var(--accent-gold)]" />
                    {indicator}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mx-auto mt-9 max-w-lg text-[13px] leading-6 text-white/38">
                Batch records are published here as testing is completed. Contact our team for
                documentation on a specific batch in the meantime.
              </p>
            )}
          </div>
        </section>

        {hasAnyProducts ? (
          <>
            {/* ——— Search + filters ————————————————————————————————— */}
            <section className="mx-auto max-w-[1180px] px-5 sm:px-6 lg:px-10">
              <label className="vl-coa-search vl-focus-ring relative mx-auto flex max-w-2xl items-center">
                <span className="sr-only">{SEARCH_PLACEHOLDER}</span>
                <SearchIcon className="pointer-events-none absolute left-5 h-[18px] w-[18px] text-white/30" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={SEARCH_PLACEHOLDER}
                  className="h-[54px] w-full rounded-full bg-transparent pl-[3.25rem] pr-5 text-[15px] text-white outline-none placeholder:text-white/33 sm:h-[58px]"
                />
              </label>

              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {STATUS_FILTERS.map((item) => {
                  const count =
                    item.key === "all"
                      ? snapshot.products.length
                      : item.key === "verified"
                        ? snapshot.documentedProductCount
                        : pendingCount;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setStatus(item.key)}
                      data-active={status === item.key}
                      aria-pressed={status === item.key}
                      className="vl-coa-pill vl-focus-ring min-h-[42px] px-4 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    >
                      <span className="sm:hidden">{item.shortLabel}</span>
                      <span className="hidden sm:inline">{item.label}</span>
                      <span className="opacity-55">{count}</span>
                    </button>
                  );
                })}
              </div>

              {categories.length > 2 ? (
                <div className="mx-auto mt-3 flex max-w-3xl flex-wrap justify-center gap-2">
                  {categories.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setCategory(item)}
                      data-active={category === item}
                      aria-pressed={category === item}
                      data-tone="quiet"
                      className="vl-coa-pill vl-focus-ring min-h-[38px] px-3.5 text-[12px] font-medium"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
            </section>

            {/* ——— Archive ——————————————————————————————————————————— */}
            <section className="mx-auto max-w-[1180px] px-5 pb-24 pt-10 sm:px-6 sm:pt-12 lg:px-10">
              {visibleProducts.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 lg:gap-6">
                  {visibleProducts.map((product) => (
                    <ProductCoaCard
                      key={product.productId}
                      product={product}
                      onOpen={(item) => setOpenProductId(item.productId)}
                    />
                  ))}
                </div>
              ) : (
                <div className="mx-auto max-w-lg rounded-3xl border border-white/[0.07] bg-white/[0.012] px-6 py-16 text-center">
                  <h2 className="vl2-serif text-xl text-white sm:text-2xl">No matching records</h2>
                  <p className="mt-3 text-sm leading-7 text-white/42">
                    Nothing matched the current filters. Try a product name, a batch number, or clear
                    them and browse the full archive.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setCategory("All");
                      setStatus("all");
                    }}
                    className="vl-coa-cta vl-focus-ring mx-auto mt-7 w-auto px-7"
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </section>
          </>
        ) : (
          <section className="mx-auto max-w-[1180px] px-5 pb-24 pt-8 sm:px-6 lg:px-10">
            <div className="mx-auto max-w-xl rounded-3xl border border-white/[0.07] bg-white/[0.012] px-6 py-16 text-center">
              <h2 className="vl2-serif text-2xl text-white sm:text-3xl">The archive is being prepared</h2>
              <p className="mt-4 text-sm leading-7 text-white/45">
                Batch documentation will be published here as it is released. Contact our team and we
                will provide the testing records available for the batch you are researching.
              </p>
              <Link href="/contact" className="vl-coa-cta vl-focus-ring mx-auto mt-8 w-auto px-8">
                Contact support
              </Link>
            </div>
          </section>
        )}

        <div className="vl-coa-seam" />
        <CoaTestingDisclosure hasPublishedRecords={snapshot.totalDocumentCount > 0} />
      </main>

      {openProduct ? <CoaViewer product={openProduct} onClose={closeViewer} /> : null}
    </div>
  );
}
