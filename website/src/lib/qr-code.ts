import "server-only";

import QRCode from "qrcode";

// Generate a QR code as a self-contained SVG string, rendered entirely on the
// server. We deliberately do NOT call any external QR image service: doing so
// would leak batch/COA URLs to a third party and would clash with the site's
// CSP/security posture. The SVG is scalable, prints crisply on a vial label,
// and embeds inline with no extra network request.
export async function generateCoaQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    // Colors are applied in the consuming markup; keep the raw paths neutral.
    color: { dark: "#000000", light: "#ffffff" },
  });
}
