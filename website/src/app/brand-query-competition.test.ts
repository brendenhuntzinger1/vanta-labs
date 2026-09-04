import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_SHORT_NAME, TITLE_TEMPLATE } from "@/lib/site-identity";

const read = (rel: string) => readFileSync(join(process.cwd(), "src/app", rel), "utf8");

/** The document title a page's `pageMetadata({ title })` literal produces. */
function documentTitle(source: string): string {
  const call = source.slice(source.indexOf("pageMetadata({"));
  const literal = call.match(/title:\s*"([^"]+)"/)?.[1];
  if (!literal) throw new Error("no pageMetadata title literal found");
  return TITLE_TEMPLATE.replace("%s", literal);
}

/**
 * ONLY THE HOMEPAGE MAY READ AS "VANTA LABS" + "RESEARCH" IN A SEARCH RESULT.
 *
 * The entity name is "Vanta Labs Research". Inner pages carry the short suffix
 * "| Vanta Labs" precisely so that none of them competes with the homepage for
 * that query (see site-identity.ts). The research library defeated that rule by
 * accident: "Research Library | Vanta Labs" is the entity name split in two,
 * on a URL that repeats the word.
 *
 * Search Console, 29 Aug – 3 Sep 2026: every impression for the query
 * "vanta labs research" went to /research, and none to the homepage. The
 * homepage was unreadable to Google's renderer for most of that window (the
 * age gate hid it), so title and URL were the only signals it had, and this
 * title won. The library's job is to rank for "how to read a COA", not for the
 * company's name; the homepage is where a brand query has to land.
 */
describe("the research library does not compete with the homepage for the brand query", () => {
  it("keeps the word 'research' out of its document title", () => {
    const title = documentTitle(read("research/page.tsx"));
    expect(title).toContain(BRAND_SHORT_NAME);
    expect(title).not.toMatch(/research/i);
  });
});
