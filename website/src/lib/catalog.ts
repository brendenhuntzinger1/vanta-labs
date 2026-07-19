import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import type { CoaRecord, Product, ProductDose, ProductImage } from "@/lib/catalog-types";

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
      stockStatus: String(row.stock_status ?? "In Stock") as ProductDose["stockStatus"],
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

  return { imagesByProductId, dosesByProductId };
}

function mapProductRow(
  row: Record<string, unknown>,
  images: ProductImage[],
  doses: ProductDose[],
): Product {
  const primaryImage = images.find((image) => image.isPrimary) ?? images[0];
  const defaultDose = doses.find((dose) => dose.isDefault) ?? doses[0];

  const basePriceCents = parseNumber(row.price_cents, 0);
  const compareAtPriceCents = parseNumber(row.compare_at_price_cents, 0);
  const salePriceCents = parseNumber(row.sale_price_cents, 0);
  const rowPrice = salePriceCents > 0 ? salePriceCents : basePriceCents;

  const displayPrice = defaultDose?.salePrice ?? defaultDose?.price ?? formatPriceFromCents(rowPrice);
  const defaultInventoryQuantity = defaultDose?.inventoryQuantity ?? parseNumber(row.inventory_quantity, 0);
  const stockStatus = defaultDose?.stockStatus ?? (defaultInventoryQuantity <= 0
    ? "Out of Stock"
    : (String(row.stock_status ?? "In Stock") as Product["stockStatus"]));
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
  const { imagesByProductId, dosesByProductId } = await fetchProductRelations(productIds);

  return productRows.map((row) => {
    const productId = String(row.id);
    return mapProductRow(
      row,
      imagesByProductId.get(productId) ?? [],
      dosesByProductId.get(productId) ?? [],
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
  const { imagesByProductId, dosesByProductId } = await fetchProductRelations([productId]);
  return mapProductRow(
    data as Record<string, unknown>,
    imagesByProductId.get(productId) ?? [],
    dosesByProductId.get(productId) ?? [],
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
  const { imagesByProductId, dosesByProductId } = await fetchProductRelations(productIds);

  const bySlug = new Map(rows.map((row) => {
    const productId = String(row.id);
    return [
      String(row.slug),
      mapProductRow(
        row,
        imagesByProductId.get(productId) ?? [],
        dosesByProductId.get(productId) ?? [],
      ),
    ];
  }));
  return slugs.map((slug) => bySlug.get(slug)).filter(Boolean) as Product[];
}

export async function getCoaRecords() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("slug, name, category, batch_number, purity_result, testing_date, lab_name, coa_url")
    .eq("is_active", true)
    .eq("is_enabled", true)
    .eq("is_published", true)
    .eq("is_archived", false)
    .order("testing_date", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    slug: String(row.slug),
    productName: String(row.name),
    category: String(row.category ?? "Research Peptides"),
    batchNumber: String(row.batch_number ?? ""),
    purityResult: String(row.purity_result ?? "Pending"),
    testingDate: String(row.testing_date ?? ""),
    labName: String(row.lab_name ?? ""),
    coaUrl: String(row.coa_url ?? ""),
  })) satisfies CoaRecord[];
}
