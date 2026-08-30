import { NextResponse } from "next/server";
import { getCatalogProducts } from "@/lib/catalog";
import { getBestSellerSlugs } from "@/lib/best-sellers";
import { recordSystemAlert } from "@/lib/monitoring";
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
    // THE CATALOGUE FAILING IS THE LOUDEST THING THIS SITE CAN DO AND IT USED
    // TO BE THE QUIETEST.
    //
    // This catch returned a customer-safe sentence and threw the cause away —
    // no console.error, no alert, nothing. Every sibling route (auth/signup,
    // account/email-change, account/change-password) logs and alerts; this one,
    // on the storefront's primary read path, did neither. So "the shop shows no
    // products" arrived with no reason attached anywhere, and the only way to
    // learn why was to re-run the query by hand against the same database.
    // That is exactly how it was diagnosed, and it should not have had to be.
    //
    // getCatalogProducts is wrapped in unstable_cache, which caches FAILURES,
    // so one bad minute keeps answering 400 long after the cause is gone — all
    // the more reason the first one has to be recorded.
    console.error("[api/catalog/products] catalogue read failed", error);
    await recordSystemAlert({
      type: "catalog_read_failed",
      severity: "critical",
      message:
        "The storefront could not load its product catalogue, so customers are seeing an empty shop. "
        + "This is cached, so it will keep failing until the cause is fixed and the cache tag is revalidated.",
      context: { reason: String(error instanceof Error ? error.message : error).slice(0, 300) },
      dedupeWindowMs: 15 * 60 * 1000,
    }).catch(() => {});

    const message = customerSafeMessage(error, "Unable to load products");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
