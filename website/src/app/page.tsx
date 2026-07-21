import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ProductCard } from "@/components/product-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { getHomepageControlConfig } from "@/lib/admin-control";
import { getCatalogProducts } from "@/lib/catalog";

export const dynamic = "force-dynamic";

const TRUST_POINTS = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M9 2h6M10 2v6.2a2 2 0 0 1-.34 1.12L4.9 17.2A2.4 2.4 0 0 0 6.9 21h10.2a2.4 2.4 0 0 0 2-3.8l-4.76-7.88A2 2 0 0 1 14 8.2V2" />
      </svg>
    ),
    label: "USA Sourced",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.4 2.4L16 9.6" />
      </svg>
    ),
    label: "99%+ Purity",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M2 8h11v8H2z" />
        <path d="M13 11h4l4 3v2h-8z" />
        <circle cx="6.5" cy="18.5" r="1.6" />
        <circle cx="17" cy="18.5" r="1.6" />
      </svg>
    ),
    label: "Fast Shipping",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
    label: "Third-Party Batch Verified",
  },
];

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
  // getCatalogProducts (unlike getHomepageControlConfig) has no internal
  // error handling - a Supabase outage shouldn't take down the whole
  // homepage (hero, nav, FAQ) just because the catalog fetch failed.
  const catalogProducts = await getCatalogProducts().catch(() => []);

  const featuredForHome = control.featuredProductSlugs?.length
    ? catalogProducts.filter((product) => control.featuredProductSlugs?.includes(product.slug))
    : catalogProducts;

  const categories = Array.from(new Set(catalogProducts.map((product) => product.category))).slice(0, 4);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <section className="vl2-hero">
        <video
          className="vl2-hero-video"
          src="/videos/vanta-labs-hero.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
        />
        <div className="vl2-hero-scrim" aria-hidden="true" />

        <div className="vl2-hero-content mx-auto w-full max-w-[1440px] px-6 pb-20 pt-40 lg:px-12 lg:pb-28">
          <div className="vl2-fade-in">
            <p className="vl2-eyebrow">Research Use Only</p>
            <h1 className="vl2-serif mt-5 max-w-2xl text-5xl leading-[1.04] text-white sm:text-6xl lg:text-7xl">
              {control.heroHeadline ?? "Precision, in every vial."}
            </h1>
            <p className="mt-6 max-w-md text-sm leading-7 text-white/70 sm:text-base">
              {control.heroSubheadline ?? "Vanta Labs sources, verifies, and ships research compounds with the discipline of a clinical laboratory."}
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link href="/products" className="vl2-btn-primary vl-focus-ring px-7 py-3.5">
                Shop the catalog
              </Link>
              <Link href="/coa-library" className="vl2-btn-secondary vl-focus-ring px-7 py-3.5">
                View Certificates of Analysis
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 py-14">
        <div className="mx-auto max-w-[1440px] px-6 lg:px-12">
          <ScrollReveal>
            <div className="vl2-trust-row justify-center">
              {TRUST_POINTS.map((point) => (
                <div key={point.label} className="flex items-center gap-2.5 text-white/60">
                  <span aria-hidden="true">{point.icon}</span>
                  <span className="text-[0.72rem] font-medium uppercase tracking-[0.14em]">{point.label}</span>
                </div>
              ))}
            </div>
          </ScrollReveal>
        </div>
      </section>

      {categories.length > 0 ? (
        <section className="border-t border-white/10 py-20">
          <div className="mx-auto max-w-[1440px] px-6 lg:px-12">
            <ScrollReveal>
              <p className="vl2-eyebrow">Catalog</p>
              <h2 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Browse by category</h2>
            </ScrollReveal>
            <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {categories.map((category, index) => (
                <ScrollReveal key={category} delayMs={index * 70}>
                  <Link
                    href={`/products?category=${encodeURIComponent(category)}`}
                    className="vl2-product-card vl-focus-ring flex h-full flex-col justify-between p-6"
                  >
                    <p className="text-base text-white">{category}</p>
                    <span className="mt-6 inline-flex items-center gap-1.5 text-[0.68rem] uppercase tracking-[0.16em] text-white/45">
                      Explore
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
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

      <section className="border-t border-white/10 py-20">
        <div className="mx-auto max-w-[1440px] px-6 lg:px-12">
          <ScrollReveal>
            <div className="mb-10 flex items-end justify-between gap-4">
              <div>
                <p className="vl2-eyebrow">Selection</p>
                <h2 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Most requested compounds</h2>
              </div>
              <Link href="/products" className="text-xs uppercase tracking-[0.14em] text-white/55 transition hover:text-white">
                Full catalog →
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
            <div className="vl2-glass p-6 text-sm text-white/60">
              Featured products will appear here once published in the live catalog.
            </div>
          )}
        </div>
      </section>

      <section className="border-t border-white/10 py-20">
        <div className="mx-auto max-w-[1440px] px-6 lg:px-12">
          <ScrollReveal>
            <div className="mb-10 max-w-2xl">
              <p className="vl2-eyebrow">Standards</p>
              <h2 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Built around trust and performance</h2>
            </div>
          </ScrollReveal>

          <div className="grid gap-px overflow-hidden border border-white/10 md:grid-cols-3">
            {BRAND_PILLARS.map((pillar, index) => (
              <ScrollReveal key={pillar.title} delayMs={index * 90}>
                <article className="h-full bg-[#0b0b0b] p-7">
                  <h3 className="vl2-serif text-xl text-white">{pillar.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-white/60">{pillar.detail}</p>
                </article>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 py-20">
        <div className="mx-auto max-w-3xl px-6 lg:px-12">
          <ScrollReveal>
            <div className="mb-10 text-center">
              <p className="vl2-eyebrow">FAQ</p>
              <h2 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Before you order</h2>
            </div>
          </ScrollReveal>
          <div className="space-y-px border border-white/10">
            {FAQ.map((entry) => (
              <details key={entry.q} className="group bg-[#0b0b0b] p-5" open={entry.q === FAQ[0].q}>
                <summary className="cursor-pointer list-none text-sm font-medium text-white marker:hidden">{entry.q}</summary>
                <p className="mt-3 text-sm leading-7 text-white/60">{entry.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
