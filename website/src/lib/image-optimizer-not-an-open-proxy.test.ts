import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// /_next/image WAS AN OPEN IMAGE PROXY, UNDER A COMMENT SAYING IT WAS NOT.
//
// next.config.ts allowed `**.supabase.co` and `**.cloudfront.net`, above a note
// explaining that a wildcard "turns the optimizer into an open image proxy
// (SSRF / bandwidth abuse)". Both ARE wildcards in the way that matters: anyone
// can create a Supabase project or a CloudFront distribution, so
// /_next/image?url=https://attacker.cloudfront.net/huge.png fetched and
// re-served arbitrary content through this domain, on Vercel's image
// optimizer, billed to this account.
//
// All 42 product_images rows are on the configured Supabase host and the string
// "cloudfront" appears nowhere else in the repository, so the second pattern
// bought nothing.
// ---------------------------------------------------------------------------

const raw = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
/** Comments stripped: the note recording this fix names the host it bans. */
const config = raw
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\/\/.*$/gm, " ");

describe("the image optimizer serves our own storage and nothing else", () => {
  it("allows no CloudFront distribution, which nothing here has ever used", () => {
    expect(config).not.toContain("cloudfront");
  });

  it("derives the allowed host from NEXT_PUBLIC_SUPABASE_URL rather than restating it", () => {
    expect(config).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(config).toContain("new URL(configured).hostname");
  });

  it("keeps exactly one remote pattern", () => {
    const patterns = [...config.matchAll(/protocol:\s*"https"/g)].length;
    expect(patterns).toBe(1);
  });

  it("falls back to the bounded wildcard only when no Supabase URL is configured", () => {
    // An empty remotePatterns list breaks every remote image, which is a worse
    // failure than the one being closed — so a local or preview build with no
    // Supabase URL keeps working.
    expect(config).toContain('hostname ?? "**.supabase.co"');
    expect(raw).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("resolves to the exact project host when the URL is set", () => {
    const resolve = (url?: string) => {
      const configured = url?.trim();
      const hostname = configured
        ? (() => {
            try {
              return new URL(configured).hostname;
            } catch {
              return null;
            }
          })()
        : null;
      return hostname ?? "**.supabase.co";
    };

    expect(resolve("https://mlpimwgkwuqpsvsrlpqv.supabase.co")).toBe("mlpimwgkwuqpsvsrlpqv.supabase.co");
    expect(resolve(undefined)).toBe("**.supabase.co");
    expect(resolve("not a url")).toBe("**.supabase.co");
  });
});
