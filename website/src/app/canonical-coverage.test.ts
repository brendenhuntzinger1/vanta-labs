import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY URL THE SITEMAP OFFERS TO GOOGLE MUST DECLARE ITS OWN CANONICAL.
 *
 * The root layout used to carry `alternates: { canonical: "/" }`. In the App
 * Router that is INHERITED by every child route that does not set its own, and
 * the relative path is not re-resolved per route — so each inheriting page
 * announced, in its own <head>, that it was a duplicate of the homepage.
 *
 * Confirmed against live production before the fix: every research article,
 * every legal policy and /partner served
 *
 *     <link rel="canonical" href="https://www.vantalabsresearch.com">
 *
 * That is ~30 indexable URLs — the entire research library and every policy
 * page — asking Google to drop them and fold them into the homepage, while the
 * sitemap simultaneously offered them up for indexing. The two signals directly
 * contradicted each other.
 *
 * The failure is invisible from the outside: the pages render, return 200 and
 * read correctly to a human. Only the <head> shows it. Hence a structural test.
 *
 * The list below is the sitemap's own route table. If a route is added to
 * sitemap.ts it belongs here too — a URL worth offering to Google is a URL
 * worth pointing at itself.
 */

const APP = join(process.cwd(), "src/app");
const read = (rel: string) => readFileSync(join(APP, rel), "utf8");

/** sitemap route -> the page file that serves it. */
const SITEMAP_PAGES: Array<[route: string, file: string]> = [
  ["/", "page.tsx"],
  ["/products", "products/page.tsx"],
  ["/products/[slug]", "products/[slug]/page.tsx"],
  ["/coa-library", "coa-library/page.tsx"],
  ["/membership", "membership/page.tsx"],
  ["/ambassador", "ambassador/page.tsx"],
  ["/partner", "partner/page.tsx"],
  ["/contact", "contact/page.tsx"],
  ["/wholesale", "wholesale/page.tsx"],
  ["/research", "research/page.tsx"],
  ["/research/[slug]", "research/[slug]/page.tsx"],
  ["/legal/[slug]", "legal/[slug]/page.tsx"],
];

describe("canonical coverage", () => {
  it("the root layout does not hand a canonical down to its children", () => {
    // The homepage sets its own (see below). Putting it on the layout is what
    // silently applied it to ~30 other pages.
    expect(read("layout.tsx")).not.toMatch(/alternates:\s*\{\s*canonical/);
  });

  it("covers every static route the sitemap publishes", () => {
    // Guards the guard: if sitemap.ts grows a route and this table does not,
    // the new route is unprotected and this test says so.
    const sitemap = read("sitemap.ts");
    const declared = [...sitemap.matchAll(/"(\/[a-z-]*)"/g)].map((m) => m[1]);
    const covered = new Set(SITEMAP_PAGES.map(([route]) => route));
    for (const route of declared) {
      expect(covered.has(route === "" ? "/" : route), `sitemap route ${route} is not covered`).toBe(true);
    }
  });

  it.each(SITEMAP_PAGES)("%s declares its own canonical", (_route, file) => {
    const src = read(file);
    const declaresOwn = src.includes("pageMetadata") || /alternates:\s*\{\s*canonical/.test(src);
    expect(declaresOwn).toBe(true);
  });
});
