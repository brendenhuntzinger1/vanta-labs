import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { lineWeightOz } from "@/lib/shippo/parcel";

/**
 * Ounces. Anything heavier than a single unit of this is a typo (a decimal
 * point in the wrong place, or pounds entered as ounces), not a peptide vial —
 * and a typo here is real money, because the weight is multiplied by the
 * quantity and handed straight to Shippo as the postage basis.
 *
 * 1120 oz is 70 lb, the heaviest single parcel USPS/UPS/FedEx will accept at
 * all, so nothing legitimate can exceed it.
 */
export const MAX_UNIT_WEIGHT_OZ = 1120;

/**
 * A catalog is treated as "not really populated" once this share of its lines
 * still sit at zero. Half is deliberately lenient: a store that has entered
 * counts for most of its catalog and left a few discontinued lines at zero is
 * making a real decision, while one where half the lines were never touched has
 * simply not done the work yet.
 */
export const EMPTY_INVENTORY_ZERO_RATIO = 0.5;

/** How many affected product names the enforcement warning names out loud. */
const SAMPLE_BLOCKED_NAME_LIMIT = 6;

export interface InventoryLine {
  key: string;
  productId: string;
  doseId: string | null;
  productSlug: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  category: string;
  inventoryQuantity: number;
  /** Units ordered from a supplier but NOT yet on the shelf. Never sellable. */
  incomingQuantity: number;
  lowStockThreshold: number;
  isLowStock: boolean;
  isOutOfStock: boolean;
  /**
   * The stored status string, NOT a derived one. This is what actually gates
   * the storefront once enforcement is on (resolveStockStatus in catalog.ts),
   * and it can hold values the quantity does not imply — "Limited" and
   * "Reserved" are set deliberately in the product editor and must survive a
   * quick quantity edit here.
   */
  stockStatus: string;
  /**
   * Stored packed weight of ONE unit, in ounces, exactly as the row holds it.
   * null on a dose means "inherit the parent product"; null on a product means
   * nothing has been weighed yet.
   */
  shippingWeightOz: number | null;
  /** The product-level weight a dose line would inherit. null on product lines. */
  inheritedShippingWeightOz: number | null;
  /**
   * What the parcel builder will actually use for one unit of this line.
   * Computed with lineWeightOz() from shippo/parcel.ts rather than re-derived
   * here, so the number the owner reads on this screen is the number that gets
   * quoted — a second implementation of the fallback chain is how the admin UI
   * ends up disagreeing with the label.
   */
  effectiveShippingWeightOz: number;
  /** Where effectiveShippingWeightOz came from, so the UI can say so. */
  shippingWeightSource: "line" | "inherited" | "default";
}

/**
 * `numeric` columns arrive as a number or a string depending on the driver, and
 * a genuinely absent weight arrives as null. Zero and negatives are folded into
 * null on purpose: parcel.ts treats them as missing (a weightless vial does not
 * exist), so surfacing them as real values would show the owner a weight the
 * label will never use.
 */
