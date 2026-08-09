import Link from "next/link";

// "About Our Testing" — the disclosure, moved OFF the top of the COA library.
//
// It used to be the first thing on the page: a bordered panel of supplier and
// confidentiality prose sitting above the archive itself, so a visitor read two
// paragraphs of caveats before seeing a single document. The caveats are still
// necessary and still here — they just belong after the evidence, not in front
// of it. Deliberately says nothing about who manufactures or tests for us
// beyond "independent third party": supplier identity is not the customer's
// question, and disclosing it is the owner's call, not this page's.

const POINTS = [
  {
    title: "Independent third-party testing",
    body: "Production batches are tested by an independent laboratory. Where a report is available, it is published here in full — the same document we receive, not a summary of it.",
  },
  {
    title: "Batch-level traceability",
    body: "Documentation is filed per batch rather than per product, so a report always corresponds to a specific production run and its own testing date.",
  },
  {
    title: "Nothing is claimed without a document",
    body: "Purity and identity results are shown only where a report records them. A product with no published report is marked Documentation Pending rather than given a placeholder figure.",
  },
];

export function CoaTestingDisclosure({ hasPublishedRecords }: { hasPublishedRecords: boolean }) {
  return (
    <section
      aria-labelledby="about-our-testing"
      className="border-t border-white/[0.06] bg-[#0c0c0c]"
    >
      <div className="mx-auto max-w-[1180px] px-5 py-16 sm:px-6 sm:py-20 lg:px-10">
        <div className="max-w-2xl">
          <p className="vl2-eyebrow">Transparency</p>
          <h2 id="about-our-testing" className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">
            About our testing
          </h2>
        </div>

        <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((point) => (
            <div key={point.title}>
              <h3 className="text-[15px] font-semibold text-white">{point.title}</h3>
              <p className="mt-2.5 text-[13px] leading-6 text-white/45">{point.body}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 border-t border-white/[0.06] pt-8">
          <p className="max-w-3xl text-[13px] leading-6 text-white/40">
            {hasPublishedRecords
              ? "Additional batch records are added as testing is completed. To protect commercial relationships, manufacturing and laboratory partner details are not published beyond what appears on each report."
              : "Batch-specific reports are being prepared and will appear here as they are released. To protect commercial relationships, manufacturing partner details are not published."}{" "}
            Researching a specific batch and can&apos;t find it?{" "}
            <Link
              href="/contact"
              className="vl-focus-ring rounded text-[color:var(--accent-gold)] underline-offset-4 transition hover:text-[color:var(--accent-gold-strong)] hover:underline"
            >
              Contact our team
            </Link>{" "}
            and we&apos;ll provide the documentation available for it.
          </p>

          <p className="mt-6 text-[11px] leading-5 text-white/25">
            All Vanta Labs compounds are supplied strictly for laboratory research use. Not for human
            or veterinary use.
          </p>
        </div>
      </div>
    </section>
  );
}
