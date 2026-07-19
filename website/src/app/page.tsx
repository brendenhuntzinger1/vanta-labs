import Link from "next/link";
import Image from "next/image";
import { SiteHeader } from "@/components/site-header";
import { products as featuredProducts } from "@/lib/demo-data";
import { getHomepageControlConfig } from "@/lib/admin-control";

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

function ProductCard({
  name,
  price,
  image,
  slug,
  description,
}: {
  name: string;
  price: string;
  image: string;
  slug: string;
  description: string;
}) {
  return (
    <article className="vl-panel vl-elevate-hover group overflow-hidden rounded-[1.65rem]">
      <Link href={`/products/${slug}`} className="block">
        <div className="relative h-60 overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_40%_10%,rgba(186,230,253,0.2),transparent_60%)]">
          <Image
            src={image}
            alt={name}
            fill
            sizes="(max-width: 1024px) 100vw, 33vw"
            className="object-contain p-8 transition duration-500 group-hover:scale-105"
          />
        </div>
        <div className="p-6">
          <p className="vl-lux-kicker text-[11px] text-zinc-500">Flagship Compound</p>
          <h3 className="vl-display mt-2 text-2xl font-semibold text-white">{name}</h3>
          <p className="vl-copy mt-2 line-clamp-2 text-sm leading-7 text-zinc-300">{description}</p>
          <div className="mt-4 flex items-center justify-between">
            <p className="vl-copy text-base font-semibold text-zinc-100">{price}</p>
            <span className="vl-lux-kicker text-xs text-zinc-400 transition group-hover:text-white">View</span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export default async function HomePage() {
  const control = await getHomepageControlConfig();
  const tickerItems = control.promoTickerItems?.length
    ? control.promoTickerItems
    : ["Buy 3 Get 1 Free", "USA Sourced", "99%+ Purity", "Fast Shipping", "Third-Party Batch Verified"];
  const promoPills = control.promoPills?.length
    ? control.promoPills
    : ["USA Sourced", "99%+ Purity", "Fast Shipping"];
  const featuredForHome = control.featuredProductSlugs?.length
    ? featuredProducts.filter((product) => control.featuredProductSlugs?.includes(product.slug))
    : featuredProducts;

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
                  <span className="h-1.5 w-1.5 rounded-full bg-white/80" />
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
                <p className="vl-lux-kicker text-[11px] text-white/80">{control.heroKicker ?? "Premium Biotech Platform"}</p>
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
              </div>

              <div className="vl-panel rounded-[2rem] p-6 sm:p-8">
                <p className="vl-lux-kicker text-xs text-white/80">Research Standards</p>
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

        <section className="border-b border-white/10 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-8 flex items-end justify-between gap-4 sm:mb-10">
              <div>
                <p className="vl-lux-kicker text-[11px] text-zinc-500">Featured Selection</p>
                <h2 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Most Requested Compounds</h2>
              </div>
              <Link href="/products" className="text-sm text-zinc-300 transition hover:text-white">
                View Full Catalog →
              </Link>
            </div>

            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {featuredForHome.slice(0, 6).map((product) => (
                <ProductCard
                  key={product.slug}
                  name={product.name}
                  price={product.price}
                  image={product.image}
                  slug={product.slug}
                  description={product.description}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-white/10 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-8 max-w-3xl">
              <p className="vl-lux-kicker text-[11px] text-zinc-500">Platform Differentiators</p>
              <h2 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Built Around Trust and Performance</h2>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {BRAND_PILLARS.map((pillar) => (
                <article key={pillar.title} className="vl-panel rounded-2xl p-6">
                  <h3 className="vl-display text-2xl font-semibold text-white">{pillar.title}</h3>
                  <p className="vl-copy mt-3 text-sm leading-7 text-zinc-300">{pillar.detail}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16 sm:py-20">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <div className="mb-8 text-center sm:mb-10">
              <p className="vl-lux-kicker text-[11px] text-zinc-500">FAQ</p>
              <h2 className="vl-display mt-3 text-4xl font-semibold text-white sm:text-5xl">Everything You Need Before Ordering</h2>
            </div>
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
