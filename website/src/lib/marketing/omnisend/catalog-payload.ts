import type { Product, ProductDose } from "@/lib/catalog-types";
import { isPlaceholderProductImage, resolveProductImage } from "@/lib/product-image";

/**
 * Pure builders for the Omnisend product catalogue (design spec §5.3).
 *
 * No `server-only`, no environment, no network: everything here is a function
 * of the Product the public catalogue already serialises for customers, so the
 * suite can pin every field name Omnisend reads without stubbing anything.
 *
 * Field names, enums and limits come from `POST /api/products` in the Omnisend
 * Public API `2026-03-15`. Two of its rules shape the fallbacks below: a
 * variant must carry id, price, title and url, and a product must carry at
 * least one variant. A product is therefore never emitted variant-less, and a
 * variant is never emitted with a price Omnisend cannot read — an unpriced
 * product goes across as a single `notAvailable` variant at 0 so Omnisend
 * stops recommending it rather than rejecting the whole batch.
 */

export type OmnisendProductStatus = "inStock" | "outOfStock" | "notAvailable";

export type OmnisendProductVariant = {
  id: string;
  title: string;
  sku?: string;
  price: number;
  strikeThroughPrice?: number;
  status: OmnisendProductStatus;
  url: string;
  defaultImageUrl?: string;
};

export type OmnisendProduct = {
  id: string;
  title: string;
  currency: "USD";
  status: OmnisendProductStatus;
  url: string;
  description?: string;
  defaultImageUrl?: string;
  images?: string[];
  vendor: "Vanta Labs";
  type?: string;
  tags?: string[];
  categoryIDs: string[];
  variants: OmnisendProductVariant[];
};

export type OmnisendProductCategory = { categoryID: string; title: string };

/** Omnisend field limits, from the product and category schemas. */
const MAX_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 255;
const MAX_TYPE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * THE SEPARATOR BETWEEN A PRODUCT AND ITS VARIANT, AND WHY IT IS NOT "#".
 *
 * Omnisend validates a variant id against `[A-Za-z0-9_-]` and answers
 * 400 `Variants[0].ID: must contain only letters, numbers, underscores and
 * dashes` for anything else. This was `#`, so EVERY product in a catalogue
 * push was refused — 34 of 34 on the first real run, 2026-09-17 — and a
 * refused catalogue means the abandoned-cart, abandoned-checkout and browse
 * abandonment flows have no product to render.
 *
 * A double underscore is legal, and it cannot be mistaken for part of either
 * side: slugs are single-dash-separated and dose ids are UUIDs.
 *
 * THREE CALLERS MUST AGREE. The catalogue's variant id, the fallback variant
 * id, and the `productVariantID` that hooks.ts puts on a cart line are the
 * same identifier seen from different places — if they drift, a cart line
 * names a variant Omnisend's catalogue does not have and the product block
 * renders empty. Hence one exported builder rather than three template
 * literals.
 */
export const OMNISEND_VARIANT_SEPARATOR = "__";

/** `<slug>__<suffix>`, trimmed to Omnisend's id ceiling. */
export function omnisendVariantId(slug: string, suffix: string): string {
  return `${slug}${OMNISEND_VARIANT_SEPARATOR}${suffix}`.slice(0, MAX_ID_LENGTH);
}

/** Lowercase, every run of non-alphanumerics to one dash, no leading or trailing dash. */
export function slugifyCategory(category: string): string {
  return String(category ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LENGTH);
}

/**
 * The catalogue stores money as the formatted string customers see
 * ("$42.99", "1,299.00"). Omnisend wants a number. Anything that does not
 * contain a readable amount is null rather than 0, so a caller can tell
 * "free" from "unknown" and never sends a phantom price.
 */
