import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { getCoaRecordByBatch } from "@/lib/catalog";
import { generateCoaQrSvg } from "@/lib/qr-code";
import { getSiteUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

function verifyUrlFor(batch: string) {
  return `${getSiteUrl().replace(/\/+$/, "")}/coa/${encodeURIComponent(batch)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ batch: string }>;
}): Promise<Metadata> {
  const { batch } = await params;
  const record = await getCoaRecordByBatch(decodeURIComponent(batch)).catch(() => null);
  if (!record) {
    return { title: "Batch not found", robots: { index: false } };
  }
  return {
    title: `Verify Batch ${record.batchNumber} — ${record.productName}`,
    description: `Certificate of Analysis verification for ${record.productName}, batch ${record.batchNumber}. Purity ${record.purityResult}, tested by ${record.labName}.`,
    robots: { index: false },
  };
}

export default async function CoaVerifyPage({
  params,
}: {
  params: Promise<{ batch: string }>;
}) {
  const { batch } = await params;
  const record = await getCoaRecordByBatch(decodeURIComponent(batch)).catch(() => null);
  if (!record) {
    notFound();
  }

  const verifyUrl = verifyUrlFor(record.batchNumber);
  const qrSvg = await generateCoaQrSvg(verifyUrl);

  const details: Array<{ label: string; value: string }> = [
    { label: "Product", value: record.productName },
    { label: "Category", value: record.category },
    { label: "Batch / Lot", value: record.batchNumber },
    { label: "Purity result", value: record.purityResult },
    { label: "Testing date", value: record.testingDate || "—" },
    { label: "Testing laboratory", value: record.labName || "—" },
  ];

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-3xl px-4 pb-24 pt-32 sm:px-6 lg:px-12">
        <Link href="/coa-library" className="text-xs text-white/45 transition hover:text-white">
          ← COA Library
        </Link>

        <div className="mt-6 flex items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Verified batch
          </span>
        </div>

        <p className="vl2-eyebrow mt-6">Certificate of Analysis</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">{record.productName}</h1>
        <p className="mt-2 text-sm text-white/45">Batch {record.batchNumber}</p>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.4fr_0.6fr]">
          <div className="vl2-glass p-5 sm:p-6">
            <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {details.map((item) => (
                <div key={item.label}>
                  <dt className="text-white/40 text-xs uppercase tracking-wide">{item.label}</dt>
                  <dd className="mt-1 text-sm text-white">{item.value}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-6 flex flex-wrap gap-3">
              {record.coaUrl ? (
                <a
                  href={record.coaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-sm"
                >
                  Open / Download lab report
                </a>
              ) : (
                <span className="inline-flex px-4 py-2 text-sm text-white/40">
                  Lab report document coming soon
                </span>
              )}
              <Link
                href={`/products/${record.slug}`}
                className="vl-focus-ring inline-flex px-4 py-2 text-sm text-white/60 transition hover:text-white"
              >
                View product →
              </Link>
            </div>
          </div>

          <div className="vl2-glass flex flex-col items-center p-5 sm:p-6">
            <p className="vl2-eyebrow self-start">Scan to verify</p>
            <div
              className="mt-4 w-40 rounded-lg bg-white p-3 [&>svg]:h-full [&>svg]:w-full"
              // Rendered from a trusted server-side QR library, not user input.
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p className="mt-3 text-center text-[11px] leading-5 text-white/40">
              This code links to this verification page. Print it on the vial or
              packaging.
            </p>
            <a
              href={`/api/catalog/coa-qr?batch=${encodeURIComponent(record.batchNumber)}`}
              className="vl-focus-ring mt-3 text-xs text-white/60 underline underline-offset-4 transition hover:text-white"
            >
              Download QR (SVG)
            </a>
          </div>
        </div>

        <div className="mt-10 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-xs leading-6 text-white/45">
          This certificate reflects third-party laboratory analysis of the stated
          batch. Vanta Labs products are sold for laboratory research use only —
          not for human or animal consumption. The batch number on your product
          label must match the batch shown above.
        </div>
      </main>
    </div>
  );
}
