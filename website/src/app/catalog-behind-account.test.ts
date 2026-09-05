import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// THE CATALOG IS BEHIND AN ACCOUNT, AND THE WALL IS THE SAME FOR EVERYONE.
//
// Two separate things are pinned here, and the second matters more than the
// first.
//
//   1. THAT THE GATE EXISTS at every layer, so a later edit cannot quietly
//      reopen one of them. Product data reached anonymous visitors through six
//      routes, all measured against production on 2026-09-05:
//
//        PostgREST direct        36 products with names and prices
//        /api/catalog/products   104 KB of JSON, HTTP 200
//        /products               21 "GLP-1" mentions
//        /products/glp-1         61 mentions, plus the title tag
//        home page               6 featured products, a compound named 9 times
//        /coa-library            GLP-1/2/3, BPC-157, Retatrutide
//
//      Closing five of those in the app is worth nothing while the sixth is
//      open, which is why the SQL policy change is pinned here too.
//
//   2. THAT THE GATE NEVER LEARNS WHO IS ASKING. Serving Googlebot or an ad
//      reviewer something different from a customer is cloaking. It violates
//      the ad platforms' policies, it is the kind of thing that costs an entire
//      business account rather than one ad, and the owner explicitly rejected
//      it. The tests below fail if a user-agent test, an IP test or a crawler
//      list ever appears on any of these paths. That is the invariant most
//      likely to be broken later by someone trying to be helpful.
// ---------------------------------------------------------------------------

const middleware = read("middleware.ts");
const robots = read("src/app/robots.ts");
const sitemap = read("src/app/sitemap.ts");
const homePage = read("src/app/page.tsx");
const catalogPage = read("src/app/products/page.tsx");
const productPage = read("src/app/products/[slug]/page.tsx");
const catalogApi = read("src/app/api/catalog/products/route.ts");
const coaPage = read("src/app/coa-library/page.tsx");
const gateSql = read("src/lib/sql/gate-catalog-behind-account.sql");

/** Strip comments, so prose ABOUT a banned pattern is not mistaken for the pattern. */
function code(src: string) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");
}

describe("the gate is uniform: it never varies by who is asking", () => {
  // middleware.ts as a whole is exempt and is checked separately below: it
  // legitimately reads the user-agent for a RENDERING-CAPABILITY decision (an
  // app's WebView cannot play the hero video), which is documented at length in
  // that file and is not a content difference. What must never read the UA is
  // the GATE, so that region is asserted on its own.
  //
  // robots.ts is likewise exempt from the string sweep, because `userAgent` is
  // a literal key in its own config shape. Its rule is checked separately.
  const guarded: Array<[string, string]> = [
    ["home page", homePage],
    ["catalog page", catalogPage],
    ["product page", productPage],
    ["catalog API", catalogApi],
    ["COA library", coaPage],
    ["sitemap.ts", sitemap],
  ];

  // The gate decides on the SESSION. Any of these appearing near it would mean
  // the answer depends on the requester's identity rather than their auth,
  // which is the definition of the thing we refused to build.
  const CLOAKING_TELLS = [
    /getUserAgent/i,
    /user-?agent/i,
    /\bbot\b/i,
    /crawler/i,
    /googlebot/i,
    /bytespider/i,
    /facebookexternalhit/i,
    /\bspider\b/i,
    /x-forwarded-for/i,
  ];

  for (const [label, src] of guarded) {
    it(`${label} decides on the session alone, never on the client`, () => {
      const body = code(src);
      for (const tell of CLOAKING_TELLS) {
        expect(body, `${label} must not branch on ${tell}`).not.toMatch(tell);
      }
    });
  }

  it("the catalog gate itself never reads the user-agent", () => {
    // The gate region only. If a UA test ever appears between these two
    // markers, the wall has started varying by who is asking.
    const body = code(middleware);
    const gate = body.slice(body.indexOf("const GATED_PREFIXES"), body.indexOf("function isGatedPath") + 400);
    for (const tell of CLOAKING_TELLS) {
      expect(gate, `the gate must not branch on ${tell}`).not.toMatch(tell);
    }

    const enforcement = body.slice(body.indexOf("if (isGatedPath(pathname)"));
    for (const tell of CLOAKING_TELLS) {
      expect(enforcement.slice(0, 1800), `enforcement must not branch on ${tell}`).not.toMatch(tell);
    }
  });

  it("robots.txt addresses every agent with the same rule", () => {
    // Two groups exist (production and non-production) and BOTH must be "*".
    // Naming Googlebot or Bytespider separately in order to give them a
    // different answer is cloaking in its most visible possible form.
    const groups = code(robots).match(/userAgent:\s*"[^"]*"/g) ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group).toBe('userAgent: "*"');
    }
  });
});

