"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const SPOTLIGHT_CARDS = [
  {
    tag: "New Arrivals",
    title: "Freshly Added Research Inventory",
    description: "Explore newly listed compounds and recent batch additions as soon as they go live.",
    points: ["Recently Added", "Limited Initial Stock", "Updated Weekly"],
    ctaLabel: "View New Arrivals",
    ctaHref: "/products",
  },
  {
    tag: "Best Sellers",
    title: "Most Requested Compounds",
    description: "See what repeat customers and research teams are choosing most often this month.",
    points: ["Top Performing", "Frequently Reordered", "Fast Fulfillment"],
    ctaLabel: "Shop Best Sellers",
    ctaHref: "/products",
  },
  {
    tag: "Featured Bundle",
    title: "Buy 3, Get 1 Free",
    description: "Bundle savings are available on select qualifying items. Availability may vary by stock.",
    points: ["Select Items", "Bundle Savings", "Easy Cart Apply"],
    ctaLabel: "Shop Eligible Products",
    ctaHref: "/products",
  },
  {
    tag: "Latest COA",
    title: "Newest Certificate Added",
    description: "Review the latest published certificate details and testing documentation before purchase.",
    points: ["Batch Documented", "Transparent Data", "Quick Access"],
    ctaLabel: "Open COA Library",
    ctaHref: "/coa-library",
  },
];

export function HeroSpotlight() {
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((current) => (current + 1) % SPOTLIGHT_CARDS.length);
    }, 4500);

    return () => clearInterval(interval);
  }, []);

  const active = SPOTLIGHT_CARDS[activeIndex];

  return (
    <div className="vl-panel relative overflow-hidden rounded-[2rem] p-7 sm:p-9">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(186,230,253,0.26),transparent_65%)]" />
      <div className="pointer-events-none absolute -right-4 top-8 h-16 w-16 rounded-full border border-cyan-100/30 bg-cyan-100/10 vl-float" />
      <div className="pointer-events-none absolute right-18 top-22 h-10 w-10 rounded-full border border-sky-100/30 bg-sky-100/10 vl-float-b" />
      <div className="pointer-events-none absolute -left-5 bottom-10 h-14 w-14 rounded-full border border-cyan-100/25 bg-cyan-100/10 vl-float" />

      <p className="relative text-xs uppercase tracking-[0.24em] text-zinc-400">Spotlight</p>
      <p className="relative mt-3 inline-flex rounded-full border border-cyan-100/30 bg-cyan-100/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-100">
        {active.tag}
      </p>
      <h3 className="relative mt-4 text-3xl font-black leading-tight text-white sm:text-4xl">
        {active.title}
      </h3>
      <p className="relative mt-3 max-w-md text-sm leading-7 text-zinc-300 sm:text-base">
        {active.description}
      </p>

      <div className="relative mt-6 grid gap-3">
        {active.points.map((item) => (
          <div key={item} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-zinc-100">
            {item}
          </div>
        ))}
      </div>

      <div className="relative mt-6 flex items-center justify-between gap-4">
        <Link href={active.ctaHref} className="vl-btn-primary vl-focus-ring inline-flex px-6 py-3 text-sm">
          {active.ctaLabel}
        </Link>
        <div className="flex items-center gap-2">
          {SPOTLIGHT_CARDS.map((item, index) => (
            <button
              key={item.tag}
              type="button"
              onClick={() => setActiveIndex(index)}
              aria-label={`Show ${item.tag}`}
              className={`h-2.5 rounded-full transition ${activeIndex === index ? "w-8 bg-cyan-100" : "w-2.5 bg-zinc-500 hover:bg-zinc-300"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
