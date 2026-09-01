import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { getArticle, isArticleSlug, ARTICLE_SLUGS } from "@/lib/articles";
import { articleBreadcrumbs, articleSchema } from "@/lib/article-structured-data";
import { organizationId, siteUrl } from "@/lib/site-identity";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return ARTICLE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!isArticleSlug(slug)) return {};
  const article = await getArticle(slug);
  return { title: article.title, description: article.excerpt, alternates: { canonical: `/research/${slug}` } };
}

function renderBody(body: string) {
  return body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block, index) =>
      block.startsWith("## ") ? (
        <h2 key={index} className="vl2-serif mt-8 text-xl text-white">{block.slice(3).trim()}</h2>
      ) : (
        <p key={index} className="text-sm leading-7 text-white/70">{block}</p>
      ),
    );
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isArticleSlug(slug)) {
    notFound();
  }
  const article = await getArticle(slug);

  // These pages shipped with no structured data at all, so nothing told Google
  // they were articles rather than more storefront — on the one part of the
  // site that competes against almost nobody. Escaped exactly as the product
  // page's JSON-LD is, so it can never break out of the script tag.
  const SITE_URL = siteUrl();
  const articleLd = articleSchema({ article, siteUrl: SITE_URL, organizationId: organizationId() });
  const breadcrumbLd = articleBreadcrumbs({ article, siteUrl: SITE_URL });

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd).replace(/</g, "\\u003c") }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd).replace(/</g, "\\u003c") }}
      />
      <SiteHeaderV2 />
      <main className="vl-nav-clearance mx-auto max-w-3xl px-6 pb-24 pt-32 lg:px-12">
        <Link href="/research" className="text-xs text-white/45 transition hover:text-white">← Research Library</Link>
        <p className="vl2-eyebrow mt-6">Research Library</p>
        <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">{article.title}</h1>
        <p className="mt-2 text-xs text-white/70">Updated: {article.updated}</p>
        <div className="mt-8 space-y-4">{renderBody(article.body)}</div>

        <div className="mt-12 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-xs leading-6 text-white/45">
          For laboratory research use only. Not for human or animal use. This content is educational and does not
          constitute medical advice.
        </div>
      </main>
    </div>
  );
}
