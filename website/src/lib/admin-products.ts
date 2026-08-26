import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { invalidateCatalogCache } from "@/lib/catalog-cache";
import type { Product, ProductBadge, ProductDose, ProductFaqItem, ProductImage } from "@/lib/catalog-types";
import { parseProductFaq } from "@/lib/product-faq";
import { resolveProductImage } from "@/lib/product-image";
import { imageExtensionFor, MAX_PRODUCT_IMAGE_BYTES, sniffImageType } from "@/lib/image-upload-safety";

export type AdminProductStatusFilter = "all" | "published" | "draft" | "archived" | "disabled";

export type DoseInput = {
  id?: string;
  label: string;
  slugSuffix: string;
  sku?: string;
  priceCents: number;
  compareAtPriceCents?: number;
  salePriceCents?: number;
  /** Internal cost (COGS) for this dose, in cents. Admin-only; never shown to
   *  customers. Feeds profit calculations only. */
  productCostCents?: number | null;
  inventoryQuantity: number;
  stockStatus?: Product["stockStatus"];
  batchNumber?: string;
  coaUrl?: string;
  imageUrl?: string;
  purityResult?: string;
  isDefault?: boolean;
  isEnabled?: boolean;
  position?: number;
};

export type ProductCreateInput = {
  name: string;
  slug?: string;
  category: string;
  shortDescription?: string;
  longDescription?: string;
  priceCents?: number;
  compareAtPriceCents?: number;
  salePriceCents?: number;
  inventoryQuantity?: number;
  stockStatus?: Product["stockStatus"];
  isFeatured?: boolean;
  requiresReconstitution?: boolean;
  badge?: ProductBadge;
  batchNumber?: string;
  coaUrl?: string;
  // COA / testing fields (drive the product page + COA library), now fully
  // admin-editable at the product level (no SQL needed).
  purityResult?: string;
  testingDate?: string;
  labName?: string;
  // Premium research-data spec fields (customer-facing).
  molecularFormula?: string;
  molecularWeight?: string;
  casNumber?: string;
  peptideSequence?: string;
  storageRecommendation?: string;
  reconstitutionNote?: string;
  faq?: ProductFaqItem[];
  seoTitle?: string;
  seoDescription?: string;
  imageUrl?: string;
  isPublished?: boolean;
  isEnabled?: boolean;
  // Hidden admin cost/margin fields — never shown to customers. Feed the profit
  // engine so it can protect margin per SKU (worst-case cost is assumed when
  // productCostCents is unset).
  productCostCents?: number;
  suggestedRetailCents?: number;
  minSellingPriceCents?: number;
  minProfitCents?: number;
  minProfitPercent?: number;
  doses?: DoseInput[];
};

export type ProductUpdateInput = Partial<ProductCreateInput> & {
  isArchived?: boolean;
};

function toCurrencyString(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function sanitizeBadge(value: unknown): ProductBadge {
  if (value === "new" || value === "best_seller" || value === "sale") {
    return value;
  }
  return null;
}

function normalizeStockStatus(value: unknown, inventoryQuantity: number): Product["stockStatus"] {
  const allowed = new Set(["In Stock", "Limited", "Reserved", "Out of Stock"]);
  if (typeof value === "string" && allowed.has(value)) {
    return value as Product["stockStatus"];
  }
  return inventoryQuantity <= 0 ? "Out of Stock" : "In Stock";
}

function mapAdminProductRow(
  row: Record<string, unknown>,
  images: ProductImage[],
  doses: ProductDose[],
): Product {
  const defaultDose = doses.find((dose) => dose.isDefault) ?? doses[0];
  const primaryImage = images.find((image) => image.isPrimary) ?? images[0];

  const basePriceCents = parseNumber(row.price_cents, 0);
  const compareAtPriceCents = parseNumber(row.compare_at_price_cents, 0);
  const salePriceCents = parseNumber(row.sale_price_cents, 0);

  const displayPrice = defaultDose?.salePrice ?? defaultDose?.price ?? toCurrencyString(salePriceCents > 0 ? salePriceCents : basePriceCents);
  const inventoryQuantity = defaultDose?.inventoryQuantity ?? parseNumber(row.inventory_quantity, 0);
  const effectiveImage = resolveProductImage(defaultDose?.imageUrl ?? primaryImage?.imageUrl ?? row.image_url);
  const effectiveBatch = defaultDose?.batchNumber ?? String(row.batch_number ?? "");
  const effectiveCoa = defaultDose?.coaUrl ?? String(row.coa_url ?? "");
  const effectivePurity = defaultDose?.purityResult ?? (row.purity_result ? String(row.purity_result) : undefined);

  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    category: String(row.category ?? "Research Peptides"),
    shortDescription: row.short_description ? String(row.short_description) : undefined,
    longDescription: row.long_description ? String(row.long_description) : undefined,
    price: displayPrice,
    compareAtPrice: defaultDose?.compareAtPrice ?? (compareAtPriceCents > 0 ? toCurrencyString(compareAtPriceCents) : undefined),
    salePrice: defaultDose?.salePrice ?? (salePriceCents > 0 ? toCurrencyString(salePriceCents) : undefined),
    stockStatus: normalizeStockStatus(row.stock_status, inventoryQuantity),
    inventoryQuantity,
    isPublished: parseBoolean(row.is_published, false),
    isEnabled: parseBoolean(row.is_enabled, true),
    isArchived: parseBoolean(row.is_archived, false),
    isFeatured: parseBoolean(row.is_featured, false),
    requiresReconstitution: parseBoolean(row.requires_reconstitution, false),
    badge: sanitizeBadge(row.badge),
    position: parseNumber(row.position, 0),
    batchNumber: effectiveBatch,
    purityResult: effectivePurity,
    description: String(row.long_description ?? row.description ?? ""),
    image: effectiveImage,
    coverImage: effectiveImage,
    galleryImages: images,
    doses,
    defaultDoseId: defaultDose?.id ?? null,
    productCostCents: row.product_cost_cents != null ? parseNumber(row.product_cost_cents) : undefined,
    suggestedRetailCents: row.suggested_retail_cents != null ? parseNumber(row.suggested_retail_cents) : undefined,
    minSellingPriceCents: row.min_selling_price_cents != null ? parseNumber(row.min_selling_price_cents) : undefined,
    minProfitCents: row.min_profit_cents != null ? parseNumber(row.min_profit_cents) : undefined,
    minProfitPercent: row.min_profit_percent != null ? parseNumber(row.min_profit_percent) : undefined,
    testingDate: String(row.testing_date ?? ""),
    labName: String(row.lab_name ?? ""),
    coaUrl: effectiveCoa,
    molecularFormula: row.molecular_formula ? String(row.molecular_formula) : undefined,
    molecularWeight: row.molecular_weight ? String(row.molecular_weight) : undefined,
    casNumber: row.cas_number ? String(row.cas_number) : undefined,
    peptideSequence: row.peptide_sequence ? String(row.peptide_sequence) : undefined,
    storageRecommendation: row.storage_recommendation ? String(row.storage_recommendation) : undefined,
    reconstitutionNote: row.reconstitution_note ? String(row.reconstitution_note) : undefined,
    faq: parseProductFaq(row.product_faq),
    seoTitle: row.seo_title ? String(row.seo_title) : undefined,
    seoDescription: row.seo_description ? String(row.seo_description) : undefined,
  };
}

