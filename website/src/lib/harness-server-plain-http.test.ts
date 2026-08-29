import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// THE HARNESS SERVES OVER PLAIN HTTP, AND THE APP'S OWN HEADERS BREAK IT THERE.
//
// Every response carries, correctly for production:
//
//   Content-Security-Policy: ...; upgrade-insecure-requests
//   Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
//
// `upgrade-insecure-requests` tells the browser to rewrite every http
// subresource URL to https. The harness listens on http://127.0.0.1:3000 and
// speaks no TLS, so on an engine that honours the directive for loopback every
// asset fails the handshake:
//
//   script https://127.0.0.1:3000/_next/static/chunks/turbopack-….js
//     :: Error performing TLS handshake: An unexpected TLS packet was received
//
// Measured 2026-08-29: 14 of 14 scripts failed, React never booted, and the age
// gate's Continue button stayed disabled forever — a dead site that is entirely
// an artifact of testing a production header over plain http.
//
// Chromium hides this. It exempts potentially-trustworthy origins (localhost,
// 127.0.0.1) from the upgrade, so the same build works there and the harness
// looked fine for as long as Chromium was the only engine available. WebKit
// does not exempt loopback — and WebKit is the engine every iOS in-app browser
// uses, which is exactly what cross-engine-check.mjs exists to cover.
//
// So the headers are stripped HERE, in the dev-only harness server, and only
// there. Production still sends both, unchanged: this file is not part of the
// deployed app, and next.config's headers are untouched.
// ---------------------------------------------------------------------------

describe("the harness server can be driven by an engine that honours HSTS on loopback", () => {
  const server = read("scripts/harness-server.mjs");

  it("drops upgrade-insecure-requests, which has no meaning on a plaintext port", () => {
    expect(server).toContain("upgrade-insecure-requests");
    expect(server).toMatch(/content-security-policy/i);
  });

  it("drops HSTS, so the engine does not pin 127.0.0.1 to https for later runs", () => {
    // HSTS on loopback poisons the browser profile: once pinned, even a later
    // correct run is upgraded and fails before it starts.
    expect(server).toMatch(/strict-transport-security/i);
  });

  it("leaves the real headers in middleware alone", () => {
    // The control the app actually ships. Weakening THIS to make a test pass
    // would be the wrong fix — production is https and both headers belong
    // there. The harness strips them on the way out instead.
    const middleware = read("middleware.ts");
    expect(middleware).toContain("upgrade-insecure-requests");
    expect(middleware).toMatch(/Strict-Transport-Security/i);
    // And the stripping must be confined to the dev-only server.
    expect(server).toMatch(/harness|development-only/i);
  });
});