export function parseMoney(formatted: string | undefined | null): number | null {
  const digits = String(formatted ?? "").replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number.parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function trimOrigin(origin: string): string {
  return String(origin ?? "").trim().replace(/\/+$/, "");
}

function absoluteUrl(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** Stored value → something Omnisend can fetch: placeholder-resolved, then absolute. */
function productImageUrl(origin: string, stored: string | null | undefined): string {
  return absoluteUrl(origin, resolveProductImage(stored));
}

function mapStockStatus(stockStatus: Product["stockStatus"] | undefined): OmnisendProductStatus {
  return stockStatus === "Out of Stock" ? "outOfStock" : "inStock";
}

function doseStatus(dose: ProductDose, productStatus: OmnisendProductStatus): OmnisendProductStatus {
  // A product that is off the shelf takes every dose with it.
  if (productStatus === "notAvailable") return "notAvailable";
  if (!dose.stockStatus) return productStatus;
  return mapStockStatus(dose.stockStatus);
}

/** Compare-at only strikes through when it is genuinely higher than what is charged. */
function strikeThroughPrice(compareAt: string | undefined, price: number): number | undefined {
  const value = parseMoney(compareAt);
  return value !== null && value > price ? value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildOmnisendProduct(
  product: Product,
  siteOrigin: string,
  opts: { available?: boolean } = {},
): OmnisendProduct {
  const origin = trimOrigin(siteOrigin);
  const slug = String(product.slug ?? "").trim().slice(0, MAX_ID_LENGTH);
  const url = `${origin}/products/${slug}`;
  const title = String(product.name ?? "").trim().slice(0, MAX_TITLE_LENGTH);
  const status: OmnisendProductStatus = opts.available === false ? "notAvailable" : mapStockStatus(product.stockStatus);

  const cover = productImageUrl(origin, product.coverImage || product.image);
  const gallery = (product.galleryImages ?? [])
    .map((image) => image.imageUrl)
    .filter((stored) => !isPlaceholderProductImage(stored))
    .map((stored) => productImageUrl(origin, stored));
  const images = unique([cover, ...gallery]);

  const description = stripTags(String(product.shortDescription ?? "")).slice(0, MAX_DESCRIPTION_LENGTH);
  const category = String(product.category ?? "").trim();
  const categoryID = slugifyCategory(category);

  const doses = (product.doses ?? []).filter((dose) => dose.isEnabled);
  const variants: OmnisendProductVariant[] = [];
  for (const dose of doses) {
    const price = parseMoney(dose.salePrice) ?? parseMoney(dose.price);
    if (price === null) continue;
    variants.push({
      id: omnisendVariantId(slug, dose.id),
      title: String(dose.label || title).trim().slice(0, MAX_TITLE_LENGTH),
      sku: dose.sku || undefined,
      price,
      strikeThroughPrice: strikeThroughPrice(dose.compareAtPrice, price),
      status: doseStatus(dose, status),
      url,
      defaultImageUrl:
        dose.imageUrl && !isPlaceholderProductImage(dose.imageUrl) ? absoluteUrl(origin, dose.imageUrl) : cover,
    });
  }

  if (variants.length === 0) {
    variants.push(defaultVariant(product, { slug, title, url, status, cover, hadDoses: doses.length > 0 }));
  }

  return {
    id: slug,
    title,
    currency: "USD",
    status,
    url,
    description: description || undefined,
    defaultImageUrl: cover,
    images,
    vendor: "Vanta Labs",
    type: category.slice(0, MAX_TYPE_LENGTH) || undefined,
    categoryIDs: categoryID ? [categoryID] : [],
    variants,
  };
}

/**
 * The single variant a product gets when it has no doses to speak of. When it
 * HAD doses and none of them carried a readable price, the product-level
 * price is not trusted either: it goes across unpriced and off the shelf.
 */
function defaultVariant(
  product: Product,
  ctx: { slug: string; title: string; url: string; status: OmnisendProductStatus; cover: string; hadDoses: boolean },
): OmnisendProductVariant {
  const base = { id: omnisendVariantId(ctx.slug, "default"), title: ctx.title, url: ctx.url, defaultImageUrl: ctx.cover };
  const price = ctx.hadDoses ? null : (parseMoney(product.salePrice) ?? parseMoney(product.price));
  if (price === null) return { ...base, price: 0, status: "notAvailable" };
  return { ...base, price, strikeThroughPrice: strikeThroughPrice(product.compareAtPrice, price), status: ctx.status };
}

/** One category per distinct slug, titled by the first product that names it. */
export function buildOmnisendCategories(products: Product[]): OmnisendProductCategory[] {
  const seen = new Map<string, OmnisendProductCategory>();
  for (const product of products) {
    const title = String(product.category ?? "").trim();
    const categoryID = slugifyCategory(title);
    if (!categoryID || seen.has(categoryID)) continue;
    seen.set(categoryID, { categoryID, title: title.slice(0, MAX_TITLE_LENGTH) });
  }
  return [...seen.values()];
}
