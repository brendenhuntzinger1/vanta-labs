import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Omnisend website script.
 *
 * Omnisend is the store's email and SMS marketing platform, and its snippet is
 * a tracker: it sets a session and a visitor identifier, reports page views,
 * and can identify a contact. The same cheap mistakes the pixel suites guard
 * against apply here, plus one of its own:
 *
 * - the launcher injected from two places, so every visit is counted twice;
 * - the script loading before consent, which breaks the promise the banner
 *   makes ("load only if you accept") and the cookie policy's "Decline stops
 *   all non-essential storage";
 * - an email address handed to `identifyContact` from client code, which the
 *   vendor docs invite ("call the function as soon as the customer logs in")
 *   and which no policy paragraph describes;
 * - the policies not naming it. The privacy policy promises that any new
 *   tracker is named, with the data shared and the purpose, BEFORE it is
 *   switched on.
 *
 * So they are asserted against the source tree itself, as for the pixels.
 */

const SRC = join(process.cwd(), "src");
const OMNISEND = join(SRC, "components", "omnisend-snippet.tsx");
const LAYOUT = join(SRC, "app", "layout.tsx");
const BANNER = join(SRC, "components", "cookie-consent.tsx");
const LEGAL = join(SRC, "lib", "legal-content.ts");
/** The owner's brand id, as it arrived in the snippet Omnisend generated. */
const BRAND_ID = "6aa09072ca3afa5724d4d71a";
const LAUNCHER = "https://omnisnippet1.com/inshop/launcher-v2.js";

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

