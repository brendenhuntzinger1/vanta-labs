import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
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

export async function POST(request: Request) {
  const user = await requireCustomer();
  if (!user) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json() as {
      label?: string;
      fullName?: string;
      address?: string;
      city?: string;
      postalCode?: string;
      isDefault?: boolean;
    };

    const fullName = String(body.fullName ?? "").trim();
    const address = String(body.address ?? "").trim();
    const city = String(body.city ?? "").trim();
    const postalCode = String(body.postalCode ?? "").trim();

    if (!fullName || !address || !city || !postalCode) {
      return NextResponse.json({ success: false, error: "Full name, address, city, and postal code are required." }, { status: 400 });
    }

    if (body.isDefault) {
      await supabaseAdmin.from("customer_addresses").update({ is_default: false }).eq("user_id", user.id);
    }

    const { data: existingAddresses } = await supabaseAdmin
      .from("customer_addresses")
      .select("id")
      .eq("user_id", user.id);

    const { error } = await supabaseAdmin.from("customer_addresses").insert({
      user_id: user.id,
      label: body.label?.trim() || null,
      full_name: fullName,
      address,
      city,
      postal_code: postalCode,
      is_default: Boolean(body.isDefault) || !existingAddresses?.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save address";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
