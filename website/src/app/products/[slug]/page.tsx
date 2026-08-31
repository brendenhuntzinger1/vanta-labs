import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductDetailClient } from "@/components/product-detail-client";
import { TikTokViewContent } from "@/components/tiktok-view-content";
import { getCatalogProductBySlug, getCatalogProductsByCategory } from "@/lib/catalog";
import { getHomepageControlConfig } from "@/lib/admin-control";
import { getApplicableBxgyPromotions } from "@/lib/bxgy-promotions";
import { isSlugEligible, storefrontDescription } from "@/lib/bxgy-engine";
import { getPublishedCoaDocumentsForProduct } from "@/lib/coa";
import { getStorefrontCoupon } from "@/lib/coupons";
import { isBacWater, resolveBacWaterProduct } from "@/lib/bac-water";
import { BRAND_SHORT_NAME, organizationId, siteUrl } from "@/lib/site-identity";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getCatalogProductBySlug(slug);
  if (!product) return {};

  // The ROOT layout already carries `template: "%s | Vanta Labs"`, so the title
  // returned here must NOT carry the brand itself — appending it produced
  // "GLP-1 | Vanta Labs | Vanta Labs" on every product page, which is the one
  // page type that actually has to rank.
  //
  // Open Graph and Twitter cards do NOT go through that template, so they get
  // the brand added explicitly — unless an admin-entered SEO title already
  // includes it, which is why this checks rather than blindly concatenating.
  const title = product.seoTitle ?? product.name;
  const socialTitle = /vanta labs/i.test(title) ? title : `${title} | Vanta Labs`;
  const description = product.seoDescription ?? product.shortDescription ?? product.description;
  const image = product.image || product.coverImage;
  const canonical = `/products/${slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title: socialTitle,
      description,
      type: "website",
      url: canonical,
      images: image ? [{ url: image, alt: product.name }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: image ? [image] : undefined,
    },
  };
}

// Via site-identity so the Product schema's url cannot disagree with the
// canonical on the same page. The local copy fell back to the APEX, which
// 308-redirects to www — a Product url pointing at a redirect if the env var
// were ever unset. It is set in production, so this never fired.
const SITE_URL = siteUrl();

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
  const controlConfig = await getHomepageControlConfig();
  const { bundleConfig } = controlConfig;
  // Every Buy X Get Y promotion this product actually qualifies for — live,
  // scheduled, not used up, and not excluded from this slug. Resolved on the
  // server so the panel is in the first paint, and described by the engine so
  // the product page cannot promise something the cart prices differently.
  const productPromotions = await getApplicableBxgyPromotions({}, { promotions: controlConfig.bxgyPromotions })
    .then((promotions) => promotions
      .filter((promotion) => isSlugEligible(promotion, product.slug))
      .map((promotion) => ({
        id: promotion.id,
        name: promotion.name,
        description: storefrontDescription(promotion),
      })))
    .catch(() => []);
  // Resolved server-side so the promo banner is in the first paint. Fetched in
  // the browser it arrived late and pushed the whole product panel down the
  // page. A failure resolves to null — no banner, never a broken product page.
  // BAC Water cross-sell (accessory block + Frequently Bought Together).
  // Null on the BAC Water page itself, or until the product exists in the DB.
  // Resolved across every accepted slug: a single hard-coded slug silently
  // dropped the accessory block on a catalogue publishing the other one.
  const bacWater = isBacWater(product.slug)
    ? null
    : await resolveBacWaterProduct(getCatalogProductBySlug).catch(() => null);

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
    // BRAND POINTS AT THE ONE ORGANIZATION NODE, RATHER THAN NAMING A STRING.
    //
    // Every product page previously declared a free-floating Brand called
    // "Vanta Labs" — the short name, hard-coded here, agreeing with nothing.
    // To a crawler that is a brand of that name, not necessarily THIS site's
    // company, which is a costly ambiguity when two other peptide vendors
    // publish under near-identical names (see site-identity.ts).
    //
    // Referencing the Organization's @id makes all ~40 product pages
    // corroborate the same entity the homepage declares, instead of each one
    // introducing a nameless lookalike. The name is kept alongside the
    // reference so the node is still self-describing if the graph is read in
    // isolation, and it now comes from the shared constant so it cannot drift.
    brand: { "@type": "Brand", "@id": organizationId(), name: BRAND_SHORT_NAME },
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
      <TikTokViewContent slug={product.slug} name={product.name} price={priceNumber} category={product.category} />
      <ProductDetailClient
        product={product}
        relatedProducts={relatedProducts}
        productPromotions={productPromotions}
        bundleConfig={bundleConfig}
        bacWater={bacWater}
        coaDocuments={coaDocuments}
      />
    </>
  );
}
