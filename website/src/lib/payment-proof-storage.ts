import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export const PAYMENT_PROOF_BUCKET = "payment-proofs";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_PROOF_BYTES = 8 * 1024 * 1024; // 8 MB

let ensuredBucket = false;

// Creates the public storage bucket on first use so uploads never fail just
// because the SQL migration wasn't run against this instance. Idempotent -
// a "already exists" error is expected and ignored.
async function ensureBucket() {
  if (ensuredBucket) return;
  try {
    await supabaseAdmin.storage.createBucket(PAYMENT_PROOF_BUCKET, {
      public: true,
      fileSizeLimit: MAX_PROOF_BYTES,
    });
  } catch {
    // Bucket already exists (or storage not reachable) - upload will surface
    // any real problem.
  }
  ensuredBucket = true;
}

function extensionForType(type: string) {
  switch (type) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}

export interface PaymentProofUploadResult {
  url: string | null;
  error?: string;
}

// Uploads a customer's payment screenshot and returns a public URL to store
// on the order. Never throws - a failed/oversized/invalid upload returns an
// error the caller can surface without failing the whole submission (the
// screenshot is optional).
export async function uploadPaymentProof(input: {
  orderId: string;
  file: File;
}): Promise<PaymentProofUploadResult> {
  const { file } = input;

  if (!file || file.size === 0) {
    return { url: null };
  }

  if (file.size > MAX_PROOF_BYTES) {
    return { url: null, error: "Screenshot is too large (max 8 MB)." };
  }

  const type = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    return { url: null, error: "Screenshot must be a PNG, JPG, WEBP, or GIF image." };
  }

  await ensureBucket();

  const safeOrderId = input.orderId.replace(/[^a-zA-Z0-9_-]/g, "");
  const path = `${safeOrderId}/${Date.now()}-proof.${extensionForType(type)}`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const { error } = await supabaseAdmin.storage
      .from(PAYMENT_PROOF_BUCKET)
      .upload(path, arrayBuffer, { contentType: type, upsert: true });

    if (error) {
      return { url: null, error: "Unable to store the screenshot right now." };
    }

    const { data } = supabaseAdmin.storage.from(PAYMENT_PROOF_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl ?? null };
  } catch {
    return { url: null, error: "Unable to store the screenshot right now." };
  }
}
