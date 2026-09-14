import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Meta (Facebook) pixel.
 *
 * The same shape as the Snap and Reddit source tests, for the same reasons:
 * a second init double-counts every conversion, an identity field pasted into
 * `fbq('init')` hands a third party a raw address on every page load, and a
 * pixel that loads before consent breaks the promise the banner makes. None
 * of those can be caught by testing a module in isolation, so they are
 * asserted against the source tree.
 */

const SRC = join(process.cwd(), "src");
const META_PIXEL = join(SRC, "components", "meta-pixel.tsx");
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

/** Source with comments removed — documenting a trap is not falling into it. */
function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** The snippet actually injected into the page, between the <Script> tags. */
function injectedSnippet(): string {
  const source = read(META_PIXEL);
  const start = source.indexOf("<Script");
  const end = source.indexOf("</Script>");
  expect(start, "meta-pixel.tsx no longer renders a <Script>").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("exactly one Meta data source", () => {
  it("initialises the pixel in exactly one place", () => {
    // Executable source only: meta-events.ts documents the init trap in prose.
    const loaders = files.filter((path) => /fbq\(\s*['"]init['"]/.test(executableSource(path)));
    expect(loaders.map(relative)).toEqual(["src/components/meta-pixel.tsx"]);
  });

  it("injects the Meta SDK from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes("https://connect.facebook.net/en_US/fbevents.js"));
    expect(loaders.map(relative)).toEqual(["src/components/meta-pixel.tsx"]);
  });

  it("holds the pixel id in one module, and the loader reads it from there", () => {
    const holders = files.filter((path) => read(path).includes("1368613292095373"));
    expect(holders.map(relative)).toEqual(["src/lib/ads/meta-pixel-id.ts"]);
    expect(read(META_PIXEL)).toContain('from "@/lib/ads/meta-pixel-id"');
    expect(read(join(SRC, "lib", "ads", "meta-pixel-id.ts"))).toContain("process.env.NEXT_PUBLIC_META_PIXEL_ID");
  });

  it("is mounted once, globally, from the root layout, beside the other pixels", () => {
    const mounts = files.filter((path) => /<MetaPixel\s*\/>/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    const layout = read(join(SRC, "app", "layout.tsx"));
    // The same Suspense boundary as the others: useSearchParams needs one, and
    // a second boundary is a second place for the pixels to fall out of step.
    const boundary = layout.slice(layout.indexOf("<Suspense fallback={null}>\n          <TikTokPixel />"), layout.indexOf("</Suspense>", layout.indexOf("<TikTokPixel />")));
    expect(boundary).toContain("<MetaPixel />");
  });

  it("ships Meta's base code verbatim, with only the id substituted", () => {
    const snippet = injectedSnippet();
    expect(snippet).toContain("n.callMethod.apply(n,arguments):n.queue.push(arguments)");
    expect(snippet).toContain("n.loaded=!0;n.version='2.0'");
    expect(snippet).toContain("fbq('init', '${META_PIXEL_ID}');");
    expect(snippet).toContain("fbq('track', 'PageView');");
  });
});

describe("no customer identity is ever handed to Meta from the browser", () => {
  it("initialises with the pixel id and nothing else", () => {
    // Meta's docs invite `fbq('init', ID, { em: 'email@example.com' })`. An
    // init with any second argument at all is refused here, so a raw address
    // can never be pasted into that position.
    const init = injectedSnippet().match(/fbq\(\s*['"]init['"][^\n]*/)?.[0] ?? "";
    expect(init).toBe("fbq('init', '${META_PIXEL_ID}');");
  });

  it("never builds Meta's match-key fields anywhere in the codebase", () => {
    for (const path of files) {
      const source = executableSource(path);
      if (!/fbq|meta-events|MetaPixel/.test(source)) continue;
      expect(source, `${relative(path)} constructs a Meta match key`).not.toMatch(/["']?\b(em|ph|fn|ln|external_id)\b["']?\s*:/);
    }
  });

  it("does not read the customer's address in the purchase component's Meta branch", () => {
    const purchase = executableSource(join(SRC, "components", "tiktok-purchase-event.tsx"));
    const start = purchase.indexOf("if (body.metaPurchase)");
    expect(start, "the Meta branch has moved — re-point this assertion").toBeGreaterThan(-1);
    const branch = purchase.slice(start, purchase.indexOf("} catch", start));
    expect(branch).not.toMatch(/email/i);
    expect(branch).not.toContain("advancedMatching");
  });
});

describe("the Meta pixel is gated on consent and environment, exactly like the others", () => {
  const meta = read(META_PIXEL);

  it("reads the same stored consent through the shared module", () => {
    expect(meta).toContain('from "@/lib/cookie-consent-client"');
    expect(meta).toContain("hasAcceptedConsent()");
    expect(meta).toContain("subscribeToConsent(sync)");
    expect(meta).not.toContain('"vl_cookie_consent"');
  });

  it("renders nothing at all until consent is recorded, and starts from declined", () => {
    expect(meta).toContain("if (!accepted) return null;");
    expect(meta).toContain("const [accepted, setAccepted] = useState(false);");
  });

  it("carries the same gates as the Snap pixel, in the same order", () => {
    const snap = read(SNAP_PIXEL);
    for (const line of [
      "const [adsAllowed, setAdsAllowed] = useState(false);",
      "setAdsAllowed(browserAdsReportingAllowed().allowed);",
      "if (!adsAllowed) return null;",
      "if (!accepted) return null;",
    ]) {
      expect(meta).toContain(line);
      expect(snap).toContain(line);
    }
    expect(meta.indexOf("if (!adsAllowed) return null;")).toBeLessThan(meta.indexOf("if (!accepted) return null;"));
  });

  it("does not render the noscript fallback, which would fire before consent", () => {
    const code = executableSource(META_PIXEL);
    expect(code).not.toMatch(/<noscript/);
    expect(code).not.toContain("facebook.com/tr?");
  });

  it("takes its id from a public env name, never a secret one", () => {
    expect(meta).not.toMatch(/SECRET|ACCESS_TOKEN|SERVICE_ROLE/);
  });

  it("tells the visitor which pixels accepting turns on", () => {
    const banner = read(join(SRC, "components", "cookie-consent.tsx"));
    expect(banner).toMatch(/Meta/);
  });

  it("names Meta in the cookie and privacy policies, and no longer denies running one", () => {
    const legal = read(join(SRC, "lib", "legal-content.ts"));
    expect(legal).toMatch(/Meta Pixel/);
    expect(legal).not.toMatch(/do not run a Meta pixel/i);
    // Every "nothing reaches" promise must now name Meta too.
    const promises = legal.match(/no request (?:is made to|reaches)[^.]*/gi) ?? [];
    expect(promises.length).toBeGreaterThan(0);
    for (const promise of promises) expect(promise).toContain("Meta");
  });
});

describe("a visitor who declined cannot be broken by the event call sites", () => {
  it("only ever calls fbq optionally, so its absence is a no-op", () => {
    for (const path of files) {
      if (path === META_PIXEL) continue; // the loader defines it
      const source = executableSource(path);
      for (const line of source.split("\n")) {
        if (!line.includes("fbq")) continue;
        const guarded = /window\.fbq\?\./.test(line) || /if \(window\.fbq\)/.test(line) || /fbq\?:/.test(line);
        expect(guarded, `${relative(path)} calls fbq unguarded: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("forwards every funnel event with the eventID Meta dedupes on", () => {
    const events = read(join(SRC, "lib", "ads", "meta-events.ts"));
    expect(events).toContain("{ eventID: event.eventId }");
    for (const file of ["tiktok-view-content.tsx", "tiktok-commerce-events.tsx", "tiktok-purchase-event.tsx"]) {
      expect(read(join(SRC, "components", file)), `${file} does not forward to Meta`).toContain("emitMetaEvent");
    }
  });
});
