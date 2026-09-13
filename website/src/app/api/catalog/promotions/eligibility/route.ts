import { NextResponse } from "next/server";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBxgyPromotions, getExhaustedPromotionIds } from "@/lib/bxgy-promotions";
import { liveBxgyPromotions } from "@/lib/bxgy-engine";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { readGuestGrantCookie, verifyGuestRecoveryGrant } from "@/lib/cart-recovery-grant";
import {
  ELIGIBILITY_ANONYMOUS_LIMIT,
  ELIGIBILITY_WINDOW_SECONDS,
  eligibilityBudgets,
  normalizeEligibilityEmail,
  type EligibilityIdentity,
} from "@/lib/promotion-eligibility-policy";

export const dynamic = "force-dynamic";

/**
 * AUTH-4's budget, kept under its original name because the route test and the
 * audit both refer to it: ten per ten minutes, which is now what an UNIDENTIFIED
 * caller gets. A caller the server can name is metered on who they are instead
 * — see promotion-eligibility-policy.ts for why that is both safer and the only
 * version of this limit that a shared IP cannot break for innocent people.
 */
export const ELIGIBILITY_RATE_LIMIT = {
  limit: ELIGIBILITY_ANONYMOUS_LIMIT,
  windowSeconds: ELIGIBILITY_WINDOW_SECONDS,
} as const;

/**
 * WHO THE SERVER CAN NAME THIS CALLER AS.
 *
 * An account first, then a signed cart-recovery grant, then nobody. Both
 * lookups are already performed elsewhere on this request's path — the wall
 * consults them to let the request through at all — so neither is new work in
 * the shape that matters, and both fail closed to "anonymous", which is the
 * tightest budget rather than the loosest.
 */
async function identifyCaller(request: Request): Promise<EligibilityIdentity> {
  try {
    const user = await getAuthenticatedUser();
    if (user?.id) {
      return { kind: "user", userId: user.id, email: user.email ?? null };
    }
  } catch {
    // An auth backend blip must not hand out a looser budget than the caller
    // has earned, so it falls through to the tighter branches.
  }
  try {
    const grant = await verifyGuestRecoveryGrant(readGuestGrantCookie(request));
    if (grant?.cartId) {
      return { kind: "grant", cartId: grant.cartId };
    }
  } catch {
    // Same rule.
  }
  return { kind: "anonymous" };
}

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
/**
 * An address cannot be longer than this, and a body carrying more than one is
 * not a cart.
 *
 * READ BEFORE THE BODY IS PARSED, because the budget below depends on WHICH
 * address is being asked about, so parsing now happens before throttling. That
 * reordering would otherwise hand an attacker a megabyte of JSON.parse for
 * free; a content-length check costs nothing and keeps the property the old
 * ordering had.
 */
const MAX_ELIGIBILITY_BODY_BYTES = 1024;

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ELIGIBILITY_BODY_BYTES) {
    return NextResponse.json({ success: false, error: "Too many requests." }, { status: 429 });
  }

  const ip = getRequestIpAddress(request);

  let email = "";
  try {
    const raw = await request.text();
    if (raw.length > MAX_ELIGIBILITY_BODY_BYTES) {
      return NextResponse.json({ success: false, error: "Too many requests." }, { status: 429 });
    }
    const body = JSON.parse(raw || "{}") as { email?: unknown };
    email = normalizeEligibilityEmail(body.email);
  } catch {
    email = "";
  }

  // WHO IS ASKING DECIDES WHAT THIS COSTS THEM.
  //
  // A customer asking about their own address is told something they already
  // know, so it is metered against their account and nothing else — which is
  // what stops a stranger on the same carrier NAT spending their budget, and
  // what stops the tenth page of an ordinary browse being refused. Asking about
  // an address that is not theirs is the oracle AUTH-4 found, and keeps a tight
  // per-account budget under a per-host ceiling.
  const identity = await identifyCaller(request);
  for (const budget of eligibilityBudgets(identity, email, ip)) {
    const limit = await checkRateLimit(budget.bucket, budget.limit, budget.windowSeconds);
    if (!limit.allowed) {
      return NextResponse.json({ success: false, error: "Too many requests." }, { status: 429 });
    }
  }

  // No email, nothing to personalise. Answering "none exhausted" is correct
  // rather than an error: an anonymous cart is priced by the store-wide list.
  if (!email) {
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
