import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { upsertControlValue } from "@/lib/admin-control";
import { sanitizeCoaUrl } from "@/lib/coa-url";
import { COA_BUCKET, COA_SETTINGS_SECTION, coaRowHasFile, resolveCoaFileKind } from "@/lib/coa";
import {
  buildCoaStoragePath,
  COA_ALLOWED_MIME_TYPES,
  COA_MAX_FILE_BYTES,
  normalizeCoaDateInput,
  normalizeCoaStatus,
  normalizeCoaText,
  sniffCoaFileType,
  type CoaMimeType,
} from "@/lib/coa-format";
import type { AdminCoaRecord, CoaProductOption, CoaStatus } from "@/lib/coa-types";

const ADMIN_COA_SELECT =
  "id, product_id, product_dose_id, strength, batch_number, lot_number, lab_name, test_date, purity, identity_result, file_path, external_url, file_name, file_type, file_size_bytes, status, created_at, updated_at";

type AdminCoaRow = {
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

export interface CoaRecordInput {
  productId: string;
  productDoseId?: string | null;
  strength?: string | null;
  batchNumber: string;
  lotNumber?: string | null;
  labName?: string | null;
  testDate?: string | null;
  purity?: string | null;
  identityResult?: string | null;
  externalUrl?: string | null;
  status?: CoaStatus;
}

export interface CoaUploadPayload {
  fileName: string;
  bytes: ArrayBuffer;
  declaredType: string;
}

export class CoaValidationError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new CoaValidationError(message);
  }
}

