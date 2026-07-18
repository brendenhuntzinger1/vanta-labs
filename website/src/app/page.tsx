"use client";

import Link from "next/link";
import { SiteHeader } from "@/components/site-header";

const trustPoints = [
  {
    title: "99%+ Purity Standards",
    description: "Every formulation is held to rigorous analytical benchmarks.",
  },
  {
    title: "COA Available for Every Released Batch",
    description: "Transparent documentation accompanies each release.",
  },
  {
    title: "Independent Third-Party Laboratory Testing",
    description: "Verification from accredited testing partners reinforces confidence.",
  },
  {
    title: "Same-Day Fulfillment on Eligible Orders",
    description: "Expedited dispatch for qualified orders within the continental US.",
  },
  {
    title: "Fast USA Shipping",
    description: "Reliable logistics support for priority domestic delivery.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />

      <main id="top">
        <section className="relative isolate overflow-hidden border-b border-zinc-800/80">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.16),_transparent_35%),radial-gradient(circle_at_bottom_right,_rgba(255,255,255,0.08),_transparent_30%)]" />
          <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col justify-center px-6 py-24 lg:px-8">
            <div className="max-w-3xl">
              <p className="mb-4 text-sm uppercase tracking-[0.4em] text-zinc-400">
                Precision. Transparency. Legacy.
              </p>
              <h1 className="text-5xl font-semibold leading-tight text-white sm:text-6xl lg:text-7xl">
                Premium laboratory standards for modern wellness.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-300 sm:text-xl">
                Vanta Labs delivers rigorously tested, research-driven formulations with full documentation and exceptional operational discipline.
              </p>
              <div className="mt-10 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/products"
                  className="rounded-full border border-zinc-600 bg-white px-6 py-3 text-center text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
                >
                  Shop Products
                </Link>
                <Link
                  href="/coa-library"
                  className="rounded-full border border-zinc-700 px-6 py-3 text-center text-sm font-semibold text-zinc-200 transition hover:bg-zinc-900"
                >
                  View COA Library
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section id="quality" className="border-b border-zinc-800/80 bg-zinc-900/70">
          <div className="mx-auto max-w-7xl px-6 py-20 lg:px-8">
            <div className="max-w-3xl">
              <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">
                Confidence at every release
              </p>
              <h2 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">
                A laboratory-grade experience built on measurable standards.
              </h2>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {trustPoints.map((point) => (
                <div key={point.title} className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-6">
                  <h3 className="text-lg font-semibold text-white">{point.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-zinc-400">{point.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="about" className="border-b border-zinc-800/80 bg-zinc-950">
          <div className="mx-auto grid max-w-7xl gap-10 px-6 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
            <div>
              <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">
                About Vanta Labs
              </p>
              <h2 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">
                A discreet, premium partner for research-minded customers.
              </h2>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-400">
                From formulation integrity to accelerated dispatch, Vanta Labs combines scientific rigor with a polished client experience designed for modern expectations.
              </p>
            </div>
            <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-8">
              <p className="text-sm uppercase tracking-[0.35em] text-zinc-500">
                Operating principles
              </p>
              <ul className="mt-6 space-y-4 text-sm leading-7 text-zinc-300">
                <li>• Controlled quality oversight across every release.</li>
                <li>• Transparent documentation for responsible evaluation.</li>
                <li>• Uncompromising presentation and service standards.</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer id="contact" className="border-t border-zinc-800/80 bg-zinc-950">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-10 text-sm text-zinc-400 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div>
            <p className="text-lg font-semibold tracking-[0.3em] text-white">VANTA LABS</p>
            <p className="mt-2 max-w-md text-zinc-400">
              Research integrity. Verified quality.
            </p>
          </div>
          <div className="flex flex-col gap-1 sm:text-right">
            <a href="mailto:hello@vantalabs.com" className="transition hover:text-white">
              hello@vantalabs.com
            </a>
            <span>Distributed with precision and discretion.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
