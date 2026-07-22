import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { bulkUpdateAdminProducts, createAdminProduct, listAdminProducts, type AdminProductStatusFilter, type ProductCreateInput } from "@/lib/admin-products";

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage products." }, { status: 403 });
}

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search") ?? "";
    const category = url.searchParams.get("category") ?? "all";
    const status = (url.searchParams.get("status") ?? "all") as AdminProductStatusFilter;

    const rows = await listAdminProducts({ search, category, status });
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageInventory(session.role)) {
    return forbiddenResponse();
  }

  try {
    const body = await request.json() as ProductCreateInput;
    const name = String(body?.name ?? "").trim();
    const category = String(body?.category ?? "").trim();

    if (!name) {
      return NextResponse.json({ success: false, error: "Product name is required" }, { status: 400 });
    }

    if (!category) {
      return NextResponse.json({ success: false, error: "Category is required" }, { status: 400 });
    }

    const product = await createAdminProduct({ ...body, name, category });
    return NextResponse.json({ success: true, product });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageInventory(session.role)) {
    return forbiddenResponse();
  }

  try {
    const body = await request.json() as {
      productIds?: string[];
      action?: "publish" | "unpublish" | "enable" | "disable" | "archive" | "unarchive" | "feature" | "unfeature" | "set_category" | "set_badge";
      value?: string | null;
    };

    const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id) => typeof id === "string" && id.length > 0) : [];
    const action = body.action;

    if (!action || productIds.length === 0) {
      return NextResponse.json({ success: false, error: "Bulk action and productIds are required" }, { status: 400 });
    }

    await bulkUpdateAdminProducts({ productIds, action, value: body.value ?? null });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
