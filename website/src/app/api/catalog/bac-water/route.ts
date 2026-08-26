import { NextResponse } from "next/server";
import { getCatalogProductBySlug } from "@/lib/catalog";
import { resolveBacWaterProduct } from "@/lib/bac-water";
import { customerSafeMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

// The BAC Water cross-sell surfaces (cart checkboxes, add-to-cart nudge) are
// client-rendered and only need this one product, so they get a dedicated
// lightweight lookup instead of pulling the whole catalog.
export async function GET() {
  try {
    // Whichever accepted slug the store publishes. Asking for a single
    // hard-coded slug 404'd this endpoint on every page load for a catalogue
    // that used the other one — see resolveBacWaterProduct.
    const product = await resolveBacWaterProduct(getCatalogProductBySlug);
    if (!product) {
      return NextResponse.json({ success: false, error: "Not available" }, { status: 404 });
    }
    return NextResponse.json({ success: true, product });
  } catch (error) {
    const message = customerSafeMessage(error, "Unable to load product");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
