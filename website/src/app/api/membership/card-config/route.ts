import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getPaymentProvider } from "@/lib/payment-provider";

export const dynamic = "force-dynamic";

// Everything the membership card form needs, in ONE authenticated call:
// a Veyra checkout session and that session's Basis Theory PUBLIC key.
//
// Why both together: `card_capture_config` is session-scoped, so a BT key can
// only be obtained for a session that already exists. Doing it in one
// authenticated endpoint keeps the session mint server-side, resolves the price
// from the tier row (never from the client), and avoids exposing a standalone
// config proxy that anyone could point at an arbitrary session id.
//
// SAQ-A: this returns a PUBLIC key only. The PAN/CVC never leave the
// js.basistheory.com iframe and never reach this origin. VEYRA_SECRET_KEY stays
// server-side — the browser never sees it.

interface VeyraCardCaptureConfig {
  basis_theory?: { public_api_key?: string; environment?: string };
  currency?: string;
}

function veyraBase(): string {
  return (process.env.VEYRA_API_BASE || "https://veyragate.com").replace(/\/+$/, "");
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    tierId?: string;
    billingCycle?: string;
  } | null;

  if (!body?.tierId || (body.billingCycle !== "monthly" && body.billingCycle !== "annual")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Price comes from the tier row. A client-supplied amount is never trusted —
  // this figure is what the card form displays AND what Veyra charges.
  const { data: tierRow } = await supabaseAdmin
    .from("membership_tiers")
    .select("id, slug, name, monthly_price_cents, annual_price_cents")
    .eq("id", body.tierId)
    .maybeSingle();

  const tier = tierRow as
    | { id: string; slug: string | null; name: string; monthly_price_cents: number | null; annual_price_cents: number | null }
    | null;

  if (!tier) {
    return NextResponse.json({ error: "Membership tier not found" }, { status: 404 });
  }

  const amountCents = body.billingCycle === "annual" ? tier.annual_price_cents : tier.monthly_price_cents;
  if (!amountCents || amountCents <= 0) {
    // Also catches the active $0 "free" tier, which is below the 50c processor
    // floor and would be refused upstream with a far less obvious error.
    return NextResponse.json({ error: "This membership is not available right now." }, { status: 400 });
  }

  // Veyra needs a real customer email. Refuse here rather than sending "" and
  // taking an opaque upstream failure that the UI would report as "card entry
  // temporarily unavailable" — which would send the shopper down the one-time
  // fallback for a fixable account problem.
  const customerEmail = (user.email ?? "").trim();
  if (!customerEmail) {
    return NextResponse.json(
      { error: "Add an email to your account before starting a membership." },
      { status: 400 },
    );
  }

  try {
    // The session exists so a card can be captured against it; the actual
    // recurring subscription is created later by /api/membership/subscribe,
    // which passes the resulting token intent to Veyra.
    const session = await getPaymentProvider().createCheckoutSession({
      orderId: `membership-${user.id}-${tier.id}-${body.billingCycle}`,
      customerEmail,
      amount: amountCents,
      currency: "USD",
      metadata: { kind: "membership_card_capture", tier_id: tier.id, billing_cycle: body.billingCycle },
    });

    const cfgRes = await fetch(
      `${veyraBase()}/api/checkout/${encodeURIComponent(session.paymentId)}/card_capture_config`,
      { method: "GET", headers: { accept: "application/json" } },
    );

    if (!cfgRes.ok) {
      // Fail closed and say nothing about the upstream. A missing BT key means
      // no card form at all — better than mounting one that cannot tokenize.
      console.error(`[membership/card-config] card_capture_config ${cfgRes.status} for session ${session.paymentId}`);
      return NextResponse.json({ error: "Card entry is temporarily unavailable." }, { status: 503 });
    }

    const cfg = (await cfgRes.json()) as VeyraCardCaptureConfig;
    const apiKey = cfg.basis_theory?.public_api_key;
    if (!apiKey) {
      console.error(`[membership/card-config] no BT public key for session ${session.paymentId}`);
      return NextResponse.json({ error: "Card entry is temporarily unavailable." }, { status: 503 });
    }

    // Narrowed on purpose — only what the form needs. The upstream response is
    // never forwarded wholesale, so no merchant-internal field can leak.
    return NextResponse.json({
      sessionId: session.paymentId,
      apiKey,
      environment: cfg.basis_theory?.environment ?? null,
      amountCents,
      tierName: tier.name,
      billingCycle: body.billingCycle,
    });
  } catch (error) {
    console.error("[membership/card-config]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Card entry is temporarily unavailable." }, { status: 503 });
  }
}
