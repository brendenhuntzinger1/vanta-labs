import "server-only";

import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isInventoryTrackingActive } from "@/lib/inventory-settings";
import { CATALOG_CACHE_TAG } from "@/lib/catalog-tag";
import { MAX_UNITS_PER_ORDER_LINE } from "@/lib/purchase-limits";
import type { Product, ProductDose, ProductImage } from "@/lib/catalog-types";
import { parseProductFaq } from "@/lib/product-faq";
import { sanitizeCoaUrl } from "@/lib/coa-url";
import { resolveProductImage } from "@/lib/product-image";

// The catalog changes rarely but the storefront (home / PDP / list) is
// force-dynamic and re-queried it on EVERY request — the top launch-scale risk.
// These reads are cached with a short TTL and a shared tag. Every write that
// can change displayed availability calls invalidateCatalogCache() (see
// lib/catalog-cache.ts), which revalidates this tag, so an admin save is
// visible on the next request instead of up to two requests later.
export { CATALOG_CACHE_TAG };
const CATALOG_CACHE_TTL = 60; // seconds

// Single source of truth for the product columns every public read selects, so
// adding a field is a one-line change instead of editing four query strings.
const PRODUCT_SELECT_COLUMNS =
  "id, slug, name, category, short_description, long_description, description, price_cents, compare_at_price_cents, sale_price_cents, stock_status, inventory_quantity, is_published, is_enabled, is_archived, is_featured, badge, position, batch_number, purity_result, image_url, testing_date, lab_name, coa_url, molecular_formula, molecular_weight, cas_number, peptide_sequence, storage_recommendation, reconstitution_note, product_faq, seo_title, seo_description";

// A stored "Out of Stock" is only honored once inventory tracking is switched
// on in admin settings. Until then every product is treated as In Stock, so the
// whole catalog stays purchasable and nothing shows "Out of Stock" /
// "Unavailable". Vanta Labs is now the sole source of truth for availability —
// this used to be answered by whether a 3PL integration was connected.
function resolveStockStatus(
  rawStatus: string,
  inventoryActive: boolean,
  quantity?: number,
): Product["stockStatus"] {
  if (!inventoryActive) {
    return "In Stock";
  }

  // ZERO MEANS ZERO once tracking is on.
  //
  // The old rule treated a 0 count as "not tracked numerically" and deferred
  // entirely to the stored stock_status. That was right when a 3PL owned the
  // stock and our counts were decorative. Self-fulfilling, it is backwards: a
  // shelf with nothing on it read as In Stock, and the catalogue would sell
  // unlimited units of something that does not exist.
  //
  // Only applies with tracking ON, so switching tracking off restores the old
  // behaviour exactly and nothing here can strand an untracked catalogue.
  if (typeof quantity === "number" && Number.isFinite(quantity) && quantity <= 0) {
    return "Out of Stock";
  }

  return (rawStatus || "In Stock") as Product["stockStatus"];
}

