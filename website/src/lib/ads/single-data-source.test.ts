import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findClientExposedSecrets } from "./tracking-health-server";

/**
 * Repository invariants for the TikTok integration.
 *
 * These are the two mistakes that are cheap to make and expensive to find: a
 * second pixel quietly initialised somewhere, and a secret that ends up in the
 * browser bundle. Neither shows up in a unit test of any individual module, so
 * they are asserted against the source tree itself.
 */

const SRC = join(process.cwd(), "src");

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

describe("exactly one TikTok data source", () => {
  it("initialises the pixel in exactly one place", () => {
    const loaders = files.filter((path) => /ttq\.load\(['"]/.test(read(path)));
    expect(loaders.map((p) => p.replace(SRC, "src"))).toEqual(["src/components/tiktok-pixel.tsx"]);
  });

  it("has only one hard-coded pixel id, and the browser and server share it", () => {
    const ids = new Set<string>();
    for (const path of files) {
      for (const match of read(path).matchAll(/["']([A-Z0-9]{20})["']/g)) ids.add(match[1]);
    }
    expect([...ids]).toHaveLength(1);

    const users = files.filter((path) => read(path).includes([...ids][0]));
    expect(users.map((p) => p.replace(SRC, "src")).sort()).toEqual([
      "src/components/tiktok-pixel.tsx",
      "src/lib/ads/tiktok-events-api.ts",
    ]);
  });

  it("reports conversions from exactly one module", () => {
    // The Events API and the Ads Management API share a host but are different
    // services: one writes conversions in, the other reads spend out. What must
    // stay singular is the thing that can create a conversion.
    const senders = files.filter((path) => read(path).includes("/event/track/"));
    expect(senders.map((p) => p.replace(SRC, "src"))).toEqual(["src/lib/ads/tiktok-events-api.ts"]);
  });

  it("keeps ad management in one module, and it cannot report conversions", () => {
    const managers = files.filter((path) => read(path).includes("/report/integrated/get/") && !read(path).includes("SimulationTikTokClient"));
    expect(managers.map((p) => p.replace(SRC, "src"))).toEqual(["src/lib/ads/tiktok-ads-api.ts"]);
    expect(read(`${SRC}/lib/ads/tiktok-ads-api.ts`)).not.toContain("/event/track/");
  });
});

describe("the access token never reaches the browser", () => {
  it("is read only in server-only modules", () => {
    const readers = files.filter((path) => read(path).includes("env.TIKTOK_EVENTS_API_ACCESS_TOKEN"));
    for (const path of readers) {
      const source = read(path);
      const isServerModule = source.includes('import "server-only"') || path.includes(`${join("app", "api")}`);
      expect(isServerModule, `${path} reads the token but is not server-only`).toBe(true);
      expect(source.startsWith('"use client"'), `${path} is a client component`).toBe(false);
    }
  });

  it("is never given a NEXT_PUBLIC_ name anywhere in the source", () => {
    for (const path of files) {
      expect(read(path)).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(ACCESS_TOKEN|SECRET|SERVICE_ROLE)/);
    }
  });

  it("flags a secret that has been given a public name at runtime", () => {
    expect(findClientExposedSecrets({ NEXT_PUBLIC_TIKTOK_ACCESS_TOKEN: "x" } as unknown as NodeJS.ProcessEnv)).toEqual([
      "NEXT_PUBLIC_TIKTOK_ACCESS_TOKEN",
    ]);
  });

  it("flags the token's value even under an innocent-looking public name", () => {
    const exposed = findClientExposedSecrets({
      TIKTOK_EVENTS_API_ACCESS_TOKEN: "a-real-looking-token-value",
      NEXT_PUBLIC_ANALYTICS_ID: "a-real-looking-token-value",
    } as unknown as NodeJS.ProcessEnv);
    expect(exposed).toEqual(["NEXT_PUBLIC_ANALYTICS_ID"]);
  });

  it("does not flag public values that are meant to be public", () => {
    expect(
      findClientExposedSecrets({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
        NEXT_PUBLIC_TIKTOK_PIXEL_ID: "D9SAES3C77U40SOI9D70",
        TIKTOK_EVENTS_API_ACCESS_TOKEN: "kept-server-side",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual([]);
  });
});
