import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { duplicateAdminProduct } from "@/lib/admin-products";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(_: Request, context: { params: Promise<{ productId: string }> }) {
  const session = await verifyAdminSessionFromRequest(_);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageInventory(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage products." }, { status: 403 });
  }

  try {
    const { productId } = await context.params;
    const product = await duplicateAdminProduct(productId);
    return NextResponse.json({ success: true, product });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to duplicate product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
