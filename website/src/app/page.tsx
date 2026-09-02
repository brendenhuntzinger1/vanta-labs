import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { HeroVideo } from "@/components/hero-video";
import { ProductCard } from "@/components/product-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { getHomepageControlConfig } from "@/lib/admin-control";
import { getCatalogProducts } from "@/lib/catalog";
import { COA_SHORT, trustPoints } from "@/lib/trust-claims";
import { BRAND_LEGAL_NAME } from "@/lib/site-identity";

export const dynamic = "force-dynamic";

// Ads append their own tracking parameters to the landing URL. Without a
// canonical, each variant is a separate page competing with the real one.
// This lived on the root layout until it was found to be leaking onto every
// other route's <head> — see the note there.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * The hero pill row. These rest on the owner attestation recorded in
 * trust-claims.ts's TESTING block. The COA line that used to sit alongside them
 * asserted that documents EXIST, which ledger finding F-006 disproved, so it is
 * appended from the evidence gate at the render site instead of typed here.
 */
const HERO_ATTESTATIONS = ["Third-party tested", "99%+ purity", "Ships from the USA"] as const;

const TESTING_PROOFS = [
  {
    title: "Independently verified",
    detail: "Tested by a third-party lab. We don't grade our own work.",
  },
  {
    title: "≥99% purity by HPLC",
    detail: "Confirmed on every batch before it ships.",
  },
  {
    title: "Identity by mass spec",
    detail: "The exact compound and molecular weight of every lot.",
  },
  {
    title: "Batch-to-COA mapping",
    detail: "Each vial's batch number links to its Certificate of Analysis.",
  },
];

