"use client";

import Link from "next/link";
import { useState, useEffect, useMemo } from "react";
import { SiteHeader } from "@/components/site-header";
import type { Product } from "@/lib/catalog-types";

// ────────────────────────────────────────────────────────────────────────────
// FEATURED PRODUCTS - Automatically detect top sellers
// ────────────────────────────────────────────────────────────────────────────

const TOP_SELLER_SLUGS = [
  "bpc-157-10mg",
  "glp-1-15mg",
  "hgh-191aa-10mg",
  "igf-1-lr3-1mg",
  "nad-250mg",
  "ghk-cu-1mg",
];

// ────────────────────────────────────────────────────────────────────────────
// WHY VANTA LABS FEATURES
// ────────────────────────────────────────────────────────────────────────────

const WHY_VANTA_FEATURES = [
  {
    icon: "01",
    title: "Third-Party Tested",
    description: "Every batch independently verified by accredited laboratories.",
  },
  {
    icon: "02",
    title: "COA Verified",
    description: "Complete Certificates of Analysis with every order.",
  },
  {
    icon: "03",
    title: "99%+ Purity",
    description: "Guaranteed minimum purity on all research compounds.",
  },
  {
    icon: "04",
    title: "Secure Checkout",
    description: "Enterprise-grade encryption and payment security.",
  },
  {
    icon: "05",
    title: "USA Fulfilled",
    description: "All compounds manufactured, tested, and dispatched domestically.",
  },
  {
    icon: "06",
    title: "Research Use Only",
    description: "Compounds sold strictly for legitimate research purposes.",
  },
];

// ────────────────────────────────────────────────────────────────────────────
// FOOTER SECTIONS
// ────────────────────────────────────────────────────────────────────────────

