"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

export type HeroFeaturedProduct = {
  name: string;
  slug: string;
  image: string;
  price?: string;
  purityResult?: string;
  description?: string;
};

export function HeroVialRotator({ products }: { products: HeroFeaturedProduct[] }) {
  const featuredProducts = products.length ? products : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (featuredProducts.length <= 1) {
      return;
    }

    let swapTimer: ReturnType<typeof setTimeout> | undefined;

    const interval = setInterval(() => {
      setIsVisible(false);

      swapTimer = setTimeout(() => {
        setActiveIndex((current) => (current + 1) % featuredProducts.length);
        setIsVisible(true);
      }, 280);
    }, 5200);

    return () => {
      clearInterval(interval);
      if (swapTimer) {
        clearTimeout(swapTimer);
      }
    };
  }, [featuredProducts.length]);

  if (featuredProducts.length === 0) {
    return null;
  }

  const safeActiveIndex = activeIndex % featuredProducts.length;
  const featured = featuredProducts[safeActiveIndex];

  return (
    <div className="vl-panel relative overflow-hidden rounded-[2rem] p-6 sm:p-8">
      <div className="vl-hero-lab-bg pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute -right-12 top-8 h-32 w-32 rounded-full bg-cyan-200/15 blur-3xl" />
      <div className="pointer-events-none absolute -left-12 bottom-8 h-28 w-28 rounded-full bg-sky-200/10 blur-3xl" />

      <div className={`relative grid gap-6 transition-all duration-500 sm:grid-cols-[0.95fr_1.05fr] ${isVisible ? "opacity-100" : "opacity-0"}`}>
        <div className="relative flex items-center justify-center px-2 py-4 sm:px-4">
          <div className="vl-molecule vl-molecule-a" />
          <div className="vl-molecule vl-molecule-b" />
          <div className="vl-molecule vl-molecule-c" />

          <div className="vl-product-scene">
            <div className="vl-product-glow" />
            <div className="vl-product-shadow" />
            <div className="vl-product-float-wrap">
              <div className="vl-product-image-shell">
                <Image
                  src={featured.image}
                  alt={`${featured.name} product render`}
                  fill
                  sizes="(max-width: 1024px) 65vw, 30vw"
                  className="object-contain"
                  priority
                  unoptimized
                />
                <div className="vl-product-reflection" />
              </div>
            </div>
          </div>
        </div>

        <div className="relative flex flex-col justify-center">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-100/80">Featured Compound</p>
          <h3 className="mt-3 text-3xl font-black leading-tight text-white sm:text-4xl">{featured.name}</h3>
          <p className="mt-1 text-lg font-semibold uppercase tracking-[0.16em] text-cyan-100">{featured.price ?? "Featured"}</p>
          <p className="mt-4 text-sm leading-7 text-zinc-300">{featured.description ?? "Exact Vanta Labs product render with original label and lot presentation."}</p>

          <div className="mt-5 grid gap-2.5 text-sm text-zinc-100 sm:text-[15px]">
            {[
              "Batch verified",
              "COA available",
              featured.purityResult ? `Purity: ${featured.purityResult}` : "Premium research quality",
            ].map((item) => (
              <div key={item} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-cyan-100 shadow-[0_0_10px_rgba(178,231,255,0.9)]" />
                <span>{item}</span>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <Link href={`/products/${featured.slug}`} className="vl-btn-primary vl-focus-ring inline-flex px-6 py-3 text-sm font-semibold">
              View Product
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
