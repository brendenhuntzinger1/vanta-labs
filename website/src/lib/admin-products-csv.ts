import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { createAdminProduct, updateAdminProduct, listAdminProducts } from "@/lib/admin-products";

const CSV_COLUMNS = [
  "slug",
  "name",
  "category",
  "shortDescription",
  "price",
  "compareAtPrice",
  "salePrice",
  "inventoryQuantity",
  "stockStatus",
  "isPublished",
  "isEnabled",
  "isFeatured",
  "badge",
  "batchNumber",
  "coaUrl",
] as const;

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

function toDollarsString(currencyString: string | undefined) {
  if (!currencyString) return "";
  return currencyString.replace(/[^0-9.]/g, "");
}

// Products only - dose/variant rows are nested one-to-many data that doesn't
// map cleanly onto flat CSV rows, so variant management stays in the
// product editor. This covers base product fields only.
export async function exportProductsCsv(): Promise<string> {
  const products = await listAdminProducts({ search: "", category: "all", status: "all" });

  const rows = products.map((product) => ({
    slug: product.slug,
    name: product.name,
    category: product.category,
    shortDescription: product.shortDescription ?? "",
    price: toDollarsString(product.price),
    compareAtPrice: toDollarsString(product.compareAtPrice),
    salePrice: toDollarsString(product.salePrice),
    inventoryQuantity: product.inventoryQuantity,
    stockStatus: product.stockStatus,
    isPublished: product.isPublished,
    isEnabled: product.isEnabled,
    isFeatured: product.isFeatured,
    badge: product.badge ?? "",
    batchNumber: product.batchNumber ?? "",
    coaUrl: product.coaUrl ?? "",
  }));

  return [
    CSV_COLUMNS.join(","),
    ...rows.map((row) => CSV_COLUMNS.map((key) => csvEscape(row[key as keyof typeof row])).join(",")),
  ].join("\n");
}

// Minimal RFC 4180-ish CSV parser: handles quoted fields, escaped quotes,
// and commas/newlines inside quotes. Good enough for the flat export format
// above (no need for a dependency for this one flow).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === "\"") {
        if (text[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function parseDollarsToCents(value: string) {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function parseBooleanCell(value: string, fallback: boolean) {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return fallback;
}

export interface ProductImportResult {
  created: number;
  updated: number;
  errors: Array<{ row: number; slug: string; message: string }>;
}

export async function importProductsCsv(csvText: string): Promise<ProductImportResult> {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    return { created: 0, updated: 0, errors: [] };
  }

  const header = rows[0].map((cell) => cell.trim());
  const dataRows = rows.slice(1);

  const result: ProductImportResult = { created: 0, updated: 0, errors: [] };

  const { data: existingProducts, error: existingError } = await supabaseAdmin
    .from("products")
    .select("id, slug");

  if (existingError) {
    throw existingError;
  }

  const idBySlug = new Map((existingProducts ?? []).map((row) => [String(row.slug), String(row.id)]));

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const cells = dataRows[rowIndex];
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key] = cells[index] ?? "";
    });

    const slug = record.slug?.trim();
    const name = record.name?.trim();

    if (!slug || !name) {
      result.errors.push({ row: rowIndex + 2, slug: slug || "(missing)", message: "slug and name are required" });
      continue;
    }

    try {
      const input = {
        slug,
        name,
        category: record.category?.trim() || "Research Peptides",
        shortDescription: record.shortDescription || undefined,
        priceCents: parseDollarsToCents(record.price || "0"),
        compareAtPriceCents: record.compareAtPrice ? parseDollarsToCents(record.compareAtPrice) : undefined,
        salePriceCents: record.salePrice ? parseDollarsToCents(record.salePrice) : undefined,
        inventoryQuantity: Number(record.inventoryQuantity) || 0,
        stockStatus: (["In Stock", "Limited", "Reserved", "Out of Stock"].includes(record.stockStatus)
          ? record.stockStatus
          : undefined) as "In Stock" | "Limited" | "Reserved" | "Out of Stock" | undefined,
        isPublished: parseBooleanCell(record.isPublished || "", false),
        isEnabled: parseBooleanCell(record.isEnabled || "", true),
        isFeatured: parseBooleanCell(record.isFeatured || "", false),
        badge: (["new", "best_seller", "sale"].includes(record.badge) ? record.badge : null) as "new" | "best_seller" | "sale" | null,
        batchNumber: record.batchNumber || undefined,
        coaUrl: record.coaUrl || undefined,
      };

      const existingId = idBySlug.get(slug);
      if (existingId) {
        await updateAdminProduct(existingId, input);
        result.updated += 1;
      } else {
        const created = await createAdminProduct(input);
        if (created?.id) {
          idBySlug.set(slug, created.id);
        }
        result.created += 1;
      }
    } catch (error) {
      result.errors.push({
        row: rowIndex + 2,
        slug,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return result;
}
