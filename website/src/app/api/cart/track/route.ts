import { NextResponse } from "next/server";
import { trackCart } from "@/lib/cart-recovery";

// Public, unauthenticated - fires for guest carts too (that's the whole
// point of abandoned-cart recovery). Fire-and-forget from the client;
// failures here must never surface to the shopper or block checkout.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    sessionId?: string;
    customerUserId?: string;
    email?: string;
    customerName?: string;
    items?: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>;
    cartValueCents?: number;
  } | null;

  if (!body?.sessionId || !body.email || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ success: false }, { status: 400 });
  }

  try {
    await trackCart({
      sessionId: body.sessionId,
      customerUserId: body.customerUserId ?? null,
      email: body.email,
      customerName: body.customerName ?? null,
      items: body.items,
      cartValueCents: body.cartValueCents ?? 0,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
