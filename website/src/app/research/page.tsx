import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { getAllArticles } from "@/lib/articles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Research Library",
  description: "Educational guides on research-use-only materials: reading a COA, purity and third-party testing, storage, and more.",
};

export default async function ResearchLibraryPage() {
  const articles = await getAllArticles();

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-32 lg:px-12">
        <p className="vl2-eyebrow">Research Library</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Guides &amp; education</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-white/60">
          Clear, research-focused guides on quality, testing, and safe lab practice. For laboratory research use only — no
          medical or dosing guidance is provided.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {articles.map((article) => (
            <Link
              key={article.slug}
              href={`/research/${article.slug}`}
              className="vl2-product-card block p-6 transition"
            >
              <h2 className="vl2-serif text-xl text-white">{article.title}</h2>
              <p className="mt-2 text-sm leading-6 text-white/55">{article.excerpt}</p>
              <span className="mt-4 inline-block text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--accent-gold)]">Read →</span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
