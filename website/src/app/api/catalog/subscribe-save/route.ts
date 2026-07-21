import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getSubscribeSaveConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

// Public: the product page reads the Subscribe & Save offer to display it.
export async function GET() {
  const config = await getSubscribeSaveConfig();
  if (!config.enabled) {
    return NextResponse.json({ success: true, config: null });
  }
  return NextResponse.json({ success: true, config });
}

// Records a subscribe-and-save opt-in as a PENDING subscription. It never
// charges — it activates only once a recurring payment processor is connected.
export async function POST(request: Request) {
  try {
    const config = await getSubscribeSaveConfig();
    if (!config.enabled) {
      return NextResponse.json({ success: false, error: "Subscriptions aren't available yet." }, { status: 400 });
    }

    const body = (await request.json()) as { productSlug?: string; variantId?: string; email?: string };
    const productSlug = String(body.productSlug ?? "").trim().slice(0, 100);
    const variantId = body.variantId ? String(body.variantId).slice(0, 100) : null;
    const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
    if (!productSlug) {
      return NextResponse.json({ success: false, error: "Missing product." }, { status: 400 });
    }
    if (!email || !email.includes("@")) {
      return NextResponse.json({ success: false, error: "Enter a valid email." }, { status: 400 });
    }

    // Only allow real products (blocks arbitrary-slug DB bloat).
    const { data: exists } = await supabaseAdmin.from("products").select("slug").eq("slug", productSlug).maybeSingle();
    if (!exists) {
      return NextResponse.json({ success: false, error: "Unknown product." }, { status: 400 });
    }

    const user = await getAuthenticatedUser();

    const { error } = await supabaseAdmin.from("product_subscriptions").insert({
      user_id: user?.id ?? null,
      email,
      product_slug: productSlug,
      variant_id: variantId,
      frequency_days: config.frequencyDays,
      discount_percent: config.discountPercent,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (error) {
      return NextResponse.json({ success: false, error: "Unable to save your subscription right now." }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "Unable to save your subscription." }, { status: 400 });
  }
}
