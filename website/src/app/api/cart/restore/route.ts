import { NextRequest, NextResponse } from "next/server";
import { getAbandonedCartById } from "@/lib/cart-recovery";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ success: false, error: "Missing cart id" }, { status: 400 });
  }

  let cart;
  try {
    cart = await getAbandonedCartById(id);
  } catch (error) {
    console.error("Unable to restore abandoned cart", error);
    return NextResponse.json({ success: false, error: "This cart link is no longer valid" }, { status: 404 });
  }
  if (!cart || cart.items.length === 0) {
    return NextResponse.json({ success: false, error: "This cart link is no longer valid" }, { status: 404 });
  }

  return NextResponse.json({ success: true, items: cart.items });
}
