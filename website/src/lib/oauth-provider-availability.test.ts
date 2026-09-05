import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasAnyOAuthProvider,
  isAppleSignInEnabled,
  isGoogleSignInEnabled,
} from "@/lib/oauth-providers";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Strip comments so prose ABOUT a rule is not mistaken for the rule. */
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

const form = code(read("src/components/account-auth-form.tsx"));

// ---------------------------------------------------------------------------
// A PROVIDER BUTTON MUST NOT EXIST BEFORE THE PROVIDER DOES.
//
// Measured against the live Supabase project on 2026-09-05: google answered
// 302 to accounts.google.com, apple answered 400 "provider is not enabled".
// The portal rendered both. So the Apple button was a control that could only
// ever produce an error, sitting on the one screen between a visitor and the
// whole catalog — the most expensive place in the store to put a dead end.
//
// These tests keep the button and the credential in step, in both directions:
// Apple cannot appear until someone declares it configured, and Google cannot
// silently vanish because a flag defaulted the wrong way.
// ---------------------------------------------------------------------------

describe("the default state of each flag is the true state of the project", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers Google by default, because Google is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED", "");
    expect(isGoogleSignInEnabled()).toBe(true);
  });

  it("withholds Apple by default, because Apple is not", () => {
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED", "");
    expect(isAppleSignInEnabled()).toBe(false);
  });

  it("lets an operator switch Apple on once it really is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED", "true");
    expect(isAppleSignInEnabled()).toBe(true);
  });

  it("lets an operator switch Google off if the credentials are ever pulled", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED", "false");
    expect(isGoogleSignInEnabled()).toBe(false);
  });

  it("treats any value other than a literal true/false as 'unset'", () => {
    // A half-set variable ("1", "yes", "TRUE") must fall back to the known
    // truth rather than guess, or a typo silently ships a dead button.
    for (const junk of ["1", "yes", "TRUE", "on", " true"]) {
      vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED", junk);
      expect(isAppleSignInEnabled(), `apple should stay off for ${JSON.stringify(junk)}`).toBe(false);
      vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED", junk);
      expect(isGoogleSignInEnabled(), `google should stay on for ${JSON.stringify(junk)}`).toBe(true);
    }
  });

  it("reports whether the provider group has anything left to show", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED", "false");
    expect(hasAnyOAuthProvider()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED", "true");
    expect(hasAnyOAuthProvider()).toBe(true);
  });
});

describe("the auth form cannot render a provider button unguarded", () => {
  // Each provider is offered in two places: the portal (first screen) and the
  // email sign-in/signup screens. Both must be guarded, and it is the second
  // one that gets forgotten.
  const guarded = (provider: "google" | "apple", guard: string) => {
    const calls = [...form.matchAll(new RegExp(`startOAuth\\("${provider}"\\)`, "g"))].map(
      (m) => m.index ?? -1,
    );
    expect(calls.length, `expected ${provider} to be offered somewhere`).toBeGreaterThan(0);

    for (const at of calls) {
      // The guard must appear between the previous provider button and this
      // one, so a second unguarded button cannot hide behind the first guard.
      const windowStart = form.lastIndexOf("<button", at);
      const before = form.slice(0, windowStart);
      const lastGuard = before.lastIndexOf(guard);
      const lastOtherButton = before.lastIndexOf("startOAuth(");
      expect(
        lastGuard > lastOtherButton,
        `a startOAuth("${provider}") button at ${at} is not behind ${guard}`,
      ).toBe(true);
    }
    return calls.length;
  };

  it("guards every Apple button behind isAppleSignInEnabled()", () => {
    expect(guarded("apple", "isAppleSignInEnabled()")).toBe(2);
  });

  it("guards every Google button behind isGoogleSignInEnabled()", () => {
    expect(guarded("google", "isGoogleSignInEnabled()")).toBe(2);
  });

  it("drops the divider furniture with the buttons it divides", () => {
    // The hairline rule and the "or" divider frame the provider group. Left
    // behind with nothing between them they read as a rendering fault.
    const orAt = form.indexOf(">or<");
    expect(orAt).toBeGreaterThan(-1);
    const groupGuard = form.lastIndexOf("hasAnyOAuthProvider()", orAt);
    expect(groupGuard).toBeGreaterThan(-1);
    // and the guard opens before the first provider button of that group
    const firstButton = form.indexOf('startOAuth("google")');
    expect(groupGuard).toBeLessThan(firstButton);
  });

  it("names only the providers actually on offer in the data-sharing notice", () => {
    // "Google or Apple" printed under a lone Google button describes a choice
    // the visitor was never given.
    const notice = form.slice(form.indexOf("shares your name and email address") - 400);
    expect(notice).toContain("isGoogleSignInEnabled() && isAppleSignInEnabled()");
  });
});

describe("the switch is discoverable by the operator who needs it", () => {
  const source = read("src/lib/oauth-providers.ts");

  it("names the exact env vars a deployment would set", () => {
    expect(source).toContain("NEXT_PUBLIC_APPLE_SIGN_IN_ENABLED");
    expect(source).toContain("NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED");
  });

  it("records how to confirm a provider is really enabled before flipping it", () => {
    // The ordering matters: setting the flag first puts the dead button back.
    expect(source).toContain("/auth/v1/authorize?provider=apple");
    expect(source).toMatch(/302 means enabled/i);
  });
});
