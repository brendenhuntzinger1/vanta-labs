import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductDetailClient } from "@/components/product-detail-client";
import { TikTokViewContent } from "@/components/tiktok-view-content";
import { getCatalogProductBySlug, getCatalogProductsByCategory } from "@/lib/catalog";
import { getHomepageControlConfig } from "@/lib/admin-control";
import { getPublishedCoaDocumentsForProduct } from "@/lib/coa";
import { BAC_WATER_SLUG, isBacWater } from "@/lib/bac-water";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getCatalogProductBySlug(slug);
  if (!product) return {};
  const title = product.seoTitle ?? `${product.name} | Vanta Labs`;
  const description = product.seoDescription ?? product.shortDescription ?? product.description;
  const image = product.image || product.coverImage;
  const canonical = `/products/${slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: "website",
      url: canonical,
      images: image ? [{ url: image, alt: product.name }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") || "https://vantalabsresearch.com");

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = await getCatalogProductBySlug(slug);

  if (!product) {
    notFound();
  }

  const relatedProducts = await getCatalogProductsByCategory(product.category, product.slug, 4).catch(() => []);
  // Batch COAs published in Admin → COA Library. The product's own `coa_url`
  // still drives the buy-panel link; this adds the per-batch history underneath
  // it so a shopper checking a specific lot doesn't have to leave the page.
  const coaDocuments = await getPublishedCoaDocumentsForProduct(product.id ?? "");
  const { promoBuy3Get1Enabled, bundleConfig } = await getHomepageControlConfig();
  // BAC Water cross-sell (accessory block + Frequently Bought Together).
  // Null on the BAC Water page itself, or until the product exists in the DB.
  const bacWater = isBacWater(product.slug)
    ? null
    : await getCatalogProductBySlug(BAC_WATER_SLUG).catch(() => null);

  // Product structured data for rich results (price / availability). Server-
  // controlled data only; escaped so it can never break out of the script tag.
  const priceNumber = Number((product.price ?? "").replace(/[^0-9.]/g, "")) || undefined;
  const productLd = {
    "@context": "https://schema.org/",
    "@type": "Product",
    name: product.name,
    image: product.image ? [product.image] : undefined,
    description: product.shortDescription ?? product.description ?? undefined,
    category: product.category,
    brand: { "@type": "Brand", name: "Vanta Labs" },
    offers: priceNumber
      ? {
          "@type": "Offer",
          priceCurrency: "USD",
          price: priceNumber,
          // Only assert InStock for an explicit In Stock status — map anything
          // else (Out of Stock, Backorder, Low, unknown) to a non-InStock value
          // so JSON-LD never over-claims availability to search engines.
          availability:
            product.stockStatus === "In Stock"
              ? "https://schema.org/InStock"
              : product.stockStatus === "Out of Stock"
                ? "https://schema.org/OutOfStock"
                : "https://schema.org/LimitedAvailability",
          url: `${SITE_URL}/products/${product.slug}`,
        }
      : undefined,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productLd).replace(/</g, "\\u003c") }}
      />
      {/* Measurement only. Rendered alongside the product UI rather than inside
          it, so the shopping component stays untouched. `priceNumber` is the
          same server-resolved figure the structured data uses. */}
      <TikTokViewContent slug={product.slug} name={product.name} price={priceNumber} />
      <ProductDetailClient
        product={product}
        relatedProducts={relatedProducts}
        promoBuy3Get1Enabled={Boolean(promoBuy3Get1Enabled)}
        bundleConfig={bundleConfig}
        bacWater={bacWater}
        coaDocuments={coaDocuments}
      />
    </>
  );
}
