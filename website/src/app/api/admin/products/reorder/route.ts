import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { reorderAdminProducts } from "@/lib/admin-products";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json() as { productIds?: string[] };
    const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    await reorderAdminProducts(productIds);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reorder products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
