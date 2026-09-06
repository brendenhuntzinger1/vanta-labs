import { describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/access-policy";
import { ARTICLE_SLUGS } from "@/lib/articles";
import { POLICY_SLUGS } from "@/lib/legal-content";

vi.mock("@/lib/site-identity", () => ({ siteUrl: () => "https://www.vantalabsresearch.com" }));

// ---------------------------------------------------------------------------
// A SITEMAP MAY ONLY ADVERTISE WHAT AN ANONYMOUS CRAWLER CAN ACTUALLY BE SERVED.
//
// The list and the rule used to live in two files. Closing the default in
// access-policy.ts gated the home page, /membership and the whole research
// library; sitemap.ts still offered all seven URLs, and every one of them
// answered 307 to /account/login. Measured on the harness build: 10 of 17
// entries servable.
//
// This is the test that would have failed on that deploy. It does not hardcode
// which URLs are public — that is exactly the duplication that caused the bug —
// it asks the wall.
// ---------------------------------------------------------------------------
describe("sitemap.xml advertises only what the wall serves", () => {
  it("every URL it lists is public", async () => {
    const { default: sitemap } = await import("./sitemap");
    const entries = await sitemap();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const pathname = new URL(entry.url).pathname;
      expect(isPublicPath(pathname), `${pathname} is in the sitemap but requires an account`).toBe(true);
    }
  });

  it("carries no product or COA URL, whatever the access policy says", async () => {
    const { default: sitemap } = await import("./sitemap");
    for (const entry of await sitemap()) {
      expect(entry.url).not.toMatch(/\/products/);
      expect(entry.url).not.toMatch(/\/coa-library/);
    }
  });

  it("still lists the pages that ARE public, so the fix is not 'ship an empty sitemap'", async () => {
    const { default: sitemap } = await import("./sitemap");
    const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
    for (const expected of ["/contact", "/wholesale", "/ambassador", "/partner"]) {
      expect(paths, `${expected} is public and belongs in the sitemap`).toContain(expected);
    }
    for (const slug of POLICY_SLUGS) {
      expect(paths).toContain(`/legal/${slug}`);
    }
  });

  it("drops the gated brand pages that the closed default moved behind the wall", async () => {
    const { default: sitemap } = await import("./sitemap");
    const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
    // Guarded by isPublicPath so that OPENING one of these again puts it back
    // automatically rather than failing this test.
    for (const gated of ["/", "/membership", "/research", ...ARTICLE_SLUGS.map((s) => `/research/${s}`)]) {
      if (!isPublicPath(gated)) {
        expect(paths, `${gated} requires an account and must not be advertised`).not.toContain(gated);
      }
    }
  });
});

describe("robots.txt does not invite crawlers through the wall", () => {
  it("disallows every gated prefix it names a page under", async () => {
    process.env.VERCEL_ENV = "production";
    const { default: robots } = await import("./robots");
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallow = ([] as string[]).concat(rule.disallow as string[]);

    // Every one of these requires an account, so a crawler fetching it gets a
    // redirect. Asking it not to is the whole point of the list.
    for (const gated of ["/products", "/coa-library", "/research", "/membership", "/account", "/cart", "/checkout"]) {
      expect(isPublicPath(gated), `${gated} is expected to be gated`).toBe(false);
      expect(disallow, `${gated} is gated and should be disallowed`).toContain(gated);
    }
  });

  it("never disallows a public page", async () => {
    process.env.VERCEL_ENV = "production";
    const { default: robots } = await import("./robots");
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallow = ([] as string[]).concat(rule.disallow as string[]);

    for (const publicPath of ["/contact", "/wholesale", "/ambassador", "/partner", "/legal/privacy"]) {
      const blocked = disallow.some((d) => publicPath === d || publicPath.startsWith(d.endsWith("/") ? d : `${d}/`));
      expect(blocked, `${publicPath} is public and must stay crawlable`).toBe(false);
    }
  });
});
