import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getAdminProductById, uploadProductImageToStorage } from "@/lib/admin-products";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const productId = formData.get("productId") as string | null;
    const makePrimary = String(formData.get("makePrimary") ?? "true") === "true";

    if (!file || !productId) {
      return NextResponse.json({ success: false, error: "Missing file or productId." }, { status: 400 });
    }

    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ success: false, error: "Only image files are allowed." }, { status: 400 });
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
