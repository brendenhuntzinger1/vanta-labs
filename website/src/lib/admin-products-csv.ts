import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { createAdminProduct, updateAdminProduct, listAdminProducts, type ProductUpdateInput } from "@/lib/admin-products";
import { csvSafeCell } from "@/lib/csv-safe";

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
    ...rows.map((row) => CSV_COLUMNS.map((key) => csvSafeCell(row[key as keyof typeof row])).join(",")),
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

const STOCK_STATUSES = ["In Stock", "Limited", "Reserved", "Out of Stock"] as const;
const BADGES = ["new", "best_seller", "sale"] as const;

function parseStockStatus(value: string) {
  return (STOCK_STATUSES as readonly string[]).includes(value)
    ? (value as (typeof STOCK_STATUSES)[number])
    : undefined;
}

function parseBadge(value: string) {
  return (BADGES as readonly string[]).includes(value) ? (value as (typeof BADGES)[number]) : null;
}

/**
 * A BLANK CELL MEANS "LEAVE IT ALONE" for a product that already exists.
 *
 * The import used to build one full input for every row and hand it to
 * updateAdminProduct, which writes every defined field. A blank price became
 * priceCents 0, a missing isPublished column became false, a blank stock cell
 * became 0 — so a spreadsheet that dropped a few columns, or a price-only
 * sheet, unpublished and zeroed every product it listed and reported "N
 * updated" with no errors. Only a column that is present in the header AND
 * has a non-blank cell is applied; a money cell also has to contain a digit,
 * so "TBD" cannot reset a price to $0. Creating a product still needs a value
 * for every field, so the create path keeps its defaults.
 */
function buildUpdatePatch(record: Record<string, string>, header: string[], slug: string, name: string): ProductUpdateInput {
  const present = (key: string) => header.includes(key) && (record[key] ?? "").trim() !== "";
  const money = (key: string) => present(key) && /\d/.test(record[key]);
  const patch: ProductUpdateInput = { slug, name };

  if (present("category")) patch.category = record.category.trim();
  if (present("shortDescription")) patch.shortDescription = record.shortDescription;
  if (money("price")) patch.priceCents = parseDollarsToCents(record.price);
  if (money("compareAtPrice")) patch.compareAtPriceCents = parseDollarsToCents(record.compareAtPrice);
  if (money("salePrice")) patch.salePriceCents = parseDollarsToCents(record.salePrice);
  if (present("inventoryQuantity")) {
    const quantity = Number(record.inventoryQuantity);
    if (Number.isFinite(quantity)) patch.inventoryQuantity = quantity;
  }
  if (present("stockStatus")) patch.stockStatus = parseStockStatus(record.stockStatus);
  if (present("isPublished")) patch.isPublished = parseBooleanCell(record.isPublished, false);
  if (present("isEnabled")) patch.isEnabled = parseBooleanCell(record.isEnabled, true);
  if (present("isFeatured")) patch.isFeatured = parseBooleanCell(record.isFeatured, false);
  if (present("badge")) patch.badge = parseBadge(record.badge);
  if (present("batchNumber")) patch.batchNumber = record.batchNumber;
  if (present("coaUrl")) patch.coaUrl = record.coaUrl;

  return patch;
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
      const existingId = idBySlug.get(slug);
      if (existingId) {
        // Only the cells this row actually filled in — see buildUpdatePatch.
        await updateAdminProduct(existingId, buildUpdatePatch(record, header, slug, name));
        result.updated += 1;
      } else {
        // A NEW product: every field needs a value, so blanks take defaults.
        const created = await createAdminProduct({
          slug,
          name,
          category: record.category?.trim() || "Research Peptides",
          shortDescription: record.shortDescription || undefined,
          priceCents: parseDollarsToCents(record.price || "0"),
          compareAtPriceCents: record.compareAtPrice ? parseDollarsToCents(record.compareAtPrice) : undefined,
          salePriceCents: record.salePrice ? parseDollarsToCents(record.salePrice) : undefined,
          inventoryQuantity: Number(record.inventoryQuantity) || 0,
          stockStatus: parseStockStatus(record.stockStatus ?? ""),
          isPublished: parseBooleanCell(record.isPublished || "", false),
          isEnabled: parseBooleanCell(record.isEnabled || "", true),
          isFeatured: parseBooleanCell(record.isFeatured || "", false),
          badge: parseBadge(record.badge ?? ""),
          batchNumber: record.batchNumber || undefined,
          coaUrl: record.coaUrl || undefined,
        });
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
