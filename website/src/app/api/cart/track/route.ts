import { NextResponse } from "next/server";
import { clearAbandonedCart, trackCart } from "@/lib/cart-recovery";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { looksLikeEmail } from "@/lib/email-shape";
import { isNonMailableAddress } from "@/lib/email/non-mailable";

// Abandoned-cart tracking.
//
// SIGNED-IN SHOPPERS: the email always comes from the SESSION, never the body.
//
// GUESTS: tracked too, since 2026-09-04, from the address they typed into the
// checkout email field. This is the "abandoned checkout" flow every store runs
// and the majority of this store's carts — nothing recovered them before,
// because the route refused any email it had not authenticated.
//
// The reason it refused was real: an unauthenticated endpoint that mails
// whatever address it is handed is an email-bombing vector. What bounds that
// now, so the flow can exist at all:
//   * the address must look like one and must not be a provider sink;
//   * per-IP and per-address rate limits on this route;
//   * ONE recovery sequence per address per seven days (cart-recovery.ts), so
//     the worst an abuser can do to a stranger is three branded emails about a
//     cart, spread over three days, once a week — and the stranger's unsubscribe
//     ends even that.
//
// AN EMPTY ITEM LIST IS MEANINGFUL. It says the shopper emptied their cart, and
// the active row is retired so no further stage is sent. Either party may send
// it; a session id is unguessable, so nothing else can clear someone's cart.
//
// Fire-and-forget from the client; failures never surface to the shopper.

const GUEST_MAX_PER_IP = 40;
const GUEST_MAX_PER_EMAIL = 12;
const WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    sessionId?: string;
    email?: string;
    customerName?: string;
    items?: Array<{ slug: string; variantId?: string; name: string; quantity: number; unitPrice: number; image?: string }>;
    cartValueCents?: number;
  } | null;

  if (!body?.sessionId || typeof body.sessionId !== "string" || !Array.isArray(body.items)) {
    return NextResponse.json({ success: false }, { status: 400 });
  }
  const sessionId = body.sessionId.slice(0, 200);

  // The exit path needs no identity: the session id is the proof.
  if (body.items.length === 0) {
    try {
      await clearAbandonedCart(sessionId);
      return NextResponse.json({ success: true, tracked: false, cleared: true });
    } catch {
      return NextResponse.json({ success: false }, { status: 500 });
    }
  }

  const user = await getAuthenticatedUser();
  let email: string;
  let customerUserId: string | null;

  if (user?.email) {
    email = user.email.trim().toLowerCase();
    customerUserId = user.id;
  } else {
    const typed = String(body.email ?? "").trim().toLowerCase();
    if (!looksLikeEmail(typed) || isNonMailableAddress(typed)) {
      // Not signed in and no usable address: nothing is stored. Not an error
      // for the client — it is a background beacon.
      return NextResponse.json({ success: true, tracked: false });
    }
    const ipLimit = await checkRateLimit(rateLimitKeyForRequest("cart-track-ip", request), GUEST_MAX_PER_IP, WINDOW_SECONDS);
    if (!ipLimit.allowed) return NextResponse.json({ success: true, tracked: false });
    const emailLimit = await checkRateLimit(`cart-track-email:${typed}`, GUEST_MAX_PER_EMAIL, WINDOW_SECONDS);
    if (!emailLimit.allowed) return NextResponse.json({ success: true, tracked: false });
    email = typed;
    customerUserId = null;
  }

  try {
    await trackCart({
      sessionId,
      customerUserId,
      email,
      customerName: body.customerName ? String(body.customerName).slice(0, 120) : null,
      items: body.items.slice(0, 50),
      cartValueCents: Number(body.cartValueCents ?? 0) || 0,
    });
    return NextResponse.json({ success: true, tracked: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
