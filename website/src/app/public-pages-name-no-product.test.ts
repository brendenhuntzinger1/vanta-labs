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
    // THE ROOT ROUTE, WHICH THIS WALKER USED TO MISS ENTIRELY.
    //
    // It only ever descended into DIRECTORIES and looked for a page.tsx inside
    // each one, so src/app/page.tsx — the home page, the one file directly in
    // this folder — was never a candidate and "/" was never scanned. That was
    // invisible while the home page required an account: it was not a public
    // page, so its absence from a public-page scan cost nothing.
    //
    // Opening the front door for SMS verification changed that, and a guard
    // with a hole in it exactly where the new public page lives is worse than
    // no guard, because it reads as coverage.
    if (prefix === "") {
      try {
        statSync(join(dir, "page.tsx"));
        found.push("/");
      } catch {
        /* no root page */
      }
    }
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

  /**
   * THE ONE PAGE THAT IMPORTS A PRODUCT RENDERER AND IS STILL SAFE.
   *
   * The home page composes the signed-IN experience from ProductCard, which of
   * course renders {product.name} — that is what a product card is for. The
   * static scan cannot see that the card is unreachable for the anonymous
   * reader it is protecting, because the thing that makes it unreachable is a
   * runtime condition: page.tsx never fetches the catalogue without a session,
   * so `featuredForHome` is empty and no card is ever constructed.
   *
   * Exempting it costs coverage, so the exemption is paid for immediately
   * below by "the home page's catalogue read is gated on the session", which
   * asserts the runtime property directly and is the stronger check of the
   * two: it fails if anyone removes the gate, which is the regression this
   * file actually exists to catch. The literal-name scan still runs against
   * the home page unchanged.
   *
   * Narrow on purpose — one route, one component. Any OTHER public page that
   * imports ProductCard is a real leak and still fails.
   */
  const RENDERER_EXEMPT = new Set(["/ (product-card.tsx)"]);

  it.each(PUBLIC_PAGES)("%s does not render a catalogue product's name", (route) => {
    for (const { label, text } of sourcesFor(route)) {
      if (RENDERER_EXEMPT.has(label)) continue;
      // Reading the catalogue for PHOTOGRAPHY is fine — the URLs are opaque.
      // What must never appear on a public page is a product's name.
      expect(text, `${label} renders product.name`).not.toMatch(/\{\s*product\.name\s*\}/);
      expect(text, `${label} renders p.name`).not.toMatch(/\{\s*p\.name\s*\}/);
      expect(text, `${label} passes a product name as alt`).not.toMatch(/alt=\{[^}]*\.name[^}]*\}/);
    }
  });

  /**
   * WHAT THE EXEMPTION ABOVE IS PAYING FOR.
   *
   * "Not fetched" rather than "fetched and hidden" is the only version of
   * withheld that survives RSC: a server component that reads the catalogue
   * and then declines to render it still serialises every row into the flight
   * payload embedded in the HTML. So the property worth pinning is not "no
   * card is rendered" — it is "no read happens at all without a session".
   */
  describe("the home page's catalogue read is gated on the session", () => {
    const home = readFileSync(join(APP, "page.tsx"), "utf8");
    const homeCode = code(home);

    it("derives visibility from the viewer's session, not from anything else", () => {
      expect(homeCode).toMatch(/getAuthenticatedUser\(\)/);
      expect(homeCode).toMatch(/const\s+catalogVisible\s*=\s*Boolean\(\s*viewer\s*\)/);
    });

    it("fetches the catalogue only inside that condition", () => {
      // Exactly one call site, and it is the guarded one. A second call
      // anywhere in this file — or this one losing its guard — means the
      // anonymous render reads the catalogue again.
      const calls = [...homeCode.matchAll(/getCatalogProducts\s*\(/g)];
      expect(calls.length, "getCatalogProducts must be called exactly once").toBe(1);
      expect(homeCode).toMatch(/catalogVisible\s*\?\s*await\s+getCatalogProducts\(\)/);
    });

    it("never decides what to serve from who is asking", () => {
      // The uniform-wall invariant, restated where the exemption lives: a
      // user-agent or crawler test here would serve a reviewer something a
      // customer does not get, which is cloaking.
      expect(homeCode).not.toMatch(/user-?agent/i);
      expect(homeCode).not.toMatch(/googlebot|bingbot|crawler/i);
    });
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
