import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getWishlistSlugs } from "@/lib/customer-account";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

async function requireCustomer() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return null;
  }
  return user;
}

export async function GET() {
  const user = await requireCustomer();
  if (!user) {
    return unauthorizedResponse();
  }

  try {
    const slugs = await getWishlistSlugs(user.id);
    return NextResponse.json({ success: true, slugs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load wishlist";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

// Toggles a product's wishlist membership: adds it if absent, removes it if
// present, and reports which happened so the client can flip its heart icon
// without needing to know prior state.
export async function POST(request: Request) {
  const user = await requireCustomer();
  if (!user) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json() as { slug?: string };
    const slug = String(body.slug ?? "").trim();
    if (!slug) {
      return NextResponse.json({ success: false, error: "slug is required" }, { status: 400 });
    }

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("wishlist_items")
      .select("id")
      .eq("user_id", user.id)
      .eq("product_slug", slug)
      .maybeSingle();

    if (lookupError) {
      throw lookupError;
    }

    if (existing) {
      const { error } = await supabaseAdmin.from("wishlist_items").delete().eq("id", existing.id);
      if (error) throw error;
      return NextResponse.json({ success: true, inWishlist: false });
    }

    const { error } = await supabaseAdmin.from("wishlist_items").insert({
      user_id: user.id,
      product_slug: slug,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;

    return NextResponse.json({ success: true, inWishlist: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update wishlist";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
