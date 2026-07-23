import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageProducts } from "@/lib/admin-roles";
import { getAdminProductById, uploadProductImageToStorage } from "@/lib/admin-products";

// Storefront product imagery only — keep the allow-list tight and cap the size
// so this authenticated endpoint can't be used to stash arbitrary large files.
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_IMAGE_SIZE_BYTES = 8 * 1024 * 1024;

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageProducts(session.role)) {
    return NextResponse.json({ success: false, error: "Only managers and super admins can manage products." }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const productId = formData.get("productId") as string | null;
    const makePrimary = String(formData.get("makePrimary") ?? "true") === "true";

    if (!file || !productId) {
      return NextResponse.json({ success: false, error: "Missing file or productId." }, { status: 400 });
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json({ success: false, error: "Only JPEG, PNG, WebP, GIF, or AVIF images are allowed." }, { status: 400 });
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return NextResponse.json({ success: false, error: "Image must be 8 MB or smaller." }, { status: 400 });
    }

    const imageUrl = await uploadProductImageToStorage({
      productId,
      file,
      makePrimary,
    });

    const product = await getAdminProductById(productId);

    return NextResponse.json({ success: true, imageUrl, product });
  } catch (err) {
    console.error("Image upload error:", err);
    return NextResponse.json({ success: false, error: "Upload failed." }, { status: 500 });
  }
}