async function fetchProductRelations(productIds: string[]) {
  if (productIds.length === 0) {
    return {
      imagesByProductId: new Map<string, ProductImage[]>(),
      dosesByProductId: new Map<string, ProductDose[]>(),
    };
  }

  const [{ data: imageRows, error: imageError }, { data: doseRows, error: doseError }] = await Promise.all([
    supabaseAdmin
      .from("product_images")
      .select("id, product_id, image_url, alt_text, is_primary, position")
      .in("product_id", productIds)
      .eq("is_enabled", true)
      .order("position", { ascending: true }),
    supabaseAdmin
      .from("product_doses")
      .select("id, product_id, label, slug_suffix, sku, price_cents, compare_at_price_cents, sale_price_cents, product_cost_cents, inventory_quantity, stock_status, batch_number, coa_url, image_url, purity_result, is_default, is_enabled, position")
      .in("product_id", productIds)
      .order("position", { ascending: true }),
  ]);

  if (imageError) {
    throw imageError;
  }

  if (doseError) {
    throw doseError;
  }

  const imagesByProductId = new Map<string, ProductImage[]>();
  for (const rawRow of imageRows ?? []) {
    const row = rawRow as Record<string, unknown>;
    const productId = String(row.product_id);
    const list = imagesByProductId.get(productId) ?? [];
    list.push({
      id: String(row.id),
      imageUrl: String(row.image_url ?? ""),
      altText: row.alt_text ? String(row.alt_text) : null,
      isPrimary: parseBoolean(row.is_primary, false),
      position: parseNumber(row.position, 0),
    });
    imagesByProductId.set(productId, list);
  }

  const dosesByProductId = new Map<string, ProductDose[]>();
  for (const rawRow of doseRows ?? []) {
    const row = rawRow as Record<string, unknown>;
    const productId = String(row.product_id);
    const list = dosesByProductId.get(productId) ?? [];

    const priceCents = parseNumber(row.price_cents, 0);
    const compareAtPriceCents = parseNumber(row.compare_at_price_cents, 0);
    const salePriceCents = parseNumber(row.sale_price_cents, 0);

    list.push({
      id: String(row.id),
      label: String(row.label ?? "Default"),
      slugSuffix: String(row.slug_suffix ?? ""),
      sku: row.sku ? String(row.sku) : undefined,
      price: toCurrencyString(priceCents),
      compareAtPrice: compareAtPriceCents > 0 ? toCurrencyString(compareAtPriceCents) : undefined,
      salePrice: salePriceCents > 0 ? toCurrencyString(salePriceCents) : undefined,
      productCostCents: row.product_cost_cents != null ? parseNumber(row.product_cost_cents) : undefined,
      inventoryQuantity: parseNumber(row.inventory_quantity, 0),
      stockStatus: String(row.stock_status ?? "In Stock") as ProductDose["stockStatus"],
      batchNumber: row.batch_number ? String(row.batch_number) : undefined,
      coaUrl: row.coa_url ? String(row.coa_url) : undefined,
      imageUrl: row.image_url ? String(row.image_url) : undefined,
      purityResult: row.purity_result ? String(row.purity_result) : undefined,
      isDefault: parseBoolean(row.is_default, false),
      isEnabled: parseBoolean(row.is_enabled, true),
      position: parseNumber(row.position, 0),
    });
    dosesByProductId.set(productId, list);
  }

  return { imagesByProductId, dosesByProductId };
}

