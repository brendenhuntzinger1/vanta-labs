import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CQ-06 / CQ-03 — the two repository facts a fresh operator relies on.
//
//   * Every `process.env.X` the RUNTIME reads is documented in .env.example, or
//     a new deployment silently degrades (push notifications fall back to
//     nothing; the marketing Reply-To falls back to the sending identity) with
//     no config-time error anywhere.
//   * public/ ships nothing that nothing references. The 6.2 MB hero master was
//     80% of every static byte the site carried and was loaded by no page.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

/** Provided by the platform or the test harness, never by an operator. */
const NOT_OPERATOR_CONFIG = new Set([
  "NODE_ENV",
  "CI",
  "PATH",
  "TZ",
  "PORT",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_REGION",
  "NEXT_PUBLIC_VERCEL_ENV",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_SENTRY_RELEASE",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  // Stamped by next.config at build time, never set by an operator.
  "NEXT_PUBLIC_BUILD_ID",
  "NEXT_PUBLIC_BUILD_TIME",
  // Test / harness plumbing, read only by *.test.ts and the e2e helpers.
  "VANTA_TEST_DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.test\.|\.e2e\./.test(entry)) out.push(path);
  }
  return out;
}

describe(".env.example documents every runtime env var the code reads", () => {
  const example = readFileSync(resolve(ROOT, ".env.example"), "utf8");
  const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

  const read = new Set<string>();
  for (const file of walk(resolve(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) read.add(match[1]);
  }

  it("has no undocumented names", () => {
    const missing = [...read].filter((name) => !NOT_OPERATOR_CONFIG.has(name) && !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("names the Pushover fallback and the marketing Reply-To specifically", () => {
    for (const name of ["PUSHOVER_API_TOKEN", "PUSHOVER_USER_KEY", "PUSHOVER_SOUND", "MARKETING_REPLY_TO"]) {
      expect(documented.has(name), `${name} missing from .env.example`).toBe(true);
    }
  });
});

describe("public/ carries no unreferenced multi-megabyte media", () => {
  it("the un-optimised hero master is gone; only the derived clips ship", () => {
    expect(existsSync(resolve(ROOT, "public/videos/vanta-labs-hero.mp4"))).toBe(false);
    expect(existsSync(resolve(ROOT, "public/videos/vanta-labs-hero-opt.mp4"))).toBe(true);
    expect(existsSync(resolve(ROOT, "public/videos/vanta-labs-hero-phone.mp4"))).toBe(true);
  });

  it("nothing under public/ is larger than 2 MB", () => {
    const large: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const info = statSync(path);
        if (info.isDirectory()) scan(path);
        else if (info.size > 2 * 1024 * 1024) large.push(`${path} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    };
    scan(resolve(ROOT, "public"));
    expect(large).toEqual([]);
  });
});
