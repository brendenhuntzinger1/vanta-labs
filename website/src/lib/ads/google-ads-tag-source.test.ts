import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Google Ads tag.
 *
 * Google's install screen hands you a snippet with the instruction "copy and
 * paste it in the code of every page of your website, immediately after the
 * <head> element". Followed literally on this site that would be a defect, not
 * a feature: it runs the tag for the visitor who just chose Decline on a banner
 * promising our advertising pixels load only if they accept. So the three
 * mistakes this file exists to catch are all mistakes a correct-looking paste
 * would make:
 *
 * - the tag loading before consent, or outside production;
 * - a second `config` for the same account somewhere, double-counting every
 *   page view and every remarketing hit;
 * - Enhanced Conversions' `user_data` arriving with a raw email address, which
 *   Google's own console actively offers and which would hand a third party a
 *   customer's address from code running in their browser.
 *
 * None of these show up in a unit test of any individual module, so they are
 * asserted against the source tree itself — the same approach, and mostly the
 * same assertions, as snap-pixel-source.test.ts and reddit-pixel-source.test.ts.
 */

const SRC = join(process.cwd(), "src");
const GOOGLE_TAG = join(SRC, "components", "google-ads-tag.tsx");
const SNAP_PIXEL = join(SRC, "components", "snap-pixel.tsx");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const files = sourceFiles(SRC);
const read = (path: string) => readFileSync(path, "utf8");
const relative = (path: string) => path.replace(SRC, "src");

/**
 * Source with comments removed.
 *
 * The distinction matters here for the same reason it does in the Snap tests:
 * this component deliberately *documents* the Enhanced Conversions trap in
 * prose so the next person knows why the field is absent. Explaining a trap is
 * not falling into it, and an assertion that cannot tell the two apart would
 * push that explanation out of the codebase.
 */