function toStoredWeight(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toLine(input: {
  productId: string;
  doseId: string | null;
  productSlug: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  category: string;
  inventoryQuantity: number;
  incomingQuantity?: number;
  lowStockThreshold: number;
  stockStatus: string;
  shippingWeightOz: number | null;
  inheritedShippingWeightOz: number | null;
}): InventoryLine {
  const inventoryQuantity = Math.max(0, Math.round(input.inventoryQuantity));
  const lowStockThreshold = Math.max(0, Math.round(input.lowStockThreshold));

  const effectiveShippingWeightOz = lineWeightOz({
    doseWeightOz: input.doseId ? input.shippingWeightOz : null,
    productWeightOz: input.doseId ? input.inheritedShippingWeightOz : input.shippingWeightOz,
  });

  const shippingWeightSource: InventoryLine["shippingWeightSource"] = input.shippingWeightOz !== null
    ? "line"
    : input.inheritedShippingWeightOz !== null
      ? "inherited"
      : "default";

  return {
    key: input.doseId ? `dose:${input.doseId}` : `product:${input.productId}`,
    ...input,
    inventoryQuantity,
    incomingQuantity: Math.max(0, Math.round(Number(input.incomingQuantity ?? 0))),
    lowStockThreshold,
    isOutOfStock: inventoryQuantity <= 0,
    isLowStock: inventoryQuantity > 0 && inventoryQuantity <= lowStockThreshold,
    effectiveShippingWeightOz,
    shippingWeightSource,
  };
}

export async function getInventoryRows(): Promise<InventoryLine[]> {
  // Archived products are excluded. They are soft-deleted predecessors kept so
  // historical orders still resolve — superseded imports whose doses are labelled
  // with a space ("5 mg" vs "5mg"). They can never be sold and are never
  // reports stock for them, so they sat permanently at zero and made the screen
  // read as though live stock had failed to sync: e.g. a real "GLP-1 — 5mg = 92"
  // next to a dead "GLP-1 — 5 mg = 0".
  const { data: products, error: productError } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, inventory_quantity, incoming_quantity, low_stock_threshold, stock_status, shipping_weight_oz")
    .eq("is_archived", false)
    .order("name", { ascending: true });

  if (productError) {
    throw productError;
  }

  const productIds = (products ?? []).map((product) => String(product.id));

  const { data: doses, error: doseError } = productIds.length > 0
    ? await supabaseAdmin
        .from("product_doses")
        .select("id, product_id, label, sku, inventory_quantity, incoming_quantity, low_stock_threshold, stock_status, shipping_weight_oz")
        .in("product_id", productIds)
        .order("position", { ascending: true })
    : { data: [], error: null };

  if (doseError) {
    throw doseError;
  }

  const dosesByProductId = new Map<string, typeof doses>();
  for (const dose of doses ?? []) {
    const list = dosesByProductId.get(String(dose.product_id)) ?? [];
    list.push(dose);
    dosesByProductId.set(String(dose.product_id), list);
  }

  const lines: InventoryLine[] = [];

  for (const product of products ?? []) {
    const productId = String(product.id);
    const productDoses = dosesByProductId.get(productId) ?? [];
    const productWeight = toStoredWeight(product.shipping_weight_oz);

    if (productDoses.length === 0) {
      lines.push(toLine({
        productId,
        doseId: null,
        productSlug: String(product.slug),
        productName: String(product.name),
        variantLabel: null,
        sku: null,
        category: String(product.category ?? ""),
        inventoryQuantity: Number(product.inventory_quantity ?? 0),
        incomingQuantity: Number(product.incoming_quantity ?? 0),
        lowStockThreshold: Number(product.low_stock_threshold ?? 5),
        stockStatus: String(product.stock_status ?? "In Stock"),
        shippingWeightOz: productWeight,
        inheritedShippingWeightOz: null,
      }));
      continue;
    }

    for (const dose of productDoses) {
      lines.push(toLine({
        productId,
        doseId: String(dose.id),
        productSlug: String(product.slug),
        productName: String(product.name),
        variantLabel: String(dose.label ?? ""),
        sku: dose.sku ? String(dose.sku) : null,
        category: String(product.category ?? ""),
        inventoryQuantity: Number(dose.inventory_quantity ?? 0),
        incomingQuantity: Number(dose.incoming_quantity ?? 0),
        lowStockThreshold: Number(dose.low_stock_threshold ?? 5),
        stockStatus: String(dose.stock_status ?? "In Stock"),
        shippingWeightOz: toStoredWeight(dose.shipping_weight_oz),
        // A dose falls back to the parent product's weight, matching the
        // NULL-means-inherit contract on product_doses.shipping_weight_oz.
        inheritedShippingWeightOz: productWeight,
      }));
    }
  }

  return lines.sort((a, b) => a.productName.localeCompare(b.productName));
}

export async function getLowStockCount(): Promise<number> {
  const rows = await getInventoryRows();
  return rows.filter((row) => row.isLowStock || row.isOutOfStock).length;
}

// ----------------------------------------------------- enforcement guard ----

/**
 * Is the inventory table populated enough for enforcement to be switched on
 * without stripping the storefront?
 *
 * WHY THIS IS SERVER-SIDE. Turning on "Enforce inventory on the storefront"
 * makes stored statuses and zero quantities start blocking sales the instant it
 * is saved. The settings screen may have been open for an hour, or another
 * admin may have been editing counts in a second tab, so a warning computed
 * from whatever the browser happens to be holding can be confidently wrong in
 * exactly the case that matters. This reads the database at the moment the
 * question is asked.
 */
export interface InventoryReadiness {
  totalLines: number;
  /** Lines with a real positive count entered. */
  stockedLines: number;
  /** Lines still sitting at zero — nothing has been entered for them. */
  zeroQuantityLines: number;
  /**
   * Lines enforcement would pull off the storefront the moment it is enabled,
   * measured against the stored status that actually gates the sale rather than
   * against the quantity alone.
   */
  blockedLines: number;
  /** Share of lines at zero, 0..1. 0 when there are no lines at all. */
  zeroRatio: number;
  /** True when enabling enforcement now would strip most or all of the catalog. */
  isEffectivelyEmpty: boolean;
  /** A few of the affected names, so the warning can be concrete rather than statistical. */
  sampleBlockedNames: string[];
  /** When this was measured, so the UI can show the operator it is fresh. */
  checkedAt: string;
}

function displayName(row: InventoryLine): string {
  return row.variantLabel ? `${row.productName} — ${row.variantLabel}` : row.productName;
}

export async function getInventoryReadiness(): Promise<InventoryReadiness> {
  // Deliberately reuses getInventoryRows() rather than running a leaner
  // count query: the guard must measure exactly the set of lines the Inventory
  // screen shows and the storefront sells (archived products excluded, doses
  // preferred over their parent). A second, subtly different query is how a
  // guard ends up reassuring the owner about rows that are not the ones at
  // risk.
  const rows = await getInventoryRows();
  const checkedAt = new Date().toISOString();

  const totalLines = rows.length;
  const zeroQuantityLines = rows.filter((row) => row.inventoryQuantity <= 0).length;
  const stockedLines = totalLines - zeroQuantityLines;

  // "Out of Stock" is the stored value resolveStockStatus() honours once
  // enforcement is live, so it — not the quantity — is what actually removes a
  // line from sale. A line at zero whose status still reads "In Stock" stays
  // purchasable until something rewrites it, and saying otherwise would be a
  // false alarm.
  const blocked = rows.filter((row) => row.stockStatus === "Out of Stock");

  const zeroRatio = totalLines === 0 ? 0 : zeroQuantityLines / totalLines;

  // An empty catalog counts as "effectively empty" too: there is nothing to
  // enforce against, so the flag is at best premature.
  const isEffectivelyEmpty = totalLines === 0 || stockedLines === 0 || zeroRatio >= EMPTY_INVENTORY_ZERO_RATIO;

  return {
    totalLines,
    stockedLines,
    zeroQuantityLines,
    blockedLines: blocked.length,
    zeroRatio,
    isEffectivelyEmpty,
    sampleBlockedNames: blocked.slice(0, SAMPLE_BLOCKED_NAME_LIMIT).map(displayName),
    checkedAt,
  };
}

// ------------------------------------------------------------- adjusting ----

function normalizeStockStatus(quantity: number): "In Stock" | "Out of Stock" {
  return quantity <= 0 ? "Out of Stock" : "In Stock";
}

export interface InventoryLineAdjustment {
  productId: string;
  doseId?: string | null;
  quantity?: number;
  lowStockThreshold?: number;
  /**
   * Packed weight of ONE unit in ounces. `undefined` leaves the stored value
   * alone; `null` clears it, which on a dose means "inherit the parent product"
   * and on a product means "fall back to the catalog default".
   */
  shippingWeightOz?: number | null;
  /** Who made the change, for the ledger. */
  actor?: string | null;
  /** Free-text explanation, shown in the inventory history. */
  reason?: string | null;
}

/**
 * Validate an operator-entered packed weight.
 *
 * Rejects rather than coerces. A silently-clamped weight is a wrong parcel and
 * therefore wrong postage, and the owner would have no way to know their typo
 * was quietly rewritten — the whole point of this field is that they weigh the
 * real thing and the number they read back is the number that ships.
 */
function normalizeShippingWeightOz(value: number | null): { ok: true; value: number | null } | { ok: false; message: string } {
  if (value === null) {
    return { ok: true, value: null };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: "Shipping weight must be a number of ounces." };
  }
  if (parsed <= 0) {
    // Zero would be stored and then ignored by parcel.ts, so the row would
    // silently rate at the default instead. Clearing the field is the honest
    // way to say "I haven't weighed this".
    return { ok: false, message: "Shipping weight must be greater than zero. Leave it blank to use the default instead." };
  }
  if (parsed > MAX_UNIT_WEIGHT_OZ) {
    return { ok: false, message: `Shipping weight looks wrong — ${MAX_UNIT_WEIGHT_OZ} oz (70 lb) is the heaviest parcel any carrier accepts. Is that value in pounds?` };
  }

  // Hundredths of an ounce is finer than any carrier's granularity and keeps
  // binary float noise out of the column.
  return { ok: true, value: Math.round((parsed + Number.EPSILON) * 100) / 100 };
}

