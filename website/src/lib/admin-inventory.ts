import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

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
  lowStockThreshold: number;
  isLowStock: boolean;
  isOutOfStock: boolean;
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
  lowStockThreshold: number;
}): InventoryLine {
  const inventoryQuantity = Math.max(0, Math.round(input.inventoryQuantity));
  const lowStockThreshold = Math.max(0, Math.round(input.lowStockThreshold));

  return {
    key: input.doseId ? `dose:${input.doseId}` : `product:${input.productId}`,
    ...input,
    inventoryQuantity,
    lowStockThreshold,
    isOutOfStock: inventoryQuantity <= 0,
    isLowStock: inventoryQuantity > 0 && inventoryQuantity <= lowStockThreshold,
  };
}

export async function getInventoryRows(): Promise<InventoryLine[]> {
  const { data: products, error: productError } = await supabaseAdmin
    .from("products")
    .select("id, slug, name, category, inventory_quantity, low_stock_threshold")
    .order("name", { ascending: true });

  if (productError) {
    throw productError;
  }

  const productIds = (products ?? []).map((product) => String(product.id));

  const { data: doses, error: doseError } = productIds.length > 0
    ? await supabaseAdmin
        .from("product_doses")
        .select("id, product_id, label, sku, inventory_quantity, low_stock_threshold")
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
        lowStockThreshold: Number(product.low_stock_threshold ?? 5),
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
        lowStockThreshold: Number(dose.low_stock_threshold ?? 5),
      }));
    }
  }

  return lines.sort((a, b) => a.productName.localeCompare(b.productName));
}

export async function getLowStockCount(): Promise<number> {
  const rows = await getInventoryRows();
  return rows.filter((row) => row.isLowStock || row.isOutOfStock).length;
}

function normalizeStockStatus(quantity: number): "In Stock" | "Out of Stock" {
  return quantity <= 0 ? "Out of Stock" : "In Stock";
}

export async function adjustInventoryLine(input: { productId: string; doseId?: string | null; quantity?: number; lowStockThreshold?: number }) {
  const table = input.doseId ? "product_doses" : "products";
  const matchValue = input.doseId ?? input.productId;

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (input.quantity !== undefined) {
    const quantity = Math.max(0, Math.round(input.quantity));
    updatePayload.inventory_quantity = quantity;

    // Only auto-flip between In Stock / Out of Stock - never clobber a
    // manually-set "Limited" or "Reserved" status, which the product editor
    // uses intentionally and this quick-adjust flow shouldn't override.
    const { data: current } = await supabaseAdmin
      .from(table)
      .select("stock_status")
      .eq("id", matchValue)
      .maybeSingle();

    const currentStatus = String(current?.stock_status ?? "In Stock");
    if (currentStatus === "In Stock" || currentStatus === "Out of Stock") {
      updatePayload.stock_status = normalizeStockStatus(quantity);
    }
  }

  if (input.lowStockThreshold !== undefined) {
    updatePayload.low_stock_threshold = Math.max(0, Math.round(input.lowStockThreshold));
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
}
