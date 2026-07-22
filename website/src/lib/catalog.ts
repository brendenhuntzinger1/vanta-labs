import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getFulfillmentRuntimeConfig } from "@/lib/fulfillment/config";
import type { CoaRecord, Product, ProductDose, ProductImage } from "@/lib/catalog-types";

// A stored "Out of Stock" is only honored once the 3PL integration is live and
// feeding real inventory. Until then every product is treated as In Stock, so
// the whole catalog stays purchasable and nothing shows "Out of Stock" /
// "Unavailable" — exactly one source of truth for availability: the 3PL.
function resolveStockStatus(rawStatus: string, inventoryActive: boolean): Product["stockStatus"] {
  if (!inventoryActive) {
    return "In Stock";
  }
  return (rawStatus || "In Stock") as Product["stockStatus"];
}

async function isInventoryActive(): Promise<boolean> {
  try {
    const config = await getFulfillmentRuntimeConfig();
    return Boolean(config.enabled);
  } catch {
    return false;
  }
}

function formatPriceFromCents(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
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

function buildProductMaps(rows: Array<Record<string, unknown>>) {
  const productIds = rows.map((row) => String(row.id));
  return { productIds };
}

async function fetchProductRelations(productIds: string[]) {
  const inventoryActive = await isInventoryActive();
  if (productIds.length === 0) {
    return {
      imagesByProductId: new Map<string, ProductImage[]>(),
      dosesByProductId: new Map<string, ProductDose[]>(),
      inventoryActive,
    };
  }

  const [{ data: imageRows, error: imageError }, { data: doseRows, error: doseError }] = await Promise.all([
    supabaseAdmin
      .from("product_images")
      .select("id, product_id, image_url, alt_text, is_primary, position")
      .eq("is_enabled", true)
      .in("product_id", productIds)
      .order("position", { ascending: true }),
    supabaseAdmin
      .from("product_doses")
      .select("id, product_id, label, slug_suffix, sku, price_cents, compare_at_price_cents, sale_price_cents, inventory_quantity, stock_status, batch_number, coa_url, image_url, purity_result, is_default, is_enabled, position")
      .eq("is_enabled", true)
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
    const current = imagesByProductId.get(productId) ?? [];
    current.push({
      id: String(row.id),
      imageUrl: String(row.image_url ?? ""),
      altText: row.alt_text ? String(row.alt_text) : null,
      isPrimary: parseBoolean(row.is_primary, false),
      position: parseNumber(row.position, 0),
    });
    imagesByProductId.set(productId, current);
  }

  const dosesByProductId = new Map<string, ProductDose[]>();
  for (const rawRow of doseRows ?? []) {
    const row = rawRow as Record<string, unknown>;
    const productId = String(row.product_id);
    const current = dosesByProductId.get(productId) ?? [];

    const basePriceCents = parseNumber(row.price_cents, 0);
    const compareAtCents = parseNumber(row.compare_at_price_cents, 0);
    const salePriceCents = parseNumber(row.sale_price_cents, 0);

    current.push({
      id: String(row.id),
      label: String(row.label ?? "Default"),
      slugSuffix: String(row.slug_suffix ?? ""),
      sku: row.sku ? String(row.sku) : undefined,
      price: formatPriceFromCents(basePriceCents),
      compareAtPrice: compareAtCents > 0 ? formatPriceFromCents(compareAtCents) : undefined,
      salePrice: salePriceCents > 0 ? formatPriceFromCents(salePriceCents) : undefined,
      inventoryQuantity: parseNumber(row.inventory_quantity, 0),
      stockStatus: resolveStockStatus(String(row.stock_status ?? "In Stock"), inventoryActive) as ProductDose["stockStatus"],
      batchNumber: row.batch_number ? String(row.batch_number) : undefined,
      coaUrl: row.coa_url ? String(row.coa_url) : undefined,
      imageUrl: row.image_url ? String(row.image_url) : undefined,
      purityResult: row.purity_result ? String(row.purity_result) : undefined,
      isDefault: parseBoolean(row.is_default, false),
      isEnabled: parseBoolean(row.is_enabled, true),
      position: parseNumber(row.position, 0),
    });

    dosesByProductId.set(productId, current);
  }

  return { imagesByProductId, dosesByProductId, inventoryActive };
}

function mapProductRow(
  row: Record<string, unknown>,
  images: ProductImage[],
  doses: ProductDose[],
  inventoryActive = false,
): Product {
  const primaryImage = images.find((image) => image.isPrimary) ?? images[0];
  const defaultDose = doses.find((dose) => dose.isDefault) ?? doses[0];

  const basePriceCents = parseNumber(row.price_cents, 0);
  const compareAtPriceCents = parseNumber(row.compare_at_price_cents, 0);
  const salePriceCents = parseNumber(row.sale_price_cents, 0);
  const rowPrice = salePriceCents > 0 ? salePriceCents : basePriceCents;

  const displayPrice = defaultDose?.salePrice ?? defaultDose?.price ?? formatPriceFromCents(rowPrice);
  const defaultInventoryQuantity = defaultDose?.inventoryQuantity ?? parseNumber(row.inventory_quantity, 0);
  // Availability has exactly one source of truth: the 3PL. Until it's live
  // (inventoryActive === false) everything is In Stock; the doses were already
  // resolved the same way in fetchProductRelations.
  const stockStatus = resolveStockStatus(
    String(defaultDose?.stockStatus ?? row.stock_status ?? "In Stock"),
    inventoryActive,
  );
  const effectiveImage = defaultDose?.imageUrl ?? primaryImage?.imageUrl ?? String(row.image_url ?? "/images/vantalabs.png");
  const effectiveBatchNumber = defaultDose?.batchNumber ?? String(row.batch_number ?? "");
  const effectiveCoaUrl = defaultDose?.coaUrl ?? String(row.coa_url ?? "");
  const effectivePurity = defaultDose?.purityResult ?? (row.purity_result ? String(row.purity_result) : undefined);

  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    category: String(row.category ?? "Research Peptides"),
    shortDescription: row.short_description ? String(row.short_description) : undefined,
    longDescription: row.long_description ? String(row.long_description) : undefined,
    price: displayPrice,
    compareAtPrice: defaultDose?.compareAtPrice ?? (compareAtPriceCents > 0 ? formatPriceFromCents(compareAtPriceCents) : undefined),
    salePrice: defaultDose?.salePrice ?? (salePriceCents > 0 ? formatPriceFromCents(salePriceCents) : undefined),
    stockStatus,
    inventoryQuantity: defaultInventoryQuantity,
    isPublished: parseBoolean(row.is_published, true),
    isEnabled: parseBoolean(row.is_enabled, true),
    isArchived: parseBoolean(row.is_archived, false),
    isFeatured: parseBoolean(row.is_featured, false),
    badge: row.badge ? String(row.badge) as Product["badge"] : null,
    position: parseNumber(row.position, 0),
    batchNumber: effectiveBatchNumber,
    purityResult: effectivePurity,
    description: String(row.long_description ?? row.description ?? ""),
    image: effectiveImage,
    coverImage: effectiveImage,
    galleryImages: images,
    doses,
    defaultDoseId: defaultDose?.id ?? null,
    testingDate: String(row.testing_date ?? ""),
    labName: String(row.lab_name ?? ""),
    coaUrl: effectiveCoaUrl,
    molecularFormula: row.molecular_formula ? String(row.molecular_formula) : undefined,
    seoTitle: row.seo_title ? String(row.seo_title) : undefined,
    seoDescription: row.seo_description ? String(row.seo_description) : undefined,
  };
}

async function fetchPublicProductRows() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, seo_title, seo_description")
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function getCatalogProducts() {
  const productRows = await fetchPublicProductRows();
  const { productIds } = buildProductMaps(productRows);
  const { imagesByProductId, dosesByProductId, inventoryActive } = await fetchProductRelations(productIds);

  return productRows.map((row) => {
    const productId = String(row.id);
    return mapProductRow(
      row,
      imagesByProductId.get(productId) ?? [],
      dosesByProductId.get(productId) ?? [],
      inventoryActive,
    );
  });
}

export async function getCatalogProductBySlug(slug: string) {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, seo_title, seo_description")
    .eq("slug", slug)
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const productId = String(data.id);
  const { imagesByProductId, dosesByProductId, inventoryActive } = await fetchProductRelations([productId]);
  return mapProductRow(
    data as Record<string, unknown>,
    imagesByProductId.get(productId) ?? [],
    dosesByProductId.get(productId) ?? [],
    inventoryActive,
  );
}

export async function getCatalogProductsBySlugs(slugs: string[]) {
  if (slugs.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, seo_title, seo_description")
    .in("slug", slugs)
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false);

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const { productIds } = buildProductMaps(rows);
  const { imagesByProductId, dosesByProductId, inventoryActive } = await fetchProductRelations(productIds);

  const bySlug = new Map(rows.map((row) => {
    const productId = String(row.id);
    return [
      String(row.slug),
      mapProductRow(
        row,
        imagesByProductId.get(productId) ?? [],
        dosesByProductId.get(productId) ?? [],
        inventoryActive,
      ),
    ];
  }));
  return slugs.map((slug) => bySlug.get(slug)).filter(Boolean) as Product[];
}

export async function getCatalogProductsByCategory(category: string, excludeSlug?: string, limit = 4) {
  const query = supabaseAdmin
    .from("products")
    .select("id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, seo_title, seo_description")
    .eq("category", category)
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .order("position", { ascending: true })
    .limit(limit + 1);

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter(
    (row) => !excludeSlug || row.slug !== excludeSlug,
  ).slice(0, limit);

  const { productIds } = buildProductMaps(rows);
  const { imagesByProductId, dosesByProductId, inventoryActive } = await fetchProductRelations(productIds);

  return rows.map((row) => {
    const productId = String(row.id);
    return mapProductRow(
      row,
      imagesByProductId.get(productId) ?? [],
      dosesByProductId.get(productId) ?? [],
      inventoryActive,
    );
  });
}

export async function getCoaRecords() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, batch_number, purity_result, testing_date, lab_name, coa_url")
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .order("testing_date", { ascending: false });

  if (error) {
    throw error;
  }

  const productRows = data ?? [];
  // Meta a variant inherits from its parent (testing date / lab live only on
  // the product row, not on product_doses).
  const productMetaById = new Map(productRows.map((row) => [String(row.id), row]));

  const records: CoaRecord[] = [];
  const seenBatches = new Set<string>();

  for (const row of productRows) {
    const batch = String(row.batch_number ?? "");
    records.push({
      slug: String(row.slug),
      productName: String(row.name),
      category: String(row.category ?? "Research Peptides"),
      batchNumber: batch,
      purityResult: String(row.purity_result ?? "Pending"),
      testingDate: String(row.testing_date ?? ""),
      labName: String(row.lab_name ?? ""),
      coaUrl: String(row.coa_url ?? ""),
    });
    if (batch.trim()) {
      seenBatches.add(batch.trim().toLowerCase());
    }
  }

  // Add per-variant (dosage) batches so each strength with its own lot shows up
  // and is searchable by batch. Variants inherit testing date / lab from the
  // parent product; batch, purity, and COA come from the variant when set.
  const { data: doseData, error: doseError } = await supabaseAdmin
    .from("product_doses")
    .select("product_id, label, batch_number, coa_url, purity_result")
    .eq("is_enabled", true)
    .not("batch_number", "is", null);

  if (doseError) {
    throw doseError;
  }

  for (const dose of doseData ?? []) {
    const product = productMetaById.get(String(dose.product_id));
    if (!product) {
      continue; // parent product isn't public
    }
    const batch = String(dose.batch_number ?? "").trim();
    if (!batch || seenBatches.has(batch.toLowerCase())) {
      continue; // blank, or already covered by the product-level batch
    }
    seenBatches.add(batch.toLowerCase());
    const label = dose.label ? String(dose.label) : undefined;
    records.push({
      slug: String(product.slug),
      productName: label ? `${String(product.name)} — ${label}` : String(product.name),
      category: String(product.category ?? "Research Peptides"),
      batchNumber: batch,
      purityResult: String(dose.purity_result ?? product.purity_result ?? "Pending"),
      testingDate: String(product.testing_date ?? ""),
      labName: String(product.lab_name ?? ""),
      coaUrl: String(dose.coa_url ?? product.coa_url ?? ""),
      doseLabel: label,
    });
  }

  return records;
}

