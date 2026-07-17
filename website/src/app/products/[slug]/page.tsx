import { notFound } from "next/navigation";
import { ProductDetailClient } from "@/components/product-detail-client";
import { products } from "@/lib/demo-data";

export function generateStaticParams() {
  return products.map((product) => ({ slug: product.slug }));
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = products.find((item) => item.slug === slug);

  if (!product) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <ProductDetailClient product={product} />
    </div>
  );
}
