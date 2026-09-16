import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Omnisend click route is the one door through the account wall that
 * Omnisend mail can use, and its destination arrives in the QUERY STRING —
 * the in-house click routes read theirs from a database row, and Omnisend has
 * no row for this route to read. That makes its ordering and its plumbing
 * security properties, so they are pinned in the source the way
 * link-grant.test.ts pins the middleware's:
 *
 *   * the token is verified before any redirect is built;
 *   * `to` is read once and goes straight into resolveSitePath, nowhere else;
 *   * every redirect target is either the validated landing or the sign-in
 *     fallback — never a request value;
 *   * the grant is minted through emailLinkLanding, so the attestation check
 *     cannot be skipped by a route that forgot to ask;
 *   * no cookie is set beyond the browse grant.
 */
const ROUTE = readFileSync(join(process.cwd(), "src/app/api/email/omnisend-link/route.ts"), "utf8");
const TOKEN = readFileSync(join(process.cwd(), "src/lib/marketing/omnisend/link-token.ts"), "utf8");

/** Source with comments removed: documenting a trap is not falling into it. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const route = executable(ROUTE);

describe("the Omnisend click route verifies before it redirects", () => {
  it("is dynamic, so a click is never served from a cache", () => {
    expect(route).toContain('export const dynamic = "force-dynamic";');
  });

  it("calls verifyOmnisendLink before the first NextResponse.redirect", () => {
    const verify = route.indexOf("verifyOmnisendLink(");
    const redirect = route.indexOf("NextResponse.redirect(");
    expect(verify).toBeGreaterThan(-1);
    expect(redirect).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(redirect);
  });

  it("imports the token verifier from the Omnisend module, not a copy", () => {
    expect(route).toMatch(/import \{[^}]*verifyOmnisendLink[^}]*\} from "@\/lib\/marketing\/omnisend\/link-token";/);
  });

  it("takes the address from the opened token and never from the request", () => {
    expect(route).not.toContain('params.get("e")');
    expect(route).toContain("const verified = await verifyOmnisendLink(token);");
    expect(route).toContain("const email = verified.email;");
  });
});

describe("the redirect target never comes from the request unvalidated", () => {
  it("reads `to` exactly once", () => {
    expect(route.match(/searchParams\.get\("to"\)|params\.get\("to"\)/g)).toHaveLength(1);
  });

  it("passes `to` straight into resolveSitePath and nowhere else", () => {
    const read = route.indexOf('params.get("to")');
    expect(read).toBeGreaterThan(-1);
    const call = route.lastIndexOf("resolveSitePath(", read);
    expect(call, "`to` is read outside a resolveSitePath call").toBeGreaterThan(-1);
    // Inside the argument list: no call closed between the opening paren and
    // the read.
    expect(route.slice(call + "resolveSitePath(".length, read)).not.toContain(")");
  });

  it("redirects only to the sign-in fallback or the validated landing", () => {
    const targets = [...route.matchAll(/NextResponse\.redirect\(\s*([^,]+?)\s*,/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const target of targets) {
      expect(["login", "landing.destination"], `redirects to ${target}`).toContain(target);
    }
  });

  it("builds the sign-in fallback on the site origin with the destination as next=", () => {
    expect(route).toContain('new URL("/account/login", origin)');
    expect(route).toContain('login.searchParams.set("next", sitePathOf(destination))');
  });

  it("tags the destination through withUtm, which refuses an off-site URL", () => {
    expect(route).toMatch(/withUtm\(\s*resolveSitePath\(/);
    expect(route).toContain('source: UTM_SOURCE');
    expect(route).toContain('const UTM_SOURCE = "omnisend";');
  });
});

describe("the grant and the attribution cookie", () => {
  it("decides the landing through emailLinkLanding, which owns the attestation check", () => {
    expect(route).toContain("emailLinkLanding(");
    expect(route).toContain("setEmailLinkGrantCookie(");
    expect(route).toMatch(/import \{[^}]*emailLinkLanding[^}]*setEmailLinkGrantCookie[^}]*\} from "@\/lib\/email\/recipient-attestation";/);
  });

  it("sets the grant cookie only from the token emailLinkLanding returned", () => {
    expect(route).toContain("if (landing.grant) setEmailLinkGrantCookie(response, landing.grant);");
  });

  it("sets no cookie beyond the browse grant, because nothing reads one and the Cookie Policy gates campaign data on consent", () => {
    expect(route).not.toContain("OMNISEND_ATTRIBUTION_COOKIE");
    expect(route).not.toContain("vl_omnisend");
    expect(route.split("cookies.set(").length - 1).toBe(0);
    expect(route.split("setEmailLinkGrantCookie(").length - 1).toBe(1);
  });

  it("caps the labels anyone can put in a utm_ parameter", () => {
    expect(route).toContain("const MAX_LABEL_LENGTH = 100;");
    expect(route).toContain('const campaign = label(params.get("utm_campaign"));');
    expect(route).toContain('const content = label(params.get("utm_content"));');
  });
});

describe("every failure still redirects", () => {
  it("wraps the handler so the last resort is the sign-in fallback", () => {
    const lastCatch = route.lastIndexOf("catch {");
    const lastRedirect = route.lastIndexOf("NextResponse.redirect(login");
    expect(lastCatch).toBeGreaterThan(-1);
    expect(lastRedirect).toBeGreaterThan(lastCatch);
  });
});

describe("the token module is middleware-safe", () => {
  it("imports neither server-only nor node:crypto, and seals with Web Crypto", () => {
    const token = executable(TOKEN);
    expect(token).not.toContain('"server-only"');
    expect(token).not.toContain("node:crypto");
    expect(token).not.toContain("Buffer.");
    expect(token).toContain("crypto.subtle.importKey(");
    expect(token).toContain("crypto.subtle.encrypt(");
    expect(token).toContain("crypto.subtle.decrypt(");
    expect(token).toContain("crypto.getRandomValues(");
  });

  it("seals under its own namespace, caps token length, and never puts the address beside the token", () => {
    const token = executable(TOKEN);
    expect(token).toContain('const NAMESPACE = `omnisend_link:${VERSION}:`;');
    expect(token).toContain("`${NAMESPACE}${address}:${expiresAtMs}`");
    expect(token).toContain("const MAX_TOKEN_LENGTH = 512;");
    expect(token).toContain("process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY");
    expect(token).not.toContain("[[contact.email]]");
  });
});