describe("middleware gates every shape of request to the catalog", () => {
  it("gates the catalog, product pages, the catalog API and the COA library", () => {
    for (const prefix of ["/products", "/coa-library", "/api/catalog", "/api/coa"]) {
      expect(code(middleware), `${prefix} must be gated`).toContain(`"${prefix}"`);
    }
    expect(code(middleware)).toContain("GATED_PREFIXES");
  });

  it("matches a prefix and everything beneath it, so no product slug slips past", () => {
    expect(code(middleware)).toMatch(/pathname === prefix \|\| pathname\.startsWith\(`\$\{prefix\}\/`\)/);
  });

  it("refuses an API request rather than redirecting it", () => {
    // fetch() follows a 307 and would parse the login page as JSON.
    const gate = middleware.slice(middleware.indexOf("if (isGatedPath(pathname)"));
    expect(gate.slice(0, 700)).toContain("401");
  });

  it("carries the requested path into ?next= so referral and ad links survive", () => {
    const gate = middleware.slice(middleware.indexOf("if (isGatedPath(pathname)"));
    expect(gate.slice(0, 1400)).toContain('login.searchParams.set("next"');
  });

  it("never lets a session-dependent redirect be cached and replayed", () => {
    const gate = middleware.slice(middleware.indexOf("if (isGatedPath(pathname)"));
    expect(gate.slice(0, 1600)).toContain('"Cache-Control", "no-store"');
  });
});

describe("gated pages check auth BEFORE reading product data", () => {
  // This is the whole game. A server component that fetches and then renders
  // nothing still serialises what it fetched into the RSC flight payload in the
  // HTML. Hiding is not withholding; not fetching is.
  const orderings: Array<[string, string, string, string]> = [
    ["catalog page", catalogPage, "getAuthenticatedUser", "getStorefrontCatalog("],
    ["product page", productPage, "getAuthenticatedUser", "getCatalogProductBySlug(slug)"],
    ["catalog API", catalogApi, "getAuthenticatedUser", "getStorefrontCatalog("],
    ["COA library", coaPage, "getAuthenticatedUser", "getCoaLibrarySnapshot("],
    ["home page", homePage, "getAuthenticatedUser", "getCatalogProducts("],
  ];

  for (const [label, src, guard, fetchCall] of orderings) {
    it(`${label} resolves the viewer before it reads the catalog`, () => {
      const body = code(src);
      const guardAt = body.indexOf(guard);
      const fetchAt = body.indexOf(fetchCall);
      expect(guardAt, `${label} must call ${guard}`).toBeGreaterThan(-1);
      expect(fetchAt, `${label} must call ${fetchCall}`).toBeGreaterThan(-1);
      expect(guardAt, `${label} must check auth before fetching`).toBeLessThan(fetchAt);
    });
  }

  it("the home page makes the catalog read itself conditional, not just the markup", () => {
    // `catalogVisible ? await ... : []` — the read does not happen at all when
    // signed out, so there is nothing to serialise into the payload.
    expect(code(homePage)).toMatch(/catalogVisible\s*\?\s*await getCatalogProducts\(\)/);
  });
});

