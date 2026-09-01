import { describe, expect, it } from "vitest";

import { articleBreadcrumbs, articleDateModified, articleSchema, type ArticleLike } from "./article-structured-data";
import { breadcrumbList } from "./breadcrumbs";
import { organizationId, siteUrl } from "./site-identity";

const SITE = "https://www.vantalabsresearch.com";
const ORG = `${SITE}/#organization`;

const article: ArticleLike = {
  slug: "how-to-read-a-coa",
  title: "How to Read a Certificate of Analysis (COA)",
  excerpt: "A COA is your window into a material's identity and purity.",
  updated: "2026",
};

describe("dateModified is never invented", () => {
  it("omits the bare year the articles default to, rather than expanding it", () => {
    // "2026" is what getArticle() returns when no operator has set a date.
    // Expanding that to 2026-01-01 would publish a date nobody chose.
    expect(articleDateModified("2026")).toBeUndefined();
  });

  it("omits anything that is not a real date", () => {
    expect(articleDateModified(undefined)).toBeUndefined();
    expect(articleDateModified("")).toBeUndefined();
    expect(articleDateModified("last spring")).toBeUndefined();
    expect(articleDateModified("2026-13-45")).toBeUndefined();
  });

  it("passes through a genuine ISO date", () => {
    expect(articleDateModified("2026-08-29")).toBe("2026-08-29");
    expect(articleDateModified(" 2026-08-29 ")).toBe("2026-08-29");
  });
});

describe("article schema", () => {
  it("resolves publisher and author to the ONE organization node the rest of the site declares", () => {
    // The whole point in a crowded namespace: every node votes for one entity.
    const schema = articleSchema({ article, siteUrl: SITE, organizationId: ORG });
    expect(schema.publisher).toEqual({ "@id": ORG });
    expect(schema.author).toEqual({ "@id": ORG });
  });

  it("uses the real organization id the site actually emits", () => {
    // Guards against this module inventing its own @id format and silently
    // failing to join the graph the homepage builds.
    expect(organizationId()).toBe(`${siteUrl()}/#organization`);
  });

  it("points headline, url and mainEntityOfPage at the article itself", () => {
    const schema = articleSchema({ article, siteUrl: SITE, organizationId: ORG });
    expect(schema.headline).toBe(article.title);
    expect(schema.description).toBe(article.excerpt);
    expect(schema.url).toBe(`${SITE}/research/how-to-read-a-coa`);
    expect(schema.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": `${SITE}/research/how-to-read-a-coa` });
  });

  it("omits dateModified entirely when the article carries only a year", () => {
    expect(articleSchema({ article, siteUrl: SITE, organizationId: ORG })).not.toHaveProperty("dateModified");
  });

  it("includes dateModified once a real date is set", () => {
    const dated = articleSchema({
      article: { ...article, updated: "2026-08-29" },
      siteUrl: SITE,
      organizationId: ORG,
    });
    expect(dated).toHaveProperty("dateModified", "2026-08-29");
  });
});

describe("article breadcrumbs", () => {
  it("walks Home > Research > article", () => {
    const crumbs = articleBreadcrumbs({ article, siteUrl: SITE });
    expect(crumbs.itemListElement.map((c) => c.item)).toEqual([
      `${SITE}/`,
      `${SITE}/research`,
      `${SITE}/research/how-to-read-a-coa`,
    ]);
  });
});

describe("the shared breadcrumb builder", () => {
  it("assigns positions itself, so a trail cannot skip or repeat one", () => {
    const crumbs = breadcrumbList([
      { name: "Home", url: "https://x.test/" },
      { name: "Research", url: "https://x.test/research" },
    ]);
    expect(crumbs.itemListElement.map((c) => c.position)).toEqual([1, 2]);
  });

  it("produces an empty trail rather than throwing on no crumbs", () => {
    expect(breadcrumbList([]).itemListElement).toEqual([]);
  });
});
