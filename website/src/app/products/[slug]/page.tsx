import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductDetailClient } from "@/components/product-detail-client";
import { getCatalogProductBySlug, getCatalogProductsByCategory } from "@/lib/catalog";
import { getHomepageControlConfig } from "@/lib/admin-control";

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
  const { promoBuy3Get1Enabled, bundleConfig } = await getHomepageControlConfig();

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
          availability:
            product.stockStatus === "Out of Stock"
              ? "https://schema.org/OutOfStock"
              : "https://schema.org/InStock",
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
      <ProductDetailClient
        product={product}
        relatedProducts={relatedProducts}
        promoBuy3Get1Enabled={Boolean(promoBuy3Get1Enabled)}
        bundleConfig={bundleConfig}
      />
    </>
  );
}
