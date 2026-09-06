import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE DESTINATION WAS VALIDATED, THREADED THROUGH, AND THEN DISCARDED.
//
// /api/auth/signup reads `nextPath`, validates it with safeInternalPath, folds
// it into `redirectTo` and hands that to generateLink. But `redirectTo` reaches
// the customer only through `fallbackActionLink` — the raw Supabase link, used
// solely when the branded hop cannot be built. The link every customer actually
// receives is brandedConfirmUrl's, and it hardcoded `next: "/account"`.
//
// So a shopper sent to sign up from a product page confirmed their address and
// landed on their account instead of the page they came from — with the client
// dutifully sending a value the server dutifully validated and then ignored.
// The resend path did the same.
//
// Both now carry the customer's own destination, re-validated at the point of
// use because it ends up in a link in an email.
// ---------------------------------------------------------------------------

const code = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const signup = code("src/app/api/auth/signup/route.ts");
const resend = code("src/lib/auth-confirmation-email.ts");

describe("the branded confirmation link", () => {
  it("no longer hardcodes /account on the signup path", () => {
    expect(signup).not.toContain('next: "/account"');
    expect(signup).toContain('next: safeInternalPath(input.nextPath, "/account")');
  });

  it("no longer hardcodes it on the resend path either", () => {
    expect(resend).not.toContain('next: "/account"');
    expect(resend).toContain("next: nextFromRedirect(redirectTo)");
  });

  it("threads the customer's path from the request to the link", () => {
    // The value the client sends, validated once at the edge and once at use.
    expect(signup).toContain('const nextPath = read("nextPath") || "/account"');
    expect(signup).toContain("nextPath,");
  });
});

describe("what the resend reads it back out of", () => {
  it("recovers the next from the redirect it is already given, keeping the signature", async () => {
    // Four callers pass `redirectTo` as one string; the destination is inside
    // it. Reading it back beats widening the signature for all of them.
    const emailModule = await import("@/lib/auth-confirmation-email");
    expect(typeof emailModule.sendBrandedConfirmationResend).toBe("function");
    expect(resend).toContain('new URL(redirectTo).searchParams.get("next")');
  });

  it("falls back to /account when the redirect carries none, or is not a URL", () => {
    // Both branches are in the source; the point is that neither throws into
    // an email send.
    expect(resend).toContain('safeInternalPath(new URL(redirectTo).searchParams.get("next"), "/account")');
    expect(resend).toContain('return "/account";');
  });
});

describe("an off-site destination", () => {
  it("is refused by the same guard both paths already use", () => {
    // safeInternalPath resolves the candidate against an origin and checks the
    // origin survived, which is what makes `/\\evil.example/steal` fail.
    for (const src of [signup, resend]) {
      expect(src).toContain("safeInternalPath(");
    }
  });
});