export async function listAdminProducts(input: {
  search?: string;
  category?: string;
  status?: AdminProductStatusFilter;
}) {
  let query = supabaseAdmin
    .from("products")
    .select("id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, molecular_weight, cas_number, peptide_sequence, storage_recommendation, reconstitution_note, requires_reconstitution, product_faq, seo_title, seo_description, product_cost_cents, suggested_retail_cents, min_selling_price_cents, min_profit_cents, min_profit_percent, updated_at")
    .order("position", { ascending: true })
    .order("updated_at", { ascending: false });

  if (input.category && input.category !== "all") {
    query = query.eq("category", input.category);
  }

  if (input.status === "published") {
    query = query.eq("is_published", true).eq("is_enabled", true).eq("is_archived", false);
  }

  if (input.status === "draft") {
    query = query.eq("is_published", false).eq("is_archived", false);
  }

  if (input.status === "archived") {
    query = query.eq("is_archived", true);
  }

  if (input.status === "disabled") {
    query = query.eq("is_enabled", false).eq("is_archived", false);
  }

  if (input.search?.trim()) {
    // Sanitize before interpolating into PostgREST's comma-delimited .or().
    const term = input.search.trim().replace(/[^a-zA-Z0-9@._\- ]/g, "").slice(0, 100);
    if (term) {
      query = query.or(`name.ilike.%${term}%,slug.ilike.%${term}%,category.ilike.%${term}%`);
    }
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const productIds = rows.map((row) => String(row.id));
  const { imagesByProductId, dosesByProductId } = await fetchProductRelations(productIds);

  return rows.map((row) => {
    const productId = String(row.id);
    return mapAdminProductRow(
      row,
      imagesByProductId.get(productId) ?? [],
      dosesByProductId.get(productId) ?? [],
    );
  });
}

async function getNextProductPosition() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return parseNumber(data?.position, 0) + 1;
}

/**
 * The columns an admin edit is allowed to set.
 *
 * Deliberately NOT here: track_inventory, reserved_quantity, incoming_quantity,
 * low_stock_threshold and shipping_weight_oz. Those are operational state owned
 * by checkout, the reservation sweeper and the receiving flow — DoseInput has no
 * field for any of them, so an editor payload can only ever reset them to their
 * schema defaults. They are preserved on update and left to default only when a
 * dose is genuinely new.
 */
function editableDoseValues(dose: DoseInput, index: number, doses: DoseInput[]) {
  return {
    label: dose.label.trim(),
    slug_suffix: dose.slugSuffix.trim(),
    sku: dose.sku?.trim() || null,
    price_cents: Math.max(0, Math.round(dose.priceCents)),
    compare_at_price_cents: Math.max(0, Math.round(dose.compareAtPriceCents ?? 0)),
    sale_price_cents: Math.max(0, Math.round(dose.salePriceCents ?? 0)),
    product_cost_cents: dose.productCostCents == null ? null : Math.max(0, Math.round(dose.productCostCents)),
    inventory_quantity: Math.max(0, Math.round(dose.inventoryQuantity)),
    stock_status: normalizeStockStatus(dose.stockStatus, dose.inventoryQuantity),
    batch_number: dose.batchNumber ?? null,
    coa_url: dose.coaUrl ?? null,
    image_url: dose.imageUrl ?? null,
    purity_result: dose.purityResult ?? null,
    is_default: Boolean(dose.isDefault) || (index === 0 && !doses.some((item) => item.isDefault)),
    is_enabled: dose.isEnabled ?? true,
    position: dose.position ?? index,
    updated_at: new Date().toISOString(),
  };
}

