import Link from "next/link";

// Owner-authored notice, and the FIRST thing shown on every COA surface (the
// COA Library page and the product page's COA tab). Copy lives here once so the
// two can never drift apart.
//
// Structured rather than run as one block of prose: the reassuring fact leads
// (independent third-party testing, US-based partner), the confidentiality note
// sits quietly beneath it, and the ask — contact us BEFORE ordering — is lifted
// into its own panel so it reads as an offer rather than fine print.
export function CoaLibraryNotice({ className = "" }: { className?: string }) {
  return (
    <section
      aria-labelledby="coa-library-notice-heading"
      className={`overflow-hidden rounded-2xl border border-[color:var(--accent-gold)]/20 bg-[#141414] ${className}`}
    >
      <div className="p-5 sm:p-7">
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

        {/* Lead with the fact that answers "is this tested?" — brighter and a
            step larger than the supporting copy, so it lands first. */}
        <p className="mt-4 text-[15px] leading-relaxed text-white">
          Current Vanta Labs inventory is sourced from production batches that undergo independent
          third-party testing through one of our trusted U.S.-based manufacturing partners.
        </p>

        <p className="mt-3 text-sm leading-relaxed text-[#a3a3a3]">
          To protect supplier relationships, partner information is not publicly disclosed. Vanta
          Labs-branded, batch-specific COAs are currently being prepared and will be added to this
          library as they become available.
        </p>
      </div>

      {/* The ask, lifted out of the prose so it reads as an offer rather than a
          disclaimer — this is the line that should reach someone about to buy. */}
      <div className="border-t border-[color:var(--accent-gold)]/15 bg-[color:var(--accent-gold)]/[0.04] p-5 sm:p-7">
        <p className="text-sm leading-relaxed text-[#d4d4d4]">
          Have questions about product quality, testing, or batch documentation?{" "}
          <span className="text-white">Contact our support team before ordering.</span> We&apos;re happy
          to provide available third-party testing documentation for the production batches supplying
          our current inventory, and to answer any questions you may have.
        </p>

        <Link
          href="/contact"
          className="vl2-btn-secondary vl-focus-ring mt-4 inline-flex items-center gap-2 px-5 py-2.5 text-xs"
        >
          Contact support
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </Link>
      </div>
    </section>
  );
}
