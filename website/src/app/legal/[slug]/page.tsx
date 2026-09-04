import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalPage } from "@/components/legal-page";
import { getPolicy, isPolicySlug, POLICY_SLUGS } from "@/lib/legal-content";
import { pageMetadata } from "@/lib/page-metadata";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return POLICY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!isPolicySlug(slug)) return {};
  const policy = await getPolicy(slug);
  // The description was `${policy.title} — Vanta Labs.` — 27 to 43 characters
  // that repeat the title and say nothing, the six shortest on the site
  // against 96+ everywhere else, with the policy's own text sitting unused on
  // the line above. It now opens with the policy itself.
  //
  // Via pageMetadata for the same reason as the research route: a bare object
  // inherits the root layout's Open Graph, so these pages advertised
  // themselves as the home page.
  return pageMetadata({
    path: `/legal/${slug}`,
    title: policy.title,
    description: summarisePolicy(policy.title, policy.body),
  });
}


/**
 * A meta description drawn from the policy's own opening, rather than from its
 * title repeated back.
 *
 * Policies are admin-editable free text, so this takes whole sentences and
 * stops before the 160 characters Google renders — a description cut
 * mid-clause reads worse than a shorter whole one. Falls back to naming the
 * document when a policy's body is empty or its first sentence is longer than
 * the budget.
 */
function summarisePolicy(title: string, body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return `${title} for Vanta Labs Research.`;
  let out = "";
  for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
    if (out && (out + " " + sentence).length > 155) break;
    out = out ? `${out} ${sentence}` : sentence;
    if (out.length > 110) break;
  }
  return out.length > 30 ? out : `${title} for Vanta Labs Research. ${flat}`.slice(0, 155).trim();
}

// All policy pages (Research Disclaimer, Privacy, Terms, Shipping, Refund,
// Cookies) render from admin-editable content via one route.
export default async function PolicyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isPolicySlug(slug)) {
    notFound();
  }
  const policy = await getPolicy(slug);
  return <LegalPage title={policy.title} updated={policy.updated} body={policy.body} />;
}
