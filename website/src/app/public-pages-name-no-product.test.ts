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
//     alt="Bacteriostatic Water 30ml"
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

  it.each(PUBLIC_PAGES)("%s does not render a catalogue product's name", (route) => {
    const segments = route.split("/").filter(Boolean);
    const source = code(readFileSync(join(APP, ...segments, "page.tsx"), "utf8"));

    // Reading the catalogue for PHOTOGRAPHY is fine — the URLs are opaque. What
    // must never appear on a public page is a product's name being rendered.
    expect(source, `${route} renders product.name`).not.toMatch(/\{\s*product\.name\s*\}/);
    expect(source, `${route} renders p.name`).not.toMatch(/\{\s*p\.name\s*\}/);
    expect(source, `${route} passes a product name as alt`).not.toMatch(/alt=\{[^}]*\.name[^}]*\}/);
  });
});
