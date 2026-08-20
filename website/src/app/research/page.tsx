import type { Metadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import Link from "next/link";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { getAllArticles } from "@/lib/articles";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  path: "/research",
  title: "Research Library",
  description:
    "Educational guides on research-use-only materials: reading a COA, purity and third-party testing, storage, and more.",
});

export default async function ResearchLibraryPage() {
  const articles = await getAllArticles();

  // Reading time is derived from the body we already have rather than stored,
  // so no content shape changes. 200 wpm, rounded up, floor of 1.
  const withMeta = articles.map((article) => ({
    ...article,
    minutes: Math.max(1, Math.ceil(article.body.trim().split(/\s+/).length / 200)),
  }));

  const [lead, ...rest] = withMeta;

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      {/* Widened from max-w-4xl. Four cards in a narrow column left the page
          mostly empty and made the library look unfinished rather than curated. */}
      <main className="mx-auto max-w-[1200px] px-4 pb-24 pt-28 sm:px-6 sm:pt-32 lg:px-12">
        <header className="max-w-2xl">
          <p className="vl2-eyebrow">Research Library</p>
          <h1 className="vl2-serif mt-3 text-[2.25rem] leading-[1.1] text-white sm:text-5xl">Guides &amp; education</h1>
          <p className="mt-4 text-[0.9375rem] leading-7 text-white/55">
            Clear, research-focused guides on quality, testing, and safe lab practice. For laboratory research use only —
            no medical or dosing guidance is provided.
          </p>
        </header>

        {/* The first guide leads at full width. A flat grid of four equal boxes
            gives the reader no idea where to start. */}
        {lead ? (
          <Link href={`/research/${lead.slug}`} className="vl-article-card group mt-12 block overflow-hidden rounded-[20px] p-7 sm:p-10">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="vl2-eyebrow text-[10px] text-[color:var(--accent-gold)]">Start here</span>
              <span aria-hidden="true" className="h-px w-8 bg-white/15" />
              <span className="text-[11px] uppercase tracking-[0.16em] text-white/35">{lead.minutes} min read</span>
            </div>
            <h2 className="vl2-serif mt-4 max-w-3xl text-[1.75rem] leading-[1.15] text-white transition-colors duration-200 group-hover:text-white sm:text-[2.25rem]">
              {lead.title}
            </h2>
            <p className="mt-4 max-w-2xl text-[0.9375rem] leading-7 text-white/55">{lead.excerpt}</p>
            <span className="vl-article-link mt-6">
              Read article
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
          </Link>
        ) : null}

        {rest.length > 0 ? (
          <div className="mt-5 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {rest.map((article, index) => (
              <Link key={article.slug} href={`/research/${article.slug}`} className="vl-article-card group flex flex-col rounded-[20px] p-6 sm:p-7">
                <div className="flex items-center justify-between">
                  <span aria-hidden="true" className="vl2-serif text-[1.75rem] leading-none text-white/12">
                    {String(index + 2).padStart(2, "0")}
                  </span>
                  <span className="text-[11px] uppercase tracking-[0.16em] text-white/30">{article.minutes} min</span>
                </div>
                <h2 className="vl2-serif mt-5 text-[1.25rem] leading-[1.25] text-white">{article.title}</h2>
                <p className="mt-3 flex-1 text-[0.875rem] leading-6 text-white/50">{article.excerpt}</p>
                <span className="vl-article-link mt-6">
                  Read article
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>
        ) : null}

        <p className="mt-14 border-t border-white/[0.06] pt-6 text-[11px] uppercase tracking-[0.2em] text-white/25">
          For laboratory research use only
        </p>
      </main>
    </div>
  );
}
