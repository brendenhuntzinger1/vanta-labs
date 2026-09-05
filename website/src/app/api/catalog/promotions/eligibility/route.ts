import { NextResponse } from "next/server";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBxgyPromotions, getExhaustedPromotionIds } from "@/lib/bxgy-promotions";
import { liveBxgyPromotions } from "@/lib/bxgy-engine";

export const dynamic = "force-dynamic";

/**
 * AUTH-4. This endpoint takes an arbitrary email and answers whether that
 * address has bought under a per-customer-limited promotion — which is to say
 * whether it belongs to a customer of a research-peptide store. 30 probes a
 * minute per IP made it a usable existence oracle. A real cart asks this a
 * handful of times per session (once each time the shopper's email becomes
 * known), so ten per ten minutes per IP costs a shopper nothing and cuts the
 * probe rate by 30×. The response shape is unchanged: a throttled cart keeps
 * its store-wide list, exactly as it does on any other non-OK answer.
 */
export const ELIGIBILITY_RATE_LIMIT = { limit: 10, windowSeconds: 10 * 60 } as const;

/**
 * POST /api/catalog/promotions/eligibility
 *
 * WHY THIS EXISTS. A per-customer usage limit ("one per customer") is the one
 * promotion rule the cart cannot evaluate on its own: it needs an email and a
 * purchase history, and /api/catalog/promotions is read by anonymous visitors.
 *
 * Without it the failure is not "the shopper loses a discount they weren't
 * entitled to" — it is a BLOCKED CHECKOUT. The cart would preview a promotion
 * the server is about to drop, send a total below the server's own, and
 * payment-service would refuse the order with "Altered total detected". This
 * endpoint lets the cart learn the same answer the checkout will reach, at the
 * moment the shopper's email becomes known, so the two never disagree.
 *
 * WHAT IT DISCLOSES. Only the ids of promotions this email has already used up.
 * It never returns counts, order history, or anything about a promotion with no
 * per-customer limit — and it is rate limited per IP, because it does take an
 * arbitrary email. It is read-only and changes nothing.
 */
export async function POST(request: Request) {
  const ip = getRequestIpAddress(request);
  const limit = await checkRateLimit(
    `promo-eligibility:${ip ?? "unknown"}`,
    ELIGIBILITY_RATE_LIMIT.limit,
    ELIGIBILITY_RATE_LIMIT.windowSeconds,
  );
  if (!limit.allowed) {
    return NextResponse.json({ success: false, error: "Too many requests." }, { status: 429 });
  }

  let email = "";
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    email = "";
  }

  // No email, nothing to personalise. Answering "none exhausted" is correct
  // rather than an error: an anonymous cart is priced by the store-wide list.
  if (!email || !email.includes("@")) {
    return NextResponse.json({ success: true, exhaustedPromotionIds: [] });
  }

  try {
    const configured = await getBxgyPromotions();
    // Only promotions that actually carry a per-customer limit are worth a
    // query, and only live ones can be applied at all.
    const candidates = liveBxgyPromotions(configured).filter((promotion) => promotion.perCustomerLimit !== null);
    if (candidates.length === 0) {
      return NextResponse.json({ success: true, exhaustedPromotionIds: [] });
    }
    const exhausted = await getExhaustedPromotionIds(candidates, { customerEmail: email });
    return NextResponse.json({ success: true, exhaustedPromotionIds: exhausted });
  } catch (error) {
    console.error("Unable to resolve promotion eligibility", error);
    // Fail open, matching getExhaustedPromotionIds: a lookup that could not run
    // must not strip a promotion the checkout will still honour, because the
    // preview would then sit below the server's total and block the sale.
    return NextResponse.json({ success: true, exhaustedPromotionIds: [] });
  }
}
