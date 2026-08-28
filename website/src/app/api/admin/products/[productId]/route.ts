import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { canManageProducts } from "@/lib/admin-roles";
import {
  deleteAdminProduct,
  getAdminProductById,
  reorderProductImages,
  replaceProductDoses,
  setPrimaryProductImage,
  type DoseInput,
  updateAdminProduct,
  uploadProductImageToStorage,
  addProductImageFromUrl,
  deleteProductImage,
  type ProductUpdateInput,
} from "@/lib/admin-products";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Only managers and super admins can manage products." }, { status: 403 });
}

export async function GET(_: Request, context: { params: Promise<{ productId: string }> }) {
  const session = await verifyAdminSessionFromRequest(_);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const { productId } = await context.params;
    const product = await getAdminProductById(productId);
    return NextResponse.json({ success: true, product });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ productId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageProducts(session.role)) {
    return forbiddenResponse();
  }

  const { productId } = await context.params;

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const action = String(formData.get("action") ?? "");

      if (action !== "upload_image") {
        return NextResponse.json({ success: false, error: "Unsupported multipart action" }, { status: 400 });
      }

      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ success: false, error: "File is required" }, { status: 400 });
      }

      const makePrimary = String(formData.get("makePrimary") ?? "false") === "true";
      const imageUrl = await uploadProductImageToStorage({ productId, file, makePrimary });
      const product = await getAdminProductById(productId);
      return NextResponse.json({ success: true, imageUrl, product });
    }

    const body = await request.json() as {
      action?: string;
      payload?: ProductUpdateInput;
      doses?: DoseInput[];
      imageUrl?: string;
      altText?: string;
      imageId?: string;
      imageIdsInOrder?: string[];
    };

    const action = String(body.action ?? "update");

    if (action === "update") {
      const product = await updateAdminProduct(productId, body.payload ?? {}, session.username);
      return NextResponse.json({ success: true, product });
    }

    if (action === "replace_doses") {
      await replaceProductDoses(productId, Array.isArray(body.doses) ? body.doses : []);
      const product = await getAdminProductById(productId);
      return NextResponse.json({ success: true, product });
    }

    if (action === "add_image_url") {
      const imageUrl = String(body.imageUrl ?? "").trim();
      if (!imageUrl) {
        return NextResponse.json({ success: false, error: "imageUrl is required" }, { status: 400 });
      }
      await addProductImageFromUrl({
        productId,
        imageUrl,
        altText: body.altText ? String(body.altText) : undefined,
        isPrimary: false,
      });
      const product = await getAdminProductById(productId);
      return NextResponse.json({ success: true, product });
    }

    if (action === "set_primary_image") {
      const imageId = String(body.imageId ?? "");
      if (!imageId) {
        return NextResponse.json({ success: false, error: "imageId is required" }, { status: 400 });
      }
      await setPrimaryProductImage({ productId, imageId });
      const product = await getAdminProductById(productId);
      return NextResponse.json({ success: true, product });
    }

    if (action === "reorder_images") {
      const imageIdsInOrder = Array.isArray(body.imageIdsInOrder) ? body.imageIdsInOrder.filter((id): id is string => typeof id === "string") : [];
      await reorderProductImages({ productId, imageIdsInOrder });
      const product = await getAdminProductById(productId);
      return NextResponse.json({ success: true, product });
    }

    if (action === "delete_image") {
      const imageId = String(body.imageId ?? "");
      if (!imageId) {
        return NextResponse.json({ success: false, error: "imageId is required" }, { status: 400 });
      }
      await deleteProductImage({ productId, imageId });
      const product = await getAdminProductById(productId);
      return NextResponse.json({ success: true, product });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ productId: string }> }) {
  const session = await verifyAdminSessionFromRequest(_);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageProducts(session.role)) {
    return forbiddenResponse();
  }

  try {
    const { productId } = await context.params;
    // Read the product BEFORE the delete: once the rows are gone the audit row
    // could only name an opaque id, and "which product was this?" is the first
    // question anyone asks of a deletion. Best-effort — a product that cannot
    // be loaded must still be deletable.
    const product = await getAdminProductById(productId).catch(() => null);
    await deleteAdminProduct(productId);

    // Deleting a product cascades to its images, dose rows and COAs and cannot
    // be undone, yet it was the one destructive admin action leaving no trace —
    // partner deletion has recorded actor, IP and user agent since I-09
    // (api/admin/partners/[partnerId]/route.ts). Logged after the delete and
    // wrapped, so a failure to write the log never fails the delete itself.
    try {
      await supabaseAdmin.from("admin_audit_logs").insert({
        action: "product_delete",
        target_table: "products",
        target_id: productId,
        metadata: {
          name: product?.name ?? null,
          slug: product?.slug ?? null,
          performedBy: session.username,
          ipAddress: getRequestIpAddress(_),
          userAgent: getRequestUserAgent(_),
          performedAt: new Date().toISOString(),
        },
      });
    } catch (auditError) {
      console.error("Unable to write product delete audit log", productId, auditError);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