async function isInventoryActive(): Promise<boolean> {
  return isInventoryTrackingActive();
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

/**
 * Units currently held by in-flight checkouts.
 *
 * Read separately from the catalogue queries on purpose. Those queries decide
 * whether the storefront renders at all, and they work today; adding a column
 * to them would mean a missing migration takes the shop down. A failure here
 * degrades to "nothing reserved", which is exactly the behaviour that shipped
 * before this existed.
 */
async function fetchReservedQuantities(productIds: string[]): Promise<{
  byProductId: Map<string, number>;
  byDoseId: Map<string, number>;
}> {
  const byProductId = new Map<string, number>();
  const byDoseId = new Map<string, number>();
  if (productIds.length === 0) return { byProductId, byDoseId };

  try {
    const [products, doses] = await Promise.all([
      supabaseAdmin.from("products").select("id, reserved_quantity").in("id", productIds),
      supabaseAdmin.from("product_doses").select("id, reserved_quantity").in("product_id", productIds),
    ]);
    for (const row of (products.data ?? []) as { id?: string; reserved_quantity?: number | null }[]) {
      if (row.id) byProductId.set(row.id, Math.max(0, Number(row.reserved_quantity ?? 0)));
    }
    for (const row of (doses.data ?? []) as { id?: string; reserved_quantity?: number | null }[]) {
      if (row.id) byDoseId.set(row.id, Math.max(0, Number(row.reserved_quantity ?? 0)));
    }
  } catch {
    /* column or table absent — treat as nothing reserved */
  }

  return { byProductId, byDoseId };
}

/** What a shopper can actually buy right now: on hand, less what is held. */
function sellable(onHand: number, reserved: number): number {
  return Math.max(0, onHand - reserved);
}

/**
 * The availability figure that is safe to publish to a browser.
 *
 * Stock depth is the owner's commercial information — how fast a line is
 * moving, how much capital sits on the shelf, when a competitor could drain it.
 * The storefront only ever needs to know two things: is there none, and may I
 * offer this many. Clamping to the per-line order ceiling answers both while
 * telling a reader of the page source at most "ten or more".
 *
 * Zero passes through unclamped, because zero is the one stock fact a customer
 * IS shown.
 */
function publishableAvailability(available: number): number {
  return Math.min(available, MAX_UNITS_PER_ORDER_LINE);
}

async function fetchProductRelations(productIds: string[]) {
  const inventoryActive = await isInventoryActive();
  if (productIds.length === 0) {
    return {
      imagesByProductId: new Map<string, ProductImage[]>(),
      dosesByProductId: new Map<string, ProductDose[]>(),
      inventoryActive,
      reservedByProductId: new Map<string, number>(),
    };
  }

  const reserved = await fetchReservedQuantities(productIds);

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
      // inventoryQuantity is deliberately ABSENT. These objects are handed to
      // client components, so anything on them is readable in the page source;
      // the shelf depth is the owner's information. Server code that needs the
      // real figure calls getStockLevelsBySlugs() below.
      //
      // Availability, not stock on hand. A unit held by someone mid-checkout is
      // not sellable, and showing it as In Stock sends a second shopper all the
      // way to checkout before telling them it is gone.
      availableQuantity: inventoryActive
        ? publishableAvailability(sellable(parseNumber(row.inventory_quantity, 0), reserved.byDoseId.get(String(row.id)) ?? 0))
        : null,
      stockStatus: resolveStockStatus(
        String(row.stock_status ?? "In Stock"),
        inventoryActive,
        sellable(parseNumber(row.inventory_quantity, 0), reserved.byDoseId.get(String(row.id)) ?? 0),
      ) as ProductDose["stockStatus"],
      batchNumber: row.batch_number ? String(row.batch_number) : undefined,
      coaUrl: sanitizeCoaUrl(row.coa_url) || undefined,
      imageUrl: row.image_url ? String(row.image_url) : undefined,
      purityResult: row.purity_result ? String(row.purity_result) : undefined,
      isDefault: parseBoolean(row.is_default, false),
      isEnabled: parseBoolean(row.is_enabled, true),
      position: parseNumber(row.position, 0),
    });

    dosesByProductId.set(productId, current);
  }

  return { imagesByProductId, dosesByProductId, inventoryActive, reservedByProductId: reserved.byProductId };
}

