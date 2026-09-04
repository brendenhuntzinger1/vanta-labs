import { NextResponse } from "next/server";
import { validateCoupon } from "@/lib/coupons";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getMembershipPerks } from "@/lib/membership";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { customerSafeMessage } from "@/lib/safe-error";

export async function POST(request: Request) {
  try {
    // Throttle coupon-code guessing: a public validate endpoint with no limit
    // lets an attacker enumerate/brute-force discount codes. 20 attempts / IP
    // per minute is plenty for a real shopper.
    const ip = getRequestIpAddress(request) ?? "unknown";
    const limit = await checkRateLimit(`coupon-validate:${ip}`, 20, 60);
    if (!limit.allowed) {
      const res = NextResponse.json({ success: false, error: "Too many attempts. Please wait a moment." }, { status: 429 });
      res.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return res;
    }

    const body = await request.json() as { code?: string; subtotal?: number; email?: string };
    const code = String(body.code ?? "").slice(0, 40);
    const subtotal = Number(body.subtotal ?? 0);
    // A GUEST'S TYPED ADDRESS, for assigned-email codes only.
    //
    // Cart-recovery codes are bound to the address they were mailed to, and
    // since 2026-09-04 guests receive them. The cart previews a code through
    // this route with no session, so it compared the assignment against
    // nothing and told the guest their own code was invalid — while the
    // checkout, which validates against the typed email, would have taken it.
    // The typed address grants nothing here that checkout does not re-check
    // with the same function against the same address.
    const typedEmail = String(body.email ?? "").trim().toLowerCase().slice(0, 320);

    if (!code.trim()) {
      return NextResponse.json({ success: false, error: "Enter a coupon code." }, { status: 400 });
    }

    // Pass the signed-in shopper's email so a once-per-customer welcome offer is
    // rejected here in the cart, not just silently later at payment time, and
    // their membership status so member-only / non-member-only codes are
    // rejected with a clear message up front (server re-checks at payment).
    const user = await getAuthenticatedUser();
    let isActiveMember = false;
    if (user?.id) {
      try {
        isActiveMember = (await getMembershipPerks(user.id)).isActiveMember;
      } catch {
        // Treated as non-member for the preview; payment re-checks authoritatively.
      }
    }
    const coupon = await validateCoupon(
      code,
      Number.isFinite(subtotal) ? subtotal : 0,
      user?.email ?? (typedEmail.includes("@") ? typedEmail : undefined),
      { isActiveMember },
    );

    if (!coupon) {
      // validateCoupon returns null only for a normalized-empty code here (a
      // real unknown/expired code throws with a specific message). Distinguish
      // it from the blank-input case above so the shopper isn't told to "enter
      // a code" when they just entered an invalid one.
      return NextResponse.json({ success: false, error: "That coupon code is not valid." }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmount: coupon.discountAmount,
    });
  } catch (error) {
    // Sanitised rather than echoed. safe-error.ts:5-16 is explicit that a raw
    // message hands a shopper a vendor hostname, a Postgres relation/column
    // name or an env-var name. Logged in full server-side, so no diagnostic
    // is lost; a genuinely shopper-written message still passes through,
    // because the sanitiser is a deny-list.
    console.error("[coupons/validate]", error);
    const message = customerSafeMessage(error, "Unable to verify coupon code");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
