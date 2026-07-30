import { NextResponse } from "next/server";
import { getCatalogProductBySlug } from "@/lib/catalog";
import { BAC_WATER_SLUG } from "@/lib/bac-water";

export const dynamic = "force-dynamic";

// The BAC Water cross-sell surfaces (cart checkboxes, add-to-cart nudge) are
// client-rendered and only need this one product, so they get a dedicated
// lightweight lookup instead of pulling the whole catalog.
export async function GET() {
  try {
    const product = await getCatalogProductBySlug(BAC_WATER_SLUG);
    if (!product) {
      return NextResponse.json({ success: false, error: "Not available" }, { status: 404 });
    }
    return NextResponse.json({ success: true, product });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
