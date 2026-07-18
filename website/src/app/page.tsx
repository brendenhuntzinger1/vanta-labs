"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { SiteHeader } from "@/components/site-header";
import { products as allProducts } from "@/lib/demo-data";

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

const FEATURED_PRODUCTS = TOP_SELLER_SLUGS
  .map((slug) => allProducts.find((p) => p.slug === slug))
  .filter(Boolean) as typeof allProducts;

// ────────────────────────────────────────────────────────────────────────────
// WHY VANTA LABS FEATURES
// ────────────────────────────────────────────────────────────────────────────

const WHY_VANTA_FEATURES = [
  {
    icon: "🔬",
    title: "Third-Party Tested",
    description: "Every batch independently verified by accredited laboratories.",
  },
  {
    icon: "📋",
    title: "COA Verified",
    description: "Complete Certificates of Analysis with every order.",
  },
  {
    icon: "✨",
    title: "99%+ Purity",
    description: "Guaranteed minimum purity on all research compounds.",
  },
  {
    icon: "🛡️",
    title: "Secure Checkout",
    description: "Enterprise-grade encryption and payment security.",
  },
  {
    icon: "🇺🇸",
    title: "USA Fulfilled",
    description: "All compounds manufactured, tested, and dispatched domestically.",
  },
  {
    icon: "⚖️",
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
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [carouselIndex, setCarouselIndex] = useState(0);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Carousel auto-rotate
  useEffect(() => {
    const interval = setInterval(() => {
      setCarouselIndex((prev) => (prev + 1) % FEATURED_PRODUCTS.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <SiteHeader />

      {/* ═══════════════════════════ HERO SECTION ═══════════════════════════ */}
      <section className="relative isolate min-h-screen flex items-center overflow-hidden">
        {/* Background gradients */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-5%,rgba(14,165,233,0.1),transparent)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_80%_55%,rgba(139,92,246,0.08),transparent)]" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_40%_35%_at_15%_75%,rgba(59,130,246,0.07),transparent)]" />

        {/* Animated peptide chains - left side (desktop) */}
        <div aria-hidden="true" className="pointer-events-none absolute left-0 top-0 hidden h-full w-[30%] lg:block">
          {/* Peptide chain 1 - top left */}
          <div className="absolute left-[5%] top-[15%] opacity-60 hover:opacity-100 transition-opacity">
            <svg width="120" height="160" viewBox="0 0 120 160" className="animate-pulse">
              {/* Molecular bonds */}
              <line x1="30" y1="20" x2="60" y2="40" stroke="rgba(59,130,246,0.4)" strokeWidth="2" />
              <line x1="60" y1="40" x2="90" y2="60" stroke="rgba(139,92,246,0.4)" strokeWidth="2" />
              <line x1="90" y1="60" x2="60" y2="90" stroke="rgba(34,197,94,0.4)" strokeWidth="2" />
              <line x1="60" y1="90" x2="30" y2="110" stroke="rgba(59,130,246,0.4)" strokeWidth="2" />
              <line x1="30" y1="110" x2="60" y2="140" stroke="rgba(139,92,246,0.4)" strokeWidth="2" />
              
              {/* Amino acid nodes */}
              <circle cx="30" cy="20" r="6" fill="rgba(59,130,246,0.6)" />
              <circle cx="60" cy="40" r="7" fill="rgba(139,92,246,0.6)" />
              <circle cx="90" cy="60" r="6" fill="rgba(34,197,94,0.6)" />
              <circle cx="60" cy="90" r="7" fill="rgba(59,130,246,0.6)" />
              <circle cx="30" cy="110" r="6" fill="rgba(139,92,246,0.6)" />
              <circle cx="60" cy="140" r="7" fill="rgba(34,197,94,0.6)" />
            </svg>
          </div>

          {/* Peptide chain 2 - middle left */}
          <div className="absolute left-[15%] top-[50%] opacity-50 hover:opacity-90 transition-opacity" style={{ animationDelay: "0.5s" }}>
            <svg width="100" height="140" viewBox="0 0 100 140" className="animate-pulse">
              {/* Molecular bonds */}
              <line x1="20" y1="10" x2="50" y2="30" stroke="rgba(34,197,94,0.4)" strokeWidth="2" />
              <line x1="50" y1="30" x2="80" y2="50" stroke="rgba(59,130,246,0.4)" strokeWidth="2" />
              <line x1="80" y1="50" x2="50" y2="80" stroke="rgba(139,92,246,0.4)" strokeWidth="2" />
              <line x1="50" y1="80" x2="20" y2="100" stroke="rgba(34,197,94,0.4)" strokeWidth="2" />
              
              {/* Amino acid nodes */}
              <circle cx="20" cy="10" r="5" fill="rgba(34,197,94,0.6)" />
              <circle cx="50" cy="30" r="6" fill="rgba(59,130,246,0.6)" />
              <circle cx="80" cy="50" r="5" fill="rgba(139,92,246,0.6)" />
              <circle cx="50" cy="80" r="6" fill="rgba(34,197,94,0.6)" />
              <circle cx="20" cy="100" r="5" fill="rgba(59,130,246,0.6)" />
            </svg>
          </div>

          {/* Peptide chain 3 - bottom left */}
          <div className="absolute left-[8%] bottom-[20%] opacity-55 hover:opacity-95 transition-opacity" style={{ animationDelay: "1s" }}>
            <svg width="110" height="150" viewBox="0 0 110 150" className="animate-pulse">
              {/* Molecular bonds */}
              <line x1="25" y1="20" x2="55" y2="45" stroke="rgba(139,92,246,0.4)" strokeWidth="2" />
              <line x1="55" y1="45" x2="85" y2="65" stroke="rgba(34,197,94,0.4)" strokeWidth="2" />
              <line x1="85" y1="65" x2="55" y2="95" stroke="rgba(59,130,246,0.4)" strokeWidth="2" />
              <line x1="55" y1="95" x2="25" y2="120" stroke="rgba(139,92,246,0.4)" strokeWidth="2" />
              
              {/* Amino acid nodes */}
              <circle cx="25" cy="20" r="6" fill="rgba(139,92,246,0.6)" />
              <circle cx="55" cy="45" r="7" fill="rgba(34,197,94,0.6)" />
              <circle cx="85" cy="65" r="6" fill="rgba(59,130,246,0.6)" />
              <circle cx="55" cy="95" r="7" fill="rgba(139,92,246,0.6)" />
              <circle cx="25" cy="120" r="6" fill="rgba(34,197,94,0.6)" />
            </svg>
          </div>
        </div>

        {/* Floating vials - right side (desktop) */}
        <div aria-hidden="true" className="pointer-events-none absolute right-0 top-0 hidden h-full w-[40%] lg:block">
          <div className="absolute right-[10%] top-[20%] h-72 w-14 animate-pulse">
            <div className="relative h-full">
              {/* Vial glow */}
              <div className="absolute -inset-8 rounded-full bg-blue-500/10 blur-2xl" />
              {/* Main vial */}
              <div className="absolute inset-0 rounded-b-[99px] rounded-t-xl border border-blue-300/20 bg-gradient-to-b from-blue-400/15 to-blue-600/20 backdrop-blur-sm">
                <div className="absolute inset-2 rounded-b-[95px] bg-gradient-to-b from-white/5 via-blue-300/10 to-transparent" />
                <div className="absolute bottom-1/3 left-1/2 h-20 w-1 -translate-x-1/2 rounded-full bg-blue-300/20" />
              </div>
            </div>
          </div>

          <div className="absolute right-[40%] top-[35%] h-56 w-10 animate-pulse" style={{ animationDelay: "0.7s" }}>
            <div className="relative h-full">
              <div className="absolute -inset-6 rounded-full bg-purple-500/8 blur-2xl" />
              <div className="absolute inset-0 rounded-b-[99px] rounded-t-lg border border-purple-300/15 bg-gradient-to-b from-purple-400/10 to-purple-600/15 backdrop-blur-sm">
                <div className="absolute inset-2 rounded-b-[95px] bg-gradient-to-b from-white/4 via-purple-300/8 to-transparent" />
              </div>
            </div>
          </div>

          <div className="absolute right-[15%] bottom-[15%] h-40 w-9 animate-pulse" style={{ animationDelay: "1.4s" }}>
            <div className="relative h-full">
              <div className="absolute -inset-5 rounded-full bg-cyan-500/8 blur-2xl" />
              <div className="absolute inset-0 rounded-b-[99px] rounded-t-lg border border-cyan-300/15 bg-gradient-to-b from-cyan-400/10 to-cyan-600/15 backdrop-blur-sm">
                <div className="absolute inset-2 rounded-b-[95px] bg-gradient-to-b from-white/4 via-cyan-300/8 to-transparent" />
              </div>
            </div>
          </div>
        </div>

        {/* Hero content */}
        <div className="relative z-10 mx-auto w-full max-w-7xl px-6 py-20 lg:px-8 lg:py-0 lg:w-[55%]">
          <p className="animate-fade-in text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-400 mb-8">
            Premium Biotech Research
          </p>

          <h1 className="animate-fade-in text-5xl sm:text-6xl lg:text-7xl font-bold leading-tight tracking-tight mb-6"
            style={{ animationDelay: "0.1s" }}>
            <span className="bg-gradient-to-r from-white via-white to-zinc-400 bg-clip-text text-transparent">
              Precision Without Compromise
            </span>
          </h1>

          <p className="animate-fade-in text-lg sm:text-xl text-zinc-400 max-w-lg mb-8"
            style={{ animationDelay: "0.2s" }}>
            Premium research compounds. Third-party tested. COA verified. USA fulfilled.
          </p>

          <div className="animate-fade-in flex flex-col sm:flex-row gap-4 mb-12"
            style={{ animationDelay: "0.3s" }}>
            <Link
              href="/products"
              className="group relative px-8 py-3.5 rounded-lg bg-white text-zinc-950 font-semibold text-center transition-all duration-300 hover:shadow-lg hover:shadow-white/20 active:scale-95"
            >
              <span className="relative z-10">Browse Products</span>
              <div className="absolute inset-0 rounded-lg bg-white opacity-0 group-hover:opacity-10 transition-opacity" />
            </Link>
            <Link
              href="/coa-library"
              className="group px-8 py-3.5 rounded-lg border border-zinc-700 text-zinc-200 font-semibold text-center transition-all duration-300 hover:border-zinc-500 hover:bg-zinc-800/50 active:scale-95"
            >
              View COA Library
            </Link>
          </div>

          {/* Stats */}
          <div className="animate-fade-in grid grid-cols-2 sm:grid-cols-4 gap-6 border-t border-zinc-800 pt-8"
            style={{ animationDelay: "0.4s" }}>
            <div>
              <p className="text-3xl font-bold text-white">40+</p>
              <p className="text-sm text-zinc-500 mt-1">Research Compounds</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-white">99%+</p>
              <p className="text-sm text-zinc-500 mt-1">Purity Standard</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-white">12</p>
              <p className="text-sm text-zinc-500 mt-1">Lab Partners</p>
            </div>
            <div>
              <p className="text-3xl font-bold text-white">100%</p>
              <p className="text-sm text-zinc-500 mt-1">Verified</p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ BUY 3 GET 1 FREE PROMO ═════════════════ */}
      <section className="relative isolate py-16 border-b border-zinc-800/50 bg-gradient-to-r from-emerald-950/40 via-zinc-950 to-emerald-950/40 overflow-hidden">
        {/* Animated background glow */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_40%_at_50%_50%,rgba(16,185,129,0.1),transparent)]" />
        
        <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 backdrop-blur-sm p-8 sm:p-12 text-center">
            <div className="flex items-center justify-center gap-3 mb-4">
              <span className="text-4xl">🎁</span>
              <span className="text-4xl">✨</span>
              <span className="text-4xl">🎉</span>
            </div>
            
            <h2 className="text-4xl sm:text-5xl font-bold text-white mb-3">
              Exclusive Summer Sale
            </h2>
            
            <p className="text-xl text-emerald-300 mb-4 font-semibold">
              Buy 3 Get 1 Free
            </p>
            
            <p className="text-lg text-zinc-300 mb-8 max-w-2xl mx-auto">
              This summer only: Add any 4 peptides to your cart and receive the cheapest one completely free. Automatically applied — no code needed.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <Link
                href="/products"
                className="px-10 py-4 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-600 text-white font-semibold transition-all duration-300 hover:shadow-lg hover:shadow-emerald-500/30 active:scale-95"
              >
                Shop Now & Save
              </Link>
              <p className="text-sm text-zinc-400">
                Valid on all 40+ research compounds • Exclusive summer offer
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ WHY VANTA LABS ═════════════════════════ */}
      <section className="py-20 border-b border-zinc-800/50 bg-zinc-950">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="max-w-2xl mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-3">Quality Assurance</p>
            <h2 className="text-4xl sm:text-5xl font-bold text-white">
              Why Vanta Labs
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {WHY_VANTA_FEATURES.map((feature) => (
              <div key={feature.title} className="group rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 transition-all duration-300 hover:border-zinc-700 hover:bg-zinc-900/50">
                <span className="text-5xl block mb-4">{feature.icon}</span>
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
      <section className="py-20 border-b border-zinc-800/50 bg-zinc-950/50">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="max-w-2xl mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-3">Best Sellers</p>
            <h2 className="text-4xl sm:text-5xl font-bold text-white">
              Featured Products
            </h2>
          </div>

          {/* Carousel */}
          <div className="relative">
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/30">
              <div className="aspect-video flex items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 relative">
                {FEATURED_PRODUCTS[carouselIndex] && (
                  <div key={carouselIndex} className="flex flex-col items-center justify-center w-full h-full animate-fade-in p-8">
                    <div className="text-6xl mb-4">🧪</div>
                    <h3 className="text-3xl font-bold text-white text-center mb-2">
                      {FEATURED_PRODUCTS[carouselIndex].name}
                    </h3>
                    <p className="text-xl text-zinc-400 mb-4">
                      {FEATURED_PRODUCTS[carouselIndex].price}
                    </p>
                    <div className="flex gap-4">
                      <span className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300">
                        {FEATURED_PRODUCTS[carouselIndex].purityResult}
                      </span>
                      <Link
                        href={`/products/${FEATURED_PRODUCTS[carouselIndex].slug}`}
                        className="px-6 py-2 rounded-lg bg-white text-zinc-950 font-semibold hover:bg-zinc-100 transition-colors"
                      >
                        View Details
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Carousel controls */}
            <div className="flex justify-center gap-2 mt-6">
              {FEATURED_PRODUCTS.map((_, idx) => (
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
      <section className="py-20 border-b border-zinc-800/50 bg-zinc-950">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-4">Quality Verification</p>
              <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6">
                Every Batch Verified
              </h2>
              <p className="text-lg text-zinc-400 mb-6">
                Every product is accompanied by independent laboratory testing with downloadable Certificates of Analysis. Our commitment to transparency means you can verify the quality and purity of every batch.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link
                  href="/coa-library"
                  className="px-8 py-3.5 rounded-lg bg-white text-zinc-950 font-semibold text-center transition-all hover:shadow-lg hover:shadow-white/20 active:scale-95"
                >
                  Browse COA Library
                </Link>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-12 flex items-center justify-center aspect-square">
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
      <section className="py-20 border-b border-zinc-800/50 bg-zinc-950/50 relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.1),transparent_70%)]" />
        
        <div className="mx-auto max-w-7xl px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-3xl mx-auto mb-12">
            <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-zinc-500 mb-4">Scientific Excellence</p>
            <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6">
              State-of-the-Art Laboratory
            </h2>
            <p className="text-lg text-zinc-400">
              Our research compounds are produced in accredited laboratories utilizing cutting-edge analytical equipment and rigorous quality control protocols. Every batch undergoes comprehensive testing to ensure consistency and purity.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center hover:border-zinc-700 transition-colors">
              <div className="text-5xl mb-4">🔬</div>
              <h3 className="text-xl font-semibold text-white mb-2">Advanced Analytics</h3>
              <p className="text-zinc-400">HPLC, GC-MS, and NMR spectroscopy for precise compound analysis.</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center hover:border-zinc-700 transition-colors">
              <div className="text-5xl mb-4">🧪</div>
              <h3 className="text-xl font-semibold text-white mb-2">Rigorous Testing</h3>
              <p className="text-zinc-400">Comprehensive QC protocols and batch verification procedures.</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center hover:border-zinc-700 transition-colors">
              <div className="text-5xl mb-4">📊</div>
              <h3 className="text-xl font-semibold text-white mb-2">Full Transparency</h3>
              <p className="text-zinc-400">Complete documentation and COA with molecular formulas.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ CTA SECTION ═════════════════════════════ */}
      <section className="py-20 border-b border-zinc-800/50 bg-zinc-950">
        <div className="mx-auto max-w-4xl px-6 lg:px-8 text-center">
          <h2 className="text-4xl sm:text-5xl font-bold text-white mb-6">
            Ready to get started?
          </h2>
          <p className="text-lg text-zinc-400 mb-8 max-w-2xl mx-auto">
            Explore our complete catalog of premium research compounds, all verified, tested, and ready to ship.
          </p>
          <Link
            href="/products"
            className="inline-block px-10 py-4 rounded-lg bg-white text-zinc-950 font-semibold transition-all hover:shadow-lg hover:shadow-white/20 active:scale-95"
          >
            Browse Full Catalog
          </Link>
        </div>
      </section>

      {/* ═══════════════════════════ FOOTER ═════════════════════════════════ */}
      <footer className="bg-zinc-950 border-t border-zinc-800/50">
        <div className="mx-auto max-w-7xl px-6 lg:px-8 py-16">
          <div className="grid md:grid-cols-4 gap-12 mb-12">
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
              <form className="flex">
                <input
                  type="email"
                  placeholder="Enter email"
                  className="flex-1 rounded-l-lg bg-zinc-900 border border-zinc-800 border-r-0 px-4 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
                />
                <button
                  type="submit"
                  className="rounded-r-lg bg-white text-zinc-950 px-4 py-2 text-sm font-semibold hover:bg-zinc-100 transition-colors"
                >
                  Subscribe
                </button>
              </form>
            </div>
          </div>

          <div className="border-t border-zinc-800 pt-8 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-zinc-500">
            <p>&copy; 2026 Vanta Labs. All rights reserved. Research use only.</p>
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
