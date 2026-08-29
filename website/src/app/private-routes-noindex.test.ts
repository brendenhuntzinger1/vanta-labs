import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ROUTES THAT MUST NOT BECOME SEARCH RESULTS CARRY A REAL noindex.
 *
 * robots.txt Disallow stops CRAWLING, not INDEXING. A blocked URL that is
 * linked from anywhere public can still be listed, as a bare URL with no
 * snippet, because Google never fetched the page to learn it was unwanted —
 * and a page blocked in robots.txt can never show Google its noindex, so
 * blocking a page is the one reliable way to guarantee its noindex is never
 * read. checkout/layout.tsx already says this in its own comment.
 *
 * Verified against live production, which is what put this file here:
 *
 *   /partner/pending  200, "index, follow", NOT in robots.txt's disallow set,
 *                     reachable by anyone. A personalised application-status
 *                     page ("Pending Approval", "Application Not Approved")
 *                     that was fully indexable.
 *   /cart/restore     200, "index, follow", protected by robots.txt alone. It
 *                     restores a cart from an abandoned-cart email link, so it
 *                     both mutates state and is per-recipient.
 *
 * Both are Client Components, which in the App Router cannot export metadata at
 * all — hence the co-located layout, the same shape vault/ and checkout/ use.
 */

const APP = join(process.cwd(), "src/app");

/** Routes that must never be indexed, whatever robots.txt happens to say. */
const MUST_NOINDEX = [
  "partner/pending",
  "cart/restore",
  "cart",
  "checkout",
  "vault",
  "maintenance",
  "account/login",
  "order-confirmation/[orderId]",
];

const hasNoindex = (path: string) =>
  existsSync(path) && /robots:\s*\{[^}]*index:\s*false/.test(readFileSync(path, "utf8"));

/**
 * A route is covered by its OWN page.tsx, or by a layout.tsx at or above it.
 *
 * Only LAYOUTS cascade. A sibling route's page.tsx does not, which an earlier
 * version of this helper got wrong: it walked page.tsx files up the tree and so
 * reported cart/restore as covered by cart/page.tsx. Production disagreed —
 * /cart/restore served "index, follow" — and production was right.
 */
function noindexDeclaredFor(route: string): boolean {
  const segments = route.split("/").filter(Boolean);
  if (hasNoindex(join(APP, ...segments, "page.tsx"))) return true;
  for (let i = segments.length; i >= 0; i--) {
    if (hasNoindex(join(APP, ...segments.slice(0, i), "layout.tsx"))) return true;
  }
  return false;
}

describe("private and utility routes are noindex in their own right", () => {
  it.each(MUST_NOINDEX)("%s declares noindex", (route) => {
    expect(noindexDeclaredFor(route)).toBe(true);
  });

  it("does not noindex anything the sitemap publishes", () => {
    // The other half of the guard: a noindex that creeps onto a page we are
    // asking Google to index is worse than a missing one.
    for (const route of ["", "products", "coa-library", "research", "partner", "membership", "wholesale", "contact", "ambassador"]) {
      expect(noindexDeclaredFor(route), `${route || "/"} must stay indexable`).toBe(false);
    }
  });
});
