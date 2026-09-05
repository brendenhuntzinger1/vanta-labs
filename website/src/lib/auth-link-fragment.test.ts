import { describe, expect, it } from "vitest";

import {
  isActionablePasswordSetupLink,
  isPasswordSetupLink,
  passwordSetupLinkType,
  readOAuthCallbackFragment,
} from "@/lib/auth-link-fragment";

// ---------------------------------------------------------------------------
// The predicate that decides whether someone may set a password without
// knowing the current one. It has to accept exactly two link types and no
// others: too narrow locks out invited ambassadors, too wide re-opens audit E2.
// ---------------------------------------------------------------------------

describe("passwordSetupLinkType", () => {
  it("accepts a recovery fragment", () => {
    expect(passwordSetupLinkType("#access_token=abc&refresh_token=def&type=recovery")).toBe("recovery");
  });

  it("accepts an invite fragment", () => {
    // The shape GoTrue redirects with after auth.admin.inviteUserByEmail. This
    // is the case that had nowhere to land: the invited user has NO password,
    // so refusing this fragment refuses them the portal entirely.
    expect(passwordSetupLinkType("#access_token=abc&refresh_token=def&type=invite")).toBe("invite");
  });

  it("rejects a signup-confirmation fragment", () => {
    // Carries an access_token exactly like the other two. Accepting it would
    // hand a no-current-password form to anyone who just confirmed an email.
    expect(passwordSetupLinkType("#access_token=abc&refresh_token=def&type=signup")).toBeNull();
  });

  it("rejects a magic-link fragment", () => {
    expect(passwordSetupLinkType("#access_token=abc&type=magiclink")).toBeNull();
  });

  it("rejects a bare access_token with no type at all", () => {
    expect(passwordSetupLinkType("#access_token=abc")).toBeNull();
  });

  it("rejects an empty fragment", () => {
    expect(passwordSetupLinkType("")).toBeNull();
    expect(passwordSetupLinkType("#")).toBeNull();
  });

  it("is not fooled by the type appearing inside another value", () => {
    // A substring test would pass all of these; the parsed check does not.
    expect(passwordSetupLinkType("#access_token=abc&type=magiclink&next=/recovery")).toBeNull();
    expect(passwordSetupLinkType("#type=not-recovery")).toBeNull();
    expect(passwordSetupLinkType("#access_token=abc&next=/invite")).toBeNull();
  });

  it("reads the fragment with or without its leading hash", () => {
    expect(passwordSetupLinkType("type=invite")).toBe("invite");
    expect(passwordSetupLinkType("#type=invite")).toBe("invite");
  });
});

describe("isPasswordSetupLink", () => {
  it("is true for both accepted types and false otherwise", () => {
    expect(isPasswordSetupLink("#type=recovery")).toBe(true);
    expect(isPasswordSetupLink("#type=invite")).toBe(true);
    expect(isPasswordSetupLink("#type=signup")).toBe(false);
  });
});

describe("isActionablePasswordSetupLink", () => {
  it("requires a token as well as the right type", () => {
    // A `type=` marker with no token is nothing to forward; following it would
    // land someone on a form that cannot do anything for them.
    expect(isActionablePasswordSetupLink("#type=recovery")).toBe(false);
    expect(isActionablePasswordSetupLink("#type=invite")).toBe(false);
  });

  it("accepts a recovery or invite fragment carrying a token", () => {
    expect(isActionablePasswordSetupLink("#access_token=abc&type=recovery")).toBe(true);
    expect(isActionablePasswordSetupLink("#access_token=abc&type=invite")).toBe(true);
  });

  it("still refuses a signup fragment that carries a token", () => {
    expect(isActionablePasswordSetupLink("#access_token=abc&type=signup")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE OAUTH LANDING, AND THE TWO FRAGMENTS THAT USED TO GET PAST IT.
//
// The first guard on /account/auth/callback reused classifyAuthReturn, which
// accepts access_token OR refresh_token. supabase-js disagrees: its
// _isImplicitGrantCallback ignores refresh_token entirely. The gap between the
// two predicates was the whole hole, so both halves are now required and these
// pin the exact shapes that walked through it.
// ---------------------------------------------------------------------------

describe("readOAuthCallbackFragment", () => {
  it("accepts a real implicit-grant return", () => {
    expect(readOAuthCallbackFragment("#access_token=abc&refresh_token=def&token_type=bearer")).toEqual({
      kind: "session",
      accessToken: "abc",
      refreshToken: "def",
    });
  });

  it("REFUSES a refresh_token on its own — bypass path A", () => {
    // classifyAuthReturn called this a session. supabase-js saw no callback at
    // all, fell through to _recoverAndRefresh(), and getSession() then handed
    // back the previous customer's stored session.
    expect(readOAuthCallbackFragment("#refresh_token=x")).toEqual({ kind: "none" });
  });

  it("REFUSES an access_token on its own — bypass path B", () => {
    // _getSessionFromURL throws on this, but __loadSession reads storage
    // directly and answers anyway, so the stored session came back regardless.
    expect(readOAuthCallbackFragment("#access_token=x")).toEqual({ kind: "none" });
  });

  it("treats an empty or absent fragment as nothing", () => {
    for (const hash of ["", "#", "#="]) {
      expect(readOAuthCallbackFragment(hash).kind).toBe("none");
    }
  });

  it("reports a GoTrue refusal, and prefers it over any token alongside it", () => {
    expect(readOAuthCallbackFragment("#error=access_denied")).toEqual({
      kind: "error",
      errorCode: "access_denied",
    });
    // A fragment can carry both; the error is what decides what happens next.
    const both = readOAuthCallbackFragment("#error_code=otp_expired&access_token=a&refresh_token=b");
    expect(both).toEqual({ kind: "error", errorCode: "otp_expired" });
  });

  it("parses rather than substring-matches, so prose naming a token is not one", () => {
    // "#error_description=missing+access_token" contains the marker and carries
    // no session — and it is an error, so it must read as one.
    const r = readOAuthCallbackFragment("#error=invalid_request&error_description=missing+access_token");
    expect(r.kind).toBe("error");

    // And a value that merely mentions the key is not the key.
    expect(readOAuthCallbackFragment("#state=access_token_and_refresh_token").kind).toBe("none");
  });

  it("tolerates the leading # being absent, as URLSearchParams callers vary", () => {
    expect(readOAuthCallbackFragment("access_token=a&refresh_token=b").kind).toBe("session");
  });
});
