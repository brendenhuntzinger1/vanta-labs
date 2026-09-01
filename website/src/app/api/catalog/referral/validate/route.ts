import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * Validate a referral code for the cart.
 *
 * WHY THIS ROUTE EXISTS, WHEN AN RPC ALREADY DID THE JOB.
 *
 * `validate_referral_code` is a SECURITY DEFINER function that anon may call
 * directly at /rest/v1/rpc/validate_referral_code, because the cart has to
 * check a code before the shopper has an account. That made it the entire
 * anonymous read surface of the ambassador programme, and
 * referral-rpc-minimise.sql already trimmed what it returns down to what the
 * cart renders.
 *
 * What that file could not fix, and said so plainly, is the ENUMERATION: "a
 * PostgREST RPC does not pass through the application's rate limiter, so the
 * codes can be swept". Referral codes are short and human-chosen (JORDAN10,
 * SAM20), so sweeping them is cheap, and each hit returns an ambassador's name.
 * The residual was documented as needing "a rate-limited application route" —
 * this is that route.
 *
 * The shape it returns is byte-identical to the RPC's, so the cart's resolution
 * of customer_discount_percent (including the meaningful null that means
 * "inherit the programme rate") is unchanged.
 */
export async function POST(request: Request) {
  try {
    // Generous for a person, useless for a sweep. A shopper might try a couple
    // of codes and mistype one; nobody legitimately tries twenty in ten
    // minutes. Keyed per IP by rateLimitKeyForRequest.
    const rateLimit = await checkRateLimit(rateLimitKeyForRequest("referral-validate", request), 20, 10 * 60);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many referral code attempts. Please wait a moment." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
      );
    }

    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const code = String(body?.code ?? "").trim().toUpperCase();
    if (!code) {
      return NextResponse.json({ success: true, valid: false });
    }

    const { data, error } = await supabaseAdmin
      .from("ambassadors")
      // EXACTLY the columns the RPC returned, and no more. `commission_percent`
      // is what Vanta pays the ambassador and has no business on this path —
      // see referral-rpc-minimise.sql for the leak that removed it.
      .select("id, name, referral_code, customer_discount_percent")
      .eq("referral_code", code)
      .eq("status", "approved")
      .maybeSingle();

    if (error) {
      // A read failure is not "this code is invalid". Saying so would strip a
      // real ambassador's discount from a real basket on a transient blip.
      return NextResponse.json({ success: false, error: "Could not check that code right now." }, { status: 503 });
    }

    if (!data) {
      return NextResponse.json({ success: true, valid: false });
    }

    return NextResponse.json({
      success: true,
      valid: true,
      referralCode: String(data.referral_code ?? code).toUpperCase(),
      ambassadorId: String(data.id),
      ambassadorName: String(data.name ?? "Ambassador"),
      // RAW, including null. Null means "no override, inherit the programme
      // rate" and the caller resolves it through the same rule the server uses.
      // Coercing it to 0 would hand every inheriting ambassador a 0% discount.
      customerDiscountPercent: (data.customer_discount_percent ?? null) as number | string | null,
    });
  } catch {
    return NextResponse.json({ success: false, error: "Could not check that code right now." }, { status: 503 });
  }
}