/** Source with comments removed: documenting a trap is not falling into it. */
function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** The snippet actually injected into the page, between the <Script> tags. */
function injectedSnippet(): string {
  const source = read(OMNISEND);
  const start = source.indexOf("<Script");
  const end = source.indexOf("</Script>");
  expect(start, "omnisend-snippet.tsx no longer renders a <Script>").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("exactly one Omnisend data source", () => {
  it("injects the launcher from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes(LAUNCHER));
    expect(loaders.map(relative)).toEqual(["src/components/omnisend-snippet.tsx"]);
  });

  it("sets the brand id in exactly one place", () => {
    const setters = files.filter((path) => /\[\s*["']brandID["']/.test(executableSource(path)));
    expect(setters.map(relative)).toEqual(["src/components/omnisend-snippet.tsx"]);
  });

  it("holds the brand id literal in one file, under a public env name", () => {
    // The id is not a secret: it ships to every visitor and names the Omnisend
    // account, not a credential. It is overridable so a staging deployment can
    // be pointed at a different account without a code change.
    const withId = files.filter((path) => read(path).includes(BRAND_ID));
    expect(withId.map(relative)).toEqual(["src/components/omnisend-snippet.tsx"]);
    const source = read(OMNISEND);
    expect(source).toContain(`process.env.NEXT_PUBLIC_OMNISEND_BRAND_ID ?? "${BRAND_ID}"`);
    expect(source).not.toMatch(/SECRET|ACCESS_TOKEN|SERVICE_ROLE|API_KEY/);
  });

  it("refuses a brand id that is not an Omnisend brand id", () => {
    // The id is interpolated into an inline <script>, so it is checked rather
    // than trusted. A misconfigured env var must produce no script, not a
    // script carrying whatever the variable held.
    const source = read(OMNISEND);
    expect(source).toContain("const BRAND_ID_SHAPE = /^[0-9a-f]{24}$/;");
    expect(source).toContain("if (!BRAND_ID_SHAPE.test(BRAND_ID)) return null;");
  });

  it("ships the vendor snippet verbatim apart from the brand id", () => {
    // So it can be diffed against whatever Omnisend's install screen generates
    // without reading past reformatting.
    const snippet = injectedSnippet();
    expect(snippet).toContain("window.omnisend = window.omnisend || [];");
    expect(snippet).toContain('omnisend.push(["brandID", "${BRAND_ID}"]);');
    expect(snippet).toContain('omnisend.push(["track", "$pageViewed"]);');
    expect(snippet).toContain(
      '!function(){var e=document.createElement("script");e.type="text/javascript",e.async=!0,'
      + `e.src="${LAUNCHER}";var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t)}();`,
    );
    // The id itself appears once, in the constant; the snippet only interpolates it.
    expect(snippet).not.toContain(BRAND_ID);
  });

  it("is mounted once, globally, from the root layout", () => {
    const mounts = files.filter((path) => /<OmnisendSnippet\s*\/>/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    // Inside the SAME Suspense boundary as the three pixels: all of them call
    // useSearchParams, and a second boundary is a second place to fall out of step.
    const layout = read(LAYOUT);
    const start = layout.indexOf("<TikTokPixel />");
    const boundary = layout.slice(start, layout.indexOf("</Suspense>", start));
    expect(boundary).toContain("<OmnisendSnippet />");
  });
});

describe("the Omnisend script is gated on consent, exactly like the three pixels", () => {
  const source = read(OMNISEND);

  it("reads the shared consent module, not its own copy of the key", () => {
    expect(source).toContain('from "@/lib/cookie-consent-client"');
    expect(source).toContain("hasAcceptedConsent()");
    expect(source).not.toContain('"vl_cookie_consent"');
  });

  it("renders nothing at all until consent is recorded", () => {
    // Not Omnisend's consent-signal API, which would fetch the launcher first
    // and then ask it to behave: the launcher is never fetched, so there is no
    // third-party request, no cookie, and nothing to revoke.
    expect(source).toContain("if (!accepted) return null;");
    // Executable source: the component documents the API it declines to use.
    expect(executableSource(OMNISEND)).not.toContain("consentManager");
  });

  it("starts from declined rather than assuming consent while it checks", () => {
    expect(source).toContain("const [accepted, setAccepted] = useState(false);");
  });

  it("reacts to consent being granted later in the visit", () => {
    expect(source).toContain("subscribeToConsent(sync)");
  });

  it("applies the environment gate before the consent gate (K-16)", () => {
    // A preview deployment or a QA run must never feed the live Omnisend
    // account: every page view there would be a real visitor to Omnisend, and
    // a browse-abandonment automation could email someone over it.
    expect(source).toContain("browserAdsReportingAllowed");
    expect(source).toContain("if (!adsAllowed) return null;");
    expect(source.indexOf("if (!adsAllowed) return null;")).toBeLessThan(source.indexOf("if (!accepted) return null;"));
  });

  it("reports client-side navigations as page views, and only through the vendor queue", () => {
    // A single-page app: after the first load, navigation never reloads the
    // document, so without this every visit is exactly one page view.
    expect(source).toContain("usePathname");
    expect(source).toContain("initialPageSent");
    expect(executableSource(OMNISEND)).toContain('window.omnisend?.push(["track", "$pageViewed"]);');
  });
});

describe("Omnisend receives page views only, and nothing identifying", () => {
  it("never calls identifyContact from anywhere in the codebase", () => {
    // Omnisend's docs say to call it "as soon as the customer logs in". Doing
    // so would hand a raw email address to a third party from client code,
    // which no other integration here does and no policy paragraph describes.
    for (const path of files) {
      expect(executableSource(path), `${relative(path)} identifies a contact to Omnisend`).not.toContain("identifyContact");
    }
  });

  it("sends only the page-view event, so the policy's 'page views only' is true", () => {
    const names = new Set<string>();
    for (const path of files) {
      for (const match of executableSource(path).matchAll(/omnisend\.push\(\[\s*["']track["'],\s*["']([^"']+)["']/g)) {
        names.add(match[1]);
      }
    }
    expect([...names]).toEqual(["$pageViewed"]);
  });

  it("only ever calls omnisend optionally outside the loader, so a blocked SDK is a no-op", () => {
    for (const path of files) {
      if (path === OMNISEND) continue;
      for (const line of executableSource(path).split("\n")) {
        // A call on the vendor object, not the component's file name in an import.
        if (!/\bomnisend\./.test(line)) continue;
        expect(/window\.omnisend\?\./.test(line), `${relative(path)} touches omnisend unguarded: ${line.trim()}`).toBe(true);
      }
    }
  });
});

describe("the disclosure names Omnisend", () => {
  const banner = read(BANNER);
  const legal = read(LEGAL);
  const cookiesStart = legal.indexOf('title: "Cookie Policy"');
  const privacy = legal.slice(0, cookiesStart);
  const cookies = legal.slice(cookiesStart);

  it("names it on the consent banner, where the choice is made", () => {
    expect(banner).toMatch(/Omnisend/);
    // In the held-back sentence, not in the Google or Meta ones.
    expect(banner).toMatch(/Omnisend[^.]*only if you accept/);
  });

  it("names it in the privacy policy with the data shared and the purpose", () => {
    expect(cookiesStart).toBeGreaterThan(-1);
    expect(privacy).toMatch(/\*\*Omnisend\.\*\*/);
    expect(privacy).toMatch(/When you accept, six things run/);
    expect(privacy).toMatch(/Omnisend[^.]*loads only if you accept/i);
    expect(privacy).toMatch(/page views/);
    expect(privacy).toMatch(/email and text-message marketing/);
  });

  it("names it in the cookie policy as something Decline prevents", () => {
    expect(cookies).toMatch(/\*\*Omnisend — only if you accept\.\*\*/);
    expect(cookies).toMatch(/Omnisend receives nothing/);
  });

  it("no longer claims there is nothing beyond the five", () => {
    // The closing sentence counted the trackers. Adding one without recounting
    // publishes a false statement in the very sentence that promises honesty.
    expect(privacy).not.toMatch(/beyond the five named above/);
    expect(privacy).toMatch(/beyond the six named above/);
    expect(privacy).not.toMatch(/narrowest of the five/);
  });

  it("never describes Omnisend the way the ungated Meta and Google tags are described", () => {
    expect(legal).not.toMatch(/Omnisend[^.]*(loads on every page|present on every page|loads either way)/i);
  });

  it("does not claim Omnisend receives things it is never sent", () => {
    // Page views only: no shopping actions, no email address from this site.
    expect(privacy).toMatch(/Omnisend[\s\S]{0,1200}?told about page views only/);
  });
});