describe("a gated product URL cannot be used to enumerate the catalog", () => {
  it("redirects before looking the slug up, so real and fake slugs answer alike", () => {
    // The page BODY only. generateMetadata above has its own ordering test;
    // measuring across both would find that function's lookup first.
    const whole = code(productPage);
    const body = whole.slice(whole.indexOf("export default async function ProductDetailPage"));
    const redirectAt = body.indexOf("redirect(`/account/login");
    const lookupAt = body.indexOf("getCatalogProductBySlug(slug)");
    const notFoundAt = body.indexOf("notFound()");
    expect(redirectAt).toBeGreaterThan(-1);
    expect(redirectAt).toBeLessThan(lookupAt);
    expect(redirectAt).toBeLessThan(notFoundAt);
  });

  it("generateMetadata does not name the product to a signed-out request", () => {
    // The live title was "GLP-1 | Vanta Labs". A title tag is what a search
    // result and a link preview quote, so it must not be product-shaped here.
    const meta = productPage.slice(
      productPage.indexOf("export async function generateMetadata"),
      productPage.indexOf("export default async function ProductDetailPage"),
    );
    const guardAt = code(meta).indexOf("getAuthenticatedUser");
    const lookupAt = code(meta).indexOf("getCatalogProductBySlug(slug)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(lookupAt);
    expect(meta).toContain('title: "Sign in"');
  });
});

describe("the site stops advertising what it will not serve", () => {
  it("robots disallows the gated paths", () => {
    expect(robots).toContain('"/products"');
    expect(robots).toContain('"/coa-library"');
  });

  it("the sitemap lists no product URLs and cannot regain the ability", () => {
    const body = code(sitemap);
    expect(body).not.toContain("/products/${");
    expect(body).not.toContain('"/products"');
    expect(body).not.toContain('"/coa-library"');
    // The import is gone, so a future edit cannot reach the catalog by accident.
    expect(body).not.toContain("getCatalogProducts");
  });

  it("the sitemap still offers the whole public brand surface", () => {
    const body = code(sitemap);
    for (const path of ["/research", "/membership", "/partner", "/wholesale", "/contact"]) {
      expect(body, `${path} must stay indexable`).toContain(`"${path}"`);
    }
    expect(body).toContain("ARTICLE_SLUGS");
    expect(body).toContain("POLICY_SLUGS");
  });

  it("gated pages carry noindex, which is the only signal that reaches an already-indexed URL", () => {
    expect(catalogPage).toContain("robots: { index: false, follow: false }");
    expect(coaPage).toContain("robots: { index: false, follow: false }");
  });
});

describe("row-level security is the boundary the app cannot bypass", () => {
  it("revokes the anonymous read on products and doses", () => {
    expect(gateSql).toContain("drop policy if exists products_select_public on public.products");
    expect(gateSql).toContain("drop policy if exists product_doses_select_public on public.product_doses");
  });

  it("leaves admin able to read, and nobody else", () => {
    expect(gateSql).toContain("products_select_admin");
    expect(gateSql).toContain("product_doses_select_admin");
    expect(gateSql).toMatch(/current_auth_role\(\)\) = 'admin'/);
  });

  it("ships the exact rollback, so the change is reversible without archaeology", () => {
    expect(gateSql).toContain("ROLLBACK");
    expect(gateSql).toContain("create policy products_select_public on public.products");
  });

  it("runs as one transaction", () => {
    expect(gateSql).toContain("begin;");
    expect(gateSql).toContain("commit;");
  });
});

describe("the public brand surface is untouched", () => {
  it("does not gate the home page, research, or legal routes", () => {
    const gated = code(middleware).slice(
      code(middleware).indexOf("const GATED_PREFIXES"),
      code(middleware).indexOf("function isGatedPath"),
    );
    for (const publicPath of ['"/research"', '"/legal"', '"/contact"', '"/membership"']) {
      expect(gated, `${publicPath} must stay public`).not.toContain(publicPath);
    }
  });

  it("still renders the home page for a signed-out visitor, with a way in", () => {
    expect(homePage).toContain("/account/login?next=%2Fproducts");
    expect(homePage).toContain("Read the research library");
  });
});
