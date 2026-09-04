// ---------------------------------------------------------------------------
// Pure helpers shared by the COA library, the admin console and the upload
// route. Kept free of `server-only` and of Supabase so both sides — and the
// test suite — can import them.
//
// The rule every function here exists to serve: NEVER SHOW A NUMBER THAT ISN'T
// DOCUMENTED. A COA page that renders "99.9%" as a placeholder is worse than a
// blank one, because the blank one doesn't make a claim.
// ---------------------------------------------------------------------------

import type { CoaFileKind, CoaStatus, PublicCoaDocument } from "@/lib/coa-types";

export const COA_STATUSES: CoaStatus[] = ["draft", "published", "archived"];

export function normalizeCoaStatus(value: unknown): CoaStatus {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (COA_STATUSES as string[]).includes(candidate) ? (candidate as CoaStatus) : "draft";
}

// A COA is a lab report: a PDF, or a scan/photo of one. Nothing else is
// accepted, and the allow-list is checked against the file's actual bytes
// (sniffCoaFileType) rather than the client-supplied Content-Type.
export const COA_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type CoaMimeType = (typeof COA_ALLOWED_MIME_TYPES)[number];

/** Vercel rejects request bodies over ~4.5 MB before the route ever runs. */
export const COA_MAX_FILE_BYTES = 4 * 1024 * 1024;

export function coaFileKindFromMime(mime: string | null | undefined): CoaFileKind | null {
  const value = String(mime ?? "").trim().toLowerCase();
  if (value === "application/pdf") return "pdf";
  if (value === "image/png" || value === "image/jpeg" || value === "image/jpg" || value === "image/webp") {
    return "image";
  }
  return null;
}

/**
 * The real type of the uploaded bytes, or null if they aren't a COA document.
 *
 * Declared Content-Type is attacker-controlled on any multipart upload, and the
 * value ends up deciding whether the browser renders the object inline. Sniffing
 * the magic bytes is what keeps an .html payload from being stored as a "PDF".
 */
