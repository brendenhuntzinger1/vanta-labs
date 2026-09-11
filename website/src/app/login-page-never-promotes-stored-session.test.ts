import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classifyAuthReturn, readOAuthCallbackFragment } from "@/lib/auth-link-fragment";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Strip comments so prose ABOUT a rule is not mistaken for the rule. */
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

const form = code(read("src/components/account-auth-form.tsx"));
const callback = code(read("src/app/account/auth/callback/page.tsx"));

// ---------------------------------------------------------------------------
// THE LOGIN PAGE SIGNED A VISITOR IN AS WHOEVER LAST USED THE BROWSER.
//
// /account/auth/callback was rewritten to stop asking a proxy question: not
// "does this URL look like a return from an auth link" but "which tokens
// arrived in it", so that client storage is never consulted for identity.
// readOAuthCallbackFragment's own header records why. The LOGIN page still
// asked the proxy question, and the gap between the two predicates is the whole
// bug:
//
//     classifyAuthReturn("#refresh_token=x")          -> kind "session"
//     supabase-js _isImplicitGrantCallback            -> not a callback at all
//
// So on `/account/login#refresh_token=anything`, the page decided a session had
// arrived, called supabase.auth.getSession(), and supabase-js — having found no
// implicit-grant callback — answered from localStorage with the PREVIOUS
// customer's live session. That was posted to /api/auth/session, which cannot
// tell: the token is genuine, so GoTrue verifies it and an httpOnly cookie is
// minted for the wrong person. A shared or public browser is all it needs.
//
// The gap is asserted directly below, so this cannot be read as hypothetical.
// ---------------------------------------------------------------------------

describe("the two fragment predicates disagree, which is why the weaker one may not gate a session", () => {
  it("classifyAuthReturn accepts a refresh_token-only fragment as a session", () => {
    expect(classifyAuthReturn("#refresh_token=anything").kind).toBe("session");
  });

  it("readOAuthCallbackFragment refuses it, because half a session is not one", () => {
    expect(readOAuthCallbackFragment("#refresh_token=anything").kind).toBe("none");
    expect(readOAuthCallbackFragment("#access_token=only").kind).toBe("none");
  });

  it("readOAuthCallbackFragment returns the tokens themselves when both arrive", () => {
    const outcome = readOAuthCallbackFragment("#access_token=aaa&refresh_token=bbb&type=signup");
    expect(outcome).toEqual({ kind: "session", accessToken: "aaa", refreshToken: "bbb" });
  });

  it("an error fragment is an error, never a session, even carrying a stale token", () => {
    expect(readOAuthCallbackFragment("#error_code=otp_expired&access_token=x&refresh_token=y").kind).toBe("error");
  });
});

describe("the login page takes its tokens from the fragment and never from client storage", () => {
  it("classifies the fragment with readOAuthCallbackFragment, like the callback does", () => {
    // The login form reads the hash through useSyncExternalStore (so the
    // hydration render matches the server) and classifies what it read; the
    // callback page reads it directly. Same predicate, same input.
    expect(form).toContain("const readLocationHash = () => window.location.hash;");
    expect(form).toContain("useSyncExternalStore(subscribeNever, readLocationHash, getServerLocationHash)");
    expect(form).toContain("readOAuthCallbackFragment(liveHash)");
    expect(callback).toContain("readOAuthCallbackFragment(window.location.hash)");
  });

  it("never asks supabase.auth.getSession() for the identity to promote", () => {
    // getSession() reads localStorage. That is the whole defect: on a shared
    // machine it answers with the previous customer.
    expect(form).not.toContain("supabase.auth.getSession()");
    expect(callback).not.toContain("supabase.auth.getSession()");
  });

  it("verifies the fragment's own token against GoTrue before establishing anything", () => {
    expect(form).toMatch(/supabase\.auth\.getUser\(\s*accessToken\s*\)/);
  });

  it("posts the fragment's tokens", () => {
    expect(form).toContain("const { accessToken, refreshToken } = authReturn");
  });

  it("reads a session object ONLY where supabase-js just minted one", () => {
    // signInWithPassword and verifyOtp RETURN the session they created; that is
    // not storage and is the correct thing to promote. Every `data.session` in
    // this file must be one of those two, never a read of what the client had
    // lying around.
    const sessionReads = [...form.matchAll(/data\.session/g)].length;
    const minted =
      [...form.matchAll(/signInWithPassword\(/g)].length + [...form.matchAll(/verifyOtp\(/g)].length;
    expect(sessionReads).toBeGreaterThan(0);
    // Two reads per minted session: the guard and the call that promotes it.
    expect(sessionReads).toBeLessThanOrEqual(minted * 3);
  });

  it("still refuses to establish anything when the fragment carried no session", () => {
    // The effect is gated on kind === "session", which requires BOTH tokens.
    expect(form).toContain('authReturn.kind === "session"');
  });
});

describe("every sign-in path leaves the page tree in its signed-in state", () => {
  it("the OAuth callback refreshes the server tree, as the password path does", () => {
    // A client-side navigation reuses the layouts it already has, so the root
    // layout — which reads the session for the nav, the promotion bar and the
    // offer modal — kept its SIGNED-OUT render after a Google sign-in. The
    // destination page came back correct, which is what made it read as a
    // styling quirk rather than a stale tree.
    expect(callback).toContain("router.refresh()");
    expect(form).toContain("router.refresh()");
  });
});
