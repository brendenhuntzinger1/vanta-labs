import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LegalPage } from "@/components/legal-page";
import { getPolicy, isPolicySlug, POLICY_SLUGS } from "@/lib/legal-content";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return POLICY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  if (!isPolicySlug(slug)) return {};
  const policy = await getPolicy(slug);
  return { title: policy.title, description: `${policy.title} — Vanta Labs.` };
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