export function sniffCoaFileType(bytes: Uint8Array): CoaMimeType | null {
  if (bytes.length < 12) return null;

  // %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  // PNG \x89PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  // JPEG FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function coaFileExtension(mime: CoaMimeType): string {
  switch (mime) {
    case "application/pdf":
      return "pdf";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

/** Lowercase, hyphenated, storage-safe. Empty input yields a stable fallback. */
export function slugifyCoaSegment(value: string, fallback: string): string {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/**
 * Object key inside the `coa-documents` bucket.
 *
 * Readable on purpose — `bpc-157/vl-bpc-0826/<uuid>.pdf` — so the Supabase
 * storage browser is navigable when someone needs to find a file by hand. The
 * uuid keeps two uploads for the same batch from colliding, which is what makes
 * "Replace file" safe to run without ever overwriting the previous document
 * before the new row is committed.
 */
export function buildCoaStoragePath(input: {
  productSlug: string;
  batchNumber: string;
  uniqueId: string;
  mime: CoaMimeType;
}): string {
  const product = slugifyCoaSegment(input.productSlug, "product");
  const batch = slugifyCoaSegment(input.batchNumber, "batch");
  const unique = slugifyCoaSegment(input.uniqueId, "file");
  return `${product}/${batch}/${unique}.${coaFileExtension(input.mime)}`;
}

/** Collapses whitespace and caps length; batch numbers are typed by hand. */
export function normalizeCoaText(value: unknown, maxLength = 120): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * A stored purity value rendered for display, or null when there is nothing
 * documented. Bare numbers get a % so "99.2" and "99.2%" read identically;
 * operator placeholders ("pending", "TBD", "N/A") resolve to null rather than
 * becoming a claim.
 */
export function formatCoaPurity(raw: unknown): string | null {
  const value = normalizeCoaText(raw, 40);
  if (!value) return null;
  if (/^(n\/?a|none|pending|tbd|unknown|-+)$/i.test(value)) return null;
  if (/^\d{1,3}(\.\d+)?$/.test(value)) return `${value}%`;
  return value;
}

/** Same placeholder rule as purity, for free-text fields like identity. */
export function formatCoaTextResult(raw: unknown): string | null {
  const value = normalizeCoaText(raw, 160);
  if (!value) return null;
  if (/^(n\/?a|none|pending|tbd|unknown|-+)$/i.test(value)) return null;
  return value;
}

/**
 * `YYYY-MM-DD` -> "Aug 4, 2026", parsed as a calendar date rather than an
 * instant. `new Date("2026-08-04")` is midnight UTC, which renders as Aug 3 for
 * every viewer west of Greenwich — a testing date that reads a day early is a
 * documentation error.
 */
export function formatCoaTestDate(raw: unknown): string | null {
  const value = normalizeCoaText(raw, 32);
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Normalizes a date input value to the `YYYY-MM-DD` the column stores. */
export function normalizeCoaDateInput(raw: unknown): string | null {
  const value = normalizeCoaText(raw, 32);
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : null;
}

/** Bytes as a short human string for the admin file column. */
export function formatCoaFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Everything a customer might type into the search box, flattened.
 * Product name, category, strength, batch, lot, and lab all match.
 */
export function coaSearchHaystack(input: {
  name: string;
  category?: string | null;
  slug?: string | null;
  strength?: string | null;
  documents?: Array<Pick<PublicCoaDocument, "batchNumber" | "lotNumber" | "labName" | "strength">>;
}): string {
  const parts: Array<string | null | undefined> = [
    input.name,
    input.category,
    input.slug,
    input.strength,
  ];
  for (const doc of input.documents ?? []) {
    parts.push(doc.batchNumber, doc.lotNumber, doc.labName, doc.strength);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

/**
 * Every whitespace-separated term must appear somewhere in the haystack, so
 * "bpc 0826" finds BPC-157 batch VL-BPC-0826 while a single wrong term still
 * narrows the grid instead of silently matching everything.
 */
export function matchesCoaSearch(haystack: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((term) => haystack.includes(term));
}

/** Newest batch first; records with no test date sort last, then by batch. */
export function compareCoaDocuments(
  a: Pick<PublicCoaDocument, "testDate" | "batchNumber">,
  b: Pick<PublicCoaDocument, "testDate" | "batchNumber">,
): number {
  if (a.testDate && b.testDate && a.testDate !== b.testDate) {
    return a.testDate < b.testDate ? 1 : -1;
  }
  if (a.testDate && !b.testDate) return -1;
  if (!a.testDate && b.testDate) return 1;
  return a.batchNumber.localeCompare(b.batchNumber);
}

// ---------------------------------------------------------------------------
// Dose ordering. One product accumulates a certificate per dose per production
// run (GLP-3 5mg, 10mg, 15mg…), and a reader who opened the viewer to compare
// doses needs them in dose order, not upload order.
// ---------------------------------------------------------------------------

/**
 * A dose label reduced to something two spellings of the same dose agree on:
 * "5 mg", "5mg" and "5MG" are one dose. Empty for a record with no dose.
 */
export function coaStrengthKey(label: string | null | undefined): string {
  return String(label ?? "").toLowerCase().replace(/\s+/g, "");
}

/**
 * The numeric part of a dose label, in milligrams, or null when the label
 * carries none. Micrograms and grams are scaled so a catalogue that mixes units
 * still orders by dose; a unit this doesn't know keeps its bare number, which
 * is right as long as one product sticks to one unit — and it does.
 */
export function parseCoaStrengthValue(label: string | null | undefined): number | null {
  const match = coaStrengthKey(label).match(/(\d+(?:\.\d+)?)\s*([a-zµ]*)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  if (unit === "mcg" || unit === "µg" || unit === "ug") return value / 1000;
  if (unit === "g" || unit === "gram" || unit === "grams") return value * 1000;
  return value;
}

/**
 * Lowest dose first, records with no dose last, newest batch first within a
 * dose. Two labels that mean the same dose sort together whatever their
 * spelling; two labels with no readable number fall back to text order so the
 * result is still stable.
 */
export function compareCoaDocumentsByStrength(
  a: Pick<PublicCoaDocument, "strength" | "testDate" | "batchNumber">,
  b: Pick<PublicCoaDocument, "strength" | "testDate" | "batchNumber">,
): number {
  const keyA = coaStrengthKey(a.strength);
  const keyB = coaStrengthKey(b.strength);
  if (keyA !== keyB) {
    if (!keyA) return 1;
    if (!keyB) return -1;
    const valueA = parseCoaStrengthValue(keyA);
    const valueB = parseCoaStrengthValue(keyB);
    if (valueA !== null && valueB !== null && valueA !== valueB) {
      return valueA - valueB;
    }
    if (valueA !== null && valueB === null) return -1;
    if (valueA === null && valueB !== null) return 1;
    if (valueA === null && valueB === null) return keyA.localeCompare(keyB);
    // Same value, different spelling ("5mg" / "5 mg"): fall through and order
    // by date so the two read as one dose.
  }
  return compareCoaDocuments(a, b);
}

/**
 * Every dose that has at least one record, once each, lowest first, spelled
 * the way its first record spells it. Records with no dose are left out — they
 * have nothing to label a pill with.
 */
export function listCoaStrengths(
  documents: Array<Pick<PublicCoaDocument, "strength" | "testDate" | "batchNumber">>,
): string[] {
  const seen = new Set<string>();
  const strengths: string[] = [];
  for (const doc of [...documents].sort(compareCoaDocumentsByStrength)) {
    const key = coaStrengthKey(doc.strength);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    strengths.push(String(doc.strength).trim());
  }
  return strengths;
}
