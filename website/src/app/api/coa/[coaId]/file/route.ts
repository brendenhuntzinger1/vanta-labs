import { NextResponse } from "next/server";
import { resolveCoaFileUrl } from "@/lib/coa";

// The ONLY public door to a COA document.
//
// The bucket is private, so nothing on the storefront ever holds a document
// URL. A customer clicking "View COA" lands here, this route re-checks that the
// record is published AND its product is still live, and only then mints a
// short-lived signed URL to redirect to. Unpublishing a COA — or delisting the
// product — cuts off every link that was ever shared, immediately.
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ coaId: string }> }) {
  const { coaId } = await context.params;
  const download = new URL(request.url).searchParams.get("download") === "1";

  const resolved = await resolveCoaFileUrl({ coaId, requirePublished: true, download });

  if (!resolved) {
    return NextResponse.json(
      { success: false, error: "That Certificate of Analysis is not available." },
      { status: 404 },
    );
  }

  // 307 rather than 302: the signed URL expires, so this must never be cached
  // as a permanent answer by a browser or a CDN.
  return NextResponse.redirect(resolved.url, {
    status: 307,
    headers: { "Cache-Control": "private, no-store" },
  });
}
