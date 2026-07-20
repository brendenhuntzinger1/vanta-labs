import { NextResponse } from "next/server";
import { requestBackInStock } from "@/lib/back-in-stock";

export const dynamic = "force-dynamic";

// Public: a customer asks to be notified when a sold-out product is restocked.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { productSlug?: string; variantId?: string; email?: string };
    const result = await requestBackInStock({
      productSlug: String(body.productSlug ?? ""),
      variantId: body.variantId ?? null,
      email: String(body.email ?? ""),
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "Unable to save your request." }, { status: 400 });
  }
}
