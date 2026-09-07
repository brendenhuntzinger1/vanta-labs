import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Google Ads tag.
 *
 * This tag is installed the way Google's install screen describes — present on
 * every page — rather than held back until Accept like the other three pixels.
 * Consent Mode is what does the privacy work instead, so the invariants that
 * matter here are different from the ones in snap-pixel-source.test.ts:
 *
 * - every storage signal must DEFAULT TO DENIED, and the default must be set
 *   BEFORE `config`; a default set afterwards is applied too late and the first
 *   hit goes out granted, which is the whole failure this file exists to stop;
 * - Decline and a later withdrawal must both reach the tag as a denied update;
 * - a second `config` for the same account somewhere would double-count every
 *   page view and every remarketing hit;
 * - Enhanced Conversions' `user_data` arriving with a raw email address, which
 *   Google's own console actively offers and which would hand a third party a
 *   customer's address from code running in their browser;
 * - the non-production environment refusals must stay in force, so a preview
 *   deployment or a CI job never reports into the live ad account.
 *
 * None of these show up in a unit test of any individual module, so they are
 * asserted against the source tree itself — the same approach, and mostly the
 * same assertions, as snap-pixel-source.test.ts and reddit-pixel-source.test.ts.
 */

const SRC = join(process.cwd(), "src");
const GOOGLE_TAG = join(SRC, "components", "google-ads-tag.tsx");

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

/**
 * Enhanced Conversions' identity payload, told apart from the Consent Mode
 * signal that shares most of its name.
 *
 * `ad_user_data` is a consent SIGNAL — it grants or denies permission and
 * carries nothing about anyone, and it is required to be present. `user_data`
 * is the Enhanced Conversions PAYLOAD, which is where a raw email address or
 * phone number would travel. A plain substring check cannot tell them apart and
 * would force the consent signal out of the snippet to stay green.
 */
const ENHANCED_CONVERSIONS_PAYLOAD = /(?<!ad_)\buser_data\b/;