function mapAdminRow(row: AdminCoaRow, productName: string, productSlug: string): AdminCoaRecord {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    productName,
    productSlug,
    productDoseId: row.product_dose_id ? String(row.product_dose_id) : null,
    strength: row.strength?.trim() || null,
    batchNumber: String(row.batch_number ?? "").trim(),
    lotNumber: row.lot_number?.trim() || null,
    labName: row.lab_name?.trim() || null,
    testDate: row.test_date ? String(row.test_date).slice(0, 10) : null,
    // Admin sees the raw stored value, unlike the storefront: the operator has
    // to be able to spot and fix a typo they made, not a prettified version of it.
    purity: row.purity?.trim() || null,
    identityResult: row.identity_result?.trim() || null,
    status: normalizeCoaStatus(row.status),
    fileKind: resolveCoaFileKind(row),
    fileName: row.file_name?.trim() || null,
    fileSizeBytes: typeof row.file_size_bytes === "number" ? row.file_size_bytes : null,
    hasFile: coaRowHasFile(row),
    externalUrl: sanitizeCoaUrl(row.external_url) || null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface AdminCoaFilters {
  search?: string;
  productId?: string;
  status?: CoaStatus | "all";
}

export async function listAdminCoaRecords(filters: AdminCoaFilters = {}): Promise<AdminCoaRecord[]> {
  let query = supabaseAdmin
    .from("coa_records")
    .select(ADMIN_COA_SELECT)
    .order("created_at", { ascending: false });

  if (filters.productId) {
    query = query.eq("product_id", filters.productId);
  }
  if (filters.status && filters.status !== "all") {
    query = query.eq("status", filters.status);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as AdminCoaRow[];
  const productIds = Array.from(new Set(rows.map((row) => String(row.product_id))));
  const productsById = new Map<string, { name: string; slug: string }>();

  if (productIds.length > 0) {
    const { data: productRows } = await supabaseAdmin
      .from("products")
      .select("id, name, slug")
      .in("id", productIds);
    for (const product of productRows ?? []) {
      productsById.set(String(product.id), {
        name: String(product.name ?? "Unknown product"),
        slug: String(product.slug ?? ""),
      });
    }
  }

  const mapped = rows.map((row) => {
    const product = productsById.get(String(row.product_id));
    return mapAdminRow(row, product?.name ?? "Unknown product", product?.slug ?? "");
  });

  const search = normalizeCoaText(filters.search ?? "", 80).toLowerCase();
  if (!search) {
    return mapped;
  }

  return mapped.filter((record) =>
    [record.productName, record.batchNumber, record.lotNumber, record.labName, record.strength]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search),
  );
}

/** Every product in the catalog, published or not, for the "Add COA" dropdown. */
export async function listCoaProductOptions(): Promise<CoaProductOption[]> {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, name, slug, category, is_published, is_archived")
    .eq("is_archived", false)
    .order("name", { ascending: true });

  if (error) {
    throw error;
  }

  const products = (data ?? []) as Array<Record<string, unknown>>;
  const productIds = products.map((product) => String(product.id));

  const strengthsByProductId = new Map<string, Array<{ id: string; label: string }>>();
  if (productIds.length > 0) {
    const { data: doseRows } = await supabaseAdmin
      .from("product_doses")
      .select("id, product_id, label, position")
      .in("product_id", productIds)
      .order("position", { ascending: true });

    for (const dose of doseRows ?? []) {
      const productId = String(dose.product_id);
      const label = String(dose.label ?? "").trim();
      if (!label) continue;
      const current = strengthsByProductId.get(productId) ?? [];
      current.push({ id: String(dose.id), label });
      strengthsByProductId.set(productId, current);
    }
  }

  return products.map((product) => ({
    id: String(product.id),
    name: String(product.name ?? ""),
    slug: String(product.slug ?? ""),
    category: String(product.category ?? "Research Peptides"),
    isPublished: product.is_published !== false,
    strengths: strengthsByProductId.get(String(product.id)) ?? [],
  }));
}

async function requireProduct(productId: string) {
  const id = normalizeCoaText(productId, 64);
  assert(id, "Choose a product for this COA.");

  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, name, slug")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  assert(data, "That product no longer exists.");

  return { id: String(data.id), name: String(data.name ?? ""), slug: String(data.slug ?? "") };
}

/**
 * Validates the uploaded bytes and puts them in the private bucket.
 *
 * The declared Content-Type is only used for a fast reject; the stored type
 * comes from the file's own magic bytes, so a script renamed to `.pdf` cannot
 * end up served back with a PDF content type.
 */
async function uploadCoaObject(input: {
  productSlug: string;
  batchNumber: string;
  upload: CoaUploadPayload;
}): Promise<{ path: string; mime: CoaMimeType; sizeBytes: number; fileName: string }> {
  const { upload } = input;
  const sizeBytes = upload.bytes.byteLength;

  assert(sizeBytes > 0, "That file is empty.");
  assert(
    sizeBytes <= COA_MAX_FILE_BYTES,
    `COA files must be ${Math.floor(COA_MAX_FILE_BYTES / (1024 * 1024))} MB or smaller.`,
  );

  const declared = upload.declaredType.trim().toLowerCase();
  assert(
    (COA_ALLOWED_MIME_TYPES as readonly string[]).includes(declared) || declared === "image/jpg" || declared === "",
    "COA files must be a PDF, PNG, JPG, or WEBP.",
  );

  const mime = sniffCoaFileType(new Uint8Array(upload.bytes));
  assert(mime, "That file doesn't look like a PDF or an image.");

  const path = buildCoaStoragePath({
    productSlug: input.productSlug,
    batchNumber: input.batchNumber,
    uniqueId: randomUUID(),
    mime,
  });

  const { error } = await supabaseAdmin.storage
    .from(COA_BUCKET)
    .upload(path, upload.bytes, { contentType: mime, upsert: false });

  if (error) {
    throw new Error(`Unable to store the COA file: ${error.message}`);
  }

  const safeName = normalizeCoaText(upload.fileName, 120).replace(/[^a-zA-Z0-9._ -]+/g, "") || `coa.${mime.split("/")[1]}`;

  return { path, mime, sizeBytes, fileName: safeName };
}

async function removeCoaObject(path: string | null | undefined) {
  if (!path) return;
  try {
    await supabaseAdmin.storage.from(COA_BUCKET).remove([path]);
  } catch (error) {
    // A stranded object is a housekeeping problem, not a reason to fail the
    // operation the operator actually asked for. Logged so it can be swept.
    console.error("COA library: unable to remove storage object", path, error);
  }
}

function buildRecordPayload(input: CoaRecordInput) {
  const batchNumber = normalizeCoaText(input.batchNumber, 80);
  assert(batchNumber, "A batch or lot number is required.");

  const externalUrlRaw = normalizeCoaText(input.externalUrl ?? "", 500);
  const externalUrl = externalUrlRaw ? sanitizeCoaUrl(externalUrlRaw) : "";
  assert(
    !externalUrlRaw || externalUrl,
    "The COA link must be a full http(s) URL, or leave it blank and upload a file.",
  );

  return {
    product_dose_id: input.productDoseId ? normalizeCoaText(input.productDoseId, 64) : null,
    strength: normalizeCoaText(input.strength ?? "", 40) || null,
    batch_number: batchNumber,
    lot_number: normalizeCoaText(input.lotNumber ?? "", 80) || null,
    lab_name: normalizeCoaText(input.labName ?? "", 120) || null,
    test_date: normalizeCoaDateInput(input.testDate),
    purity: normalizeCoaText(input.purity ?? "", 40) || null,
    identity_result: normalizeCoaText(input.identityResult ?? "", 160) || null,
    external_url: externalUrl || null,
    status: normalizeCoaStatus(input.status ?? "draft"),
  };
}

export async function createAdminCoaRecord(
  input: CoaRecordInput & { upload?: CoaUploadPayload | null },
): Promise<AdminCoaRecord> {
  const product = await requireProduct(input.productId);
  const payload = buildRecordPayload(input);

  assert(
    Boolean(input.upload) || Boolean(payload.external_url),
    "Attach a COA file, or paste a link to one.",
  );

  let uploaded: Awaited<ReturnType<typeof uploadCoaObject>> | null = null;
  if (input.upload) {
    uploaded = await uploadCoaObject({
      productSlug: product.slug,
      batchNumber: payload.batch_number,
      upload: input.upload,
    });
  }

  const { data, error } = await supabaseAdmin
    .from("coa_records")
    .insert({
      product_id: product.id,
      ...payload,
      file_path: uploaded?.path ?? null,
      file_name: uploaded?.fileName ?? null,
      file_type: uploaded?.mime ?? (payload.external_url ? "link" : null),
      file_size_bytes: uploaded?.sizeBytes ?? null,
    })
    .select(ADMIN_COA_SELECT)
    .single();

  if (error || !data) {
    // The row is what makes the object findable. Without it the upload is
    // unreachable dead weight in the bucket, so it goes back out.
    await removeCoaObject(uploaded?.path);
    throw error ?? new Error("Unable to save this COA.");
  }

  return mapAdminRow(data as AdminCoaRow, product.name, product.slug);
}

export async function updateAdminCoaRecord(
  coaId: string,
  input: Partial<CoaRecordInput>,
): Promise<AdminCoaRecord> {
  const id = normalizeCoaText(coaId, 64);
  assert(id, "Missing COA id.");

  const { data: existing, error: readError } = await supabaseAdmin
    .from("coa_records")
    .select(ADMIN_COA_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (readError) throw readError;
  assert(existing, "That COA no longer exists.");

  const current = existing as AdminCoaRow;
  const productId = input.productId ? normalizeCoaText(input.productId, 64) : String(current.product_id);
  const product = await requireProduct(productId);

  const payload = buildRecordPayload({
    productId,
    productDoseId: input.productDoseId !== undefined ? input.productDoseId : current.product_dose_id,
    strength: input.strength !== undefined ? input.strength : current.strength,
    batchNumber: input.batchNumber !== undefined ? input.batchNumber : String(current.batch_number ?? ""),
    lotNumber: input.lotNumber !== undefined ? input.lotNumber : current.lot_number,
    labName: input.labName !== undefined ? input.labName : current.lab_name,
    testDate: input.testDate !== undefined ? input.testDate : current.test_date,
    purity: input.purity !== undefined ? input.purity : current.purity,
    identityResult: input.identityResult !== undefined ? input.identityResult : current.identity_result,
    externalUrl: input.externalUrl !== undefined ? input.externalUrl : current.external_url,
    status: input.status !== undefined ? input.status : normalizeCoaStatus(current.status),
  });

  // Publishing something a customer cannot open is the one state this system
  // must never reach — the whole point of the library is that "View COA" works.
  if (payload.status === "published") {
    assert(
      Boolean(current.file_path) || Boolean(payload.external_url),
      "Attach a file or a link before publishing this COA.",
    );
  }

  const { data, error } = await supabaseAdmin
    .from("coa_records")
    .update({ product_id: product.id, ...payload })
    .eq("id", id)
    .select(ADMIN_COA_SELECT)
    .single();

  if (error || !data) {
    throw error ?? new Error("Unable to update this COA.");
  }

  return mapAdminRow(data as AdminCoaRow, product.name, product.slug);
}

export async function replaceAdminCoaFile(coaId: string, upload: CoaUploadPayload): Promise<AdminCoaRecord> {
  const id = normalizeCoaText(coaId, 64);
  assert(id, "Missing COA id.");

  const { data: existing, error: readError } = await supabaseAdmin
    .from("coa_records")
    .select(ADMIN_COA_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (readError) throw readError;
  assert(existing, "That COA no longer exists.");

  const current = existing as AdminCoaRow;
  const product = await requireProduct(String(current.product_id));
  // Captured before anything is written. Reading it back off `current` after
  // the update would make the cleanup depend on the row snapshot not aliasing
  // live state — true today, and not a thing worth betting a customer's
  // "View COA" on.
  const previousPath = current.file_path;

  const uploaded = await uploadCoaObject({
    productSlug: product.slug,
    batchNumber: String(current.batch_number ?? "batch"),
    upload,
  });

  const { data, error } = await supabaseAdmin
    .from("coa_records")
    .update({
      file_path: uploaded.path,
      file_name: uploaded.fileName,
      file_type: uploaded.mime,
      file_size_bytes: uploaded.sizeBytes,
    })
    .eq("id", id)
    .select(ADMIN_COA_SELECT)
    .single();

  if (error || !data) {
    await removeCoaObject(uploaded.path);
    throw error ?? new Error("Unable to replace this COA file.");
  }

  // Only once the row points at the new object — a failure above leaves the
  // record still serving the document it had.
  await removeCoaObject(previousPath);

  return mapAdminRow(data as AdminCoaRow, product.name, product.slug);
}

export async function setAdminCoaStatus(coaId: string, status: CoaStatus): Promise<AdminCoaRecord> {
  return updateAdminCoaRecord(coaId, { status: normalizeCoaStatus(status) });
}

export async function deleteAdminCoaRecord(coaId: string): Promise<void> {
  const id = normalizeCoaText(coaId, 64);
  assert(id, "Missing COA id.");

  const { data: existing, error: readError } = await supabaseAdmin
    .from("coa_records")
    .select("id, file_path")
    .eq("id", id)
    .maybeSingle();

  if (readError) throw readError;
  if (!existing) return;

  const { error } = await supabaseAdmin.from("coa_records").delete().eq("id", id);
  if (error) throw error;

  await removeCoaObject((existing as { file_path: string | null }).file_path);
}

export async function setCoaShowPendingProducts(input: {
  showPendingProducts: boolean;
  actorUsername?: string | null;
}): Promise<void> {
  await upsertControlValue({
    section: COA_SETTINGS_SECTION,
    key: "show_pending_products",
    value: Boolean(input.showPendingProducts),
    actorUsername: input.actorUsername ?? null,
  });
}
