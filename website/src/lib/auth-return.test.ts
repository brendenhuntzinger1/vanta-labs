import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyAuthReturn, deadAuthLinkMessage } from "@/lib/auth-link-fragment";

// ---------------------------------------------------------------------------
// `?verified=1` IS NOT EVIDENCE, AND A DEAD LINK MUST SAY SO.
//
// Two defects in the same three lines of the login page.
//
// FIRST, the security one. isVerificationReturn was true whenever the query
// string said `verified=1` — a param that is typed, shared, bookmarked and
// re-opened. On any load where the FRAGMENT was empty, getSession() fell back
// to the session supabase-js keeps in localStorage and the page promoted THAT
// into an httpOnly cookie and redirected: the visitor was signed in as whoever
// last used the browser. Reachable because our cookie lapsed hourly while the
// localStorage session refreshed itself for weeks — A's cookie expires, A's
// browser session survives, B opens their own confirmation link on the shared
// machine, B's one-time token is already spent, and B lands as A.
//
// SECOND, the silent one. When a token is spent GoTrue sends no tokens — it
// redirects with `#error=access_denied&error_code=otp_expired`. Nothing read
// that, so the branch fell through to a bare `return` and the customer was left
// on an ordinary sign-in form that said nothing at all. Not rare: mailbox
// security scanners pre-fetch links and burn them, which is what happened to
// the applicant of 2026-08-28 whose auth log reads "One-time token not found".
// ---------------------------------------------------------------------------

describe("classifyAuthReturn", () => {
  it("accepts a fragment that really carries a session", () => {
    expect(classifyAuthReturn("#access_token=abc&type=signup&expires_in=3600").kind).toBe("session");
    expect(classifyAuthReturn("access_token=abc").kind).toBe("session");
  });

  it("refuses an empty fragment — the whole point", () => {
    // This is what a hand-typed, shared or re-opened /account/login?verified=1
    // looks like, and it must never sign anyone in.
    expect(classifyAuthReturn("").kind).toBe("none");
    expect(classifyAuthReturn("#").kind).toBe("none");
  });

  it("reports a dead link, with the reason GoTrue gave", () => {
    const spent = classifyAuthReturn("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid");
    expect(spent.kind).toBe("error");
    expect(spent.errorCode).toBe("otp_expired");
  });

  it("prefers the error when a fragment carries both", () => {
    // A stale token alongside an error is still a failed confirmation, and the
    // error is the thing the customer needs to be told.
    expect(classifyAuthReturn("#access_token=stale&error_code=otp_expired").kind).toBe("error");
  });

  it("parses rather than substring-matches", () => {
    // "#error_description=your+access_token+is+invalid" contains the marker and
    // carries no session; a substring check would sign that visitor in.
    expect(classifyAuthReturn("#error=x&error_description=your+access_token+is+invalid").kind).toBe("error");
    expect(classifyAuthReturn("#next=/account%3Faccess_token%3Dnope").kind).toBe("none");
  });

  it("falls back to `error` when there is no `error_code`", () => {
    expect(classifyAuthReturn("#error=server_error").errorCode).toBe("server_error");
  });
});

describe("deadAuthLinkMessage", () => {
  it("names a next step in every branch", () => {
    // The failure this whole change exists to fix was a page that told the
    // customer nothing.
    for (const code of ["otp_expired", "access_denied", "server_error", undefined]) {
      const message = deadAuthLinkMessage(code);
      expect(message.length).toBeGreaterThan(30);
      expect(message.toLowerCase()).toContain("email");
    }
  });

  it("distinguishes expired from already-used", () => {
    expect(deadAuthLinkMessage("otp_expired")).toContain("expired");
    expect(deadAuthLinkMessage("access_denied")).toContain("already been used");
  });
});

// ---------------------------------------------------------------------------
// The wiring. Exercising these components for real needs a live GoTrue and a
// browser; what regresses is which signal each one trusts.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const LOGIN = read("src/components/account-auth-form.tsx");
const RESET = read("src/components/account-reset-password-form.tsx");

/** Strip comments, so prose ABOUT a rejected API cannot trip a check on it. */
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

const RESET_CODE = stripComments(RESET);

describe("the login page trusts the fragment, not the query string", () => {
  it("gates the sign-in on a real session having arrived", () => {
    expect(LOGIN).toContain("classifyAuthReturn(window.location.hash)");
    expect(LOGIN).toContain('const isVerificationReturn = authReturn.kind === "session";');
  });

  it("no longer treats ?verified=1 alone as a verification return", () => {
    // The exact expression that caused it.
    expect(LOGIN).not.toContain('if (searchParams.get("verified") === "1") return true;');
  });

  it("classifies once, before supabase-js can consume the fragment", () => {
    // The browser client is lazily constructed on first `supabase.auth` access,
    // which happens inside an effect — after this runs.
    expect(LOGIN).toContain("const [authReturn] = useState<AuthReturn>(");
  });

  it("says something when the link is dead", () => {
    expect(LOGIN).toContain("deadAuthLinkMessage(authReturn.errorCode)");
  });

  it("reads the ?link= reason /auth/confirm redirects with", () => {
    // The route already sent people to /account/login?link=invalid and nothing
    // read it, so that landing was silent too.
    expect(LOGIN).toContain('searchParams.get("link")');
  });

  it("tells a re-opened ?verified=1 visitor to sign in, rather than nothing", () => {
    expect(LOGIN).toContain("Your email address is confirmed. Sign in below");
  });
});

describe("the reset page survives a reload", () => {
  it("remembers that this tab is mid-recovery", () => {
    // Both original signals are one-shot: auth-js clears the fragment the
    // moment it consumes the link and only emits PASSWORD_RECOVERY from that
    // same function. So a refresh rendered "This reset link is invalid or has
    // expired" over a live recovery session that would have accepted a
    // password — and the new link the customer then requests lands identically.
    expect(RESET).toContain("markRecoveryInProgress");
    expect(RESET).toContain("recoveryInProgress()");
  });

  it("uses sessionStorage, not localStorage", () => {
    // It must die with the tab. In localStorage the marker would unlock this
    // no-current-password form for the browser's next occupant.
    expect(RESET).toContain("window.sessionStorage");
    expect(RESET_CODE).not.toContain("localStorage");
  });

  it("still requires a live session alongside the marker", () => {
    // A stale marker must never unlock the form on its own.
    expect(RESET).toContain("Boolean(data.session) && evidence");
  });

  it("clears the marker once the password is set", () => {
    const submit = RESET.slice(RESET.indexOf("const handleSubmit"));
    expect(submit).toContain("clearRecoveryMarker()");
  });

  it("wraps every storage access, because Safari private mode throws", () => {
    for (const fn of ["markRecoveryInProgress", "recoveryInProgress", "clearRecoveryMarker"]) {
      const body = RESET.slice(RESET.indexOf(`function ${fn}(`));
      expect(body.slice(0, 400), `${fn} does not guard sessionStorage`).toContain("try {");
    }
  });
});
