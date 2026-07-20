import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export const PAYMENT_PROOF_BUCKET = "payment-proofs";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_PROOF_BYTES = 8 * 1024 * 1024; // 8 MB
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

let ensuredBucket = false;

// Creates the PRIVATE storage bucket on first use so uploads never fail just
// because the SQL migration wasn't run. Idempotent — an "already exists" error
// is expected and ignored. Private because proof screenshots contain PII
// (names, handles, partial account/transaction details); admins view them via
// short-lived signed URLs, never a public link.
async function ensureBucket() {
  if (ensuredBucket) return;
  try {
    await supabaseAdmin.storage.createBucket(PAYMENT_PROOF_BUCKET, {
      public: false,
      fileSizeLimit: MAX_PROOF_BYTES,
    });
  } catch {
    // Bucket already exists (or storage not reachable) — upload surfaces real problems.
  }
  ensuredBucket = true;
}

// Sniffs the leading bytes to confirm the file really is one of the allowed
// image types, rather than trusting the client-supplied Content-Type.
function detectImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
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
  /** Storage path (NOT a public URL). Persist this on the order. */
  path: string | null;
  error?: string;
}

// Uploads a customer's payment screenshot to the private bucket and returns
// its storage path. Never throws — a failed/oversized/invalid upload returns
// an error the caller can surface without failing the whole submission.
export async function uploadPaymentProof(input: {
  orderId: string;
  file: File;
}): Promise<PaymentProofUploadResult> {
  const { file } = input;

  if (!file || file.size === 0) {
    return { path: null };
  }

  if (file.size > MAX_PROOF_BYTES) {
    return { path: null, error: "Screenshot is too large (max 8 MB)." };
  }

  const declaredType = (file.type || "").toLowerCase();
  if (!ALLOWED_MIME.has(declaredType)) {
    return { path: null, error: "Screenshot must be a PNG, JPG, WEBP, or GIF image." };
  }

  await ensureBucket();

  const safeOrderId = input.orderId.replace(/[^a-zA-Z0-9_-]/g, "");

  try {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Content-based validation — reject anything whose actual bytes aren't a
    // real image, regardless of the declared Content-Type.
    const sniffedType = detectImageType(bytes);
    if (!sniffedType) {
      return { path: null, error: "That file doesn't look like a valid image." };
    }

    const path = `${safeOrderId}/${Date.now()}-proof.${extensionForType(sniffedType)}`;
    const { error } = await supabaseAdmin.storage
      .from(PAYMENT_PROOF_BUCKET)
      .upload(path, arrayBuffer, { contentType: sniffedType, upsert: true });

    if (error) {
      return { path: null, error: "Unable to store the screenshot right now." };
    }

    return { path };
  } catch {
    return { path: null, error: "Unable to store the screenshot right now." };
  }
}

// Generates a short-lived signed URL for an admin to view a proof. Accepts
// either a stored path or a legacy full URL (returned as-is). Returns null on
// failure so the admin UI can degrade gracefully.
export async function createSignedProofUrl(pathOrUrl: string | null | undefined): Promise<string | null> {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl; // legacy public URL
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(PAYMENT_PROOF_BUCKET)
      .createSignedUrl(pathOrUrl, SIGNED_URL_TTL_SECONDS);
    if (error) return null;
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}
