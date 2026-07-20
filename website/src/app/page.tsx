import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { ProductCard } from "@/components/product-card";
import { TrustBadge } from "@/components/trust-badge";
import { ScrollReveal } from "@/components/scroll-reveal";
import { getHomepageControlConfig } from "@/lib/admin-control";
import { getCatalogProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";

const BRAND_PILLARS = [
  {
    title: "Analytical Precision",
    detail: "Every batch is screened with calibrated instrumentation and archived reports.",
  },
  {
    title: "Transparent Documentation",
    detail: "Product lots are mapped to structured quality documents and purity records.",
  },
  {
    title: "Operational Reliability",
    detail: "Rapid processing, careful packaging, and secure, tracked shipment workflows.",
  },
];

const FAQ = [
  {
    q: "How do you verify quality?",
    a: "Each lot is linked to a Certificate of Analysis and tracked through internal QC checkpoints before release.",
  },
  {
    q: "How quickly are orders processed?",
    a: "Most in-stock orders are prepared within one business day, with secure tracking sent after dispatch.",
  },
  {
    q: "Can I review COAs before ordering?",
    a: "Yes. Browse our COA library to inspect report metadata before adding products to your cart.",
  },
];

export default async function HomePage() {
  const control = await getHomepageControlConfig();
  const catalogProducts = await getCatalogProducts();
  const enabledPromoLabels = [
    control.promoBuy3Get1Enabled ? "Buy 3 Get 1 Free" : null,
    control.promoBuy2Get1HalfEnabled ? "Buy 2 Get 1 (50% Off)" : null,
  ].filter((value): value is string => Boolean(value));

  const tickerBase = control.promoTickerItems?.length
    ? control.promoTickerItems
    : ["USA Sourced", "99%+ Purity", "Fast Shipping", "Third-Party Batch Verified"];

  const tickerItems = Array.from(new Set([...enabledPromoLabels, ...tickerBase]));

  const promoBase = control.promoPills?.length
    ? control.promoPills
    : ["USA Sourced", "99%+ Purity", "Fast Shipping"];
  const promoPills = Array.from(new Set([...enabledPromoLabels, ...promoBase]));

  const featuredForHome = control.featuredProductSlugs?.length
    ? catalogProducts.filter((product) => control.featuredProductSlugs?.includes(product.slug))
    : catalogProducts;

  const categories = Array.from(new Set(catalogProducts.map((product) => product.category))).slice(0, 4);

  return (
    <div className="vl-page-shell min-h-screen text-zinc-100">
      <SiteHeader />

      <main>
        <section className="border-b border-white/15 bg-[linear-gradient(90deg,rgba(255,255,255,0.08),rgba(255,255,255,0.14),rgba(255,255,255,0.08))]">
          <div className="mx-auto max-w-7xl overflow-hidden px-4 sm:px-6 lg:px-8">
            <div className="vl-ticker flex w-max items-center gap-12 py-3 text-sm font-black uppercase tracking-[0.18em] text-zinc-100 sm:text-base">
              {[...tickerItems, ...tickerItems].map((item, index) => (
                <span key={`${item}-${index}`} className="inline-flex items-center gap-3 whitespace-nowrap">
                  {item}
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-gold)]" />
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden border-b border-white/10">
          <div className="pointer-events-none absolute inset-0">
            <div className="vl-orb -left-24 top-20 h-72 w-72 bg-white/12" />
            <div className="vl-orb right-[-5rem] top-10 h-80 w-80 bg-white/12" />
            <div className="vl-orb bottom-[-9rem] left-[38%] h-64 w-64 bg-zinc-200/10" />
          </div>
          <div className="vl-ambient-layer" aria-hidden="true">
            <span className="vl-galaxy-cloud vl-galaxy-a" />
            <span className="vl-galaxy-cloud vl-galaxy-b" />
            <span className="vl-light-ray vl-light-ray-a" />
            <span className="vl-light-ray vl-light-ray-b" />
            <span className="vl-reflection-sheen" />
            <span className="vl-hero-molecule vl-hero-molecule-a" />
            <span className="vl-hero-molecule vl-hero-molecule-b" />
            <span className="vl-hero-molecule vl-hero-molecule-c" />
            <span className="vl-hero-molecule vl-hero-molecule-d" />
            <span className="vl-hero-particle vl-hero-particle-a" />
            <span className="vl-hero-particle vl-hero-particle-b" />
            <span className="vl-hero-particle vl-hero-particle-c" />
            <span className="vl-hero-particle vl-hero-particle-d" />
            <span className="vl-hero-particle vl-hero-particle-e" />
            <span className="vl-hero-particle vl-hero-particle-f" />
          </div>

          <div className="relative mx-auto max-w-7xl px-4 pb-20 pt-16 sm:px-6 sm:pt-20 lg:px-8 lg:pb-24 lg:pt-24">
            <div className="grid items-center gap-10 lg:grid-cols-[1.04fr_0.96fr]">
              <div className="vl-hero-frame p-6 sm:p-8 lg:p-10">
                <p className="vl-eyebrow text-[11px]">{control.heroKicker ?? "Premium Biotech Platform"}</p>
                <h1 className="vl-display mt-5 max-w-3xl text-5xl font-semibold leading-[0.96] text-white sm:text-7xl lg:text-8xl">
                  <span className="vl-gradient-text">{control.heroHeadline ?? "Premium Research Compounds."}</span>
                </h1>
                <div className="mt-6 grid max-w-3xl gap-3 sm:grid-cols-3">
                  {promoPills.map((item) => (
                    <div
                      key={item}
                      className="rounded-xl border border-white/35 bg-white/10 px-4 py-3 text-center text-base font-black uppercase tracking-[0.14em] text-zinc-50 sm:text-lg"
                    >
                      {item}
                    </div>
                  ))}
                </div>
                <p className="vl-lux-kicker mt-4 text-xs text-white/85 sm:text-sm">
                  Florida&apos;s leading source for verified research compounds
                </p>
                <p className="vl-copy mt-6 max-w-2xl text-base leading-8 text-zinc-300 sm:text-lg">{control.heroSubheadline ?? "Vanta Labs combines rigorous quality documentation with an elevated digital buying experience. Browse premium inventory, review verified reports, and complete secure checkout in minutes."}</p>
                <div className="mt-9 flex flex-wrap gap-3">
                  <Link href="/products" className="vl-btn-primary vl-focus-ring px-7 py-3 text-sm">
                    Shop Products
                  </Link>
                  <Link href="/coa-library" className="vl-btn-secondary vl-focus-ring px-7 py-3 text-sm">
                    Browse COA Library
                  </Link>
                </div>

                <div className="mt-8 flex flex-wrap gap-3 border-t border-white/10 pt-6">
                  <TrustBadge icon="flask" label="Lab-Verified" />
                  <TrustBadge icon="shield" label="Secure Checkout" />
                  <TrustBadge icon="truck" label="Fast Dispatch" />
                </div>
              </div>

              <div className="vl-panel rounded-[2rem] p-6 sm:p-8">
                <p className="vl-eyebrow text-xs">Research Standards</p>
                <h3 className="vl-display mt-3 text-4xl font-semibold leading-[1.02] text-white sm:text-5xl">{control.qualityPanelTitle ?? "Built for Reliable Results"}</h3>
                <p className="vl-copy mt-4 text-sm leading-7 text-zinc-300 sm:text-base">
                  Every order is supported by documented quality controls, consistent fulfillment, and transparent reporting standards.
                </p>
                <div className="mt-6 grid gap-3">
                  {(control.qualityPanelItems?.length ? control.qualityPanelItems : [
                    "Third-party batch verification",
                    "COA documentation with each lot",
                    "Secure processing and rapid dispatch",
                  ]).map((item) => (
                    <div key={item} className="vl-copy rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-zinc-100">
                      {item}
                    </div>
                  ))}
                </div>
                <div className="mt-6">
                  <Link href="/coa-library" className="vl-btn-secondary vl-focus-ring inline-flex px-6 py-3 text-sm font-semibold">
                    View Quality Library
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {categories.length > 0 ? (
          <section className="border-b border-white/10 py-14 sm:py-16">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <ScrollReveal>
                <p className="vl-eyebrow text-[11px]">Shop By Category</p>
                <h2 className="vl-display mt-3 text-3xl font-semibold text-white sm:text-4xl">Browse the Catalog</h2>
              </ScrollReveal>
              <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {categories.map((category, index) => (
                  <ScrollReveal key={category} delayMs={index * 70}>
                    <Link
                      href={`/products?category=${encodeURIComponent(category)}`}
                      className="vl-panel vl-elevate-hover vl-focus-ring flex h-full flex-col justify-between rounded-2xl p-5"
                    >
                      <p className="text-lg font-semibold text-white">{category}</p>
                      <span className="mt-4 inline-flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] text-zinc-400">
                        Explore
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                          <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </Link>
                  </ScrollReveal>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section className="border-b border-white/10 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="mb-8 flex items-end justify-between gap-4 sm:mb-10">
                <div>
                  <p className="vl-eyebrow text-[11px]">Featured Selection</p>
                  <h2 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Most Requested Compounds</h2>
                </div>
                <Link href="/products" className="text-sm text-zinc-300 transition hover:text-white">
                  View Full Catalog →
                </Link>
              </div>
            </ScrollReveal>

            {featuredForHome.length > 0 ? (
              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {featuredForHome.slice(0, 6).map((product, index) => (
                  <ScrollReveal key={product.slug} delayMs={Math.min(index, 3) * 80}>
                    <ProductCard product={product} image={product.image} priority={index < 3} />
                  </ScrollReveal>
                ))}
              </div>
            ) : (
              <div className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
                Featured products will appear here once published in the live catalog.
              </div>
            )}
          </div>
        </section>

        <section className="border-b border-white/10 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="mb-8 max-w-3xl">
                <p className="vl-eyebrow text-[11px]">Platform Differentiators</p>
                <h2 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Built Around Trust and Performance</h2>
              </div>
            </ScrollReveal>

            <div className="grid gap-4 md:grid-cols-3">
              {BRAND_PILLARS.map((pillar, index) => (
                <ScrollReveal key={pillar.title} delayMs={index * 90}>
                  <article className="vl-panel h-full rounded-2xl p-6">
                    <h3 className="vl-display text-2xl font-semibold text-white">{pillar.title}</h3>
                    <p className="vl-copy mt-3 text-sm leading-7 text-zinc-300">{pillar.detail}</p>
                  </article>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16 sm:py-20">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <ScrollReveal>
              <div className="mb-8 text-center sm:mb-10">
                <p className="vl-eyebrow text-[11px]">FAQ</p>
                <h2 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Everything You Need Before Ordering</h2>
              </div>
            </ScrollReveal>
            <div className="space-y-3">
              {FAQ.map((entry) => (
                <details key={entry.q} className="vl-panel rounded-2xl p-5 open:border-white/40" open={entry.q === FAQ[0].q}>
                  <summary className="vl-copy cursor-pointer list-none text-base font-semibold text-white marker:hidden">{entry.q}</summary>
                  <p className="vl-copy mt-3 text-sm leading-7 text-zinc-300">{entry.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