const FAQ = [
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
    <div className="min-h-screen bg-[#0f0f0f] text-white">
      <SiteHeaderV2 />
      <main>

      <section className="vl2-hero">
        <HeroVideo className="vl2-hero-video" src="/videos/vanta-labs-hero-opt.mp4" />
        <div className="vl2-hero-scrim" aria-hidden="true" />

        {/* The content block is bottom-anchored over a full-height video, so
            bottom padding is what sets how high it rides. Kept low on larger
            screens deliberately: the vial is the centre of the shot and the
            CTA cluster was sitting across it. Mobile keeps its original
            padding -- there the block is nearly full-width and dropping it
            further would crowd the scroll cue. */}
        <div className="vl2-hero-content mx-auto w-full max-w-[1440px] px-4 sm:px-6 pb-12 pt-28 sm:pb-12 sm:pt-40 lg:px-12 lg:pb-14">
          {/* vl2-hero-enter, NOT vl2-fade-in: the headline below is this page's
              LCP element and must not be held at opacity:0 while it animates.
              See the rule in globals.css for the measurement. */}
          <div className="vl2-hero-enter">
            {/* THE HERO PROMO PILL WAS REMOVED, AND IT WAS THREE PROBLEMS.
                It read "🎁 Buy 3 Get 1 Free — Limited Time" in amber, gated on
                the same `promoBuy3Get1Enabled` flag the offers bar now reads.

                  1. It was a SECOND promotion surface for the SAME promotion,
                     and on the home page both were above the fold at once —
                     the duplicate-on-one-viewport case this feature exists to
                     end.
                  2. "Limited Time" was not backed by anything. Buy 3 Get 1 is
                     an admin toggle with no end date, so the urgency was
                     manufactured.
                  3. An emoji in an amber pill is the discount-store look the
                     brand is defined against.

                The promotion is still advertised — accurately, once, at the
                top, by StorefrontOffersBar, which states the real terms and
                says it applies automatically. */}
            <p className="vl2-eyebrow">Research Use Only</p>
            {/* THE ENTITY NAME IS PART OF THE H1, NOT JUST THE <title>.
                
                The h1 was "Precision, in every vial." alone — a tagline with no
                brand in it. On the one query this page has to win, its most
                heavily weighted piece of on-page text named the company nowhere,
                while two other peptide vendors with near-identical names put
                "Vanta Labs" straight in their titles and outrank it.

                Rendered as two lines inside ONE h1 rather than as a separate
                element above it, because the signal comes from the h1's text
                content: split the brand into its own <p> and the h1 goes back to
                being a brand-less tagline. Visual hierarchy is unchanged — the
                tagline keeps every size class it had and stays the thing the eye
                lands on; the brand sits above it in the same serif at reading
                size, which is also why it is not styled like the uppercase
                eyebrow directly above (two stacked eyebrow lines read as a
                mistake).

                Deliberately OUTSIDE control.heroHeadline. That field is how the
                hero copy gets reworded from the admin screen, and rewording the
                hero is what removed the brand from this page in the first place.
                The tagline stays editable; the entity name is not something a
                copy tweak can drop by accident again. It comes from
                BRAND_LEGAL_NAME so it cannot drift from the schema or title. */}
            <h1 className="vl2-serif mt-5 max-w-2xl text-white">
              <span className="block text-[1.35rem] leading-tight text-white/65 sm:text-2xl md:text-[1.75rem]">
                {BRAND_LEGAL_NAME}
              </span>
              <span className="mt-1.5 block text-[2.6rem] leading-[1.04] tracking-[-0.01em] sm:mt-2 sm:text-5xl md:text-6xl lg:text-7xl">
                {control.heroHeadline ?? "Precision, in every vial."}
              </span>
            </h1>
            <p className="mt-4 max-w-md text-[0.95rem] leading-7 text-white/75 sm:mt-6 sm:text-lg sm:leading-8">
              {control.heroSubheadline ?? "Research compounds, sourced and verified with the discipline of an analytical laboratory."}
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:mt-9 sm:flex-row sm:items-center">
              <Link href="/products" className="vl2-btn-primary vl-focus-ring w-full px-8 py-4 text-sm sm:w-auto">
                Shop the catalog
              </Link>
              <Link href="/membership" className="vl2-btn-secondary vl-focus-ring w-full px-8 py-4 text-sm sm:w-auto">
                Explore membership
              </Link>
            </div>

            {/* Inline trust strip — factual claims only, right under the CTA so
                purchase confidence lands before the fold on mobile.

                SET AS ONE LINE OF TEXT, NOT A ROW OF TICKS. Each claim used to
                carry its own gold check mark, and three of those cost 60px of
                the 358px available at 390px — enough that "Ships from the USA"
                wrapped onto a second line and the strip read as a badge
                cluster rather than a specification. The claims are unchanged,
                word for word; only the ornament is gone. Measured at 390px the
                row is now 322px and sits on one line.

                The middots are decoration and are hidden from assistive tech —
                the <li> boundaries already separate the items. */}
            <ul className="mt-7 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-white/60 sm:mt-8 sm:text-[0.8rem]">
              {[...HERO_ATTESTATIONS, ...trustPoints().filter((p: string) => p === COA_SHORT)].map((claim, index) => (
                <li key={claim} className="inline-flex items-center gap-2.5">
                  {index > 0 ? (
                    <span aria-hidden="true" className="text-[color:var(--accent-gold)]/60">·</span>
                  ) : null}
                  {claim}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Subtle scroll cue — a quiet premium detail, hidden for reduced motion. */}
        <div className="vl2-hero-scroll-cue" aria-hidden="true">
          <span className="vl2-hero-scroll-dot" />
        </div>
      </section>

      {categories.length > 0 ? (
        <section className="border-t border-white/10 py-10 sm:py-20">
          <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-12">
            <ScrollReveal>
              <h2 className="vl2-serif text-2xl text-white sm:text-4xl">Browse by category</h2>
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

      <section className="border-t border-white/10 py-10 sm:py-20">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-12">
          <ScrollReveal>
            <div className="mb-10 flex items-end justify-between gap-4">
              <div>
                <h2 className="vl2-serif text-2xl text-white sm:text-4xl">Most requested compounds</h2>
              </div>
              {/* inline-flex + min-h-6: a 24px tap target (WCAG 2.2 AA 2.5.8)
                  for a standalone section link that was 16px tall. */}
              <Link href="/products" className="inline-flex min-h-6 items-center text-xs uppercase tracking-[0.14em] text-white/55 transition hover:text-white">
                Full catalog →
              </Link>
            </div>
          </ScrollReveal>

          {featuredForHome.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:gap-5 xl:grid-cols-3">
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

      <section className="border-t border-white/10 bg-gradient-to-b from-[color:var(--accent-gold)]/[0.06] to-transparent py-10 sm:py-20">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-12">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-center">
            <ScrollReveal>
              <div className="max-w-lg">
                <p className="vl2-eyebrow text-[color:var(--accent-gold)]/80">Testing &amp; Transparency</p>
                <h2 className="vl2-serif mt-2 text-2xl text-white sm:mt-3 sm:text-4xl lg:text-5xl">Every batch, third-party tested.</h2>
                <p className="mt-5 text-sm leading-7 text-white/65 sm:text-base">
                  Anyone can print a label. We publish the proof — every lot independently
                  verified, every batch number mapped to its Certificate of Analysis.
                </p>
                <div className="mt-8">
                  <Link href="/coa-library" className="vl2-btn-primary vl-focus-ring px-7 py-3.5">Browse the COA Library</Link>
                </div>
              </div>
            </ScrollReveal>
            <div className="grid gap-3 sm:grid-cols-2">
              {TESTING_PROOFS.map((proof, index) => (
                <ScrollReveal key={proof.title} delayMs={index * 80}>
                  <article className="vl2-product-card h-full p-6">
                    <div className="mb-4 inline-flex h-9 w-9 items-center justify-center border border-[color:var(--accent-gold)]/30 bg-[color:var(--accent-gold)]/10 text-[color:var(--accent-gold)]">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                        <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                    </div>
                    <h3 className="text-base text-white">{proof.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-white/60">{proof.detail}</p>
                  </article>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 py-10 sm:py-20">
        <div className="mx-auto max-w-3xl px-6 lg:px-12">
          <ScrollReveal>
            <div className="mb-10 text-center">
              <h2 className="vl2-serif text-2xl text-white sm:text-4xl">Before you order</h2>
            </div>
          </ScrollReveal>
          <div className="space-y-px border border-white/10">
            {FAQ.map((entry) => (
              <details key={entry.q} className="group bg-[#181818] p-5" open={entry.q === FAQ[0].q}>
                <summary className="cursor-pointer list-none text-sm font-medium text-white marker:hidden">{entry.q}</summary>
                <p className="mt-3 text-sm leading-7 text-white/60">{entry.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
      </main>
    </div>
  );
}
