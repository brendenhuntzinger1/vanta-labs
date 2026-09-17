import "server-only";

import { getCatalogProducts } from "@/lib/catalog";
import {
  buildOmnisendCategories,
  buildOmnisendProduct,
  type OmnisendProduct,
  type OmnisendProductCategory,
} from "@/lib/marketing/omnisend/catalog-payload";
import { omnisendActive, omnisendRequest, type OmnisendResult } from "@/lib/marketing/omnisend/client";
import { siteUrl } from "@/lib/site-identity";

/**
 * Push the public catalogue to Omnisend (design spec §5.3).
 *
 * Categories go first, one `POST /product-categories` each, because a product
 * that names a category Omnisend has not seen is rejected. A category that
 * already exists is a success, not a failure: the endpoint has no upsert, so
 * every run after the first would otherwise report every category as broken.
 *
 * Products go through `POST /batches` as `PUT` in chunks of 100 (the batch
 * ceiling). PUT is a full replace, which is what makes a re-run idempotent —
 * the same product pushed twice ends up in the same state, and a dose that was
 * removed here is removed there. When Omnisend refuses a PUT batch outright
 * with a 4xx, the chunk is retried as `POST` so a first run against an empty
 * account, where nothing exists to replace, still lands.
 *
 * Never throws: this runs from cron and from an admin button, and neither
 * may fail over a marketing sync. Whatever went wrong is in the log under
 * `[omnisend/catalog]` and in `skipped`.
 */

const BATCH_SIZE = 100;
const LOG = "[omnisend/catalog]";

export type OmnisendCatalogSyncResult = {
  products: number;
  categories: number;
  batches: number;
  skipped: string | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** 409, or a 400 whose text says the category is already there, is the category existing. */
function categoryAlreadyExists(result: OmnisendResult<unknown>): boolean {
  if (result.status === 409) return true;
  return result.status === 400 && /already exists|duplicate/i.test(result.error ?? "");
}

async function ensureCategory(category: OmnisendProductCategory): Promise<boolean> {
  const result = await omnisendRequest({ method: "POST", path: "/product-categories", body: category });
  if (result.ok || categoryAlreadyExists(result)) return true;
  console.error(LOG, "category", category.categoryID, result.error);
  return false;
}

async function pushBatch(items: OmnisendProduct[], method: "PUT" | "POST"): Promise<OmnisendResult<unknown>> {
  return omnisendRequest({ method: "POST", path: "/batches", body: { method, endpoint: "products", items } });
}

async function pushChunk(items: OmnisendProduct[], index: number): Promise<boolean> {
  const put = await pushBatch(items, "PUT");
  if (put.ok) return true;
  // A 4xx on a PUT batch is Omnisend refusing to replace what it does not
  // have; anything else (5xx, timeout, gate) is not fixed by trying POST.
  if (put.status >= 400 && put.status < 500) {
    const post = await pushBatch(items, "POST");
    if (post.ok) return true;
    console.error(LOG, "batch", index, "PUT and POST both failed", put.error, post.error);
    return false;
  }
  console.error(LOG, "batch", index, put.error);
  return false;
}

export async function syncOmnisendCatalog(): Promise<OmnisendCatalogSyncResult> {
  const gate = omnisendActive();
  if (!gate.active) return { products: 0, categories: 0, batches: 0, skipped: gate.reason };

  let categories = 0;
  let products = 0;
  let batches = 0;
  try {
    const catalog = await getCatalogProducts();
    const origin = siteUrl();

    for (const category of buildOmnisendCategories(catalog)) {
      if (await ensureCategory(category)) categories += 1;
    }

    const items = catalog.map((product) => buildOmnisendProduct(product, origin));
    const chunks = chunk(items, BATCH_SIZE);
    for (const [index, batch] of chunks.entries()) {
      if (!(await pushChunk(batch, index))) continue;
      batches += 1;
      products += batch.length;
    }

    const failedBatches = chunks.length - batches;
    console.info(LOG, "synced", { products, categories, batches, failedBatches });
    return { products, categories, batches, skipped: failedBatches > 0 ? `${failedBatches} batch(es) failed` : null };
  } catch (error) {
    console.error(LOG, "sync threw", error);
    return { products, categories, batches, skipped: `sync threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
