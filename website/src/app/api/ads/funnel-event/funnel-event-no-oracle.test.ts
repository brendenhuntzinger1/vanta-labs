import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE PUBLIC FUNNEL RELAY MUST NOT BE A CATALOGUE ORACLE.
//
// /api/ads/funnel-event is public (it measures the login/landing page, which a
// signed-out ad click reaches). It re-resolves product slugs against the
// catalogue to price the TikTok event. An earlier version let that resolution
// LEAK BACK in the HTTP response: a matched slug returned {sent:true,…,
// totalOverridden}, a miss returned {sent:false,reason:"no line matched a
// catalogue product"}. Measured against production, that was an anonymous oracle
// twice over — probe a slug to learn whether the compound exists, and vary the
// claimed total to binary-search its price — i.e. seeing behind the login wall
// without an account.
//
// The fix: every outcome returns the SAME opaque acknowledgement. These tests
// lock that in at the source level (the handler pulls in supabaseAdmin + the
// TikTok client, so a from-scratch unit invocation would need the whole backend;
// the invariant we care about is purely about what the response body may carry).
// Behavioural parity was also verified on the harness build: a real slug, an
// unknown slug and an implausible-total probe all return byte-identical bodies.
// ---------------------------------------------------------------------------

const src = readFileSync(
  join(process.cwd(), "src/app/api/ads/funnel-event/route.ts"),
  "utf8",
);
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\*.*$/gm, " ")
  .replace(/\/\/.*$/gm, " ");

describe("funnel-event returns a uniform, catalogue-blind acknowledgement", () => {
  it("defines a single constant ACK body", () => {
    expect(code).toMatch(/const ACK = \{[^}]*\}/);
  });

  it("never returns a body that reveals whether a slug matched or a total was overridden", () => {
    const responseBodies = [...code.matchAll(/NextResponse\.json\(([^;]*?)\)/g)].map((m) => m[1]);
    const returned = responseBodies.join("\n");
    expect(returned).not.toMatch(/totalOverridden/);
    expect(returned).not.toMatch(/delivered/);
    expect(returned).not.toMatch(/tiktokCode/);
    expect(returned).not.toMatch(/sent:\s*true/);
    const nonRateLimit = responseBodies.filter((b) => !/rate limited/.test(b));
    for (const body of nonRateLimit) {
      expect(body.trim().startsWith("ACK"), `non-uniform response body: ${body.trim().slice(0, 60)}`).toBe(true);
    }
  });

  it("still re-resolves prices from the catalogue server-side (the anti-forgery property is untouched)", () => {
    expect(code).toContain('.from("products")');
    expect(code).toContain("decideRelay");
  });
});
