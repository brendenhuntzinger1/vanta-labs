import { describe, expect, it } from "vitest";
import { isSafeSitePath, resolveSitePath } from "@/lib/email/cta-path";

const SITE = "https://vantalabsresearch.com";

// ---------------------------------------------------------------------------
// This file exists because of one bug found in the pre-launch audit: the check
// used to be `startsWith("/") && !startsWith("//")`, and `/\evil.com` walked
// straight through it. The URL parser treats a backslash as a slash when it is
// resolving authority, so that path resolves to https://evil.com/ — on a link
// customers click because it came from us.
//
// Each hostile case below is a separate `it` rather than a loop, so a
// regression names the exact bypass that came back.
// ---------------------------------------------------------------------------

describe("paths that must be accepted", () => {
  it.each([
    "/",
    "/products",
    "/products/bpc-157",
    "/products?sort=price",
    "/products#section",
    "/legal/research-disclaimer",
  ])("accepts %s", (path) => {
    expect(isSafeSitePath(path, SITE)).toBe(true);
    expect(resolveSitePath(path, SITE)).toBe(`${SITE}${path}`);
  });
});

describe("authority tricks that must be refused", () => {
  it("refuses a protocol-relative path", () => {
    expect(isSafeSitePath("//evil.com", SITE)).toBe(false);
  });

  it("refuses a BACKSLASH authority — the bypass this module was written for", () => {
    // Resolves to https://evil.com/ despite starting with a single "/".
    expect(new URL("/\\evil.com", SITE).origin).toBe("https://evil.com");
    expect(isSafeSitePath("/\\evil.com", SITE)).toBe(false);
  });

  it("refuses mixed slash/backslash authorities", () => {
    for (const path of ["/\\/evil.com", "/\\\\evil.com", "\\\\evil.com", "/\\t\\evil.com"]) {
      expect(isSafeSitePath(path, SITE)).toBe(false);
    }
  });

  it("refuses absolute URLs and non-http schemes", () => {
    for (const path of ["https://evil.com", "http://evil.com", "javascript:alert(1)", "data:text/html,x", "mailto:x@y.com"]) {
      expect(isSafeSitePath(path, SITE)).toBe(false);
    }
  });

  it("refuses a userinfo trick that targets another host", () => {
    // "https://vantalabsresearch.com@evil.com" is a classic; it must not be
    // reachable through the relative-path field either.
    expect(isSafeSitePath("//vantalabsresearch.com@evil.com", SITE)).toBe(false);
  });

  it("refuses anything not anchored at the root", () => {
    for (const path of ["products", "./products", "../admin", ""]) {
      expect(isSafeSitePath(path, SITE)).toBe(false);
    }
  });

  it("refuses control characters, which would split a Location header", () => {
    for (const path of ["/products\r\nSet-Cookie: admin=1", "/products\nX: y", "/pro\tducts"]) {
      expect(isSafeSitePath(path, SITE)).toBe(false);
    }
  });

  it("refuses null and undefined without throwing", () => {
    expect(isSafeSitePath(null, SITE)).toBe(false);
    expect(isSafeSitePath(undefined, SITE)).toBe(false);
  });
});

describe("resolveSitePath always yields somewhere safe to send a customer", () => {
  it("falls back to the catalog for every hostile input", () => {
    for (const path of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "", null]) {
      const resolved = resolveSitePath(path, SITE);
      expect(resolved).toBe(`${SITE}/products`);
      expect(new URL(resolved).origin).toBe(SITE);
    }
  });

  it("never returns a URL on another origin, for any input", () => {
    const inputs = ["/ok", "//evil.com", "/\\evil.com", "\\evil.com", "/a\\b", "///evil.com", "/%2f%2fevil.com"];
    for (const path of inputs) {
      expect(new URL(resolveSitePath(path, SITE)).origin).toBe(SITE);
    }
  });

  it("degrades safely when the site origin itself is malformed", () => {
    expect(isSafeSitePath("/products", "not-a-url")).toBe(false);
  });
});
