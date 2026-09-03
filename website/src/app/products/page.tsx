import type { Metadata } from "next";
import { ProductsPageClient } from "./products-client";
import { getStorefrontCatalog } from "@/lib/storefront-catalog";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/products",
  title: "Research Peptides Catalog",
  description:
    "Browse Vanta Labs' catalog of premium, third-party tested research compounds with batch-matched COAs and transparent purity records.",
});

// Stock and price have to be current, and the catalogue read is wrapped in
// unstable_cache anyway, so the work here is a cache read rather than a
// database round trip on most requests.
export const dynamic = "force-dynamic";

/**
 * THE CATALOGUE IS FETCHED HERE NOW, AND IT USED TO BE FETCHED IN THE BROWSER.
 *
 * This page shipped its products as an empty grid: `ProductsPageContent` calls
 * `useSearchParams()`, which opts it out of server rendering, so what Next put
 * in the HTML was the Suspense fallback — a grey skeleton — and the real cards
 * only existed after a `/api/catalog/products` round trip in the browser.
 *
 * That is invisible to a customer and expensive with a search engine. Measured
 * against production on 2026-09-03, the HTML for this page contained ZERO links
 * to product pages, against six on the home page. This is the catalogue: it is
 * the one page whose job is to point at all thirty-seven products, and on a
 * crawler's first pass it pointed at none of them. They were reachable only via
 * sitemap.xml — listed, but with nothing linking to them.
 *
 * So the list is resolved on the server and handed down. The client component
 * is unchanged in behaviour: it still owns search, filters, sorting and the
 * cart. It simply starts with the answer instead of asking for it.
 */
export default async function Page() {
  // A catalogue read failure must not take the page down. The client keeps its
  // own retry path for exactly this case, and an empty list is what triggers
  // it — see `initialProducts` in products-client.tsx.
  const initialProducts = await getStorefrontCatalog().catch(() => []);
  return <ProductsPageClient initialProducts={initialProducts} />;
}
