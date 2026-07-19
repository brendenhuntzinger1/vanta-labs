import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
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
      const product = await updateAdminProduct(productId, body.payload ?? {});
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

  try {
    const { productId } = await context.params;
    await deleteAdminProduct(productId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete product";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
