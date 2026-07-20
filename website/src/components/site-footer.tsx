import Link from "next/link";

const FOOTER_COLUMNS = {
  shop: [
    { label: "All Products", href: "/products" },
    { label: "COA Library", href: "/coa-library" },
    { label: "Cart", href: "/cart" },
  ],
  company: [
    { label: "Contact", href: "/contact" },
    { label: "Research Library", href: "/research" },
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

const TRUST_POINTS = ["Lab-Verified", "COA Documented", "Encrypted Checkout", "Fast Dispatch"];

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
            {link.href.startsWith("mailto:") ? (
              <a href={link.href} className="text-sm text-white/55 transition hover:text-white">
                {link.label}
              </a>
            ) : (
              <Link href={link.href} className="text-sm text-white/55 transition hover:text-white">
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
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-center gap-x-8 gap-y-3 px-6 py-6 lg:px-12">
          {TRUST_POINTS.map((point) => (
            <span key={point} className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-white/45">
              {point}
            </span>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-6 py-14 lg:px-12">
        <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div>
            <p className="vl2-serif text-lg tracking-[0.08em] text-white">Vanta Labs</p>
            <p className="mt-4 max-w-md text-sm leading-7 text-white/55">
              Premium biotech research supply with verified quality standards, transparent batch documentation,
              and streamlined fulfillment.
            </p>
            <div className="mt-6 inline-flex items-center border border-white/20 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-white/70">
              Research Use Only
            </div>
          </div>

          <FooterColumn title="Shop" links={FOOTER_COLUMNS.shop} />
          <FooterColumn title="Company" links={FOOTER_COLUMNS.company} />
          <FooterColumn title="Legal" links={FOOTER_COLUMNS.legal} />
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-white/40 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Support{" "}
            <a href="mailto:brendenhuntzinger1@vantalabsresearch.com" className="text-white/60 transition hover:text-white">
              brendenhuntzinger1@vantalabsresearch.com
            </a>
          </p>
          <p>© 2026 Vanta Labs. All Rights Reserved.</p>
        </div>
      </div>
    </footer>
  );
}
