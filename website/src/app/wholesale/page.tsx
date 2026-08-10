import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { SiteFooter } from "@/components/site-footer";
import { WholesaleForm } from "@/components/wholesale-form";
import { WholesaleVialStack, selectStackImages } from "@/components/wholesale-vial-stack";
import { getCatalogProducts } from "@/lib/catalog";

/**
 * Wholesale — an enquiry page, not a price sheet.
 *
 * Publishes no minimums, discounts, payment terms or dispatch times. None are
 * configured anywhere in this system, so stating them would invent commitments
 * on the company's behalf; the form collects volume and cadence instead, so a
 * quote follows the requirement rather than the requirement following a
 * published number.
 *
 * The composition deliberately alternates: photograph, then editorial text,
 * then photograph, then a hairline timeline, then the form. The first version
 * of this page put every section inside its own bordered rectangle, which is
 * what made it read as a template — the borders did the structuring, so nothing
 * had any hierarchy. Here the sections are separated by rhythm and scale, and
 * only the form sits on a panel, because a form is the one thing that genuinely
 * benefits from a surface.
 */

export const metadata: Metadata = {
  title: "Wholesale",
  description:
    "Bulk and wholesale supply of research-use-only materials from Vanta Labs. Submit a request and we will review your volume and requirements.",
};

const BENEFITS = [
  { n: "01", title: "Volume pricing", body: "Priced around the quantity and cadence you actually order." },
  { n: "02", title: "Consistent supply", body: "Agree your requirement once, then reorder without restating it." },
  { n: "03", title: "Documentation", body: "The same certificates of analysis we publish, on every wholesale lot." },
  { n: "04", title: "Direct support", body: "Handled by the Vanta Labs team, not a general queue." },
];

const STEPS = [
  { n: "01", title: "Submit your requirements", body: "Compounds, quantities, cadence." },
  { n: "02", title: "We review availability", body: "We confirm what we can supply." },
  { n: "03", title: "Receive options", body: "Pricing for the volume you asked about." },
  { n: "04", title: "Confirm your order", body: "Approved accounts order directly." },
];

/** Shared button shapes, so one accent treatment is used across the page. */
const PRIMARY_CTA =
  "vl2-btn-primary vl-focus-ring inline-flex items-center justify-center px-8 py-4 text-xs uppercase tracking-[0.18em]";
const SECONDARY_CTA =
  "vl-focus-ring inline-flex items-center justify-center rounded-xl border border-white/15 px-8 py-4 text-xs uppercase tracking-[0.18em] text-white/70 transition hover:border-white/35 hover:text-white";

