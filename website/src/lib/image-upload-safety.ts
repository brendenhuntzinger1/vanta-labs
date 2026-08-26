/**
 * ONE image sniffer, for every upload path that stores a file.
 *
 * A declared `Content-Type` on a multipart part is written by the client. It is
 * a hint about the sender's intent, never evidence about the bytes. The only
 * thing that establishes what a file IS, is reading its magic bytes.
 *
 * This existed twice already and was missing in the place it mattered most:
 *
 *   payment-proof-storage.ts  detectImageType   correct, private, customer-facing
 *   coa-format.ts             sniffCoaFileType  correct, exported, its own allow-list (+PDF)
 *   admin-products.ts         -- nothing --     PUBLIC bucket, no check at all
 *
 * The product-image path is now the third caller rather than the third
 * implementation. COA keeps its own because its allow-list includes PDF and
 * excludes GIF/AVIF, and folding two different allow-lists into one function
 * would make each caller's contract less obvious, not more.
 */

export type SniffedImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";

/** 8 MB. Matches the cap the upload-image route advertises and payment proofs use. */
export const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;

function hasAscii(bytes: Uint8Array, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/**
 * The image type the BYTES say, or null.
 *
 * Null means "not a recognised image", and every caller must treat that as a
 * rejection rather than falling back to the declared type — falling back is the
 * whole defect this closes.
 */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  // 12 bytes is the longest prefix any check below needs (RIFF/WEBP, ftyp).
  // Anything shorter cannot be identified, and guessing is what this prevents.
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && hasAscii(bytes, 1, "PNG")) return "image/png";

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  // GIF: "GIF87a" or "GIF89a"
  if (hasAscii(bytes, 0, "GIF8")) return "image/gif";

  // WEBP: "RIFF" <4-byte size> "WEBP". The brand at offset 8 is required —
  // "RIFF" alone is also a WAV and an AVI.
  if (hasAscii(bytes, 0, "RIFF") && hasAscii(bytes, 8, "WEBP")) return "image/webp";

  // AVIF: ISO-BMFF "ftyp" at offset 4, brand "avif" (still) or "avis"
  // (sequence) at offset 8. The brand is required — "ftyp" alone is also MP4,
  // HEIC and every other ISO-BMFF container.
  if (hasAscii(bytes, 4, "ftyp") && (hasAscii(bytes, 8, "avif") || hasAscii(bytes, 8, "avis"))) {
    return "image/avif";
  }

  return null;
}

/** The storage extension for a SNIFFED type. Never derived from a filename. */
export function imageExtensionFor(type: SniffedImageType): string {
  switch (type) {
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      return "jpg";
  }
}