describe("no customer identity is ever handed to Google", () => {
  it("never ships Enhanced Conversions' user_data field", () => {
    // Google's console offers this next to the snippet itself. Pasted as
    // offered it sends a raw email address or phone number to Google from the
    // visitor's own browser, on every page that fires a conversion.
    const snippet = injectedSnippet();
    expect(snippet).not.toMatch(ENHANCED_CONVERSIONS_PAYLOAD);
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
      expect(source, `${relative(path)} builds a user_data payload near gtag`).not.toMatch(ENHANCED_CONVERSIONS_PAYLOAD);
      expect(source, `${relative(path)} constructs a raw email for gtag`).not.toMatch(/["']?user_email["']?\s*:/);
    }
  });
});

describe("Consent Mode is what protects a visitor who has not accepted", () => {
  const google = read(GOOGLE_TAG);

  it("reads the same stored consent key as every other tracker", () => {
    // Asserted as a SHARED IMPORT rather than as a matching string literal: a
    // test that pins one copy of a magic string cannot tell "every tracker
    // agrees" from "this file happens to contain the same characters", which is
    // the drift the shared module removes.
    expect(google).toContain('from "@/lib/cookie-consent-client"');
    expect(google).toContain("hasAcceptedConsent()");
    expect(google).not.toContain('"vl_cookie_consent"');
  });

  it("denies every storage signal by default", () => {
    // Exhaustive on purpose. gtag leaves an unnamed signal at whatever it had,
    // so omitting one here is how it silently ships granted.
    const snippet = injectedSnippet();
    const defaultBlock = snippet.slice(snippet.indexOf("gtag('consent', 'default'"));
    for (const signal of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) {
      expect(defaultBlock, `${signal} is missing from the consent default`).toContain(signal);
    }
    // No signal may be granted in the default block.
    const upToConfig = defaultBlock.slice(0, defaultBlock.indexOf("gtag('config'"));
    expect(upToConfig).not.toContain("granted");
  });

  it("sets the consent default BEFORE config, not after", () => {
    // The ordering IS the control. A default applied after config is too late:
    // the first hit has already gone out granted, and nothing in the ad account
    // shows that it did.
    const snippet = injectedSnippet();
    const consentAt = snippet.indexOf("gtag('consent', 'default'");
    const configAt = snippet.indexOf("gtag('config'");
    expect(consentAt, "the consent default is missing entirely").toBeGreaterThan(-1);
    expect(configAt).toBeGreaterThan(-1);
    expect(consentAt).toBeLessThan(configAt);
  });

  it("grants only on an accept, and returns to denied on a withdrawal", () => {
    // A withdrawal that only reaches the tab it was made in is not a withdrawal,
    // and a grant that survives one is worse. Both directions run through the
    // same effect, so neither can be dropped without the other.
    const source = executableSource(GOOGLE_TAG);
    expect(source).toMatch(/gtag\?\.\(\s*["']consent["']\s*,\s*["']update["']/);
    expect(source).toContain("accepted ? CONSENT_GRANTED : CONSENT_DENIED");
    expect(source).toContain("subscribeToConsent(sync)");
    for (const signal of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) {
      const denied = source.slice(source.indexOf("CONSENT_DENIED = {"));
      expect(denied, `${signal} is missing from CONSENT_DENIED`).toContain(signal);
    }
  });

  it("does not send a consent update before it has read the stored answer", () => {
    // `accepted` starts undefined rather than false. Starting false would send a
    // denied update on every load for a visitor who had already accepted, racing
    // the granted one a tick later.
    const source = executableSource(GOOGLE_TAG);
    expect(source).toContain("useState<boolean | undefined>(undefined)");
    expect(source).toContain("accepted === undefined) return;");
  });

  it("keeps the non-production refusals in force (K-16)", () => {
    // The id falls back to the live account, so without this a preview
    // deployment, a local run or a CI job trains the real bid optimiser.
    expect(google).toContain("browserAdsReportingAllowed()");
    expect(google).toContain("if (!envAllowed) return null;");
  });

  it("tolerates the automated-browser refusal, and ONLY that one", () => {
    // Google's own installation check drives an automated browser, so honouring
    // that rule would mean a correctly installed tag can never be verified.
    // Tolerating it as the SOLE reason is what keeps a Playwright run against a
    // preview refused: ads-environment.ts reports the broadest reason first, so
    // `not_production_environment` wins there.
    const source = executableSource(GOOGLE_TAG);
    expect(source).toContain('verdict.reason === "automated_browser"');
    for (const reason of ["not_production_environment", "not_production_build", "non_production_host"]) {
      expect(source, `${reason} must not be tolerated`).not.toContain(reason);
    }
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

  it("never sweeps Google into the three pixels' \"nothing loads\" promise", () => {
    // THE ONE WAY THESE POLICIES CAN BECOME FALSE.
    //
    // The three pixels genuinely are not loaded before Accept, and both policies
    // say so. The Google tag IS loaded, on every page, with consent mode denying
    // its storage instead. Every sentence promising that nothing loads must
    // therefore name only the three — a later edit that tidies the two
    // paragraphs into one publishes a false statement about a live tag.
    for (const promise of legal.match(/no request (?:is made to|reaches)[^.]*/gi) ?? []) {
      for (const platform of ["TikTok", "Snap", "Reddit"]) {
        expect(promise, `the decline promise does not name ${platform}`).toContain(platform);
      }
      expect(promise, "Google is inside a \"nothing reaches\" promise, which is false").not.toContain("Google");
    }
    // Same trap, stated the other way round.
    expect(legal).not.toMatch(/none of (them|these|the four)[^.]*(is|are) ever loaded[^.]*Google/i);
    expect(legal).not.toMatch(/the Google tag included/);
  });

  it("says plainly that the tag loads whatever the visitor chooses", () => {
    // Understating this is the failure mode: a policy that implies the tag is
    // held back is worse than one that admits it is not.
    expect(legal).toMatch(/loads on every page|present on every page|loads either way/i);
    expect(legal).toMatch(/denied/);
    expect(legal).toMatch(/cookieless/i);
  });

  it("does not claim Google receives shopping actions it is never sent", () => {
    // No conversion action is wired: `config` records the page view and the
    // remarketing hit and that is all. If a purchase conversion is added later,
    // this policy sentence has to change in the same edit.
    expect(legal).toMatch(/does not report shopping actions at all/);
    expect(legal).toMatch(/never told about shopping actions/);
  });

  it("tells the visitor on the banner that Google is not held back", () => {
    // The banner is where the choice is actually made, so it carries the same
    // distinction rather than deferring all of it to the policy page.
    expect(banner).toMatch(/Google Ads tag loads either way/);
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
