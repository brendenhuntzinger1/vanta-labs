import Link from "next/link";
import { TrustBadge } from "@/components/trust-badge";

const FOOTER_COLUMNS = {
  shop: [
    { label: "All Products", href: "/products" },
    { label: "COA Library", href: "/coa-library" },
    { label: "Cart", href: "/cart" },
  ],
  company: [
    { label: "Contact", href: "/contact" },
    { label: "Partner Program", href: "/partner" },
    { label: "Ambassador", href: "/ambassador" },
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
      <p className="vl-eyebrow text-[11px] text-zinc-500">{title}</p>
      <ul className="mt-4 space-y-3">
        {links.map((link) => (
          <li key={link.label}>
            {link.href.startsWith("mailto:") ? (
              <a href={link.href} className="text-sm text-zinc-300/80 transition hover:text-white">
                {link.label}
              </a>
            ) : (
              <Link href={link.href} className="text-sm text-zinc-300/80 transition hover:text-white">
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
    <footer className="relative border-t border-white/10 bg-[linear-gradient(180deg,rgba(18,18,18,0.86),rgba(8,8,8,0.98))]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />

      <div className="border-b border-white/8">
        <div className="mx-auto grid max-w-7xl gap-3 px-4 py-6 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
          <TrustBadge icon="flask" label="Lab-Verified" detail="Third-party batch testing" />
          <TrustBadge icon="check" label="COA Documented" detail="Certificate per lot" />
          <TrustBadge icon="shield" label="Encrypted Checkout" detail="Secure order handling" />
          <TrustBadge icon="truck" label="Fast Dispatch" detail="Tracked, discreet shipping" />
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div>
            <p className="vl-display text-sm font-semibold tracking-[0.3em] text-white">Vanta Labs</p>
            <p className="mt-4 max-w-md text-sm leading-7 text-zinc-300/85">
              Premium biotech research supply with verified quality standards, transparent batch documentation,
              and streamlined fulfillment.
            </p>
            <div className="mt-6 inline-flex items-center rounded-full border border-white/30 bg-white/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-zinc-100">
              Research Use Only
            </div>
          </div>

          <FooterColumn title="Shop" links={FOOTER_COLUMNS.shop} />
          <FooterColumn title="Company" links={FOOTER_COLUMNS.company} />
          <FooterColumn title="Legal" links={FOOTER_COLUMNS.legal} />
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Support{" "}
            <a href="mailto:support@vantalabsresearch.com" className="text-zinc-300 transition hover:text-white">
              support@vantalabsresearch.com
            </a>
          </p>
          <p>© 2026 Vanta Labs. All Rights Reserved.</p>
        </div>
      </div>
    </footer>
  );
}
