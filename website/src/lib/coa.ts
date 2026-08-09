import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCatalogProducts } from "@/lib/catalog";
import { getControlSnapshot } from "@/lib/admin-control";
import { sanitizeCoaUrl } from "@/lib/coa-url";
import {
  compareCoaDocuments,
  coaFileKindFromMime,
  formatCoaPurity,
  formatCoaTextResult,
  normalizeCoaStatus,
} from "@/lib/coa-format";
import {
  DEFAULT_COA_LIBRARY_SETTINGS,
  type CoaFileKind,
  type CoaLibraryProduct,
  type CoaLibrarySettings,
  type CoaLibrarySnapshot,
  type PublicCoaDocument,
} from "@/lib/coa-types";

// DELIBERATELY UNCACHED.
//
// The owner's test of this feature is "upload, hit Publish, see it on the
// site" — a response cache in front of that turns a working publish into a
// support question. The library is two small queries, and the expensive half
// (the product catalog) is already cached under CATALOG_CACHE_TAG, so the
// marginal cost of always-fresh COA data is one indexed read.
const COA_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour
export const COA_BUCKET = "coa-documents";

export const COA_SETTINGS_SECTION = "coa";
const COA_SETTINGS_SHOW_PENDING_KEY = "show_pending_products";

type CoaRow = {
  id: string;
  product_id: string;
  product_dose_id: string | null;
  strength: string | null;
  batch_number: string | null;
  lot_number: string | null;
  lab_name: string | null;
  test_date: string | null;
  purity: string | null;
  identity_result: string | null;
  file_path: string | null;
  external_url: string | null;
  file_name: string | null;
  file_type: string | null;
  file_size_bytes: number | null;
  status: string | null;
  created_at: string;
  updated_at: string;
};

const COA_SELECT_COLUMNS =
  "id, product_id, product_dose_id, strength, batch_number, lot_number, lab_name, test_date, purity, identity_result, file_path, external_url, file_name, file_type, file_size_bytes, status, created_at, updated_at";

/**
 * How the document is reachable. `file_path` (private bucket) wins over
 * `external_url` (a link typed in admin, or carried over from the legacy
 * `products.coa_url`) so replacing a link with a real upload takes effect
 * without having to clear the old field.
 */
export function resolveCoaFileKind(row: Pick<CoaRow, "file_path" | "external_url" | "file_type">): CoaFileKind {
  if (row.file_path) {
    return coaFileKindFromMime(row.file_type) ?? "pdf";
  }
  if (sanitizeCoaUrl(row.external_url)) {
    return "link";
  }
  return "link";
}

export function coaRowHasFile(row: Pick<CoaRow, "file_path" | "external_url">): boolean {
  return Boolean(row.file_path) || Boolean(sanitizeCoaUrl(row.external_url));
}

function toPublicDocument(row: CoaRow): PublicCoaDocument {
  return {
    id: String(row.id),
    batchNumber: String(row.batch_number ?? "").trim(),
    lotNumber: row.lot_number?.trim() || null,
    strength: row.strength?.trim() || null,
    labName: row.lab_name?.trim() || null,
    testDate: row.test_date ? String(row.test_date).slice(0, 10) : null,
    purity: formatCoaPurity(row.purity),
    identityResult: formatCoaTextResult(row.identity_result),
    fileKind: resolveCoaFileKind(row),
    fileName: row.file_name?.trim() || null,
    hasFile: coaRowHasFile(row),
  };
}

async function fetchPublishedCoaRows(): Promise<CoaRow[]> {
  const { data, error } = await supabaseAdmin
    .from("coa_records")
    .select(COA_SELECT_COLUMNS)
    .eq("status", "published")
    .order("test_date", { ascending: false, nullsFirst: false });

  if (error) {
    throw error;
  }

  return (data ?? []) as CoaRow[];
}

export async function getCoaLibrarySettings(): Promise<CoaLibrarySettings> {
  try {
    const snapshot = await getControlSnapshot(COA_SETTINGS_SECTION);
    const cfg = (snapshot[COA_SETTINGS_SECTION] ?? {}) as Record<string, unknown>;
    const raw = cfg[COA_SETTINGS_SHOW_PENDING_KEY];
    const showPendingProducts =
      typeof raw === "boolean" ? raw : typeof raw === "string" ? raw.toLowerCase() !== "false" : DEFAULT_COA_LIBRARY_SETTINGS.showPendingProducts;
    return { showPendingProducts };
  } catch {
    // An unreadable setting must not empty the library — fall back to showing
    // everything, which is the state the page is designed to look good in.
    return DEFAULT_COA_LIBRARY_SETTINGS;
  }
}

