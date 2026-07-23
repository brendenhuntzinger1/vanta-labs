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
  return {
    title: product.seoTitle ?? `${product.name} | Vanta Labs`,
    description: product.seoDescription ?? product.shortDescription ?? product.description,
  };
}

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

  return (
    <ProductDetailClient
      product={product}
      relatedProducts={relatedProducts}
      promoBuy3Get1Enabled={Boolean(promoBuy3Get1Enabled)}
      bundleConfig={bundleConfig}
    />
  );
}
