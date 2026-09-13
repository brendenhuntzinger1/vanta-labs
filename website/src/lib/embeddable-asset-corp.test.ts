import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isPublicPath } from "@/lib/access-policy";

// ---------------------------------------------------------------------------
// A campaign hero has to survive being embedded somewhere that is not us.
//
// middleware set Cross-Origin-Resource-Policy: same-origin on every response,
// which is the right default for this app and the wrong one for /images. An
// email is the case that proves it: the artwork is loaded by a document on a
// completely different origin, so same-origin tells the renderer to drop it and
// the recipient gets alt text where the offer should be.
//
// curl cannot catch this. CORP is enforced by the embedding client, so a
// blocked asset still answers 200 with the right bytes, the right
// content-type and the right length from the command line — which is exactly
// what it did. It was found by rendering a real campaign against the deployed
// URL and reading the console: ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
// ---------------------------------------------------------------------------

const MIDDLEWARE = readFileSync(
  path.resolve(__dirname, "..", "..", "middleware.ts"),
  "utf8",
);

const EMBEDDABLE = ["/images/", "/icons/", "/videos/", "/fonts/"];

describe("public asset trees are embeddable off-origin", () => {
  it("does not hardcode same-origin for every response", () => {
    expect(MIDDLEWARE).not.toContain('response.headers.set("Cross-Origin-Resource-Policy", "same-origin");');
  });

  it("chooses the value from the path", () => {
    expect(MIDDLEWARE).toContain("EMBEDDABLE_ASSET_PREFIXES");
    expect(MIDDLEWARE).toContain('embeddable ? "cross-origin" : "same-origin"');
  });

  it.each(EMBEDDABLE)("relaxes %s", (prefix) => {
    const list = MIDDLEWARE.slice(
      MIDDLEWARE.indexOf("const EMBEDDABLE_ASSET_PREFIXES"),
      MIDDLEWARE.indexOf("function applySecurityHeaders"),
    );
    expect(list).toContain(`"${prefix}"`);
  });

  it("passes the path in, or the choice can never be made", () => {
    // The helper defaults pathname to undefined, so forgetting this argument
    // fails closed (same-origin) and silently reinstates the bug.
    expect(MIDDLEWARE).toContain("applySecurityHeaders(response, pathname)");
  });

  it("relaxes NOTHING that is not already public without an account", () => {
    // The security property that makes this safe: these trees are already
    // served to anyone who asks, so cross-origin grants no new access.
    for (const prefix of EMBEDDABLE) {
      expect(isPublicPath(`${prefix}example.png`), `${prefix} must be public`).toBe(true);
    }
  });

  it("leaves the app itself same-origin", () => {
    for (const p of ["/products", "/api/catalog/products", "/account/orders", "/admin"]) {
      expect(EMBEDDABLE.some((prefix) => p.startsWith(prefix)), `${p} must stay same-origin`).toBe(false);
    }
  });

  it("keeps the hero on a relaxed tree", () => {
    const hero = "/images/b2g1-hero.jpg";
    expect(EMBEDDABLE.some((prefix) => hero.startsWith(prefix))).toBe(true);
    expect(isPublicPath(hero)).toBe(true);
  });
});
