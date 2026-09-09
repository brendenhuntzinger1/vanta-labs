import { NextRequest, NextResponse } from "next/server";
import { getAbandonedCartById, liveRecoveryCouponForCart, markCartRestored } from "@/lib/cart-recovery";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { BAC_WATER_SLUG_CANDIDATES } from "@/lib/bac-water";
import {
  GUEST_GRANT_COOKIE,
  GUEST_GRANT_MAX_AGE_SECONDS,
  GUEST_GRANT_PARAM,
  readGuestGrantCookie,
  verifyGuestRecoveryGrant,
} from "@/lib/cart-recovery-grant";
import {
  describeReconciliation,
  reconcileRestoredCart,
  type ReconcileCatalogueEntry,
} from "@/lib/cart-restore-reconcile";

export const dynamic = "force-dynamic";

/**
 * THE SLUGS A RETIRED ONE MAY HAVE BECOME.
 *
 * Recon Water is the only product that has ever been renamed here, and its
 * rename is what made this necessary: production moved to `bac-water`,
 * `bacteriostatic-water` stopped being a products row, and carts holding the
 * old slug became unbuyable. Every candidate but the stored one is offered, in
 * the canonical order bac-water.ts declares, so a cart follows the rename
 * instead of losing the line.
 *
 * Anything that is not part of that family gets an empty list and is dropped
 * on the honest grounds that we cannot identify it.
 */
function slugAliases(slug: string): readonly string[] {
  const family = BAC_WATER_SLUG_CANDIDATES as readonly string[];
  return family.includes(slug) ? family.filter((candidate) => candidate !== slug) : [];
}

function toNumber(price: string | undefined): number {
  if (!price) return 0;
  return Number(String(price).replace(/[^0-9.]/g, "")) || 0;
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ success: false, error: "Missing cart id" }, { status: 400 });
  }

  // THE GRANT MUST NAME THIS CART. The middleware decided only that the caller
  // holds SOME valid grant for a path on the allowlist; binding it to the cart
  // being asked for is this route's job, and it is the whole of "no ability to
  // access another customer's cart".
  //
  // The parameter is accepted as well as the cookie because a cookie set on a
  // redirect does not always reach the browser — see the click route. Whichever
  // arrives, it is verified the same way, and a grant that names a different
  // cart is refused as though it were absent.
  const presentedGrant = request.nextUrl.searchParams.get(GUEST_GRANT_PARAM) ?? readGuestGrantCookie(request);
  const grant = await verifyGuestRecoveryGrant(presentedGrant);
  if (grant && grant.cartId !== id) {
    // Deliberately the same answer as an unknown cart. Telling the holder of a
    // valid grant that some OTHER id exists would turn this into an oracle for
    // enumerating carts.
    return NextResponse.json({ success: false, error: "This cart link is no longer valid" }, { status: 404 });
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

  // THE SNAPSHOT IS RECONCILED AGAINST THE CATALOGUE BEFORE IT IS HANDED BACK.
  //
  // It used to be returned verbatim, and /api/cart/validate leaves a line it
  // cannot find alone by design, so a stored slug with no products row survived
  // all the way to quoteOrder — which throws on it and fails the WHOLE quote.
  // The one email whose purpose is to bring a shopper back was delivering them
  // to a checkout that refused them. See cart-restore-reconcile.ts.
  //
  // A catalogue read that FAILS falls back to the old behaviour rather than
  // refusing the restore: a cart that might not check out beats no cart at all,
  // and the shopper can still remove the line by hand.
  let items = cart.items;
  let notice: string | null = null;
  try {
    const wanted = new Set<string>();
    for (const line of cart.items) {
      const slug = String(line?.slug ?? "").trim();
      if (!slug) continue;
      wanted.add(slug);
      for (const alias of slugAliases(slug)) wanted.add(alias);
    }
    const catalogue = new Map<string, ReconcileCatalogueEntry>();
    for (const product of await getCatalogProductsBySlugs([...wanted])) {
      catalogue.set(String(product.slug), {
        slug: String(product.slug),
        name: String(product.name),
        unitPrice: toNumber(product.salePrice ?? product.price),
        image: product.image ?? undefined,
        doses: (product.doses ?? []).filter((dose) => dose.isEnabled !== false).map((dose) => ({
          id: String(dose.id),
          label: String(dose.label ?? ""),
          unitPrice: toNumber(dose.salePrice ?? dose.price),
          image: dose.imageUrl ?? undefined,
        })),
      });
    }
    const reconciled = reconcileRestoredCart(cart.items, catalogue, slugAliases);
    items = reconciled.items;
    notice = describeReconciliation(reconciled);
    if (reconciled.dropped.length > 0 || reconciled.repaired.length > 0) {
      console.log("[cart/restore] reconciled a stored cart", id, {
        dropped: reconciled.dropped.map((line) => line.reason),
        repaired: reconciled.repaired,
      });
    }
  } catch (error) {
    console.error("[cart/restore] catalogue unavailable; restoring the stored snapshot as-is", error);
  }

  // Every line died. Sending the shopper to an empty cart under a "your cart is
  // saved" email would read as the store having lost it, so say what happened.
  if (items.length === 0) {
    return NextResponse.json(
      { success: false, error: notice ?? "The items in this cart are no longer available." },
      { status: 410 },
    );
  }

  // Stamped only once a buyable cart is actually going back, so the funnel's
  // restore count means "the link worked" rather than "the link was clicked" —
  // which is the click count, and which it was previously indistinguishable
  // from. It is the middle of the funnel that did not exist.
  await markCartRestored(cart.id);

  // The code the cart's own emails promised, armed for the shopper so it is
  // not retyped from the email. Looked up by the cart id only — a code in the
  // URL is never read — and only while the cart is still open; a recovered or
  // cleared cart restores its items and nothing else. Best-effort: a coupon
  // read that fails still restores the cart. The address handed back is the
  // one the CODE is bound to, and only when there is a code to bind it to.
  const coupon = cart.status === "active" ? await liveRecoveryCouponForCart(cart.id).catch(() => null) : null;
  const body = NextResponse.json({
    success: true,
    items,
    ...(notice ? { notice } : {}),
    // The browser session that built the cart: a restore on another device
    // continues this cart instead of opening a second one for the tracker.
    sessionId: cart.sessionId,
    ...(coupon
      ? { coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue }, email: coupon.email }
      : {}),
  });

  // EXCHANGE THE PARAMETER FOR THE COOKIE. From here on the guest carries the
  // grant in a header no script can read, and /cart and /checkout are admitted
  // by it without the token ever appearing in another URL.
  if (grant && grant.cartId === id) {
    body.cookies.set({
      name: GUEST_GRANT_COOKIE,
      value: presentedGrant as string,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: GUEST_GRANT_MAX_AGE_SECONDS,
    });
  }
  return body;
}
