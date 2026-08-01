import { NextResponse } from "next/server";
import {
  loadIntentBySession,
  resolveShopperIdentity,
  veyraApiBase,
} from "@/lib/express-checkout-service";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// The Basis Theory PUBLIC key + wallet flags for one session.
//
// Narrowed on purpose: only the handful of fields the wallet button needs are
// forwarded. The upstream response is never passed through wholesale, so no
// merchant-internal field can leak into the browser, and VEYRA_SECRET_KEY is
// never anywhere near this path.

interface VeyraCardCaptureConfig {
  basis_theory?: { public_api_key?: string; environment?: string };
  wallets?: { merchant_name?: string; apple_pay_enabled?: boolean; enable_wallets?: boolean };
  currency?: string;
}

export async function GET(request: Request) {
  const sessionId = (new URL(request.url).searchParams.get("session_id") ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session." }, { status: 400 });
  }

  const { ip, userAgent } = resolveShopperIdentity(request);
  const rateLimit = await checkRateLimit(`express-config:${ip ?? "unknown"}`, 30, 60);
  if (!rateLimit.allowed) {
    const res = NextResponse.json({ error: "Too many requests." }, { status: 429 });
    res.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return res;
  }

  // Not an open proxy: the session must belong to a live intent of ours.
  const intent = await loadIntentBySession(sessionId);
  if (!intent || intent.consumed_at || new Date(intent.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "This checkout has expired. Please start again." }, { status: 410 });
  }

  try {
    const response = await fetch(`${veyraApiBase()}/api/checkout/${encodeURIComponent(sessionId)}/card_capture_config`, {
      method: "GET",
      headers: {
        ...(ip ? { "x-forwarded-for": ip, "x-real-ip": ip } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
      cache: "no-store",
    });
    const data = (await response.json().catch(() => null)) as VeyraCardCaptureConfig | null;
    if (!response.ok || !data?.basis_theory?.public_api_key) {
      return NextResponse.json({ error: "Express checkout is unavailable right now." }, { status: 502 });
    }

    return NextResponse.json({
      basis_theory: {
        public_api_key: data.basis_theory.public_api_key,
        environment: data.basis_theory.environment ?? null,
      },
      wallets: {
        // Reads "Secure Checkout" rather than the store name on a
        // descriptor-masked account. That is expected, and it is the label the
        // shopper sees while authorizing — never fall back to a legal business
        // name here.
        merchant_name: data.wallets?.merchant_name ?? "Secure Checkout",
        apple_pay_enabled: data.wallets?.apple_pay_enabled === true,
        enable_wallets: data.wallets?.enable_wallets === true,
      },
      currency: data.currency ?? "usd",
    });
  } catch (error) {
    console.error("Express config proxy failed", error);
    return NextResponse.json({ error: "Express checkout is unavailable right now." }, { status: 502 });
  }
}
