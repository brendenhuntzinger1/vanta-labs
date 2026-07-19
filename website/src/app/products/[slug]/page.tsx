import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductDetailClient } from "@/components/product-detail-client";
import { getCatalogProductBySlug, getCatalogProductsByCategory } from "@/lib/catalog";

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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <ProductDetailClient product={product} relatedProducts={relatedProducts} />
    </div>
  );
}
