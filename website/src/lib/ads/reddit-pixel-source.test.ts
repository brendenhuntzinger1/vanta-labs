import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Reddit pixel.
 *
 * The same three cheap mistakes the Snap suite guards against apply here, and
 * two are made likelier by how Reddit hands the snippet over:
 *
 * - a second pixel initialised somewhere, double-counting every conversion;
 * - a user identifier pasted into `rdt('init', ...)`, which Reddit's own docs
 *   invite ("DO NOT MODIFY UNLESS TO REPLACE A USER IDENTIFIER" is Reddit's
 *   comment, not ours) and which would send an email to a third party on every
 *   page load;
 * - the pixel loading before consent, which is the single most common finding
 *   in a cookie audit and would break the promise the banner makes.
 *
 * So they are asserted against the source tree itself.
 */

const SRC = join(process.cwd(), "src");
const REDDIT_PIXEL = join(SRC, "components", "reddit-pixel.tsx");
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
 * Source with comments removed. The component deliberately *documents* the
 * identifier trap in prose so the next person knows why the field is empty;
 * explaining a trap is not falling into it.
 */
function executableSource(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** The snippet actually injected into the page, between the <Script> tags. */
function injectedSnippet(): string {
  const source = read(REDDIT_PIXEL);
  const start = source.indexOf("<Script");
  const end = source.indexOf("</Script>");
  expect(start, "reddit-pixel.tsx no longer renders a <Script>").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("exactly one Reddit data source", () => {
  it("initialises the pixel in exactly one place", () => {
    // Executable source only: the matching module and its API route DESCRIBE
    // init in prose, and explaining a call is not making one.
    const loaders = files.filter((path) => /rdt\(\s*['"]init['"]/.test(executableSource(path)));
    expect(loaders.map(relative)).toEqual(["src/components/reddit-pixel.tsx"]);
  });

  it("injects the Reddit SDK from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes("redditstatic.com/ads/pixel.js"));
    expect(loaders.map(relative)).toEqual(["src/components/reddit-pixel.tsx"]);
  });

  it("holds the pixel id in exactly one file", () => {
    const withId = files.filter((path) => read(path).includes("a2_jipuxv3ugrju"));
    expect(withId.map(relative)).toEqual(["src/components/reddit-pixel.tsx"]);
  });

  it("uses the same id for the loader URL and both init forms", () => {
    // Reddit's snippet carries the id twice. Two different ids means the SDK
    // downloads for one account and reports to another — the loader still works,
    // so nothing looks broken, and the conversions simply never arrive.
    // The id is now referenced from three places (loader URL, init-with-keys,
    // init-without-keys) and every one must be the same constant.
    const source = read(REDDIT_PIXEL);
    expect(injectedSnippet()).toContain("pixel_id=${REDDIT_PIXEL_ID}");
    const initForms = source.match(/rdt\('init','\$\{REDDIT_PIXEL_ID\}'/g) ?? [];
    expect(initForms).toHaveLength(2);
    // No hard-coded id anywhere except the env-var default.
    const literals = source.match(/a2_[a-z0-9]+/g) ?? [];
    expect(literals).toHaveLength(1);
    expect(source).toContain('process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID ?? "a2_jipuxv3ugrju"');
  });

  it("is mounted once, globally, from the root layout", () => {
    const mounts = files.filter((path) => /<RedditPixel\s*\/>/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    // Inside the SAME Suspense boundary as the other two: all three call
    // useSearchParams, and a second boundary is a second place to fall out of step.
    const layout = read(join(SRC, "app", "layout.tsx"));
    const boundary = layout.slice(layout.indexOf("<TikTokPixel />"), layout.indexOf("</Suspense>", layout.indexOf("<TikTokPixel />")));
    expect(boundary).toContain("<RedditPixel />");
  });
});

describe("no customer identifier is ever handed to Reddit", () => {
  it("builds the init call from a serialised digest object, never from raw text", () => {
    // Advanced Matching goes in init's second argument. Reddit's own example
    // puts a PLAINTEXT address there. The guarantee here is that the only thing
    // that can reach it is the object fetched from the server, serialised — so
    // there is no position in this file where an address could be interpolated.
    const source = read(REDDIT_PIXEL);
    expect(source).toContain("JSON.stringify(matchKeys)");
    expect(source).toMatch(/rdt\('init','\$\{REDDIT_PIXEL_ID\}'\);/); // the no-keys form
  });

  it("never reads a raw address in the browser — the component only ever sees digests", () => {
    // The component may name the FIELD (its payload has an `email` key holding a
    // digest); what it must never do is read a customer's actual address off a
    // session, a form or a prop.
    const source = executableSource(REDDIT_PIXEL);
    expect(source).not.toMatch(/user\??\.email|customer\??\.email|\.email\s*=|getAuthenticatedUser/);
    expect(source).toContain('fetch("/api/ads/reddit-match-keys"');
  });

  it("hashes on the server, and the endpoint takes no input it could be tricked with", () => {
    const route = read(join(SRC, "app", "api", "ads", "reddit-match-keys", "route.ts"));
    // Derived from the session only. No request body, no query parameter — so
    // it cannot be used as an oracle to hash an arbitrary address.
    expect(route).toContain("getAuthenticatedUser()");
    expect(route).toContain("buildRedditMatchKeys");
    expect(route).not.toMatch(/request\.json\(\)|searchParams/);
    // Per-person values must never land in a shared cache.
    expect(route).toContain("no-store");
  });

  it("the match-key lookup can never prevent the pixel loading", () => {
    const source = read(REDDIT_PIXEL);
    // Resolves to null on any failure, and the timeout guarantees it resolves.
    expect(source).toContain("setMatchKeys(null)");
    expect(source).toContain("MATCH_KEY_TIMEOUT_MS");
  });

  it("sends page views only — no commerce events, which is what the policy states", () => {
    // The cookie policy tells customers that TikTok and Snap receive shopping
    // actions and Reddit does not. If that stops being true, the policy is
    // wrong before anyone notices, so the claim is pinned to the code.
    for (const path of files) {
      const source = executableSource(path);
      if (!source.includes("rdt")) continue;
      const tracked = [...source.matchAll(/rdt\?\.\(\s*["']track["']\s*,\s*["']([^"']+)["']/g)].map((m) => m[1]);
      const inlineTracked = [...source.matchAll(/rdt\('track',\s*'([^']+)'\)/g)].map((m) => m[1]);
      expect(new Set([...tracked, ...inlineTracked])).toEqual(new Set(["PageVisit"]));
    }
  });
});

describe("the Reddit pixel is gated on consent, exactly like the others", () => {
  const reddit = read(REDDIT_PIXEL);
  const snap = read(SNAP_PIXEL);

  it("reads the same stored consent key as every other tracker", () => {
    expect(reddit).toContain('"vl_cookie_consent"');
    expect(reddit).toContain('window.localStorage.getItem(STORAGE_KEY) === "accepted"');
  });

  it("renders nothing at all until consent is recorded", () => {
    // Not merely "does not fire events" — the <Script> must not exist, so the
    // SDK is never fetched and no request reaches redditstatic.com.
    expect(reddit).toContain("if (!accepted) return null;");
    const gate = reddit.indexOf("if (!accepted) return null;");
    expect(gate).toBeLessThan(reddit.indexOf("<Script"));
  });

  it("treats blocked storage as a refusal, not as consent", () => {
    expect(reddit).toMatch(/catch\s*\{[\s\S]*?return false;/);
  });

  it("listens for consent being granted later in the same session", () => {
    // Otherwise accepting the banner does nothing until a full page reload.
    expect(reddit).toContain('"vanta:cookie-consent"');
    expect(reddit).toContain('window.addEventListener(CONSENT_EVENT, sync)');
  });

  it("starts from the same default as the Snap pixel: not accepted", () => {
    expect(reddit).toContain("useState(false)");
    expect(snap).toContain("useState(false)");
  });
});

describe("the disclosure names Reddit", () => {
  const banner = read(join(SRC, "components", "cookie-consent.tsx"));
  const legal = read(join(SRC, "lib", "legal-content.ts"));

  it("names it on the consent banner, where the choice is made", () => {
    expect(banner).toMatch(/Reddit/);
  });

  it("names it in the cookie policy alongside the other two", () => {
    expect(legal).toMatch(/Reddit Pixel/);
    expect(legal).toMatch(/no request reaches TikTok, Snap or Reddit/);
  });

  it("states that what Reddit receives is a hash, never a raw address", () => {
    // The policy previously said no identifier of any kind reached Reddit. That
    // stopped being true the moment Advanced Matching was switched on, and a
    // published policy that is false is worse than no pixel at all.
    expect(legal).toMatch(/SHA-256[^.]*Reddit|Reddit[^.]*SHA-256/);
  });
});
