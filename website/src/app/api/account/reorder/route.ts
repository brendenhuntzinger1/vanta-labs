import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer" || !user.email) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as { orderId?: string };
    const orderId = String(body.orderId ?? "");
    if (!orderId) {
      return NextResponse.json({ success: false, error: "orderId is required" }, { status: 400 });
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, order_items(product_id, quantity)")
      .eq("order_id", orderId)
      .maybeSingle();

    if (orderError) {
      throw orderError;
    }

    if (!order || String(order.customer_email ?? "").toLowerCase() !== user.email.toLowerCase()) {
      return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 });
    }

    const lineItems = (order.order_items ?? []) as Array<{ product_id: string; quantity: number }>;
    const slugs = Array.from(new Set(lineItems.map((item) => String(item.product_id).split("::")[0])));
    const products = await getCatalogProductsBySlugs(slugs);
    const productsBySlug = new Map(products.map((product) => [product.slug, product]));

    const available: Array<{
      slug: string;
      variantId?: string;
      name: string;
      price: number;
      quantity: number;
      image: string;
      stockStatus: string;
      batchNumber: string;
      sku?: string;
    }> = [];
    const unavailable: string[] = [];

    for (const item of lineItems) {
      const [slug, variantId] = String(item.product_id).split("::");
      const product = productsBySlug.get(slug);

      if (!product) {
        unavailable.push(slug);
        continue;
      }

      const dose = variantId ? product.doses?.find((d) => d.id === variantId) : undefined;
      const stockStatus = dose?.stockStatus ?? product.stockStatus;

      if (stockStatus === "Out of Stock" || stockStatus === "Reserved") {
        unavailable.push(dose?.label ? `${product.name} (${dose.label})` : product.name);
        continue;
      }

      const priceString = dose ? (dose.salePrice ?? dose.price) : (product.salePrice ?? product.price);
      const price = Number(priceString.replace(/[^0-9.]/g, ""));

      available.push({
        slug: product.slug,
        variantId: dose?.id,
        name: product.name,
        price: Number.isFinite(price) ? price : 0,
        quantity: Number(item.quantity ?? 1),
        image: dose?.imageUrl ?? product.image,
        stockStatus,
        batchNumber: dose?.batchNumber ?? product.batchNumber,
        sku: dose?.sku,
      });
    }

    return NextResponse.json({ success: true, available, unavailable });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reorder";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
