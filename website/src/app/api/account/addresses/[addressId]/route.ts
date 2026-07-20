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

export async function PATCH(request: Request, context: { params: Promise<{ addressId: string }> }) {
  const user = await requireCustomer();
  if (!user) {
    return unauthorizedResponse();
  }

  const { addressId } = await context.params;

  try {
    const body = await request.json() as {
      label?: string;
      fullName?: string;
      address?: string;
      city?: string;
      postalCode?: string;
      isDefault?: boolean;
    };

    if (body.isDefault) {
      await supabaseAdmin.from("customer_addresses").update({ is_default: false }).eq("user_id", user.id);
    }

    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.label !== undefined) updatePayload.label = body.label.trim() || null;
    if (body.fullName !== undefined) updatePayload.full_name = body.fullName.trim();
    if (body.address !== undefined) updatePayload.address = body.address.trim();
    if (body.city !== undefined) updatePayload.city = body.city.trim();
    if (body.postalCode !== undefined) updatePayload.postal_code = body.postalCode.trim();
    if (body.isDefault !== undefined) updatePayload.is_default = body.isDefault;

    // user_id filter ensures a customer can only ever update their own row,
    // regardless of what addressId is passed.
    const { error } = await supabaseAdmin
      .from("customer_addresses")
      .update(updatePayload)
      .eq("id", addressId)
      .eq("user_id", user.id);

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update address";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ addressId: string }> }) {
  const user = await requireCustomer();
  if (!user) {
    return unauthorizedResponse();
  }

  const { addressId } = await context.params;

  try {
    const { error } = await supabaseAdmin
      .from("customer_addresses")
      .delete()
      .eq("id", addressId)
      .eq("user_id", user.id);

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete address";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