export async function adjustInventoryLine(input: InventoryLineAdjustment) {
  const table = input.doseId ? "product_doses" : "products";
  const matchValue = input.doseId ?? input.productId;

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Track a 0 → back-in-stock transition so we can notify waitlisted shoppers.
  let restockedTo = 0;
  let wasOutOfStock = false;
  // Captured for the ledger: an audit row with no "before" cannot answer the
  // question it exists for.
  let quantityBefore: number | null = null;

  if (input.quantity !== undefined) {
    const q = Number(input.quantity);
    if (!Number.isFinite(q)) {
      // Reject non-numeric input rather than writing NaN into inventory_quantity.
      throw new Error("Inventory quantity must be a valid number.");
    }
    const quantity = Math.max(0, Math.round(q));
    updatePayload.inventory_quantity = quantity;
    restockedTo = quantity;

    // Only auto-flip between In Stock / Out of Stock - never clobber a
    // manually-set "Limited" or "Reserved" status, which the product editor
    // uses intentionally and this quick-adjust flow shouldn't override.
    const { data: current } = await supabaseAdmin
      .from(table)
      .select("stock_status, inventory_quantity")
      .eq("id", matchValue)
      .maybeSingle();

    quantityBefore = current?.inventory_quantity == null ? null : Number(current.inventory_quantity);
    const currentStatus = String(current?.stock_status ?? "In Stock");
    wasOutOfStock = currentStatus === "Out of Stock" || Number(current?.inventory_quantity ?? 0) <= 0;
    if (currentStatus === "In Stock" || currentStatus === "Out of Stock") {
      updatePayload.stock_status = normalizeStockStatus(quantity);
    }
  }

  if (input.lowStockThreshold !== undefined) {
    updatePayload.low_stock_threshold = Math.max(0, Math.round(input.lowStockThreshold));
  }

  if (input.shippingWeightOz !== undefined) {
    const weight = normalizeShippingWeightOz(input.shippingWeightOz);
    if (!weight.ok) {
      throw new Error(weight.message);
    }
    updatePayload.shipping_weight_oz = weight.value;
  }

  if (Object.keys(updatePayload).length <= 1) {
    return;
  }

  const { error } = await supabaseAdmin
    .from(table)
    .update(updatePayload)
    .eq("id", matchValue);

  if (error) {
    throw error;
  }

  // Append to the ledger. Best-effort: the stock has already moved, so throwing
  // here would fail an operation that succeeded and turn a missing audit row
  // into a misleading error.
  if (input.quantity !== undefined) {
    const after = Math.max(0, Math.round(Number(input.quantity)));
    const { recordInventoryTransaction } = await import("@/lib/inventory-ledger");
    await recordInventoryTransaction({
      productId: input.productId,
      doseId: input.doseId ?? null,
      type: "manual_set",
      delta: quantityBefore === null ? after : after - quantityBefore,
      quantityBefore,
      quantityAfter: after,
      reason: input.reason ?? null,
      actor: input.actor ?? null,
    });
  }

  // Fire back-in-stock notifications on a genuine 0 → in-stock transition.
  if (wasOutOfStock && restockedTo > 0) {
    try {
      const { notifyBackInStock } = await import("@/lib/back-in-stock");
      if (input.doseId) {
        const { data: dose } = await supabaseAdmin.from("product_doses").select("product_id, label").eq("id", input.doseId).maybeSingle();
        if (dose?.product_id) {
          const { data: product } = await supabaseAdmin.from("products").select("slug, name").eq("id", dose.product_id).maybeSingle();
          if (product?.slug) await notifyBackInStock(String(product.slug), String(product.name ?? "Product"), input.doseId);
        }
      } else {
        const { data: product } = await supabaseAdmin.from("products").select("slug, name").eq("id", input.productId).maybeSingle();
        if (product?.slug) await notifyBackInStock(String(product.slug), String(product.name ?? "Product"));
      }
    } catch {
      // Notifications are best-effort; the inventory update already succeeded.
    }
  }
}
