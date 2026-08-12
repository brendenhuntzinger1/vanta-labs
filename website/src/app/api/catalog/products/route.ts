import { NextResponse } from "next/server";
import { getCatalogProducts } from "@/lib/catalog";
import { getBestSellerSlugs } from "@/lib/best-sellers";
import { customerSafeMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [products, bestSellerSlugs] = await Promise.all([
      getCatalogProducts(),
      getBestSellerSlugs().catch(() => new Set<string>()),
    ]);
    // Mark best sellers automatically from real sales. A manual "best_seller"
    // badge still counts, so an admin can always feature something by hand.
    const enriched = products.map((product) => ({
      ...product,
      isBestSeller: bestSellerSlugs.has(product.slug) || product.badge === "best_seller",
    }));
    return NextResponse.json({ success: true, products: enriched });
  } catch (error) {
    const message = customerSafeMessage(error, "Unable to load products");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
