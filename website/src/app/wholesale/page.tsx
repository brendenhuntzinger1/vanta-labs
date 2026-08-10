import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { SiteFooter } from "@/components/site-footer";
import { WholesaleForm } from "@/components/wholesale-form";

/**
 * Wholesale — an enquiry page, not a price sheet.
 *
 * Deliberately publishes no minimums, discounts, payment terms or dispatch
 * times. None of those are configured anywhere in this system, so stating them
 * would be inventing business commitments on the company's behalf; the form
 * collects volume and cadence instead, and a quote follows the requirement
 * rather than the requirement following a published number.
 *
 * Every claim below is one the site already stands behind elsewhere — batch
 * documentation in the COA library, tracked shipping on the product pages.
 */

export const metadata: Metadata = {
  title: "Wholesale",
  description:
    "Bulk and wholesale supply of research-use-only materials from Vanta Labs. Submit a request and we will review your volume and requirements.",
};

const BENEFITS = [
  {
    title: "Volume pricing",
    body: "Pricing is quoted against the quantity and cadence you actually need, rather than a fixed public tier.",
  },
  {
    title: "Consistent supply",
    body: "Standing requirements are planned ahead so repeat orders draw on the same catalogue you already buy from.",
  },
  {
    title: "Batch documentation",
    body: "The same certificates of analysis published in our COA library accompany wholesale lots.",
  },
  {
    title: "Direct point of contact",
    body: "Wholesale requests are handled by the Vanta Labs team directly, not through a general queue.",
  },
  {
    title: "Tracked shipping",
    body: "Orders ship discreetly with tracking, the same way every Vanta Labs order does.",
  },
  {
    title: "Simple reordering",
    body: "Once your requirement is understood, repeat orders are placed without restating it each time.",
  },
];

const STEPS = [
  { n: "01", title: "Submit your request", body: "Tell us the compounds, quantities and cadence you need." },
  { n: "02", title: "We review", body: "We confirm what we can supply against your requirement." },
  { n: "03", title: "Receive options", body: "You get pricing and terms for the volume you asked about." },
  { n: "04", title: "Order", body: "Approved accounts place bulk orders directly with the team." },
];

export default function WholesalePage() {
  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="pb-24 pt-24 sm:pt-28">
        {/* HERO. Kept short on phones — a full-height hero on a 375px screen is
            a scroll before any content. */}
        <section className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-12">
          <div className="vl2-lab-panel relative overflow-hidden px-6 py-12 sm:px-10 sm:py-16 lg:px-14 lg:py-20">
            {/* A single soft light source rather than a stock photograph: it is
                the treatment the rest of the site already uses, and it does not
                invent product imagery we do not have. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[color:var(--accent-gold)]/[0.07] blur-3xl"
            />
            <div className="relative max-w-2xl">
              <p className="vl2-eyebrow text-[color:var(--accent-gold)]/80">Bulk &amp; wholesale</p>
              <h1 className="vl2-serif mt-4 text-[34px] leading-[1.1] text-white sm:text-5xl lg:text-6xl">
                Research supply at scale
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-7 text-white/55 sm:text-base">
                Vanta Labs works with laboratories, clinics and resellers who need larger quantities and a consistent
                source. Tell us what you require and we will put together pricing around it.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  href="#wholesale-request"
                  className="vl2-btn-primary vl-focus-ring flex items-center justify-center px-7 py-3.5 text-xs uppercase tracking-[0.16em]"
                >
                  Request wholesale pricing
                </a>
                <Link
                  href="/products"
                  className="vl-focus-ring flex items-center justify-center rounded-xl border border-white/15 px-7 py-3.5 text-xs uppercase tracking-[0.16em] text-white/75 transition hover:border-white/30 hover:text-white"
                >
                  View catalog
                </Link>
              </div>
              <p className="mt-6 text-[11px] uppercase tracking-[0.18em] text-white/30">
                For laboratory research use only
              </p>
            </div>
          </div>
        </section>

        {/* WHY */}
        <section className="mx-auto mt-16 max-w-[1200px] px-4 sm:mt-20 sm:px-6 lg:px-12">
          <p className="vl2-eyebrow text-white/40">The program</p>
          <h2 className="vl2-serif mt-3 text-2xl text-white sm:text-3xl">Built around your requirement</h2>
          <div className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-3">
            {BENEFITS.map((benefit) => (
              <div key={benefit.title} className="bg-[#0f0f0f] px-6 py-7">
                <h3 className="text-sm font-medium text-white">{benefit.title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/50">{benefit.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* HOW */}
        <section className="mx-auto mt-16 max-w-[1200px] px-4 sm:mt-20 sm:px-6 lg:px-12">
          <p className="vl2-eyebrow text-white/40">How it works</p>
          <h2 className="vl2-serif mt-3 text-2xl text-white sm:text-3xl">Four steps</h2>
          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <li key={step.n} className="rounded-2xl border border-white/[0.07] bg-[#0f0f0f] px-6 py-7">
                <span className="font-mono text-xs text-[color:var(--accent-gold)]/70">{step.n}</span>
                <h3 className="mt-3 text-sm font-medium text-white">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/50">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* REQUEST */}
        <section id="wholesale-request" className="mx-auto mt-16 max-w-[760px] px-4 sm:mt-24 sm:px-6 lg:px-0">
          <div className="vl2-lab-panel px-6 py-10 sm:px-10 sm:py-12">
            <div className="mb-8 text-center">
              <p className="vl2-eyebrow text-[color:var(--accent-gold)]/80">Request pricing</p>
              <h2 className="vl2-serif mt-3 text-2xl text-white sm:text-3xl">Start a wholesale account</h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-white/50">
                Share the compounds, volume and cadence you need. We review each request before issuing pricing.
              </p>
            </div>
            <WholesaleForm />
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
