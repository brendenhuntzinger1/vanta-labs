import Link from "next/link";

// Owner-authored notice shown at the top of every COA surface (the COA Library
// page and the product page's COA tab). Copy lives here once so the two can
// never drift apart.
export function CoaLibraryNotice({ className = "" }: { className?: string }) {
  return (
    <section
      aria-labelledby="coa-library-notice-heading"
      className={`rounded-2xl border border-[color:var(--accent-gold)]/20 bg-[#141414] p-5 sm:p-7 ${className}`}
    >
      <div className="flex items-center gap-2.5">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent-gold)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 flex-shrink-0"
          aria-hidden
        >
          <path d="M9 3h6M10 3v5.2a2 2 0 0 1-.3 1.05L5 17.2A2.2 2.2 0 0 0 6.9 20.5h10.2a2.2 2.2 0 0 0 1.9-3.3l-4.7-7.95A2 2 0 0 1 14 8.2V3" />
        </svg>
        <h2
          id="coa-library-notice-heading"
          className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--accent-gold)]"
        >
          COA Library
        </h2>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-[#a3a3a3]">
        Batch-specific Certificates of Analysis (COAs) are currently being updated for Vanta Labs. As new
        production lots complete independent testing, Vanta Labs-branded COAs will be added to our COA library.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-[#a3a3a3]">
        If you have any questions or would like additional information regarding batch testing, please{" "}
        <Link
          href="/contact"
          className="vl-focus-ring rounded text-white underline decoration-[color:var(--accent-gold)]/50 underline-offset-4 transition hover:decoration-[color:var(--accent-gold)]"
        >
          contact our support team
        </Link>
        . We&apos;re happy to assist.
      </p>
    </section>
  );
}
