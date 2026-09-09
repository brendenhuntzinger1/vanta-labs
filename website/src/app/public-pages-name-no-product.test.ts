import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { isPublicPath } from "@/lib/access-policy";
import { selectStackImages } from "@/components/wholesale-vial-stack";

// ---------------------------------------------------------------------------
// A PAGE THAT IS PUBLIC MAY NOT PUBLISH THE CATALOGUE THE WALL WITHHOLDS.
//
// /wholesale, /ambassador, /partner and /contact are exempt from the account
// wall on purpose: recruitment and support cannot sit behind a login. That
// exemption is only sound while those pages say nothing the gate exists to
// withhold — and one of them did.
//
// /wholesale composes its hero from real catalogue photography, and each
// photograph carried `alt={product.name}`. When the catalogue was public that
// was merely a caption. Once access-policy.ts closed the default it became the
// single remaining route by which a compound name reached an anonymous reader.
// Measured on the harness build, in the HTML served with no cookie at all:
//
//     alt="BPC-157 10mg"
//     alt="Recon Water 30ml"
//
// The photographs stay — their URLs are opaque storage UUIDs and the
// composition is the page's whole visual language. The NAMES do not.
// ---------------------------------------------------------------------------

const APP = join(process.cwd(), "src/app");

/**
 * Strip comments, so prose ABOUT the banned pattern is not mistaken for it.
 *
 * The same guard catalog-behind-account.test.ts uses, and for the same reason:
 * the comment recording why an alt attribute was removed contains the exact
 * string the assertion looks for.
 */
function code(src: string) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

describe("the wholesale hero shows photography without naming it", () => {
  it("selectStackImages carries no product name", () => {
    const picked = selectStackImages([
      { image: "https://storage.example/product-images/uuid-1/opaque", coverImage: null },
      { image: "https://storage.example/product-images/uuid-2/opaque", coverImage: null },
    ] as Array<{ image?: string | null; coverImage?: string | null }>, 2);

    expect(picked.length).toBeGreaterThan(0);
    for (const entry of picked) {
      expect(Object.keys(entry)).toEqual(["src"]);
    }
  });

  it("the component never renders a product name as alt text", () => {
    const source = code(readFileSync(join(process.cwd(), "src/components/wholesale-vial-stack.tsx"), "utf8"));
    // The regression, exactly: an alt attribute fed from the stack entry.
    expect(source).not.toMatch(/alt=\{[^}]*\.alt\}/);
    expect(source).not.toMatch(/alt=\{[^}]*\.name\}/);
    expect(source).not.toMatch(/alt:\s*product\.name/);
  });
});

describe("no public page renders product names from the catalogue", () => {
  /** Every page.tsx under src/app, as a route path. */
  function routes(dir: string, prefix = ""): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      // Route groups "(x)" and private folders "_x" do not appear in the URL.
      const segment = entry.startsWith("(") || entry.startsWith("_") ? "" : `/${entry}`;
      const path = `${prefix}${segment}`;
      try {
        statSync(join(full, "page.tsx"));
        found.push(path || "/");
      } catch {
        /* no page at this level */
      }
      found.push(...routes(full, path));
    }
    return found;
  }

  /**
   * Exempt from the CUSTOMER wall, but NOT anonymous.
   *
   * access-policy.ts lists these because they carry their OWN authentication
   * boundary — putting the customer gate in front of an admin login would lock
   * the owner out of their own store. So /admin/products naming a product is
   * correct: only an authenticated admin ever sees it. The invariant here is
   * about pages an ANONYMOUS reader can actually be served, which is what
   * isPublicPath alone does not distinguish.
   */
  const SELF_AUTHENTICATING = ["/admin", "/vault", "/partner/dashboard", "/partner/pending"];

  const PUBLIC_PAGES = routes(APP).filter(
    (route) =>
      !route.includes("[")
      && isPublicPath(route)
      && !SELF_AUTHENTICATING.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)),
  );

  it("finds the public pages at all, so a broken walker cannot pass this vacuously", () => {
    expect(PUBLIC_PAGES).toContain("/wholesale");
    expect(PUBLIC_PAGES).toContain("/contact");
  });

  /**
   * The page AND the components it composes itself from.
   *
   * Reading page.tsx alone is how the second leak survived this suite: the
   * offending string was `placeholder="e.g. BPC-157, TB-500"` in
   * wholesale-form.tsx, a component the page imports. It was in the HTML served
   * with no cookie at all —
   *
   *     $ curl -s .../wholesale | grep -o '.\{80\}BPC-157.\{60\}'
   *     ...<input id="wholesale-products" placeholder="e.g. BPC-157, TB-500" ...
   *
   * — and both are real catalogue rows. One import hop covers every component
   * these pages actually use; a page that reaches deeper for a product name
   * would have to route it through a prop, which the `.name` assertions below
   * still catch at the page.
   */
  function sourcesFor(route: string): Array<{ label: string; text: string }> {
    const segments = route.split("/").filter(Boolean);
    const pagePath = join(APP, ...segments, "page.tsx");
    const raw = readFileSync(pagePath, "utf8");
    const sources = [{ label: `${route} (page.tsx)`, text: code(raw) }];

    for (const match of raw.matchAll(/from\s+"@\/components\/([A-Za-z0-9._-]+)"/g)) {
      for (const ext of [".tsx", ".ts"]) {
        try {
          const componentPath = join(process.cwd(), "src/components", `${match[1]}${ext}`);
          sources.push({ label: `${route} (${match[1]}${ext})`, text: code(readFileSync(componentPath, "utf8")) });
          break;
        } catch {
          /* not this extension */
        }
      }
    }
    return sources;
  }

  /**
   * Names from the store's own seeded catalogue, read out of harness-seed.sql
   * rather than typed here — a hardcoded list would go stale the first time a
   * product is added, which is precisely the failure this file exists to stop.
   */
  const CATALOGUE_NAMES = [...readFileSync(join(process.cwd(), "src/lib/sql/harness-seed.sql"), "utf8")
    .matchAll(/values\s*\('[0-9a-f-]+','[a-z0-9-]+','([^']+)'/gi)]
    .map((match) => match[1])
    .filter((name) => name.length >= 4);

  it("knows some catalogue names to look for, so the scan cannot pass vacuously", () => {
    expect(CATALOGUE_NAMES.length).toBeGreaterThan(2);
  });

  it.each(PUBLIC_PAGES)("%s does not render a catalogue product's name", (route) => {
    for (const { label, text } of sourcesFor(route)) {
      // Reading the catalogue for PHOTOGRAPHY is fine — the URLs are opaque.
      // What must never appear on a public page is a product's name.
      expect(text, `${label} renders product.name`).not.toMatch(/\{\s*product\.name\s*\}/);
      expect(text, `${label} renders p.name`).not.toMatch(/\{\s*p\.name\s*\}/);
      expect(text, `${label} passes a product name as alt`).not.toMatch(/alt=\{[^}]*\.name[^}]*\}/);
    }
  });

  it.each(PUBLIC_PAGES)("%s does not spell one out as a literal either", (route) => {
    for (const { label, text } of sourcesFor(route)) {
      for (const name of CATALOGUE_NAMES) {
        // The name, and its bare compound without the strength — "BPC-157" is
        // what identifies the product; "10mg" is not.
        for (const needle of [name, name.replace(/\s+\d+\s*(mg|ml|mcg|iu)\b/i, "")]) {
          if (needle.length < 4) continue;
          expect(
            text.toLowerCase(),
            `${label} spells out the catalogue name "${needle}"`,
          ).not.toContain(needle.toLowerCase());
        }
      }
    }
  });
});