async function createDoseRows(productId: string, doses: DoseInput[]) {
  if (doses.length === 0) {
    return;
  }

  const rows = doses.map((dose, index) => ({
    id: dose.id ?? randomUUID(),
    product_id: productId,
    ...editableDoseValues(dose, index, doses),
    created_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin.from("product_doses").insert(rows);
  if (error) {
    throw error;
  }
}

/**
 * A published product must have a price a customer can actually be charged.
 *
 * `products.price_cents` is `integer not null default 0`, and every write path
 * here coerces a missing price with `Math.max(0, Math.round(x ?? 0))` — so
 * "saved before the price was typed in" produces 0 rather than an error. A
 * published 0 reached checkout and was refused there (see parseProductPrice in
 * quote-order.ts), which protects the money but shows the customer a product
 * they cannot buy.
 *
 * So this is the FIRST of two independent gates, not a replacement for the
 * second: the admin refuses to publish an unsellable product, and checkout
 * still refuses to sell one if bad data reaches the database by any other
 * route (a CSV import, a direct SQL edit, a restored backup).
 *
 * Unpublishing, archiving and saving a draft are all unaffected — a product
 * with no price yet is a perfectly normal draft.
 */
export function assertPublishablePrice(priceCents: unknown, productName?: string | null): void {
  const cents = Number(priceCents);
  if (!Number.isFinite(cents) || cents <= 0) {
    const named = productName ? `"${String(productName).trim()}"` : "This product";
    throw new Error(
      `${named} has no price, so it cannot be published — a customer would see it on the storefront and checkout would refuse the order. Set a price above $0.00 first.`,
    );
  }
}

export async function createAdminProduct(input: ProductCreateInput) {
  const slug = slugify(input.slug || input.name);
  if (!slug) {
    throw new Error("Product slug could not be generated.");
  }

  const now = new Date().toISOString();
  const productId = randomUUID();
  const position = await getNextProductPosition();

  const inventoryQuantity = Math.max(0, Math.round(input.inventoryQuantity ?? 0));
  const stockStatus = normalizeStockStatus(input.stockStatus, inventoryQuantity);

  const priceCents = Math.max(0, Math.round(input.priceCents ?? 0));
  if (input.isPublished) {
    assertPublishablePrice(priceCents, input.name);
  }

  const { error } = await supabaseAdmin
    .from("products")
    .insert({
      id: productId,
      slug,
      name: input.name.trim(),
      category: input.category.trim() || "Research Peptides",
      short_description: input.shortDescription ?? null,
      long_description: input.longDescription ?? null,
      description: input.longDescription ?? input.shortDescription ?? null,
      price_cents: priceCents,
      compare_at_price_cents: Math.max(0, Math.round(input.compareAtPriceCents ?? 0)),
      sale_price_cents: Math.max(0, Math.round(input.salePriceCents ?? 0)),
      inventory_quantity: inventoryQuantity,
      stock_status: stockStatus,
      is_featured: input.isFeatured ?? false,
      requires_reconstitution: input.requiresReconstitution ?? false,
      badge: input.badge ?? null,
      batch_number: input.batchNumber ?? null,
      image_url: input.imageUrl ?? null,
      coa_url: input.coaUrl ?? null,
      purity_result: input.purityResult ?? null,
      testing_date: input.testingDate ? input.testingDate : null,
      lab_name: input.labName ?? null,
      molecular_formula: input.molecularFormula ?? null,
      molecular_weight: input.molecularWeight ?? null,
      cas_number: input.casNumber ?? null,
      peptide_sequence: input.peptideSequence ?? null,
      storage_recommendation: input.storageRecommendation ?? null,
      reconstitution_note: input.reconstitutionNote ?? null,
      product_faq: parseProductFaq(input.faq),
      seo_title: input.seoTitle ?? null,
      seo_description: input.seoDescription ?? null,
      is_published: input.isPublished ?? false,
      is_enabled: input.isEnabled ?? true,
      is_archived: false,
      is_active: true,
      product_cost_cents: input.productCostCents != null ? Math.max(0, Math.round(input.productCostCents)) : null,
      suggested_retail_cents: input.suggestedRetailCents != null ? Math.max(0, Math.round(input.suggestedRetailCents)) : null,
      min_selling_price_cents: input.minSellingPriceCents != null ? Math.max(0, Math.round(input.minSellingPriceCents)) : null,
      min_profit_cents: input.minProfitCents != null ? Math.max(0, Math.round(input.minProfitCents)) : null,
      min_profit_percent: input.minProfitPercent != null ? Math.max(0, input.minProfitPercent) : null,
      position,
      created_at: now,
      updated_at: now,
    });

  if (error) {
    throw error;
  }

  if (input.doses?.length) {
    await replaceProductDoses(productId, input.doses);
  }

  if (input.imageUrl) {
    await addProductImageFromUrl({ productId, imageUrl: input.imageUrl, isPrimary: true });
  }

  invalidateCatalogCache();
  return getAdminProductById(productId);
}

export async function getAdminProductById(productId: string) {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, molecular_weight, cas_number, peptide_sequence, storage_recommendation, reconstitution_note, requires_reconstitution, product_faq, seo_title, seo_description")
    .eq("id", productId)
    .single();

  if (error) {
    throw error;
  }

  const { imagesByProductId, dosesByProductId } = await fetchProductRelations([productId]);
  return mapAdminProductRow(
    data as Record<string, unknown>,
    imagesByProductId.get(productId) ?? [],
    dosesByProductId.get(productId) ?? [],
  );
}

export async function updateAdminProduct(productId: string, input: ProductUpdateInput, changedBy?: string) {
  const nextInventory = input.inventoryQuantity !== undefined ? Math.max(0, Math.round(input.inventoryQuantity)) : undefined;

  // Snapshot current costs BEFORE mutating so we can log what actually changed.
  const { data: beforeProduct } = await supabaseAdmin
    .from("products")
    .select("name, product_cost_cents, price_cents")
    .eq("id", productId)
    .maybeSingle();
  const { data: beforeDoseRows } = await supabaseAdmin
    .from("product_doses")
    .select("id, label, product_cost_cents")
    .eq("product_id", productId);
  const beforeDoseCostById = new Map<string, { label: string; cost: number | null }>();
  for (const row of (beforeDoseRows ?? []) as Array<{ id: string; label: string | null; product_cost_cents: number | null }>) {
    beforeDoseCostById.set(String(row.id), { label: String(row.label ?? ""), cost: row.product_cost_cents == null ? null : Number(row.product_cost_cents) });
  }
  const productName = beforeProduct?.name ? String(beforeProduct.name) : "";

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.slug !== undefined) payload.slug = slugify(input.slug);
  if (input.category !== undefined) payload.category = input.category.trim();
  if (input.shortDescription !== undefined) payload.short_description = input.shortDescription;
  if (input.longDescription !== undefined) {
    payload.long_description = input.longDescription;
    payload.description = input.longDescription;
  }
  if (input.priceCents !== undefined) payload.price_cents = Math.max(0, Math.round(input.priceCents));
  if (input.compareAtPriceCents !== undefined) payload.compare_at_price_cents = Math.max(0, Math.round(input.compareAtPriceCents));
  if (input.salePriceCents !== undefined) payload.sale_price_cents = Math.max(0, Math.round(input.salePriceCents));
  if (nextInventory !== undefined) payload.inventory_quantity = nextInventory;
  if (input.stockStatus !== undefined || nextInventory !== undefined) {
    payload.stock_status = normalizeStockStatus(input.stockStatus, nextInventory ?? 1);
  }
  if (input.isFeatured !== undefined) payload.is_featured = input.isFeatured;
  if (input.requiresReconstitution !== undefined) payload.requires_reconstitution = input.requiresReconstitution;
  if (input.badge !== undefined) payload.badge = input.badge;
  if (input.batchNumber !== undefined) payload.batch_number = input.batchNumber;
  if (input.coaUrl !== undefined) payload.coa_url = input.coaUrl;
  if (input.purityResult !== undefined) payload.purity_result = input.purityResult;
  if (input.testingDate !== undefined) payload.testing_date = input.testingDate ? input.testingDate : null;
  if (input.labName !== undefined) payload.lab_name = input.labName;
  if (input.molecularFormula !== undefined) payload.molecular_formula = input.molecularFormula;
  if (input.molecularWeight !== undefined) payload.molecular_weight = input.molecularWeight;
  if (input.casNumber !== undefined) payload.cas_number = input.casNumber;
  if (input.peptideSequence !== undefined) payload.peptide_sequence = input.peptideSequence;
  if (input.storageRecommendation !== undefined) payload.storage_recommendation = input.storageRecommendation;
  if (input.reconstitutionNote !== undefined) payload.reconstitution_note = input.reconstitutionNote;
  if (input.faq !== undefined) payload.product_faq = parseProductFaq(input.faq);
  if (input.imageUrl !== undefined) payload.image_url = input.imageUrl;
  if (input.seoTitle !== undefined) payload.seo_title = input.seoTitle;
  if (input.seoDescription !== undefined) payload.seo_description = input.seoDescription;
  if (input.isPublished !== undefined) payload.is_published = input.isPublished;
  if (input.isEnabled !== undefined) payload.is_enabled = input.isEnabled;
  if (input.isArchived !== undefined) payload.is_archived = input.isArchived;
  if (input.productCostCents !== undefined) payload.product_cost_cents = input.productCostCents === null ? null : Math.max(0, Math.round(input.productCostCents));
  if (input.suggestedRetailCents !== undefined) payload.suggested_retail_cents = input.suggestedRetailCents === null ? null : Math.max(0, Math.round(input.suggestedRetailCents));
  if (input.minSellingPriceCents !== undefined) payload.min_selling_price_cents = input.minSellingPriceCents === null ? null : Math.max(0, Math.round(input.minSellingPriceCents));
  if (input.minProfitCents !== undefined) payload.min_profit_cents = input.minProfitCents === null ? null : Math.max(0, Math.round(input.minProfitCents));
  if (input.minProfitPercent !== undefined) payload.min_profit_percent = input.minProfitPercent === null ? null : Math.max(0, input.minProfitPercent);

  // PUBLISHING is the gate, not saving. A draft with no price yet is normal;
  // a PUBLISHED product with no price is one a customer can see and cannot buy.
  //
  // The price that matters is the one that will end up on the parent row after
  // this save, so every source is considered: an explicit price in this update,
  // the price already stored, and the doses — replaceProductDoses() copies the
  // first dose's price onto the parent, so a dosed product whose parent price
  // is still 0 is priced and must not be blocked.
  if (input.isPublished === true) {
    const doseRows = input.doses
      ?? ((await supabaseAdmin
        .from("product_doses")
        .select("price_cents, sale_price_cents")
        .eq("product_id", productId)).data ?? []).map((row) => ({
          priceCents: Number((row as { price_cents?: unknown }).price_cents ?? 0),
          salePriceCents: Number((row as { sale_price_cents?: unknown }).sale_price_cents ?? 0),
        }));

    const candidates = [
      input.priceCents,
      beforeProduct?.price_cents,
      ...doseRows.flatMap((dose) => [dose.priceCents, dose.salePriceCents]),
    ];
    const best = candidates.reduce<number>((max, value) => {
      const cents = Number(value);
      return Number.isFinite(cents) && cents > max ? cents : max;
    }, 0);
    assertPublishablePrice(best, input.name ?? (beforeProduct?.name as string | undefined));
  }

  const { error } = await supabaseAdmin.from("products").update(payload).eq("id", productId);
  if (error) {
    throw error;
  }

  if (input.doses) {
    await replaceProductDoses(productId, input.doses);
  }

  // Record cost changes to the history table (best-effort — never block a save
  // if the history table isn't migrated yet).
  try {
    const changeRows: Array<Record<string, unknown>> = [];
    const norm = (cents: number | null | undefined): number | null =>
      cents == null ? null : Math.max(0, Math.round(cents));

    if (input.productCostCents !== undefined) {
      const oldCost = beforeProduct?.product_cost_cents == null ? null : Number(beforeProduct.product_cost_cents);
      const newCost = norm(input.productCostCents);
      if (oldCost !== newCost) {
        changeRows.push({ product_id: productId, dose_id: null, product_name: productName, dose_label: null, old_cost_cents: oldCost, new_cost_cents: newCost, changed_by: changedBy ?? null });
      }
    }

    for (const dose of input.doses ?? []) {
      if (dose.productCostCents === undefined || !dose.id) continue;
      const before = beforeDoseCostById.get(dose.id);
      const oldCost = before?.cost ?? null;
      const newCost = norm(dose.productCostCents);
      if (oldCost !== newCost) {
        changeRows.push({ product_id: productId, dose_id: dose.id, product_name: productName, dose_label: dose.label ?? before?.label ?? null, old_cost_cents: oldCost, new_cost_cents: newCost, changed_by: changedBy ?? null });
      }
    }

    if (changeRows.length > 0) {
      await supabaseAdmin.from("product_cost_changes").insert(changeRows);
    }
  } catch (logError) {
    console.error("Unable to record product cost change history:", logError);
  }

  invalidateCatalogCache();
  return getAdminProductById(productId);
}

export async function deleteAdminProduct(productId: string) {
  const [{ error: imagesError }, { error: dosesError }, { error: productError }] = await Promise.all([
    supabaseAdmin.from("product_images").delete().eq("product_id", productId),
    supabaseAdmin.from("product_doses").delete().eq("product_id", productId),
    supabaseAdmin.from("products").delete().eq("id", productId),
  ]);

  if (imagesError) throw imagesError;
  if (dosesError) throw dosesError;
  if (productError) throw productError;

  invalidateCatalogCache();
}

export async function duplicateAdminProduct(productId: string) {
  const product = await getAdminProductById(productId);
  const duplicateName = `${product.name} Copy`;

  const created = await createAdminProduct({
    name: duplicateName,
    slug: `${product.slug}-copy-${Date.now().toString().slice(-4)}`,
    category: product.category,
    shortDescription: product.shortDescription,
    longDescription: product.longDescription,
    priceCents: Math.round(parseNumber(product.price.replace(/[^0-9.]/g, "")) * 100),
    compareAtPriceCents: product.compareAtPrice ? Math.round(parseNumber(product.compareAtPrice.replace(/[^0-9.]/g, "")) * 100) : 0,
    salePriceCents: product.salePrice ? Math.round(parseNumber(product.salePrice.replace(/[^0-9.]/g, "")) * 100) : 0,
    inventoryQuantity: product.inventoryQuantity ?? 0,
    stockStatus: product.stockStatus,
    isFeatured: product.isFeatured,
    requiresReconstitution: product.requiresReconstitution,
    badge: product.badge,
    batchNumber: product.batchNumber,
    coaUrl: product.coaUrl,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    imageUrl: product.coverImage,
    isPublished: false,
    isEnabled: true,
    doses: (product.doses ?? []).map((dose, index) => ({
      label: dose.label,
      slugSuffix: dose.slugSuffix,
      sku: dose.sku,
      priceCents: Math.round(parseNumber(dose.price.replace(/[^0-9.]/g, "")) * 100),
      compareAtPriceCents: dose.compareAtPrice ? Math.round(parseNumber(dose.compareAtPrice.replace(/[^0-9.]/g, "")) * 100) : 0,
      salePriceCents: dose.salePrice ? Math.round(parseNumber(dose.salePrice.replace(/[^0-9.]/g, "")) * 100) : 0,
      // The source here is an ADMIN read, which does populate the count; the ?? 0
      // only satisfies the now-optional public type (the storefront reads leave
      // it undefined on purpose so stock depth is never serialized to a browser).
      inventoryQuantity: dose.inventoryQuantity ?? 0,
      stockStatus: dose.stockStatus,
      batchNumber: dose.batchNumber,
      coaUrl: dose.coaUrl,
      imageUrl: dose.imageUrl,
      purityResult: dose.purityResult,
      isDefault: dose.isDefault,
      isEnabled: dose.isEnabled,
      position: dose.position ?? index,
    })),
  });

  if (product.galleryImages?.length) {
    await Promise.all(
      product.galleryImages.map((image) =>
        addProductImageFromUrl({
          productId: created.id ?? "",
          imageUrl: image.imageUrl,
          altText: image.altText ?? undefined,
          isPrimary: image.isPrimary,
        }),
      ),
    );
  }

  return getAdminProductById(created.id ?? "");
}

export async function reorderAdminProducts(productIdsInOrder: string[]) {
  if (productIdsInOrder.length === 0) {
    return;
  }

  const updates = productIdsInOrder.map((id, index) =>
    supabaseAdmin
      .from("products")
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq("id", id),
  );

  const results = await Promise.all(updates);
  for (const result of results) {
    if (result.error) {
      throw result.error;
    }
  }

  invalidateCatalogCache();
}

export async function bulkUpdateAdminProducts(input: {
  productIds: string[];
  action: "publish" | "unpublish" | "enable" | "disable" | "archive" | "unarchive" | "feature" | "unfeature" | "set_category" | "set_badge";
  value?: string | null;
}) {
  if (input.productIds.length === 0) {
    return;
  }

  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  // A bulk publish must obey the same rule as publishing one product, or the
  // gate is only as strong as the slowest route through it. Refuses the WHOLE
  // batch and names the offenders, rather than publishing some and silently
  // skipping others.
  if (input.action === "publish") {
    const { data: pricing } = await supabaseAdmin
      .from("products")
      .select("id, name, price_cents")
      .in("id", input.productIds);
    const unpriced = ((pricing ?? []) as Array<{ id: string; name: string | null; price_cents: number | null }>)
      .filter((row) => !(Number(row.price_cents ?? 0) > 0));
    if (unpriced.length > 0) {
      const names = unpriced.map((row) => (row.name ?? row.id)).join(", ");
      throw new Error(
        `Cannot publish — ${unpriced.length === 1 ? "this product has" : "these products have"} no price: ${names}. Set a price above $0.00 first.`,
      );
    }
  }

  switch (input.action) {
    case "publish":
      payload.is_published = true;
      payload.is_archived = false;
      break;
    case "unpublish":
      payload.is_published = false;
      break;
    case "enable":
      payload.is_enabled = true;
      break;
    case "disable":
      payload.is_enabled = false;
      break;
    case "archive":
      payload.is_archived = true;
      payload.is_published = false;
      break;
    case "unarchive":
      payload.is_archived = false;
      break;
    case "feature":
      payload.is_featured = true;
      break;
    case "unfeature":
      payload.is_featured = false;
      break;
    case "set_category":
      payload.category = (input.value ?? "").toString();
      break;
    case "set_badge":
      payload.badge = sanitizeBadge(input.value);
      break;
  }

  const { error } = await supabaseAdmin
    .from("products")
    .update(payload)
    .in("id", input.productIds);

  if (error) {
    throw error;
  }

  invalidateCatalogCache();
}

async function getNextImagePosition(productId: string) {
  const { data, error } = await supabaseAdmin
    .from("product_images")
    .select("position")
    .eq("product_id", productId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return parseNumber(data?.position, 0) + 1;
}

export async function addProductImageFromUrl(input: {
  productId: string;
  imageUrl: string;
  altText?: string;
  isPrimary?: boolean;
}) {
  const position = await getNextImagePosition(input.productId);
  const now = new Date().toISOString();
  const imageId = randomUUID();

  if (input.isPrimary) {
    const { error: clearError } = await supabaseAdmin
      .from("product_images")
      .update({ is_primary: false, updated_at: now })
      .eq("product_id", input.productId);
    if (clearError) throw clearError;
  }

  const { error } = await supabaseAdmin
    .from("product_images")
    .insert({
      id: imageId,
      product_id: input.productId,
      image_url: input.imageUrl,
      alt_text: input.altText ?? null,
      is_primary: input.isPrimary ?? false,
      position,
      is_enabled: true,
      created_at: now,
      updated_at: now,
    });

  if (error) {
    throw error;
  }

  if (input.isPrimary) {
    const { error: productUpdateError } = await supabaseAdmin
      .from("products")
      .update({ image_url: input.imageUrl, updated_at: now })
      .eq("id", input.productId);
    if (productUpdateError) throw productUpdateError;
  }

  invalidateCatalogCache();
  return imageId;
}

export async function setPrimaryProductImage(input: { productId: string; imageId: string }) {
  const now = new Date().toISOString();

  const { error: clearError } = await supabaseAdmin
    .from("product_images")
    .update({ is_primary: false, updated_at: now })
    .eq("product_id", input.productId);
  if (clearError) throw clearError;

  const { data: image, error: imageError } = await supabaseAdmin
    .from("product_images")
    .update({ is_primary: true, updated_at: now })
    .eq("id", input.imageId)
    .eq("product_id", input.productId)
    .select("image_url")
    .single();
  if (imageError) throw imageError;

  const { error: productError } = await supabaseAdmin
    .from("products")
    .update({ image_url: image.image_url, updated_at: now })
    .eq("id", input.productId);
  if (productError) throw productError;

  invalidateCatalogCache();
}

export async function reorderProductImages(input: { productId: string; imageIdsInOrder: string[] }) {
  const updates = input.imageIdsInOrder.map((id, index) =>
    supabaseAdmin
      .from("product_images")
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("product_id", input.productId),
  );

  const results = await Promise.all(updates);
  for (const result of results) {
    if (result.error) {
      throw result.error;
    }
  }

  invalidateCatalogCache();
}

export async function deleteProductImage(input: { productId: string; imageId: string }) {
  const { data: imageRow, error: readError } = await supabaseAdmin
    .from("product_images")
    .select("image_url, is_primary")
    .eq("id", input.imageId)
    .eq("product_id", input.productId)
    .single();

  if (readError) {
    throw readError;
  }

  const { error } = await supabaseAdmin
    .from("product_images")
    .delete()
    .eq("id", input.imageId)
    .eq("product_id", input.productId);

  if (error) {
    throw error;
  }

  if (imageRow.is_primary) {
    const { data: fallbackImage, error: fallbackError } = await supabaseAdmin
      .from("product_images")
      .select("id, image_url")
      .eq("product_id", input.productId)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fallbackError) {
      throw fallbackError;
    }

    const nextImageUrl = fallbackImage?.image_url ?? null;

    if (fallbackImage?.id) {
      const { error: setPrimaryError } = await supabaseAdmin
        .from("product_images")
        .update({ is_primary: true, updated_at: new Date().toISOString() })
        .eq("id", fallbackImage.id);
      if (setPrimaryError) throw setPrimaryError;
    }

    const { error: productUpdateError } = await supabaseAdmin
      .from("products")
      .update({ image_url: nextImageUrl, updated_at: new Date().toISOString() })
      .eq("id", input.productId);

    if (productUpdateError) {
      throw productUpdateError;
    }
  }

  invalidateCatalogCache();
}

/**
 * Apply an edited set of doses to a product.
 *
 * This used to DELETE every dose and re-insert from the payload, which was wrong
 * in three ways at once. DoseInput carries none of the operational columns
 * (track_inventory, reserved_quantity, incoming_quantity, low_stock_threshold,
 * shipping_weight_oz), so re-inserting reset all five to their schema defaults:
 * an ordinary "Save" in the product editor silently switched OFF oversell
 * protection for that product and threw away the holds on any checkout in
 * flight, while their inventory_reservations rows stayed 'active'. If the
 * payload omitted an id, a fresh uuid was minted and every order_items
 * "slug::doseId" and every reservation pointing at the old row was orphaned. And
 * the delete was not transactional with the insert, so a failure in between left
 * the product with no doses at all and the storefront falling back to the stale
 * parent row.
 *
 * So it merges instead. Existing doses are UPDATEd in place with the editable
 * columns only, keeping their ids and their operational state; genuinely new
 * doses are inserted; and the rows the admin actually removed are deleted LAST,
 * once the writes that keep the product sellable have succeeded.
 *
 * A dose is matched by id, and failing that by slug_suffix — an id-less payload
 * is far more likely to be the same 5mg dose round-tripped than a brand new one.
 */
export async function replaceProductDoses(productId: string, doses: DoseInput[]) {
  const { data: existingRows, error: readError } = await supabaseAdmin
    .from("product_doses")
    .select("id, slug_suffix")
    .eq("product_id", productId);

  if (readError) {
    throw readError;
  }

  const existing = (existingRows ?? []) as Array<{ id: string; slug_suffix: string | null }>;
  const byId = new Map(existing.map((row) => [row.id, row]));
  const bySlug = new Map(
    existing.filter((row) => row.slug_suffix).map((row) => [String(row.slug_suffix), row]),
  );

  const claimed = new Set<string>();
  const updates: Array<{ id: string; values: ReturnType<typeof editableDoseValues> }> = [];
  const inserts: DoseInput[] = [];

  doses.forEach((dose, index) => {
    const slug = dose.slugSuffix.trim();
    const match =
      (dose.id && byId.get(dose.id)) ||
      (slug ? bySlug.get(slug) : undefined);

    if (match && !claimed.has(match.id)) {
      claimed.add(match.id);
      updates.push({ id: match.id, values: editableDoseValues(dose, index, doses) });
    } else {
      inserts.push(dose);
    }
  });

  for (const update of updates) {
    const { error } = await supabaseAdmin
      .from("product_doses")
      .update(update.values)
      .eq("id", update.id);
    if (error) {
      throw error;
    }
  }

  await createDoseRows(productId, inserts);

  // Last, and only now: the doses the admin genuinely removed. Doing this after
  // the writes means a failure above leaves the product over-supplied with
  // doses rather than with none.
  const removed = existing.filter((row) => !claimed.has(row.id)).map((row) => row.id);
  if (removed.length > 0) {
    const { error: deleteError } = await supabaseAdmin
      .from("product_doses")
      .delete()
      .eq("product_id", productId)
      .in("id", removed);

    if (deleteError) {
      throw deleteError;
    }
  }

  const firstDose = doses.find((dose) => dose.isDefault) ?? doses[0];
  if (firstDose) {
    const payload = {
      price_cents: Math.max(0, Math.round(firstDose.salePriceCents && firstDose.salePriceCents > 0 ? firstDose.salePriceCents : firstDose.priceCents)),
      compare_at_price_cents: Math.max(0, Math.round(firstDose.compareAtPriceCents ?? 0)),
      sale_price_cents: Math.max(0, Math.round(firstDose.salePriceCents ?? 0)),
      inventory_quantity: Math.max(0, Math.round(firstDose.inventoryQuantity)),
      stock_status: normalizeStockStatus(firstDose.stockStatus, firstDose.inventoryQuantity),
      batch_number: firstDose.batchNumber ?? null,
      coa_url: firstDose.coaUrl ?? null,
      image_url: firstDose.imageUrl ?? null,
      purity_result: firstDose.purityResult ?? null,
      sku: firstDose.sku ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error: productError } = await supabaseAdmin
      .from("products")
      .update(payload)
      .eq("id", productId);

    if (productError) {
      throw productError;
    }
  }

  invalidateCatalogCache();
}

const PRODUCT_IMAGE_BUCKET = "product-images";

export async function ensureProductImageBucket() {
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
  if (error) {
    throw error;
  }

  const existing = (buckets ?? []).find((bucket) => bucket.name === PRODUCT_IMAGE_BUCKET);
  if (existing) {
    return PRODUCT_IMAGE_BUCKET;
  }

  const { error: createError } = await supabaseAdmin.storage.createBucket(PRODUCT_IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: "10MB",
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/avif"],
  });

  if (createError) {
    throw createError;
  }

  return PRODUCT_IMAGE_BUCKET;
}

export async function uploadProductImageToStorage(input: {
  productId: string;
  file: File;
  makePrimary?: boolean;
}) {
  // Validated HERE rather than in the route, because there are two routes into
  // this function and only one of them checked anything:
  //   POST  /api/admin/upload-image          checked the CLIENT-DECLARED type
  //   PATCH /api/admin/products/[productId]  checked nothing at all
  // A check in the helper is a check both inherit.
  if (input.file.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new Error("Image must be 8 MB or smaller.");
  }

  const bytes = await input.file.arrayBuffer();

  // The bytes decide the type. `file.type` is the Content-Type the client wrote
  // into its own multipart part -- it is a claim, not evidence -- and this
  // bucket is PUBLIC, with the resulting URL attached to a product.
  const sniffed = sniffImageType(new Uint8Array(bytes));
  if (!sniffed) {
    throw new Error("That file doesn't look like an image.");
  }

  const bucket = await ensureProductImageBucket();
  // Extension from the SNIFFED type, never from the client's filename.
  const fileName = `${input.productId}/${Date.now()}-${randomUUID()}.${imageExtensionFor(sniffed)}`;

  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(fileName, Buffer.from(bytes), {
      upsert: false,
      contentType: sniffed,
    });

  if (error) {
    throw error;
  }

  const { data: publicUrlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(fileName);
  const imageUrl = publicUrlData.publicUrl;
  await addProductImageFromUrl({
    productId: input.productId,
    imageUrl,
    isPrimary: input.makePrimary ?? false,
  });

  return imageUrl;
}