function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** The inline snippet actually injected into the page. */
function injectedSnippet(): string {
  const source = read(GOOGLE_TAG);
  const start = source.indexOf('<Script id="google-ads-tag"');
  const end = source.indexOf("</Script>", start);
  expect(start, "google-ads-tag.tsx no longer renders the inline <Script>").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("exactly one Google Ads data source", () => {
  it("configures the tag in exactly one place", () => {
    const loaders = files.filter((path) => /gtag\(\s*['"]config['"]/.test(read(path)));
    expect(loaders.map(relative)).toEqual(["src/components/google-ads-tag.tsx"]);
  });

  it("injects gtag.js from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes("googletagmanager.com/gtag/js"));
    expect(loaders.map(relative)).toEqual(["src/components/google-ads-tag.tsx"]);
  });

  it("has exactly one hard-coded tag id, and only the id module holds it", () => {
    // Scoped to the AW- shape rather than to every quoted string: an unrelated
    // identifier elsewhere in the tree is not a second Google tag, and failing
    // on one would make this assertion noise rather than signal.
    const ids = new Set<string>();
    for (const path of files) {
      for (const match of read(path).matchAll(/["'](AW-\d{6,})["']/g)) ids.add(match[1]);
    }
    expect([...ids]).toHaveLength(1);
    expect(files.filter((path) => read(path).includes([...ids][0])).map(relative)).toEqual([
      "src/lib/ads/google-ads-tag-id.ts",
    ]);
  });

  it("is mounted once, globally, from the root layout", () => {
    const mounts = files.filter((path) => /<GoogleAdsTag\s*\/>/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    // Grouped with the other three ad tags rather than mounted somewhere of its
    // own. It does not itself need that Suspense boundary — it reads no search
    // params, for the reason in the double-count test below — but keeping the
    // four together is what stops one of them being missed by a change to the
    // consent or environment gates they all share.
    expect(read(join(SRC, "app", "layout.tsx"))).toContain("<RedditPixel />");
  });
});

describe("no customer identity is ever handed to Google", () => {
  it("never ships Enhanced Conversions' user_data field", () => {
    // Google's console offers this next to the snippet itself. Pasted as
    // offered it sends a raw email address or phone number to Google from the
    // visitor's own browser, on every page that fires a conversion.
    const snippet = injectedSnippet();
    expect(snippet).not.toContain("user_data");
    expect(snippet).not.toMatch(/email|phone_number|address/i);
  });

  it("configures with the tag id and nothing else", () => {
    // Asserting the config call is *bare* rather than merely identity-free is
    // what makes this durable: it also rejects a user_id, an external id, or
    // anything else a future paste drops into that position.
    const config = injectedSnippet().match(/gtag\('config'[^\n]*/)?.[0] ?? "";
    expect(config).toBe("gtag('config', '${GOOGLE_ADS_TAG_ID}');");
  });

  it("passes no identity to gtag from anywhere in the codebase", () => {
    for (const path of files) {
      const source = executableSource(path);
      if (!source.includes("gtag")) continue;
      expect(source, `${relative(path)} builds a user_data payload near gtag`).not.toContain("user_data");
      expect(source, `${relative(path)} constructs a raw email for gtag`).not.toMatch(/["']?user_email["']?\s*:/);
    }
  });
});

describe("the Google tag is gated exactly like the other three pixels", () => {
  const google = read(GOOGLE_TAG);
  const snap = read(SNAP_PIXEL);

  it("reads the same stored consent key as every other tracker", () => {
    // Asserted as a SHARED IMPORT rather than as a matching string literal: a
    // test that pins one copy of a magic string cannot tell "every tracker
    // agrees" from "this file happens to contain the same characters", which is
    // the drift the shared module removes.
    expect(google).toContain('from "@/lib/cookie-consent-client"');
    expect(google).toContain("hasAcceptedConsent()");
    expect(google).not.toContain('"vl_cookie_consent"');
  });

  it("renders nothing at all until consent is recorded", () => {
    // Not a denied consent-mode default, not a disabled cookie: gtag.js is
    // never fetched, so there is no request to Google for someone who declined.
    expect(google).toContain("if (!accepted) return null;");
    expect(snap).toContain("if (!accepted) return null;");
  });

  it("starts from declined rather than assuming consent while it checks", () => {
    expect(google).toContain("useState(false)");
  });

  it("reacts to consent being granted later in the visit", () => {
    expect(google).toContain("subscribeToConsent(sync)");
  });

  it("refuses to report from anywhere but production (K-16)", () => {
    // The id falls back to the live account, so consent alone would let a
    // preview deployment, a local run, a CI job or a Playwright script train
    // the real bid optimiser. Same gate, same chokepoint, as the other three.
    expect(google).toContain("browserAdsReportingAllowed()");
    expect(google).toContain("if (!adsAllowed) return null;");
  });

  it("does not implement consent mode's default-denied pings", () => {
    // Deliberate, and the reasoning is in the component header. `denied` does
    // not stop the tag: it loads gtag.js anyway and sends cookieless pings so
    // Google can model what it was not allowed to observe. That is MORE contact
    // with Google for a declining visitor than we promise, so the stronger
    // guarantee — never loading — is the one we keep. Turning this on requires
    // the Cookie Policy sentence below to change in the same edit.
    expect(injectedSnippet()).not.toMatch(/gtag\('consent'/);
  });

  it("sends no manual page view on navigation, because gtag already does", () => {
    // THE ONE PLACE THIS TAG MUST NOT COPY THE OTHER THREE PIXELS.
    //
    // TikTok, Snap and Reddit all fire a manual event on route change, because
    // their SDKs do not watch the History API. gtag.js does. This component was
    // written from that pattern and shipped a `gtag('event','page_view')` on
    // every navigation, which double-counted: measured against the live tag,
    // one client-side navigation produced two hits to google.com/ccm/collect
    // for the same URL — ours with `ep.page_path`, gtag's own with `ae=a` —
    // and suppressing only ours left exactly one still arriving.
    //
    // The failure is silent and only visible in the ad account, as inflated
    // page views and remarketing-list membership, so it is pinned here.
    const source = executableSource(GOOGLE_TAG);
    expect(source).not.toMatch(/gtag\?\.\(\s*["']event["']\s*,\s*["']page_view["']/);
    expect(source).not.toContain("usePathname");
    expect(source).not.toContain("useSearchParams");
  });

  it("takes its id from a public env name, never a secret one", () => {
    const idPath = join(SRC, "lib", "ads", "google-ads-tag-id.ts");
    expect(read(idPath)).toContain("process.env.NEXT_PUBLIC_GOOGLE_ADS_ID");
    // Executable source, not the whole file: the module's header explains at
    // length that this id is NOT a secret, and an assertion that cannot tell
    // the word from the thing would push that explanation out of the codebase.
    expect(executableSource(idPath)).not.toMatch(/SECRET|ACCESS_TOKEN|SERVICE_ROLE/);
    expect(executableSource(GOOGLE_TAG)).not.toMatch(/SECRET|ACCESS_TOKEN|SERVICE_ROLE/);
  });
});

describe("the disclosure names Google", () => {
  const banner = read(join(SRC, "components", "cookie-consent.tsx"));
  const legal = read(join(SRC, "lib", "legal-content.ts"));

  it("names it on the consent banner, where the choice is made", () => {
    expect(banner).toMatch(/Google/);
  });

  it("names it in the cookie and privacy policies", () => {
    // The privacy policy makes an explicit promise: if another advertising
    // platform is added, the policy names it, the data shared and the purpose
    // *before* it is switched on. Adding the tag without this would make the
    // published policy false, which is a worse problem than no tag at all.
    expect(legal).toMatch(/Google Ads tag/);
  });

  it("no longer claims we run no Google Ads tag", () => {
    // Both policies said exactly this until the tag was installed. A policy
    // that describes the previous version of the integration is the failure
    // mode this catches — and here it was a flat contradiction, not a stale
    // detail.
    expect(legal).not.toMatch(/We do not run a Meta pixel, a Google Ads tag/);
    expect(legal).not.toMatch(/do not run[^.]*Google Ads tag/);
  });

  it("keeps the decline promise true for Google too", () => {
    // Asserts the PROMISE, not one word order — see the same note on the Snap
    // and Reddit tests. Every platform the site loads a tag for has to appear
    // in the sentence that says declining stops it.
    for (const promise of legal.match(/no request (?:is made to|reaches)[^.]*/gi) ?? []) {
      for (const platform of ["TikTok", "Snap", "Reddit", "Google"]) {
        expect(promise, `the decline promise does not name ${platform}`).toContain(platform);
      }
    }
    expect(legal.match(/no request (?:is made to|reaches)[^.]*/gi) ?? []).toHaveLength(2);
  });

  it("does not claim Google receives shopping actions it is never sent", () => {
    // No conversion action is wired: `config` records the page view and the
    // remarketing hit and that is all. If a purchase conversion is added later,
    // this policy sentence has to change in the same edit.
    expect(legal).toMatch(/the Google tag gets page views and nothing else/);
  });
});

describe("a visitor who declined cannot be broken by the event call sites", () => {
  it("only ever calls gtag optionally, so its absence is a no-op", () => {
    for (const path of files) {
      if (path === GOOGLE_TAG) continue; // the loader defines it
      const source = executableSource(path);
      for (const line of source.split("\n")) {
        if (!/\bgtag\b/.test(line)) continue;
        const guarded = /window\.gtag\?\./.test(line) || /if \(window\.gtag\)/.test(line) || /gtag\?:/.test(line);
        expect(guarded, `${relative(path)} calls gtag unguarded: ${line.trim()}`).toBe(true);
      }
    }
  });
});
