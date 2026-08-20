import type { Metadata } from "next";
import { ProductsPageClient } from "./products-client";
import { getStorefrontCoupon } from "@/lib/coupons";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/products",
  title: "Research Peptides Catalog",
  description:
    "Browse Vanta Labs' catalog of premium, third-party tested research compounds with batch-matched COAs and transparent purity records.",
});

// Resolve the promo banner SERVER-side. Fetching it in the browser made it drop
// into the page a few hundred milliseconds late and shove the catalogue down.
// A lookup failure resolves to null, which renders no banner — exactly what the
// client fetch did on error, so a coupon hiccup still cannot break the page.
export default async function Page() {
  const featuredCoupon = await getStorefrontCoupon().catch(() => null);
  return <ProductsPageClient featuredCoupon={featuredCoupon ?? null} />;
}