const FOOTER_LINKS = {
  company: [
    { label: "About Vanta Labs", href: "#about" },
    { label: "Contact", href: "mailto:hello@vantalabs.com" },
    { label: "COA Library", href: "/coa-library" },
  ],
  legal: [
    { label: "Terms & Conditions", href: "#" },
    { label: "Privacy Policy", href: "#" },
    { label: "Refund Policy", href: "#" },
    { label: "Shipping Policy", href: "#" },
    { label: "Research Disclaimer", href: "#" },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// PAGE COMPONENT
// ────────────────────────────────────────────────────────────────────────────

export default function Home() {
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [carouselIndex, setCarouselIndex] = useState(0);

  const featuredProducts = useMemo(() => TOP_SELLER_SLUGS
    .map((slug) => allProducts.find((product) => product.slug === slug))
    .filter(Boolean) as Product[], [allProducts]);

  useEffect(() => {
    fetch("/api/catalog/products", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => {
        if (json?.success && Array.isArray(json.products)) {
          setAllProducts(json.products as Product[]);
        }
      })
      .catch(() => {
        setAllProducts([]);
      });
  }, []);

  // Carousel auto-rotate
  useEffect(() => {
    if (featuredProducts.length === 0) {
      return;
    }

    const interval = setInterval(() => {
      setCarouselIndex((prev) => (prev + 1) % featuredProducts.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [featuredProducts.length]);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <SiteHeader />

      {/* ═══════════════════════════ HERO SECTION ═══════════════════════════ */}
      <section className="relative isolate flex min-h-[88svh] items-center overflow-hidden sm:min-h-screen">
        {/* Background gradients */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-5%,rgba(255,255,255,0.11),transparent)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_80%_55%,rgba(255,255,255,0.07),transparent)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_40%_35%_at_15%_75%,rgba(255,255,255,0.06),transparent)]" />
        <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-gradient-to-b from-transparent via-white/25 to-transparent animate-pulse" />
        <div className="pointer-events-none absolute inset-y-0 right-1/4 w-px bg-gradient-to-b from-transparent via-white/18 to-transparent animate-pulse" style={{ animationDelay: "0.8s" }} />

        {/* Animated peptide chains - left side (desktop) */}
        <div aria-hidden="true" className="pointer-events-none absolute left-0 top-0 hidden h-full w-[30%] lg:block">
          {/* Peptide chain 1 - top left */}
          <div className="absolute left-[5%] top-[15%] opacity-60 hover:opacity-100 transition-opacity">
            <svg width="120" height="160" viewBox="0 0 120 160" className="animate-pulse">
              {/* Molecular bonds */}
              <line x1="30" y1="20" x2="60" y2="40" stroke="rgba(255,255,255,0.36)" strokeWidth="2" />
              <line x1="60" y1="40" x2="90" y2="60" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
              <line x1="90" y1="60" x2="60" y2="90" stroke="rgba(255,255,255,0.32)" strokeWidth="2" />
              <line x1="60" y1="90" x2="30" y2="110" stroke="rgba(255,255,255,0.24)" strokeWidth="2" />
              <line x1="30" y1="110" x2="60" y2="140" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
              
              {/* Amino acid nodes */}
              <circle cx="30" cy="20" r="6" fill="rgba(255,255,255,0.58)" />
              <circle cx="60" cy="40" r="7" fill="rgba(255,255,255,0.45)" />
              <circle cx="90" cy="60" r="6" fill="rgba(255,255,255,0.52)" />
              <circle cx="60" cy="90" r="7" fill="rgba(255,255,255,0.5)" />
              <circle cx="30" cy="110" r="6" fill="rgba(255,255,255,0.43)" />
              <circle cx="60" cy="140" r="7" fill="rgba(255,255,255,0.55)" />
            </svg>
          </div>

          {/* Peptide chain 2 - middle left */}
          <div className="absolute left-[15%] top-[50%] opacity-50 hover:opacity-90 transition-opacity" style={{ animationDelay: "0.5s" }}>
            <svg width="100" height="140" viewBox="0 0 100 140" className="animate-pulse">
              {/* Molecular bonds */}
              <line x1="20" y1="10" x2="50" y2="30" stroke="rgba(255,255,255,0.36)" strokeWidth="2" />
              <line x1="50" y1="30" x2="80" y2="50" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
              <line x1="80" y1="50" x2="50" y2="80" stroke="rgba(255,255,255,0.32)" strokeWidth="2" />
              <line x1="50" y1="80" x2="20" y2="100" stroke="rgba(255,255,255,0.24)" strokeWidth="2" />
              
              {/* Amino acid nodes */}
              <circle cx="20" cy="10" r="5" fill="rgba(255,255,255,0.52)" />
              <circle cx="50" cy="30" r="6" fill="rgba(255,255,255,0.46)" />
              <circle cx="80" cy="50" r="5" fill="rgba(255,255,255,0.54)" />
              <circle cx="50" cy="80" r="6" fill="rgba(255,255,255,0.48)" />
              <circle cx="20" cy="100" r="5" fill="rgba(255,255,255,0.42)" />
            </svg>
          </div>

          {/* Peptide chain 3 - bottom left */}
          <div className="absolute left-[8%] bottom-[20%] opacity-55 hover:opacity-95 transition-opacity" style={{ animationDelay: "1s" }}>
            <svg width="110" height="150" viewBox="0 0 110 150" className="animate-pulse">
              {/* Molecular bonds */}
              <line x1="25" y1="20" x2="55" y2="45" stroke="rgba(255,255,255,0.36)" strokeWidth="2" />
              <line x1="55" y1="45" x2="85" y2="65" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
              <line x1="85" y1="65" x2="55" y2="95" stroke="rgba(255,255,255,0.32)" strokeWidth="2" />
              <line x1="55" y1="95" x2="25" y2="120" stroke="rgba(255,255,255,0.24)" strokeWidth="2" />
              
              {/* Amino acid nodes */}
              <circle cx="25" cy="20" r="6" fill="rgba(255,255,255,0.55)" />
              <circle cx="55" cy="45" r="7" fill="rgba(255,255,255,0.48)" />
              <circle cx="85" cy="65" r="6" fill="rgba(255,255,255,0.52)" />
              <circle cx="55" cy="95" r="7" fill="rgba(255,255,255,0.46)" />
              <circle cx="25" cy="120" r="6" fill="rgba(255,255,255,0.42)" />
            </svg>
          </div>
        </div>

        {/* Floating vials - right side (desktop) */}
        <div aria-hidden="true" className="pointer-events-none absolute right-0 top-0 hidden h-full w-[40%] lg:block">
          <div className="absolute right-[10%] top-[20%] h-72 w-14 animate-pulse">
            <div className="relative h-full">
              {/* Vial glow */}
              <div className="absolute -inset-8 rounded-full bg-white/10 blur-2xl" />
              {/* Main vial */}
              <div className="absolute inset-0 rounded-b-[99px] rounded-t-xl border border-white/22 bg-gradient-to-b from-white/16 to-white/6 backdrop-blur-sm">
                <div className="absolute inset-2 rounded-b-[95px] bg-gradient-to-b from-white/8 via-white/10 to-transparent" />
                <div className="absolute bottom-1/3 left-1/2 h-20 w-1 -translate-x-1/2 rounded-full bg-white/24" />
              </div>
            </div>
          </div>

          <div className="absolute right-[40%] top-[35%] h-56 w-10 animate-pulse" style={{ animationDelay: "0.7s" }}>
            <div className="relative h-full">
              <div className="absolute -inset-6 rounded-full bg-white/8 blur-2xl" />
              <div className="absolute inset-0 rounded-b-[99px] rounded-t-lg border border-white/18 bg-gradient-to-b from-white/12 to-white/5 backdrop-blur-sm">
                <div className="absolute inset-2 rounded-b-[95px] bg-gradient-to-b from-white/5 via-white/8 to-transparent" />
              </div>
            </div>
          </div>

          <div className="absolute right-[15%] bottom-[15%] h-40 w-9 animate-pulse" style={{ animationDelay: "1.4s" }}>
            <div className="relative h-full">
              <div className="absolute -inset-5 rounded-full bg-white/8 blur-2xl" />
              <div className="absolute inset-0 rounded-b-[99px] rounded-t-lg border border-white/16 bg-gradient-to-b from-white/10 to-white/4 backdrop-blur-sm">
                <div className="absolute inset-2 rounded-b-[95px] bg-gradient-to-b from-white/4 via-white/7 to-transparent" />
              </div>
            </div>
          </div>
        </div>

        {/* Hero content */}
        <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:w-[55%] lg:px-8 lg:py-0">
          <p className="mb-6 animate-fade-in text-[10px] font-semibold uppercase tracking-[0.3em] text-zinc-300 sm:mb-8 sm:text-[11px] sm:tracking-[0.4em]">
            Certified Research Supply
          </p>

          <h1 className="mb-5 animate-fade-in text-4xl font-bold leading-tight tracking-tight sm:mb-6 sm:text-6xl lg:text-7xl"
            style={{ animationDelay: "0.1s" }}>
            <span className="bg-gradient-to-r from-zinc-200 via-white to-zinc-300 bg-clip-text text-transparent">
              Official-Grade Research Standards
            </span>
          </h1>

          <p className="mb-7 max-w-lg animate-fade-in text-base text-zinc-400 sm:mb-8 sm:text-xl"
            style={{ animationDelay: "0.2s" }}>
            Premium compounds with institutional-grade quality control, verified documentation, and reliable domestic fulfillment.
          </p>

          <div className="mb-10 flex animate-fade-in flex-col gap-3 sm:mb-12 sm:flex-row sm:gap-4"
            style={{ animationDelay: "0.3s" }}>
            <Link href="/products" className="vl-btn-primary vl-focus-ring group relative px-7 py-3.5 text-center text-sm active:scale-95 sm:px-8 sm:text-base">
              <span className="relative z-10">Browse Products</span>
              <div className="absolute inset-0 rounded-lg bg-white opacity-0 group-hover:opacity-10 transition-opacity" />
            </Link>
            <Link
              href="/coa-library"
              className="vl-btn-secondary vl-focus-ring group px-7 py-3.5 text-center text-sm transition-all duration-300 active:scale-95 sm:px-8 sm:text-base"
            >
              View COA Library
            </Link>
          </div>

          {/* Stats */}
          <div className="grid animate-fade-in grid-cols-2 gap-4 border-t border-white/20 pt-6 sm:grid-cols-4 sm:gap-6 sm:pt-8"
            style={{ animationDelay: "0.4s" }}>
            <div>
              <p className="text-2xl font-bold text-zinc-100 sm:text-3xl">40+</p>
              <p className="text-sm text-zinc-500 mt-1">Research Compounds</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-zinc-100 sm:text-3xl">99%+</p>
              <p className="text-sm text-zinc-500 mt-1">Purity Standard</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-zinc-100 sm:text-3xl">12</p>
              <p className="text-sm text-zinc-500 mt-1">Lab Partners</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-zinc-100 sm:text-3xl">100%</p>
              <p className="text-sm text-zinc-500 mt-1">Verified</p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ BUY 3 GET 1 FREE PROMO ═════════════════ */}
      <section className="relative isolate overflow-hidden border-b border-zinc-800/50 bg-gradient-to-r from-zinc-950 via-zinc-900/70 to-zinc-950 py-12 sm:py-16">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_85%_42%_at_50%_50%,rgba(255,255,255,0.08),transparent)]" />
        
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="vl-panel rounded-2xl border-white/20 bg-white/5 p-6 text-center sm:p-12">
            <div className="mx-auto mb-5 inline-flex items-center rounded-full border border-white/25 bg-white/10 px-4 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-100">
                Volume Incentive
              </span>
            </div>
            
            <h2 className="mb-3 text-3xl font-bold text-white sm:text-5xl">
              Preferred Purchase Program
            </h2>
            
            <p className="mb-4 text-xl font-semibold text-zinc-100">
              Buy 3, Receive 1 Complimentary
            </p>
            
            <p className="mx-auto mb-7 max-w-2xl text-base text-zinc-300 sm:mb-8 sm:text-lg">
              Add any four qualifying research compounds to your cart and the lowest-priced item is automatically adjusted to no charge. No code required.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <Link
                href="/products"
                className="vl-focus-ring rounded-full bg-gradient-to-r from-zinc-100 to-white px-8 py-3.5 text-sm font-semibold text-zinc-950 transition-all duration-300 hover:shadow-lg hover:shadow-white/20 active:scale-95 sm:px-10 sm:py-4 sm:text-base"
              >
                View Eligible Compounds
              </Link>
              <p className="text-sm text-zinc-400">
                Applied automatically at cart level on qualifying 4-item selections.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ WHY VANTA LABS ═════════════════════════ */}
      <section className="border-b border-zinc-800/50 bg-zinc-950 py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-2xl sm:mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-3">Quality Assurance</p>
            <h2 className="text-3xl font-bold text-white sm:text-5xl">
              Why Vanta Labs
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {WHY_VANTA_FEATURES.map((feature) => (
              <div key={feature.title} className="vl-panel vl-elevate-hover group rounded-xl p-8 bg-gradient-to-br from-zinc-900/90 via-zinc-900/65 to-zinc-800/25">
                <span className="text-sm font-bold tracking-[0.35em] text-zinc-300 block mb-4">{feature.icon}</span>
                <h3 className="text-lg font-semibold text-white mb-2">
                  {feature.title}
                </h3>
                <p className="text-zinc-400 group-hover:text-zinc-300 transition-colors">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ FEATURED PRODUCTS ══════════════════════ */}
      <section className="border-b border-zinc-800/50 bg-zinc-950/50 py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-2xl sm:mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-3">Best Sellers</p>
            <h2 className="text-3xl font-bold text-white sm:text-5xl">
              Featured Products
            </h2>
          </div>

          {/* Carousel */}
          <div className="relative">
            <div className="vl-panel overflow-hidden rounded-xl">
              <div className="aspect-video flex items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 relative">
                {featuredProducts[carouselIndex] ? (
                  <div key={carouselIndex} className="flex h-full w-full animate-fade-in flex-col items-center justify-center p-5 sm:p-8">
                    <div className="mb-4 text-5xl sm:text-6xl">🧪</div>
                    <h3 className="mb-2 text-center text-2xl font-bold text-white sm:text-3xl">
                      {featuredProducts[carouselIndex].name}
                    </h3>
                    <p className="mb-4 text-lg text-zinc-400 sm:text-xl">
                      {featuredProducts[carouselIndex].price}
                    </p>
                    <p className="mb-6 text-sm text-zinc-500 max-w-md text-center">
                      Purity: <span className="text-zinc-200 font-semibold">{featuredProducts[carouselIndex].purityResult ?? "N/A"}</span>
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4">
                      <span className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300">{featuredProducts[carouselIndex].price}</span>
                      <Link href={`/products/${featuredProducts[carouselIndex].slug}`} className="vl-btn-primary vl-focus-ring px-6 py-2">
                        View Details
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div className="text-zinc-500 text-sm">Featured products loading...</div>
                )}
              </div>
            </div>

            {/* Carousel controls */}
            <div className="flex justify-center gap-2 mt-6">
              {featuredProducts.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => setCarouselIndex(idx)}
                  className={`w-2 h-2 rounded-full transition-all ${
                    idx === carouselIndex ? "bg-white w-6" : "bg-zinc-600 hover:bg-zinc-500"
                  }`}
                  aria-label={`Go to product ${idx + 1}`}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ COA SECTION ═════════════════════════════ */}
      <section className="border-b border-zinc-800/50 bg-zinc-950 py-14 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-4">Quality Verification</p>
              <h2 className="mb-5 text-3xl font-bold text-white sm:text-5xl sm:mb-6">
                Every Batch Verified
              </h2>
              <p className="mb-6 text-base text-zinc-400 sm:text-lg">
                Every product is accompanied by independent laboratory testing with downloadable Certificates of Analysis. Our commitment to transparency means you can verify the quality and purity of every batch.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link
                  href="/coa-library"
                  className="vl-btn-primary vl-focus-ring px-8 py-3.5 text-center active:scale-95"
                >
                  Browse COA Library
                </Link>
              </div>
            </div>
            <div className="vl-panel aspect-square rounded-xl p-8 sm:p-12 flex items-center justify-center">
              <div className="text-center">
                <div className="text-8xl mb-4">🛡️</div>
                <p className="text-xl font-semibold text-white">Laboratory Certified</p>
                <p className="text-zinc-400 mt-2">Independent third-party verification</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ LABORATORY SECTION ══════════════════════ */}
      <section className="relative overflow-hidden border-b border-zinc-800/50 bg-zinc-950/50 py-14 sm:py-20">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.1),transparent_70%)]" />
        
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mx-auto mb-10 max-w-3xl text-center sm:mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-4">Scientific Excellence</p>
            <h2 className="mb-5 text-3xl font-bold text-white sm:mb-6 sm:text-5xl">
              State-of-the-Art Laboratory
            </h2>
            <p className="text-base text-zinc-400 sm:text-lg">
              Our research compounds are produced in accredited laboratories utilizing cutting-edge analytical equipment and rigorous quality control protocols. Every batch undergoes comprehensive testing to ensure consistency and purity.
            </p>
          </div>

          <div className="grid gap-5 md:grid-cols-3 md:gap-6">
            <div className="vl-panel vl-elevate-hover rounded-xl p-8 text-center">
              <div className="text-5xl mb-4">🔬</div>
              <h3 className="text-xl font-semibold text-white mb-2">Advanced Analytics</h3>
              <p className="text-zinc-400">HPLC, GC-MS, and NMR spectroscopy for precise compound analysis.</p>
            </div>
            <div className="vl-panel vl-elevate-hover rounded-xl p-8 text-center">
              <div className="text-5xl mb-4">🧪</div>
              <h3 className="text-xl font-semibold text-white mb-2">Rigorous Testing</h3>
              <p className="text-zinc-400">Comprehensive QC protocols and batch verification procedures.</p>
            </div>
            <div className="vl-panel vl-elevate-hover rounded-xl p-8 text-center">
              <div className="text-5xl mb-4">📊</div>
              <h3 className="text-xl font-semibold text-white mb-2">Full Transparency</h3>
              <p className="text-zinc-400">Complete documentation and COA with molecular formulas.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ CTA SECTION ═════════════════════════════ */}
      <section className="border-b border-zinc-800/50 bg-zinc-950 py-14 sm:py-20">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-5 text-3xl font-bold text-white sm:mb-6 sm:text-5xl">
            Ready to get started?
          </h2>
          <p className="mx-auto mb-8 max-w-2xl text-base text-zinc-400 sm:text-lg">
            Explore our complete catalog of premium research compounds, all verified, tested, and ready to ship.
          </p>
          <Link
            href="/products"
            className="vl-btn-primary vl-focus-ring inline-block px-10 py-4 active:scale-95"
          >
            Browse Full Catalog
          </Link>
        </div>
      </section>

      {/* ═══════════════════════════ FOOTER ═════════════════════════════════ */}
      <footer className="bg-zinc-950 border-t border-zinc-800/50">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
          <div className="mb-10 grid gap-8 sm:gap-10 md:grid-cols-2 lg:grid-cols-4 lg:gap-12">
            {/* Brand */}
            <div>
              <p className="text-lg font-bold tracking-wider text-white mb-2">VANTA LABS</p>
              <p className="text-sm text-zinc-500">Premium research compounds. Scientific integrity. Uncompromising quality.</p>
            </div>

            {/* Company */}
            <div>
              <p className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Company</p>
              <ul className="space-y-3">
                {FOOTER_LINKS.company.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Legal */}
            <div>
              <p className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Legal</p>
              <ul className="space-y-3">
                {FOOTER_LINKS.legal.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Newsletter */}
            <div>
              <p className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Stay Updated</p>
              <p className="text-sm text-zinc-500 mb-4">Subscribe for new product releases and research updates.</p>
              <form className="flex flex-col gap-2 sm:flex-row sm:gap-0">
                <input
                  type="email"
                  placeholder="Enter email"
                  className="vl-input flex-1 px-4 py-2 text-sm placeholder-zinc-600 sm:rounded-r-none sm:border-r-0"
                />
                <button
                  type="submit"
                  className="vl-btn-primary vl-focus-ring rounded-lg px-4 py-2 text-sm sm:rounded-l-none"
                >
                  Subscribe
                </button>
              </form>
            </div>
          </div>

          <div className="flex flex-col items-start justify-between gap-4 border-t border-zinc-800 pt-8 text-sm text-zinc-500 sm:flex-row sm:items-center">
            <p className="text-left sm:text-center">&copy; 2026 Vanta Labs. All rights reserved. Research use only.</p>
            <div className="flex gap-4">
              <a href="#" className="hover:text-zinc-300 transition-colors">Twitter</a>
              <a href="#" className="hover:text-zinc-300 transition-colors">LinkedIn</a>
              <a href="#" className="hover:text-zinc-300 transition-colors">Discord</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
