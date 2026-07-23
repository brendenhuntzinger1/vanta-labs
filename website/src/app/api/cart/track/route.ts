import { NextResponse } from "next/server";
import { trackCart } from "@/lib/cart-recovery";
import { getAuthenticatedUser } from "@/lib/auth-session";

// Abandoned-cart tracking. SECURITY: this must be tied to the authenticated
// shopper — the recovery sweep emails whatever address is stored here, so an
// unauthenticated endpoint that accepted an arbitrary `email` was an email-
// bombing / spoofing vector (send mail from our own domain to any victim).
// Checkout already requires a signed-in account, so only signed-in shoppers get
// abandoned-cart recovery, and the email always comes from the SESSION, never
// the request body. Fire-and-forget; failures never surface to the shopper.
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user?.email) {
    // Not signed in → nothing tracked, no email stored. Not an error for the
    // client (it's a background beacon).
    return NextResponse.json({ success: true, tracked: false });
  }

  const body = await request.json().catch(() => null) as {
    sessionId?: string;
    customerName?: string;
    items?: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>;
    cartValueCents?: number;
  } | null;

  if (!body?.sessionId || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ success: false }, { status: 400 });
  }

  try {
    await trackCart({
      sessionId: body.sessionId,
      customerUserId: user.id,
      email: user.email.trim().toLowerCase(),
      customerName: body.customerName ?? null,
      items: body.items,
      cartValueCents: body.cartValueCents ?? 0,
    });
    return NextResponse.json({ success: true, tracked: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