// Look up a single published COA by its batch/lot number for the public
// verification page (`/coa/[batch]`). Matched case-insensitively and trimmed so
// a QR scan or hand-typed lot resolves regardless of spacing/case. Blank batch
// numbers never match, so unverified products can't be reached by an empty URL.
export async function getCoaRecordByBatch(batch: string): Promise<CoaRecord | null> {
  const normalized = batch.trim();
  if (!normalized) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("products")
    .select("slug, name, category, batch_number, purity_result, testing_date, lab_name, coa_url")
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .ilike("batch_number", normalized)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data && String(data.batch_number ?? "").trim()) {
    return {
      slug: String(data.slug),
      productName: String(data.name),
      category: String(data.category ?? "Research Peptides"),
      batchNumber: String(data.batch_number ?? ""),
      purityResult: String(data.purity_result ?? "Pending"),
      testingDate: String(data.testing_date ?? ""),
      labName: String(data.lab_name ?? ""),
      coaUrl: String(data.coa_url ?? ""),
    } satisfies CoaRecord;
  }

  // Fall back to a dosage-variant batch. Variants carry their own batch / purity
  // / COA but inherit testing date + lab from the parent product, so we look the
  // parent up second and enforce the same "publicly visible" checks on it.
  const { data: dose, error: doseError } = await supabaseAdmin
    .from("product_doses")
    .select("product_id, label, batch_number, coa_url, purity_result")
    .eq("is_enabled", true)
    .ilike("batch_number", normalized)
    .limit(1)
    .maybeSingle();

  if (doseError) {
    throw doseError;
  }

  if (!dose || !String(dose.batch_number ?? "").trim()) {
    return null;
  }

  const { data: parent, error: parentError } = await supabaseAdmin
    .from("products")
    .select("slug, name, category, purity_result, testing_date, lab_name, coa_url")
    .eq("id", dose.product_id)
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .maybeSingle();

  if (parentError) {
    throw parentError;
  }

  if (!parent) {
    return null; // variant exists but its product isn't public
  }

  const label = dose.label ? String(dose.label) : undefined;
  return {
    slug: String(parent.slug),
    productName: String(parent.name),
    category: String(parent.category ?? "Research Peptides"),
    batchNumber: String(dose.batch_number ?? ""),
    purityResult: String(dose.purity_result ?? parent.purity_result ?? "Pending"),
    testingDate: String(parent.testing_date ?? ""),
    labName: String(parent.lab_name ?? ""),
    coaUrl: String(dose.coa_url ?? parent.coa_url ?? ""),
    doseLabel: label,
  } satisfies CoaRecord;
}