function mapProductRow(
  row: Record<string, unknown>,
  images: ProductImage[],
  doses: ProductDose[],
  inventoryActive = false,
  /** Units held by in-flight checkouts for this product. */
  reservedQuantity = 0,
): Product {
  const primaryImage = images.find((image) => image.isPrimary) ?? images[0];
  const defaultDose = doses.find((dose) => dose.isDefault) ?? doses[0];

  const basePriceCents = parseNumber(row.price_cents, 0);
  const compareAtPriceCents = parseNumber(row.compare_at_price_cents, 0);
  const salePriceCents = parseNumber(row.sale_price_cents, 0);
  const rowPrice = salePriceCents > 0 ? salePriceCents : basePriceCents;

  const displayPrice = defaultDose?.salePrice ?? defaultDose?.price ?? formatPriceFromCents(rowPrice);
  // Only meaningful for a product sold WITHOUT doses; a dosed product's stock
  // lives on the dose rows, and this column is a stale shadow of it.
  const productLevelQuantity = parseNumber(row.inventory_quantity, 0);
  // What backs this product, expressed as "units we may offer". For a dosed
  // product that is the default dose's already-computed figure (its own status
  // and reservations are baked in by fetchProductRelations); for an undosed one
  // it is this row's count less its holds. Note the dose branch reads
  // availableQuantity, NOT a raw count — the dose objects no longer carry one,
  // and this value is exactly as good for the zero test below.
  const backingAvailability = defaultDose
    ? defaultDose.availableQuantity ?? undefined
    : sellable(productLevelQuantity, reservedQuantity);
  // Availability has exactly one source of truth: Vanta Labs. Until tracking is
  // on (inventoryActive === false) everything is In Stock.
  const stockStatus = resolveStockStatus(
    String(defaultDose?.stockStatus ?? row.stock_status ?? "In Stock"),
    inventoryActive,
    backingAvailability,
  );
  const effectiveImage = resolveProductImage(defaultDose?.imageUrl ?? primaryImage?.imageUrl ?? row.image_url);
  const effectiveBatchNumber = defaultDose?.batchNumber ?? String(row.batch_number ?? "");
  const effectiveCoaUrl = defaultDose?.coaUrl ?? sanitizeCoaUrl(row.coa_url);
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
    // inventoryQuantity is deliberately ABSENT — see the dose mapping above.
    // A product with doses is sold through its doses, so its headline
    // availability is the default dose's already-computed figure; a product
    // without doses subtracts its own reservations here.
    availableQuantity: !inventoryActive
      ? null
      : defaultDose
        ? defaultDose.availableQuantity ?? null
        : publishableAvailability(sellable(productLevelQuantity, reservedQuantity)),
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

async function fetchPublicProductRows() {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(PRODUCT_SELECT_COLUMNS)
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

export const getCatalogProducts = unstable_cache(
  async () => {
    const productRows = await fetchPublicProductRows();
    const { productIds } = buildProductMaps(productRows);
    const { imagesByProductId, dosesByProductId, inventoryActive, reservedByProductId } = await fetchProductRelations(productIds);

    return productRows.map((row) => {
      const productId = String(row.id);
      return mapProductRow(
        row,
        imagesByProductId.get(productId) ?? [],
        dosesByProductId.get(productId) ?? [],
        inventoryActive,
        reservedByProductId.get(productId) ?? 0,
      );
    });
  },
  ["catalog-products-all"],
  { tags: [CATALOG_CACHE_TAG], revalidate: CATALOG_CACHE_TTL },
);

export const getCatalogProductBySlug = unstable_cache(
  async (slug: string) => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(PRODUCT_SELECT_COLUMNS)
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
  const { imagesByProductId, dosesByProductId, inventoryActive, reservedByProductId } = await fetchProductRelations([productId]);
  return mapProductRow(
    data as Record<string, unknown>,
    imagesByProductId.get(productId) ?? [],
    dosesByProductId.get(productId) ?? [],
    inventoryActive,
    reservedByProductId.get(productId) ?? 0,
  );
  },
  ["catalog-product-by-slug"],
  { tags: [CATALOG_CACHE_TAG], revalidate: CATALOG_CACHE_TTL },
);

export async function getCatalogProductsBySlugs(slugs: string[]) {
  if (slugs.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("products")
    .select(PRODUCT_SELECT_COLUMNS)
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
  const { imagesByProductId, dosesByProductId, inventoryActive, reservedByProductId } = await fetchProductRelations(productIds);

  const bySlug = new Map(rows.map((row) => {
    const productId = String(row.id);
    return [
      String(row.slug),
      mapProductRow(
        row,
        imagesByProductId.get(productId) ?? [],
        dosesByProductId.get(productId) ?? [],
        inventoryActive,
        reservedByProductId.get(productId) ?? 0,
      ),
    ];
  }));
  return slugs.map((slug) => bySlug.get(slug)).filter(Boolean) as Product[];
}

export const getCatalogProductsByCategory = unstable_cache(
  async (category: string, excludeSlug?: string, limit = 4) => {
  const query = supabaseAdmin
    .from("products")
    .select(PRODUCT_SELECT_COLUMNS)
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
  const { imagesByProductId, dosesByProductId, inventoryActive, reservedByProductId } = await fetchProductRelations(productIds);

  return rows.map((row) => {
    const productId = String(row.id);
    return mapProductRow(
      row,
      imagesByProductId.get(productId) ?? [],
      dosesByProductId.get(productId) ?? [],
      inventoryActive,
      reservedByProductId.get(productId) ?? 0,
    );
  });
  },
  ["catalog-products-by-category"],
  { tags: [CATALOG_CACHE_TAG], revalidate: CATALOG_CACHE_TTL },
);

/**
 * Raw stock counts for the checkout guard — SERVER ONLY, never serialized.
 *
 * The public catalog objects deliberately carry no `inventoryQuantity`: they
 * are handed to client components, so anything on them ends up readable in the
 * page source, and the depth of the shelf is the owner's commercial
 * information. quoteOrder() still needs the true figure for its secondary
 * oversell check (the authoritative one is the row-locked reserve_inventory()),
 * so it asks for exactly that, here, and nothing else travels with it.
 *
 * Uncached on purpose. A stale count is fine for merchandising and wrong for a
 * purchase decision, and this is only ever called on the checkout path.
 *
 * ONLY TRACKED ROWS ARE RETURNED. That is not a filter for convenience — it is
 * what keeps checkout agreeing with the storefront. `track_inventory` defaults
 * to false, and an untracked row's count is decorative: the storefront sells it
 * freely and reserve_inventory() lets it through without a hold. Returning the
 * count anyway made quoteOrder's guard enforce a number nothing else believed,
 * so a shopper could be refused 10 units of something the site was advertising
 * as available — a lost sale caused by a figure the owner had been told was
 * inert.
 *
 * Keys are `slug` for a product-level count and the dose UUID for a variant.
 * A failure returns an empty map, which makes the guard a no-op — the atomic
 * reservation still refuses the sale, so failing open here cannot oversell.
 */
export async function getStockLevelsBySlugs(slugs: string[]): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  if (slugs.length === 0) {
    return levels;
  }

  try {
    const { data: products, error } = await supabaseAdmin
      .from("products")
      .select("id, slug, inventory_quantity, track_inventory")
      .in("slug", slugs);

    if (error) throw error;

    const productIds: string[] = [];
    for (const row of (products ?? []) as Array<{ id?: string; slug?: string; inventory_quantity?: number | null; track_inventory?: boolean | null }>) {
      if (row.slug && row.track_inventory === true) {
        levels.set(String(row.slug), Math.max(0, Number(row.inventory_quantity ?? 0)));
      }
      // Doses are still fetched for an untracked parent: tracking is per-row, so
      // a tracked dose under an untracked product must still be enforced.
      if (row.id) productIds.push(String(row.id));
    }

    if (productIds.length > 0) {
      const { data: doses, error: doseError } = await supabaseAdmin
        .from("product_doses")
        .select("id, inventory_quantity, track_inventory")
        .in("product_id", productIds);

      if (doseError) throw doseError;

      for (const row of (doses ?? []) as Array<{ id?: string; inventory_quantity?: number | null; track_inventory?: boolean | null }>) {
        if (row.id && row.track_inventory === true) {
          levels.set(String(row.id), Math.max(0, Number(row.inventory_quantity ?? 0)));
        }
      }
    }
  } catch (error) {
    console.error("[catalog] getStockLevelsBySlugs failed; oversell guard degrades to the atomic reservation", error);
    return new Map();
  }

  return levels;
}
