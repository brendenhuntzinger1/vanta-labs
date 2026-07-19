import Link from "next/link";

const FOOTER_COLUMNS = {
  products: [
    { label: "All Products", href: "/products" },
    { label: "COA Library", href: "/coa-library" },
    { label: "Checkout", href: "/checkout" },
  ],
  company: [
    { label: "Partner Program", href: "/partner" },
    { label: "Ambassador", href: "/ambassador" },
    { label: "Contact", href: "mailto:hello@vantalabs.com" },
  ],
  legal: [
    { label: "Research Disclaimer", href: "#" },
    { label: "Privacy Policy", href: "#" },
    { label: "Terms", href: "#" },
  ],
};

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: Array<{ label: string; href: string }>;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-400">{title}</p>
      <ul className="mt-4 space-y-3">
        {links.map((link) => (
          <li key={link.label}>
            <Link href={link.href} className="text-sm text-zinc-300/80 transition hover:text-white">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="relative border-t border-white/10 bg-[linear-gradient(180deg,rgba(18,18,18,0.86),rgba(8,8,8,0.98))]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div>
            <p className="vl-display text-sm font-semibold tracking-[0.3em] text-white">VANTA LABS</p>
            <p className="mt-4 max-w-md text-sm leading-7 text-zinc-300/85">
              Premium biotech research supply with verified quality standards, transparent batch documentation,
              and streamlined fulfillment.
            </p>
            <div className="mt-6 inline-flex items-center rounded-full border border-white/30 bg-white/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-100">
              Research Use Only
            </div>
          </div>

          <FooterColumn title="Products" links={FOOTER_COLUMNS.products} />
          <FooterColumn title="Company" links={FOOTER_COLUMNS.company} />
          <FooterColumn title="Legal" links={FOOTER_COLUMNS.legal} />
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Vanta Labs. All rights reserved.</p>
          <p>Built for modern biotech commerce.</p>
        </div>
      </div>
    </footer>
  );
}
