import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { backInStockTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";

function normEmail(email: string) {
  return email.trim().toLowerCase();
}

// Records a "notify me when back in stock" request. Idempotent per
// email+product+variant while still pending.
export async function requestBackInStock(input: {
  productSlug: string;
  variantId?: string | null;
  email: string;
}): Promise<{ ok: boolean; error?: string }> {
  const email = normEmail(input.email).slice(0, 200);
  const productSlug = input.productSlug.trim().slice(0, 100);
  const variantId = input.variantId ? String(input.variantId).slice(0, 100) : null;
  if (!email || !email.includes("@") || email.length > 200) {
    return { ok: false, error: "Enter a valid email." };
  }
  if (!productSlug) {
    return { ok: false, error: "Missing product." };
  }

  // Only allow enrolling on real products (blocks arbitrary-slug DB bloat).
  const { data: exists } = await supabaseAdmin
    .from("products")
    .select("slug")
    .eq("slug", productSlug)
    .maybeSingle();
  if (!exists) {
    return { ok: false, error: "Unknown product." };
  }

  const { error } = await supabaseAdmin
    .from("back_in_stock_requests")
    .upsert(
      {
        product_slug: productSlug,
        variant_id: variantId,
        email,
        notified: false,
        created_at: new Date().toISOString(),
      },
      { onConflict: "product_slug,variant_id,email", ignoreDuplicates: true },
    );

  // A duplicate is fine — they're already on the list.
  if (error && !String(error.message ?? "").toLowerCase().includes("duplicate")) {
    return { ok: false, error: "Unable to save your request right now." };
  }
  return { ok: true };
}

// Emails everyone waiting on a product (optionally a specific variant) and
// marks them notified. Called when a product is restocked. Best-effort.
export async function notifyBackInStock(productSlug: string, productName: string, variantId?: string | null): Promise<number> {
  try {
    let query = supabaseAdmin
      .from("back_in_stock_requests")
      .select("id, email")
      .eq("product_slug", productSlug)
      .eq("notified", false);
    if (variantId) {
      query = query.eq("variant_id", variantId);
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) {
      return 0;
    }

    const productUrl = `${getSiteUrl()}/products/${productSlug}`;
    let sent = 0;
    for (const row of data) {
      const template = backInStockTemplate({ name: "", productName, productUrl });
      const result = await sendEmail({ to: String(row.email), ...template });
      if (result.success) {
        await supabaseAdmin
          .from("back_in_stock_requests")
          .update({ notified: true, notified_at: new Date().toISOString() })
          .eq("id", row.id);
        sent += 1;
      }
    }
    return sent;
  } catch {
    return 0;
  }
}
