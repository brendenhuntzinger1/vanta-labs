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

// ---------------------------------------------------------------------------
// AND THE TIMING MUST NOT ANSWER EITHER.
//
// Uniform bodies closed half of it. The handler still AWAITED sendServerEvents,
// and that call only happens when a line matched the catalogue — so a real slug
// replied a TikTok round trip later than an unknown one and the same
// enumeration was available with a stopwatch. Both gates are open in production
// (credentialStatus().configured, then serverAdsReportingAllowed()), so that is
// where it was reachable; the harness denies at the second gate and cannot
// reproduce it, which is why this is pinned at the source.
//
// BOUNDED AT BOTH ENDS ON PURPOSE. "The catalogue read appears somewhere after
// after(" is satisfied by a file that awaits it first and reads it again later.
// What has to be true is that NO catalogue work sits on the response path at
// all: nothing before after( opens, and everything inside it.
// ---------------------------------------------------------------------------
describe("funnel-event answers before it touches the catalogue", () => {
  const CATALOGUE_WORK = ['.from("products")', "decideRelay(", "sendServerEvents("];

  // The handler only — imports name sendServerEvents and decideRelay at the top
  // of the file, and an import is not the response path.
  const handlerAt = code.indexOf("export async function POST");
  const afterOpens = code.indexOf("after(", handlerAt);

  /** The matching close of the after() call, found by counting, not guessed. */
  const closeOf = (open: number) => {
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  };
  const afterCloses = closeOf(code.indexOf("(", afterOpens));

  it("defers the catalogue work with after(), not a bare floating promise", () => {
    expect(code).toContain('import { NextResponse, after } from "next/server"');
    expect(handlerAt, "could not find the POST handler").toBeGreaterThan(-1);
    expect(afterOpens, "the handler no longer schedules anything with after()").toBeGreaterThan(handlerAt);
    expect(afterCloses, "could not find the end of the after() callback").toBeGreaterThan(afterOpens);
  });

  it("does no catalogue work before the reply is scheduled", () => {
    for (const needle of CATALOGUE_WORK) {
      const first = code.indexOf(needle, handlerAt);
      expect(first, `expected the handler to still do ${needle}`).toBeGreaterThan(-1);
      expect(first, `${needle} runs on the response path, so its latency is an oracle`).toBeGreaterThan(afterOpens);
      expect(first, `${needle} escaped the after() callback`).toBeLessThan(afterCloses);
    }
  });

  it("never awaits the relay on the response path", () => {
    const responsePath = code.slice(handlerAt, afterOpens);
    expect(responsePath).not.toContain("sendServerEvents");
    expect(responsePath).not.toContain("decideRelay");
    expect(responsePath).not.toContain('.from("products")');
    expect(responsePath).not.toContain("await supabaseAdmin");
  });

  it("still returns the same opaque ack after scheduling", () => {
    expect(code.slice(afterCloses)).toContain("NextResponse.json(ACK");
  });
});