export async function getCoaLibrarySnapshot(): Promise<CoaLibrarySnapshot> {
  const [products, rows, settings] = await Promise.all([
    getCatalogProducts(),
    fetchPublishedCoaRows().catch((error) => {
      // The table may not exist yet on an install that hasn't run
      // src/lib/sql/coa-library.sql. That is a "no COAs yet" state, not a
      // 500 — the page still renders every product as Documentation Pending.
      console.error("COA library: unable to read coa_records", error);
      return [] as CoaRow[];
    }),
    getCoaLibrarySettings(),
  ]);

  const documentsByProductId = new Map<string, PublicCoaDocument[]>();
  for (const row of rows) {
    // A published record with no reachable document is a broken promise, not a
    // COA. Drop it rather than render a "View COA" that 404s.
    if (!coaRowHasFile(row)) continue;
    const productId = String(row.product_id);
    const current = documentsByProductId.get(productId) ?? [];
    current.push(toPublicDocument(row));
    documentsByProductId.set(productId, current);
  }

  const libraryProducts: CoaLibraryProduct[] = [];
  for (const product of products) {
    const productId = product.id ? String(product.id) : "";
    if (!productId) continue;

    const documents = (documentsByProductId.get(productId) ?? []).sort(compareCoaDocuments);
    if (documents.length === 0 && !settings.showPendingProducts) {
      continue;
    }

    const defaultDose = product.doses?.find((dose) => dose.isDefault) ?? product.doses?.[0];

    libraryProducts.push({
      productId,
      slug: product.slug,
      name: product.name,
      category: product.category,
      strength: defaultDose?.label?.trim() || null,
      imageUrl: product.image || "/images/vantalabs.png",
      documents,
    });
  }

  // Documented products first — the page should open on evidence, not on
  // pending rows — then alphabetically inside each group.
  libraryProducts.sort((a, b) => {
    if ((a.documents.length > 0) !== (b.documents.length > 0)) {
      return a.documents.length > 0 ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const documented = libraryProducts.filter((product) => product.documents.length > 0);
  const allDocuments = documented.flatMap((product) => product.documents);

  return {
    products: libraryProducts,
    documentedProductCount: documented.length,
    totalDocumentCount: allDocuments.length,
    hasLabAttribution: allDocuments.some((doc) => Boolean(doc.labName)),
    hasIdentityVerification: allDocuments.some((doc) => Boolean(doc.identityResult)),
  };
}

/** Published COAs for one product — used by the product page's COA panel. */
export async function getPublishedCoaDocumentsForProduct(productId: string): Promise<PublicCoaDocument[]> {
  if (!productId) return [];
  try {
    const { data, error } = await supabaseAdmin
      .from("coa_records")
      .select(COA_SELECT_COLUMNS)
      .eq("product_id", productId)
      .eq("status", "published");

    if (error) throw error;

    return ((data ?? []) as CoaRow[])
      .filter(coaRowHasFile)
      .map(toPublicDocument)
      .sort(compareCoaDocuments);
  } catch (error) {
    console.error("COA library: unable to read product COAs", error);
    return [];
  }
}

export type ResolvedCoaFile = {
  url: string;
  fileKind: CoaFileKind;
  fileName: string;
  /** True when the URL points at a third-party host rather than our bucket. */
  isExternal: boolean;
};

function fallbackFileName(row: CoaRow): string {
  const batch = (row.batch_number ?? "coa").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const kind = resolveCoaFileKind(row);
  const extension = row.file_path?.split(".").pop();
  if (extension && /^[a-z0-9]{2,5}$/i.test(extension)) {
    return `coa-${batch || "record"}.${extension.toLowerCase()}`;
  }
  return kind === "pdf" ? `coa-${batch || "record"}.pdf` : `coa-${batch || "record"}`;
}

/**
 * A URL a browser can open for one COA, or null.
 *
 * NOT cached and re-reads status on every call, deliberately: unpublishing a
 * record has to cut off access immediately, and a cached "published" answer
 * would keep the document reachable for the rest of the TTL. `requirePublished`
 * is false only for the admin preview route, which has already checked a session.
 */
export async function resolveCoaFileUrl(input: {
  coaId: string;
  requirePublished: boolean;
  download?: boolean;
}): Promise<ResolvedCoaFile | null> {
  const coaId = String(input.coaId ?? "").trim();
  if (!coaId) return null;

  const { data, error } = await supabaseAdmin
    .from("coa_records")
    .select(COA_SELECT_COLUMNS)
    .eq("id", coaId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const row = data as CoaRow;

  if (input.requirePublished && normalizeCoaStatus(row.status) !== "published") {
    return null;
  }

  // A COA is only public if the product it belongs to is. Unpublishing a
  // product must take its documents down with it, otherwise a delisted batch
  // stays reachable through a shared link.
  if (input.requirePublished) {
    const { data: productRow } = await supabaseAdmin
      .from("products")
      .select("id")
      .eq("id", row.product_id)
      .eq("is_active", true)
      .eq("is_enabled", true)
      .eq("is_published", true)
      .eq("is_archived", false)
      .maybeSingle();
    if (!productRow) return null;
  }

  const fileName = row.file_name?.trim() || fallbackFileName(row);

  if (row.file_path) {
    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(COA_BUCKET)
      .createSignedUrl(
        row.file_path,
        COA_SIGNED_URL_TTL_SECONDS,
        input.download ? { download: fileName } : undefined,
      );

    if (signedError || !signed?.signedUrl) {
      return null;
    }

    return {
      url: signed.signedUrl,
      fileKind: resolveCoaFileKind(row),
      fileName,
      isExternal: false,
    };
  }

  const externalUrl = sanitizeCoaUrl(row.external_url);
  if (!externalUrl) {
    return null;
  }

  return { url: externalUrl, fileKind: "link", fileName, isExternal: true };
}
