import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCoaRecordByBatch } from "@/lib/catalog";
import { generateCoaQrSvg } from "@/lib/qr-code";
import { getSiteUrl } from "@/lib/env";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ batch: string }>;
}): Promise<Metadata> {
  const { batch } = await params;
  return { title: `Label — Batch ${decodeURIComponent(batch)}`, robots: { index: false } };
}

// A print-ready label for a single batch. Open it, hit "Print label", and the
// on-screen buttons drop away so only the clean QR card prints — ready to trim
// and stick on the vial or box. Also reachable straight from the admin editor.
export default async function CoaLabelPage({
  params,
}: {
  params: Promise<{ batch: string }>;
}) {
  const { batch } = await params;
  const record = await getCoaRecordByBatch(decodeURIComponent(batch)).catch(() => null);
  if (!record) {
    notFound();
  }

  const base = getSiteUrl().replace(/\/+$/, "");
  const verifyUrl = `${base}/coa/${encodeURIComponent(record.batchNumber)}`;
  const qrSvg = await generateCoaQrSvg(verifyUrl);
  const displayDomain = base.replace(/^https?:\/\//, "");

  return (
    <div className="min-h-screen bg-white text-black">
      <div className="mx-auto max-w-md px-6 py-10">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <Link href={`/coa/${encodeURIComponent(record.batchNumber)}`} className="text-sm text-black/50 hover:text-black">
            ← Back to verification
          </Link>
          <PrintButton />
        </div>

        {/* The printable label card. */}
        <div className="mx-auto w-full max-w-sm rounded-xl border border-black/15 p-6 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-black/50">
            Vanta Labs
          </p>
          <h1 className="mt-2 text-lg font-semibold leading-tight">
            {record.productName}
            {record.doseLabel ? ` · ${record.doseLabel}` : ""}
          </h1>
          <p className="mt-1 text-sm text-black/60">Batch {record.batchNumber}</p>

          <div className="mx-auto mt-5 w-44 [&>svg]:h-full [&>svg]:w-full">
            {/* Rendered from a trusted server-side QR library, not user input. */}
            <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
          </div>

          <p className="mt-4 text-sm font-medium">Scan to verify authenticity</p>
          <p className="mt-1 text-xs text-black/55">
            {displayDomain}/coa/{record.batchNumber}
          </p>
          <p className="mt-3 text-[10px] leading-4 text-black/45">
            For laboratory research use only. Not for human or animal consumption.
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-black/45 print:hidden">
          Tip: in the print dialog, set margins to “None” and scale to fit for the crispest label.
        </p>
      </div>
    </div>
  );
}
