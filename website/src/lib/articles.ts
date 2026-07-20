import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";

// -------------------------------------------------------------------------
// Research Library — educational, compliance-forward content.
//
// These articles drive organic SEO traffic AND reinforce the store's legal
// positioning (research-use-only, no medical claims, quality/COA emphasis),
// which protects the business. Editable from Admin → Content (stored in the
// "articles" control section, keyed by slug). Body uses the same tiny markup
// as policies: "## " is a heading; blank lines separate paragraphs.
// -------------------------------------------------------------------------

export const ARTICLE_SLUGS = [
  "research-use-only",
  "how-to-read-a-coa",
  "storing-and-handling",
  "purity-and-third-party-testing",
] as const;

export type ArticleSlug = (typeof ARTICLE_SLUGS)[number];

export interface Article {
  slug: ArticleSlug;
  title: string;
  excerpt: string;
  updated: string;
  body: string;
}

const DEFAULTS: Record<ArticleSlug, { title: string; excerpt: string; body: string }> = {
  "research-use-only": {
    title: "What “Research Use Only” Actually Means",
    excerpt: "Why these materials are for the lab bench — not for people or animals — and what that means for buyers.",
    body: `“Research use only” (RUO) is a defined category of materials intended for laboratory research, not for human or veterinary use.

## Not a drug or supplement
RUO materials are not drugs, dietary supplements, food, or medical devices. They are not intended to diagnose, treat, cure, or prevent any condition, and no preparation, dosage, or administration guidance is provided.

## Who they're for
They're sold to qualified researchers and institutions for in-vitro and laboratory study. By purchasing, buyers confirm they are 21+, legally permitted to buy in their jurisdiction, and will handle the materials responsibly.

## Why this matters
Clear RUO labeling protects both the researcher and the supplier and keeps the focus where it belongs — on transparent, well-documented laboratory materials.`,
  },
  "how-to-read-a-coa": {
    title: "How to Read a Certificate of Analysis (COA)",
    excerpt: "A COA is your window into a material's identity and purity. Here's how to read one with confidence.",
    body: `A Certificate of Analysis (COA) is a third-party lab report describing a specific batch of material.

## Identity
Confirms the material matches what's on the label, typically via mass spectrometry (MS) — the measured mass should match the expected molecular weight.

## Purity
Usually reported by HPLC as a percentage. Higher purity means fewer impurities. Look for the method and the batch number so the COA ties to your specific lot.

## Batch matching
A COA is only meaningful when its batch number matches the batch you received. Always cross-check them.

## Where to find ours
Every batch's COA is available in our COA Library, linked from each product.`,
  },
  "storing-and-handling": {
    title: "Storing & Handling Research Materials",
    excerpt: "Good lab practice for keeping materials stable — general storage principles, no dosing or use guidance.",
    body: `Proper storage preserves the integrity of laboratory materials. The following is general lab-practice information, not use or dosing guidance.

## General principles
Keep materials sealed, protected from light, moisture, and heat, and stored at the temperature indicated on the label or COA. Lyophilized (freeze-dried) materials are generally more stable than reconstituted ones.

## Labeling
Keep the batch number with the material so it always ties back to its COA.

## Safety
Handle all laboratory materials with appropriate protective equipment and follow your institution's safety protocols. These materials are not for human or animal use.`,
  },
  "purity-and-third-party-testing": {
    title: "Purity & Third-Party Testing, Explained",
    excerpt: "What independent testing tells you — and why it's the most important trust signal in this space.",
    body: `Independent, third-party testing is the clearest signal of a trustworthy supplier.

## Why third-party
An in-house claim is just a claim. A COA from an independent lab is verifiable evidence of a batch's identity and purity.

## What to look for
Look for the testing method (e.g., HPLC for purity, MS for identity), the measured result, and a batch number that matches your material.

## Our standard
We publish COAs per batch so you can verify exactly what you received — no vague marketing claims, just documentation.`,
  },
};

export async function getArticle(slug: ArticleSlug): Promise<Article> {
  const fallback = DEFAULTS[slug];
  try {
    const snapshot = await getControlSnapshot("articles");
    const o = (snapshot.articles ?? {})[slug] as { title?: string; excerpt?: string; body?: string; updated?: string } | undefined;
    return {
      slug,
      title: (o?.title && o.title.trim()) || fallback.title,
      excerpt: (o?.excerpt && o.excerpt.trim()) || fallback.excerpt,
      updated: (o?.updated && String(o.updated).trim()) || "2026",
      body: (o?.body && o.body.trim()) || fallback.body,
    };
  } catch {
    return { slug, ...fallback, updated: "2026" };
  }
}

export async function getAllArticles(): Promise<Article[]> {
  return Promise.all(ARTICLE_SLUGS.map((slug) => getArticle(slug)));
}

export function isArticleSlug(value: string): value is ArticleSlug {
  return (ARTICLE_SLUGS as readonly string[]).includes(value);
}
