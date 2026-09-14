import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Meta (Facebook) pixel.
 *
 * Meta is the one advertising pixel besides the Google tag that loads for
 * every visitor, before and regardless of the cookie banner — the owner's
 * decision. That makes two things matter more here than for the other
 * pixels, not less:
 *
 * - The policies must describe it honestly. A "nothing loads if you decline"
 *   sentence that sweeps Meta in is a false statement about a live tag.
 * - Identity must only ever reach Meta as a server-side SHA-256 digest. The
 *   pixel is on every page for everyone, so a raw address in `fbq('init')`
 *   would be handed to a third party at scale.
 *
 * Plus the usual: one init, one loader, one id module, one mount.
 */

const SRC = join(process.cwd(), "src");
const META_PIXEL = join(SRC, "components", "meta-pixel.tsx");
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

/** Source with comments removed — documenting a trap is not falling into it. */
function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

describe("exactly one Meta data source", () => {
  it("initialises the pixel in exactly one place", () => {
    const loaders = files.filter((path) => /fbq\(\s*['"]init['"]/.test(executableSource(path)));
    expect(loaders.map(relative)).toEqual(["src/components/meta-pixel.tsx"]);
  });

  it("injects the Meta SDK from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes("https://connect.facebook.net/en_US/fbevents.js"));
    expect(loaders.map(relative)).toEqual(["src/components/meta-pixel.tsx"]);
  });

  it("holds the pixel id in one module, and both legs read it from there", () => {
    const holders = files.filter((path) => read(path).includes("1368613292095373"));
    expect(holders.map(relative)).toEqual(["src/lib/ads/meta-pixel-id.ts"]);
    expect(read(META_PIXEL)).toContain('from "@/lib/ads/meta-pixel-id"');
    expect(read(join(SRC, "lib", "ads", "meta-conversions.ts"))).toContain('from "@/lib/ads/meta-pixel-id"');
    expect(read(join(SRC, "lib", "ads", "meta-pixel-id.ts"))).toContain("process.env.NEXT_PUBLIC_META_PIXEL_ID");
  });

  it("is mounted once, globally, from the root layout, beside the Google tag and outside the consent pixels' boundary", () => {
    const mounts = files.filter((path) => /<MetaPixel[\s>]/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    const layout = read(join(SRC, "app", "layout.tsx"));
    const meta = layout.indexOf("<MetaPixel");
    expect(meta).toBeGreaterThan(layout.indexOf("<GoogleAdsTag />"));
    expect(meta).toBeLessThan(layout.indexOf("<TikTokPixel />"));
  });

  it("ships Meta's base code verbatim, with the noscript image, server-rendered", () => {
    const source = read(META_PIXEL);
    expect(source).not.toContain('"use client"');
    expect(source).toContain("n.callMethod.apply(n,arguments):n.queue.push(arguments)");
    expect(source).toContain("n.loaded=!0;n.version='2.0'");
    expect(source).toContain("fbq('track', 'PageView');");
    expect(source).toContain("<noscript>");
    expect(source).toContain("facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1");
  });

  it("checks the id's shape before interpolating it into an inline script", () => {
    const source = read(META_PIXEL);
    expect(source).toContain("PIXEL_ID_SHAPE");
    expect(source).toMatch(/if \(!PIXEL_ID_SHAPE\.test\(META_PIXEL_ID\)\) return null;/);
  });
});

describe("no raw customer identity ever reaches Meta from the browser", () => {
  it("places only 64-hex digests in fbq('init'), and refuses anything else structurally", () => {
    const source = read(META_PIXEL);
    expect(source).toContain("DIGEST_SHAPE");
    expect(source).toMatch(/\/\^\[0-9a-f\]\{64\}\$\//);
    expect(source).toContain("JSON.stringify(keys)");
    // Never the raw props straight into the script.
    expect(executableSource(META_PIXEL)).not.toMatch(/\$\{matchKeys/);
  });

  it("derives the match keys in the layout from the server-side hashing module, never from a raw value", () => {
    const layout = executableSource(join(SRC, "app", "layout.tsx"));
    expect(layout).toContain('from "@/lib/ads/advanced-matching"');
    expect(layout).toMatch(/buildAdvancedMatching\(\{ email: user\.email \?\? null, externalId: user\.id \}\)/);
    expect(layout).not.toMatch(/em:\s*user\.email/);
  });

  it("never builds Meta's match-key fields in browser code", () => {
    // Server modules are the exception BY DESIGN: meta-conversions.ts builds
    // `em`, `ph`, `fn`, `ln` and the postal keys as server-side SHA-256
    // digests for the Conversions API. The rule here is that no client bundle
    // ever holds them.
    for (const path of files) {
      if (read(path).includes('import "server-only"')) continue;
      if (path === META_PIXEL) continue; // server component; asserted above
      if (path === join(SRC, "app", "layout.tsx")) continue; // builds digests via advanced-matching; asserted above
      const source = executableSource(path);
      if (!/fbq|meta-events|MetaPixel/.test(source)) continue;
      expect(source, `${relative(path)} constructs a Meta match key`).not.toMatch(/["']?\b(em|ph|fn|ln|external_id)\b["']?\s*:/);
    }
  });

  it("does not read the customer's address in the purchase component's Meta branch", () => {
    const purchase = executableSource(join(SRC, "components", "tiktok-purchase-event.tsx"));
    const start = purchase.indexOf("if (body.metaPurchase)");
    expect(start, "the Meta branch has moved — re-point this assertion").toBeGreaterThan(-1);
    const branch = purchase.slice(start, purchase.indexOf("if (!consented) return;", start));
    expect(branch).not.toMatch(/email/i);
    expect(branch).not.toContain("advancedMatching");
  });

  it("the server leg hashes every identity field and sends none raw", () => {
    const source = read(join(SRC, "lib", "ads", "meta-conversions.ts"));
    expect(source).toContain('import "server-only"');
    expect(source).toContain("buildAdvancedMatching(");
    for (const key of ["em", "ph", "fn", "ln", "ct", "st", "zp", "country", "external_id"]) {
      expect(source, `${key} is not assigned from a digest`).toMatch(new RegExp(`userData\\.${key} = \\[(sha256\\(|hashed\\.)`));
    }
  });
});

describe("Meta is ungated by consent and the policies say so", () => {
  const meta = read(META_PIXEL);
  const banner = read(join(SRC, "components", "cookie-consent.tsx"));
  const legal = read(join(SRC, "lib", "legal-content.ts"));

  it("does not consult the consent store at all", () => {
    expect(meta).not.toContain("cookie-consent-client");
    expect(meta).not.toContain("hasAcceptedConsent");
    expect(read(join(SRC, "components", "meta-pixel-route-views.tsx"))).not.toContain("hasAcceptedConsent");
  });

  it("still applies the environment gate on the server, exactly as the Google tag does", () => {
    for (const source of [meta, read(GOOGLE_TAG)]) {
      expect(source).toContain("adsReportingAllowed({");
      expect(source).toContain("vercelEnv: process.env.VERCEL_ENV ?? process.env.NEXT_PUBLIC_VERCEL_ENV");
    }
  });

  it("the banner names Meta as loading either way, in its own sentence", () => {
    expect(banner).toMatch(/Meta Pixel loads either way/);
    // And keeps the three gated pixels' sentence free of it.
    expect(banner).toMatch(/advertising pixels \(TikTok, Snapchat and Reddit\) load only if you accept/);
  });

  it("the policies describe Meta as always present, with the hashes it receives and how to opt out", () => {
    expect(legal).toMatch(/Meta Pixel is present on every page, whether or not you accept cookies/);
    expect(legal).toMatch(/Meta Pixel — always present/);
    expect(legal).toMatch(/Declining cookies does not stop the Meta Pixel/);
    expect(legal).toMatch(/SHA-256[^.]*Meta|Meta[^.]*SHA-256/);
    expect(legal).toMatch(/opt out/i);
    expect(legal).not.toMatch(/do not run a Meta pixel/i);
    expect(legal).not.toMatch(/If we ever send Meta a hash/);
  });

  it("never sweeps Meta into a \"nothing loads if you decline\" promise", () => {
    for (const promise of legal.match(/no request (?:is made to|reaches)[^.]*/gi) ?? []) {
      expect(promise, "Meta is inside a \"nothing reaches\" promise, which is false").not.toContain("Meta");
    }
    expect(legal).not.toMatch(/none of (them|these|the four|the five)[^.]*(is|are) (ever )?loaded[^.]*Meta/i);
    expect(legal).not.toMatch(/Meta[^.]*loads only if you accept/i);
  });
});

describe("every visitor's events reach Meta, and fbq is only ever called optionally", () => {
  it("only ever calls fbq optionally, so a blocked SDK is a no-op", () => {
    for (const path of files) {
      if (path === META_PIXEL) continue; // the loader defines it
      const source = executableSource(path);
      for (const line of source.split("\n")) {
        if (!line.includes("fbq")) continue;
        const guarded = /window\.fbq\?\./.test(line) || /if \(window\.fbq\)/.test(line) || /!window\.fbq/.test(line) || /fbq\?:/.test(line);
        expect(guarded, `${relative(path)} calls fbq unguarded: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("forwards every funnel event with the eventID Meta dedupes on, before any consent check", () => {
    const events = read(join(SRC, "lib", "ads", "meta-events.ts"));
    expect(events).toContain("{ eventID: event.eventId }");
    for (const file of ["tiktok-view-content.tsx", "tiktok-commerce-events.tsx", "tiktok-purchase-event.tsx"]) {
      expect(read(join(SRC, "components", file)), `${file} does not forward to Meta`).toContain("emitMetaEvent");
    }
    const commerce = executableSource(join(SRC, "components", "tiktok-commerce-events.tsx"));
    expect(commerce.indexOf("emitMetaEvent(")).toBeLessThan(commerce.indexOf("if (!window.ttq) return;"));
    const purchase = executableSource(join(SRC, "components", "tiktok-purchase-event.tsx"));
    expect(purchase.indexOf("if (body.metaPurchase)")).toBeLessThan(purchase.indexOf("if (!consented) return;"));
  });

  it("reports Purchase from the server for every paid order, not only from the confirmation page", () => {
    const sweep = read(join(SRC, "app", "api", "cron", "sweep", "route.ts"));
    expect(sweep).toContain("sweepUnsentMetaPurchases");
    const sync = read(join(SRC, "lib", "ads", "meta-purchase-sync.ts"));
    expect(sync).toContain('claimSend("meta"');
    const route = read(join(SRC, "app", "api", "ads", "purchase-event", "[orderId]", "route.ts"));
    expect(route).toContain("sendMetaPurchaseForOrder(");
  });
});