export default async function WholesalePage() {
  // Real photography from the catalogue. If none of it is usable the stack
  // returns nothing and the hero falls back to type, rather than showing a
  // rack of placeholders.
  const products = await getCatalogProducts().catch(() => []);
  const heroImages = selectStackImages(products, 3);
  const bulkImages = selectStackImages(products.slice().reverse(), 3);

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="pt-24 sm:pt-28">
        {/* ── HERO ─────────────────────────────────────────────────────────
            Type left, product right, no containing box. On a phone the copy
            and both CTAs come first and the photograph follows, so the offer
            is readable before anything has to be scrolled past. */}
        <section className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-12">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
            <div className="max-w-xl">
              <p className="vl2-eyebrow text-[color:var(--accent-gold)]/80">Bulk &amp; wholesale</p>
              <h1 className="vl2-display mt-5 text-[40px] leading-[0.98] text-white sm:text-[58px] lg:text-[68px]">
                Research supply
                <span className="block text-white/55">at scale</span>
              </h1>
              <p className="mt-6 max-w-lg text-sm leading-7 text-white/50 sm:text-base sm:leading-8">
                For laboratories, clinics and resellers ordering in larger quantities. Tell us what you need and
                we&rsquo;ll price it around your volume.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <a href="#wholesale-request" className={PRIMARY_CTA}>Request wholesale pricing</a>
                <Link href="/products" className={SECONDARY_CTA}>View catalog</Link>
              </div>
              <p className="mt-8 text-[11px] uppercase tracking-[0.2em] text-white/25">
                For laboratory research use only
              </p>
            </div>

            {heroImages.length > 0 ? (
              <WholesaleVialStack images={heroImages} priority />
            ) : (
              /* Not a blank rectangle: a typographic mark that stands on its
                 own when the catalogue has no photography to show. */
              <div className="relative mx-auto flex aspect-square w-full max-w-[460px] items-center justify-center">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute h-[60%] w-[60%] rounded-full bg-[color:var(--accent-gold)]/[0.06] blur-3xl"
                />
                <p className="vl2-display relative text-center text-[64px] leading-none text-white/[0.07] sm:text-[92px]">
                  VANTA
                  <span className="block">LABS</span>
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ── BENEFITS ─────────────────────────────────────────────────────
            Editorial, not cards. Hairline rules and oversized numerals carry
            the structure that four bordered boxes used to. */}
        <section className="mx-auto mt-24 max-w-[1280px] px-4 sm:mt-32 sm:px-6 lg:px-12">
          <div className="max-w-xl">
            <p className="vl2-eyebrow text-white/35">The program</p>
            <h2 className="vl2-display mt-4 text-[28px] leading-tight text-white sm:text-[40px]">
              Built around your requirement
            </h2>
          </div>

          <div className="mt-12 grid gap-x-14 gap-y-10 sm:grid-cols-2">
            {BENEFITS.map((benefit) => (
              <div key={benefit.n} className="border-t border-white/[0.08] pt-6">
                <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-gold)]/60">
                  {benefit.n}
                </span>
                <h3 className="mt-4 text-lg text-white">{benefit.title}</h3>
                <p className="mt-2.5 max-w-md text-sm leading-7 text-white/45">{benefit.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── BULK VISUAL ──────────────────────────────────────────────────
            Breaks the page before it can become another column of text.
            Photograph leads on desktop; on mobile the headline leads so the
            section announces itself before it shows itself. */}
        <section className="mt-24 border-y border-white/[0.06] bg-[#0e0e0e] py-20 sm:mt-32 sm:py-28">
          <div className="mx-auto grid max-w-[1280px] items-center gap-12 px-4 sm:px-6 lg:grid-cols-2 lg:gap-20 lg:px-12">
            {bulkImages.length > 0 ? (
              <div className="order-2 lg:order-1">
                <WholesaleVialStack images={bulkImages} />
              </div>
            ) : null}

            <div className={bulkImages.length > 0 ? "order-1 lg:order-2" : ""}>
              <p className="vl2-eyebrow text-white/35">Bulk orders</p>
              <h2 className="vl2-display mt-4 max-w-md text-[28px] leading-tight text-white sm:text-[40px]">
                Built around your volume
              </h2>
              <p className="mt-6 max-w-md text-sm leading-7 text-white/50">
                Send us what you order and how often. We check it against what we can supply, then come back with
                options for that volume.
              </p>
              <ul className="mt-8 space-y-3 text-sm text-white/55">
                {["Compounds and quantities", "Recurring or standing requirements", "General ordering cadence"].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span aria-hidden="true" className="mt-2 h-px w-5 flex-none bg-[color:var(--accent-gold)]/50" />
                    {item}
                  </li>
                ))}
              </ul>
              <a href="#wholesale-request" className={`${PRIMARY_CTA} mt-10`}>Request pricing</a>
            </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ─────────────────────────────────────────────────
            A hairline timeline. The connector is drawn once across the row
            rather than four boxes each drawing their own outline. */}
        <section className="mx-auto mt-24 max-w-[1280px] px-4 sm:mt-32 sm:px-6 lg:px-12">
          <div className="max-w-xl">
            <p className="vl2-eyebrow text-white/35">How it works</p>
            <h2 className="vl2-display mt-4 text-[28px] leading-tight text-white sm:text-[40px]">Four steps</h2>
          </div>

          <ol className="relative mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 right-0 top-[7px] hidden h-px bg-gradient-to-r from-[color:var(--accent-gold)]/25 via-white/10 to-transparent lg:block"
            />
            {STEPS.map((step) => (
              <li key={step.n} className="relative">
                <span
                  aria-hidden="true"
                  className="absolute -top-[3px] left-0 hidden h-[7px] w-[7px] rounded-full bg-[color:var(--accent-gold)]/70 lg:block"
                />
                <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-gold)]/60 lg:block lg:pt-8">
                  {step.n}
                </span>
                <h3 className="mt-3 text-base text-white lg:mt-4">{step.title}</h3>
                <p className="mt-2 max-w-[22rem] text-sm leading-6 text-white/45">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── REQUEST ──────────────────────────────────────────────────────
            40/60. The information column is sticky on desktop so the heading
            stays with the form through a long fill. */}
        <section id="wholesale-request" className="mx-auto mt-24 max-w-[1280px] scroll-mt-24 px-4 sm:mt-32 sm:px-6 lg:px-12">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <p className="vl2-eyebrow text-[color:var(--accent-gold)]/80">Request pricing</p>
              <h2 className="vl2-display mt-4 text-[28px] leading-tight text-white sm:text-[40px]">
                Start a wholesale request
              </h2>
              <p className="mt-6 max-w-sm text-sm leading-7 text-white/50">
                Every request is reviewed before pricing is issued. Nothing is ordered or charged here.
              </p>
              <div className="mt-8 border-t border-white/[0.08] pt-6">
                <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Prefer email?</p>
                <a
                  href="mailto:support@vantalabsresearch.com"
                  className="vl-focus-ring mt-2 inline-block text-sm text-white/70 underline-offset-4 transition hover:text-white hover:underline"
                >
                  support@vantalabsresearch.com
                </a>
              </div>
            </div>

            {/* The one panel on the page. A form is the thing that genuinely
                benefits from a surface to sit on. */}
            <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#151515] to-[#101010] p-6 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)] sm:p-9">
              <WholesaleForm />
            </div>
          </div>
        </section>

        {/* ── CLOSING ──────────────────────────────────────────────────────*/}
        <section className="mt-24 border-t border-white/[0.06] bg-[#0e0e0e] py-20 sm:mt-32 sm:py-24">
          <div className="mx-auto max-w-[1280px] px-4 text-center sm:px-6 lg:px-12">
            <h2 className="vl2-display mx-auto max-w-2xl text-[26px] leading-tight text-white sm:text-[38px]">
              Planning a larger order?
            </h2>
            <p className="mx-auto mt-4 max-w-md text-sm leading-7 text-white/45">
              Tell us what you need and we&rsquo;ll review the request.
            </p>
            <a href="#wholesale-request" className={`${PRIMARY_CTA} mt-9`}>Request wholesale pricing</a>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
