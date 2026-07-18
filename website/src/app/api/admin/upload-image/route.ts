import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const slug = formData.get("slug") as string | null;

    if (!file || !slug) {
      return Response.json({ success: false, error: "Missing file or slug." }, { status: 400 });
    }

    // Sanitize slug — only allow alphanumeric and hyphens
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return Response.json({ success: false, error: "Invalid slug." }, { status: 400 });
    }

    const ext = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z]/g, "");
    const allowedExts = ["png", "jpg", "jpeg", "webp"];
    if (!allowedExts.includes(ext)) {
      return Response.json({ success: false, error: "Only PNG, JPG, JPEG, and WEBP files are allowed." }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const filename = `${slug}.${ext}`;
    const imagePath = path.join(process.cwd(), "public", "images", filename);
    await writeFile(imagePath, buffer);

    // Update product-images.json override map
    const overridesPath = path.join(process.cwd(), "public", "product-images.json");
    let overrides: Record<string, string> = {};
    try {
      const raw = await readFile(overridesPath, "utf8");
      overrides = JSON.parse(raw);
    } catch {
      // file doesn't exist yet, start fresh
    }
    overrides[slug] = `/images/${filename}`;
    await writeFile(overridesPath, JSON.stringify(overrides, null, 2));

    return Response.json({ success: true, path: `/images/${filename}` });
  } catch (err) {
    console.error("Image upload error:", err);
    return Response.json({ success: false, error: "Upload failed." }, { status: 500 });
  }
}
