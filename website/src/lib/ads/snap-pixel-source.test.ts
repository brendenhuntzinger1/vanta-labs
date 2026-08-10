import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository invariants for the Snapchat pixel.
 *
 * Three of these cannot be caught by testing any module in isolation, and all
 * three are cheap mistakes with expensive consequences:
 *
 * - a second pixel initialised somewhere, double-counting every conversion;
 * - the `__INSERT_USER_EMAIL__` placeholder from Snap's generated snippet
 *   shipping as-is, which sends a literal placeholder — or worse, a real
 *   address — to a third party on every page load;
 * - the pixel loading before consent, which is the single most common finding
 *   in a cookie audit and would break the promise the banner makes.
 *
 * So they are asserted against the source tree itself.
 */

const SRC = join(process.cwd(), "src");
const SNAP_PIXEL = join(SRC, "components", "snap-pixel.tsx");
const TIKTOK_PIXEL = join(SRC, "components", "tiktok-pixel.tsx");

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
 * The distinction matters here: the file deliberately *documents* the email
 * placeholder in prose so the next person knows why it is absent. Explaining a
 * trap is not falling into it, and an assertion that cannot tell the two apart
 * would push that explanation out of the codebase.
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
  const source = read(SNAP_PIXEL);
  const start = source.indexOf("<Script");
  const end = source.indexOf("</Script>");
  expect(start, "snap-pixel.tsx no longer renders a <Script>").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("exactly one Snapchat data source", () => {
  it("initialises the pixel in exactly one place", () => {
    const loaders = files.filter((path) => /snaptr\(\s*['"]init['"]/.test(read(path)));
    expect(loaders.map(relative)).toEqual(["src/components/snap-pixel.tsx"]);
  });

  it("loads the Snap SDK from exactly one place", () => {
    const loaders = files.filter((path) => read(path).includes("sc-static.net"));
    expect(loaders.map(relative)).toEqual(["src/components/snap-pixel.tsx"]);
  });

  it("has exactly one hard-coded Snap pixel id, and only the pixel component holds it", () => {
    // Scoped to files that touch Snap at all: an unrelated UUID elsewhere in
    // the tree is not a second pixel, and failing on one would make this
    // assertion noise rather than signal.
    const ids = new Set<string>();
    for (const path of files.filter((p) => /snaptr|SNAP_PIXEL|snap-events/.test(read(p)))) {
      for (const match of read(path).matchAll(/["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/g)) {
        ids.add(match[1]);
      }
    }
    expect([...ids]).toHaveLength(1);
    expect(files.filter((path) => read(path).includes([...ids][0])).map(relative)).toEqual([
      "src/components/snap-pixel.tsx",
    ]);
  });

  it("is mounted once, globally, from the root layout", () => {
    const mounts = files.filter((path) => /<SnapPixel\s*\/>/.test(read(path)));
    expect(mounts.map(relative)).toEqual(["src/app/layout.tsx"]);
    // Alongside the TikTok pixel rather than in a second boundary of its own:
    // both need the same Suspense wrapper for useSearchParams, and a second one
    // is a second place for the two to fall out of step.
    expect(read(join(SRC, "app", "layout.tsx"))).toContain("<TikTokPixel />");
  });
});

describe("no customer email is ever handed to Snap", () => {
  it("never ships the placeholder from Snapchat's generated snippet", () => {
    // 'user_email': '__INSERT_USER_EMAIL__' is what Snap's console hands you.
    // Pasted verbatim it reports that literal string as the visitor's identity.
    const snippet = injectedSnippet();
    expect(snippet).not.toContain("__INSERT_USER_EMAIL__");
    expect(snippet).not.toContain("user_email");
  });

  it("initialises with the pixel id and an empty options object", () => {
    // Asserting the object is *empty* rather than merely email-free is what
    // makes this durable: it also rejects a phone number, an external id, or
    // anything else a future paste drops into that position.
    const init = injectedSnippet().match(/snaptr\(\s*['"]init['"][^\n]*/)?.[0] ?? "";
    expect(init).toBe("snaptr('init', '${SNAP_PIXEL_ID}', {});");
  });

  it("passes no email to snaptr from anywhere in the codebase", () => {
    for (const path of files) {
      const source = executableSource(path);
      if (!source.includes("snaptr")) continue;
      expect(source, `${relative(path)} mentions an email near snaptr`).not.toMatch(/user_email|__INSERT_/);
    }
  });

  it("never builds Snap's raw-identity fields anywhere, only the hashed ones", () => {
    // Snapchat's parameter reference offers both forms side by side. The raw
    // ones are the trap: they work, they look correct, and they quietly hand a
    // third party a customer's address and phone number on every event.
    for (const path of files) {
      const source = executableSource(path);
      expect(source, `${relative(path)} constructs a raw user_email`).not.toMatch(/["']?user_email["']?\s*:/);
      expect(source, `${relative(path)} constructs a raw user_phone_number`).not.toMatch(/["']?user_phone_number["']?\s*:/);
    }
  });

  it("refuses anything that is not a digest, rather than trusting its callers", () => {
    // The guarantee is structural, not a convention: even a caller that hands
    // the builder a raw address gets nothing sent. Asserted here as well as in
    // the unit tests so the guard cannot be deleted as redundant.
    const source = read(join(SRC, "lib", "ads", "snap-events.ts"));
    expect(source).toMatch(/\/\^\[0-9a-f\]\{64\}\$\//);
    expect(source).toContain("hashedOnly");
  });

  it("does not read the customer's address in the purchase component", () => {
    // The one page where the site does know who the visitor is. The browser leg
    // reports the money; identity stays server-side, where TikTok's Events API
    // sends a digest rather than a raw address.
    const purchase = executableSource(join(SRC, "components", "tiktok-purchase-event.tsx"));
    const start = purchase.indexOf("if (body.snapPurchase)");
    expect(start, "the Snap branch has moved — re-point this assertion").toBeGreaterThan(-1);
    const snapBranch = purchase.slice(start, purchase.indexOf("} catch", start));
    expect(snapBranch).toContain("body.snapPurchase");
    expect(snapBranch).not.toMatch(/email/i);
    expect(snapBranch).not.toContain("advancedMatching");
  });
});

describe("the Snap pixel is gated on consent, exactly like the TikTok pixel", () => {
  const snap = read(SNAP_PIXEL);
  const tiktok = read(TIKTOK_PIXEL);

  it("reads the same stored consent key as every other tracker", () => {
    expect(snap).toContain('"vl_cookie_consent"');
    expect(snap).toContain('window.localStorage.getItem(STORAGE_KEY) === "accepted"');
  });

  it("renders nothing at all until consent is recorded", () => {
    // Not `holdConsent`, not a disabled cookie: the SDK is never fetched, so
    // there is no third-party request for someone who declined.
    expect(snap).toContain("if (!accepted) return null;");
    expect(tiktok).toContain("if (!accepted) return null;");
  });

  it("starts from declined rather than assuming consent while it checks", () => {
    expect(snap).toContain("useState(false)");
  });

  it("reacts to consent being granted later in the visit", () => {
    // Someone who accepts the banner on a product page must start being
    // measured there, not on their next page load.
    for (const source of [snap, tiktok]) {
      expect(source).toContain('window.addEventListener(CONSENT_EVENT, sync)');
      expect(source).toContain('window.addEventListener("storage", sync)');
    }
    expect(snap).toContain('const CONSENT_EVENT = "vanta:cookie-consent"');
  });

  it("takes its id from a public env name, never a secret one", () => {
    expect(snap).toContain("process.env.NEXT_PUBLIC_SNAP_PIXEL_ID");
    expect(snap).not.toMatch(/SECRET|ACCESS_TOKEN|SERVICE_ROLE/);
  });

  it("tells the visitor which pixels accepting turns on", () => {
    const banner = read(join(SRC, "components", "cookie-consent.tsx"));
    expect(banner).toMatch(/Snapchat/);
    expect(banner).toMatch(/TikTok/);
  });

  it("names Snap in the cookie and privacy policies", () => {
    // The privacy policy makes an explicit promise: if another advertising
    // platform is added, the policy names it, the data shared and the purpose
    // *before* it is switched on. Adding the pixel without this would make the
    // published policy false, which is a worse problem than no pixel at all.
    const legal = read(join(SRC, "lib", "legal-content.ts"));
    expect(legal).toMatch(/Snap Pixel/);
    expect(legal).toMatch(/neither pixel is loaded at all/);
    // The identity claim has to match what the code actually sends: a digest
    // on a paid order, never a raw address.
    expect(legal).toMatch(/raw email address and phone number are never sent/);
    expect(legal).toMatch(/SHA-256 hash/);
  });
});

describe("a visitor who declined cannot be broken by the event call sites", () => {
  it("only ever calls snaptr optionally, so its absence is a no-op", () => {
    for (const path of files) {
      if (path === SNAP_PIXEL) continue; // the loader defines it
      const source = executableSource(path);
      for (const line of source.split("\n")) {
        if (!line.includes("snaptr")) continue;
        const guarded = /window\.snaptr\?\./.test(line) || /if \(window\.snaptr\)/.test(line) || /snaptr\?:/.test(line);
        expect(guarded, `${relative(path)} calls snaptr unguarded: ${line.trim()}`).toBe(true);
      }
    }
  });
});
