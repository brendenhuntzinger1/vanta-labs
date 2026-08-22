import Link from "next/link";
import { TRUST_POINTS } from "@/lib/trust-claims";

const FOOTER_COLUMNS = {
  shop: [
    { label: "All Products", href: "/products" },
    { label: "COA Library", href: "/coa-library" },
    { label: "Cart", href: "/cart" },
  ],
  company: [
    { label: "Contact", href: "/contact" },
    { label: "Wholesale", href: "/wholesale" },
    { label: "Partner Program", href: "/partner" },
    { label: "Ambassador", href: "/ambassador" },
  ],
  legal: [
    { label: "Research Disclaimer", href: "/legal/research-disclaimer" },
    { label: "Privacy Policy", href: "/legal/privacy" },
    { label: "Terms of Service", href: "/legal/terms" },
    { label: "Shipping Policy", href: "/legal/shipping" },
    { label: "Return & Refund", href: "/legal/refund" },
    { label: "Cookie Policy", href: "/legal/cookies" },
  ],
};

// Single source of truth — see src/lib/trust-claims.ts for each claim's provenance.

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: Array<{ label: string; href: string }>;
}) {
  return (
    <div>
      <p className="vl2-eyebrow">{title}</p>
      <ul className="mt-4 space-y-3">
        {links.map((link) => (
          <li key={link.label}>
            {/* inline-flex + min-h-6 gives every footer link a 24px tap target
                (WCAG 2.2 AA 2.5.8) without moving the text: at text-sm the link
                box was 19px tall, which is a fiddly thing to hit on a phone and
                there are a dozen of them on every page. The label stays
                vertically centred, so only the hit area grows. */}
            {link.href.startsWith("mailto:") ? (
              <a href={link.href} className="inline-flex min-h-6 items-center text-sm text-white/55 transition hover:text-white">
                {link.label}
              </a>
            ) : (
              <Link href={link.href} className="inline-flex min-h-6 items-center text-sm text-white/55 transition hover:text-white">
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#0b0b0b]">
      <div className="border-b border-white/10">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-center gap-2.5 px-4 py-5 sm:gap-3 sm:px-6 sm:py-6 lg:px-12">
          {TRUST_POINTS.map((point) => (
            <span key={point} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[0.66rem] font-medium uppercase tracking-[0.14em] text-white/55">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-emerald-300/80"><path d="m5 12 4 4 10-10" /></svg>
              {point}
            </span>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-5 sm:px-6 py-12 sm:py-14 lg:px-12">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div className="col-span-2 md:col-span-1">
            <p className="vl2-serif text-lg tracking-[0.08em] text-white">Vanta Labs</p>
            <p className="mt-4 max-w-md text-sm leading-7 text-white/55">
              Premium biotech research supply with verified quality standards, transparent batch documentation,
              and streamlined fulfillment.
            </p>
            <div className="mt-6 inline-flex items-center rounded-full border border-white/15 bg-white/[0.03] px-3.5 py-1.5 text-[11px] uppercase tracking-[0.18em] text-white/70">
              Research Use Only
            </div>
          </div>

          <FooterColumn title="Shop" links={FOOTER_COLUMNS.shop} />
          <FooterColumn title="Company" links={FOOTER_COLUMNS.company} />
          <FooterColumn title="Legal" links={FOOTER_COLUMNS.legal} />
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-white/70 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Support{" "}
            {/* Same 24px floor. This is the support address — the one link a
                frustrated customer reaches for — and it sat 17px tall. */}
            <a href="mailto:support@vantalabsresearch.com" className="inline-flex min-h-6 items-center text-white/70 underline-offset-4 transition hover:text-white hover:underline">
              support@vantalabsresearch.com
            </a>
          </p>
          <p className="text-white/45">© 2026 Vanta Labs. All Rights Reserved.</p>
        </div>
      </div>
    </footer>
  );
}
