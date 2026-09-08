import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCartRecovery } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";
import { validateRecoveryTiers } from "@/lib/cart-recovery-tiers";
import { listGiftableProducts } from "@/lib/admin-cart-recovery";

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageCartRecovery(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage cart recovery." }, { status: 403 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const ipAddress = getRequestIpAddress(request);
    const userAgent = getRequestUserAgent(request);

    // THE BANDS ARE VALIDATED HERE, NOT TRUSTED FROM THE FORM.
    //
    // This value decides what the store gives away, and the composer's copy of
    // the validator is a convenience for the person typing. Refused rather than
    // repaired: silently sorting or clamping would mean the operator's intent
    // and the store's behaviour differ with nobody told, and here that
    // difference is money.
    //
    // Checked against the LIVE catalogue, because quoteOrder resolves a gift
    // with an exact slug match and no fallback — a band naming a retired
    // product would promise a vial the till never adds, which is exactly how a
    // rename once shipped a percentage and no BAC Water for weeks.
    if (body.tiers !== undefined) {
      const products = await listGiftableProducts();
      // An empty catalogue read means "could not check", not "nothing is on
      // sale". Passing null skips the product check rather than refusing every
      // band — the sweep re-checks at mint time and quoteOrder refuses an
      // unsellable gift at the till regardless.
      const slugs = products.length > 0 ? new Set(products.map((product) => product.slug)) : null;
      const verdict = validateRecoveryTiers(body.tiers, slugs);
      if (!verdict.ok) {
        return NextResponse.json({ success: false, error: verdict.error }, { status: 400 });
      }
      body.tiers = verdict.tiers;
    }

    const entries: Array<[string, unknown]> = [
      ["t30m_enabled", body.t30mEnabled],
      ["t12h_enabled", body.t12hEnabled],
      ["t24h_enabled", body.t24hEnabled],
      ["t72h_enabled", body.t72hEnabled],
      ["discount_percent", body.discountPercent],
      ["coupon_expiration_hours", body.couponExpirationHours],
      ["tiers", body.tiers],
    ];

    for (const [key, value] of entries) {
      if (value === undefined) continue;
      await upsertControlValue({
        section: "cart_recovery",
        key,
        value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save cart recovery settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
