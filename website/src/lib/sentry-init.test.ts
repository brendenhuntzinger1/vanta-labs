import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sentryDsnState, sentryEnabled } from "@/lib/sentry-init";

/**
 * Regression cover for a real production failure.
 *
 * The Vercel environment briefly held the literal string "SENTRY_DSN" as the
 * VALUE of the DSN variable — the variable's own name pasted into its value
 * box. Sentry.init threw `Invalid Sentry Dsn: SENTRY_DSN` on eight routes,
 * server-side reporting was off for that entire deployment, and because Sentry
 * was the thing that broke, Sentry could not report it. sentryDsnState() is how
 * /admin/status can say so instead.
 */
describe("sentryDsnState", () => {
  const REAL = "https://c8cf41da5ce5cac4b59f624acfb69935@o4511968099565568.ingest.us.sentry.io/4511968494878720";
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
      SENTRY_DSN: process.env.SENTRY_DSN,
    };
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports a well-formed DSN as ok, naming the project but never the key", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = REAL;
    const state = sentryDsnState();
    expect(state).toEqual({
      state: "ok",
      host: "o4511968099565568.ingest.us.sentry.io",
      projectId: "4511968494878720",
    });
    expect(JSON.stringify(state)).not.toContain("c8cf41da5ce5cac4b59f624acfb69935");
  });

  it("rejects the exact value production shipped: the variable's own name", () => {
    process.env.SENTRY_DSN = "SENTRY_DSN";
    expect(sentryDsnState()).toEqual({ state: "invalid", reason: "not a URL" });
  });

  it("rejects a DSN with no public key", () => {
    process.env.SENTRY_DSN = "https://o123.ingest.us.sentry.io/456";
    expect(sentryDsnState()).toEqual({ state: "invalid", reason: "no public key" });
  });

  it("rejects a DSN with no numeric project id", () => {
    process.env.SENTRY_DSN = "https://abc@o123.ingest.us.sentry.io/";
    expect(sentryDsnState()).toEqual({ state: "invalid", reason: "no project id" });
  });

  it("reports missing when nothing is configured — local dev and the test suite", () => {
    expect(sentryDsnState()).toEqual({ state: "missing" });
    expect(sentryEnabled()).toBe(false);
  });

  it("prefers the public DSN, so browser and server agree on one project", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = REAL;
    process.env.SENTRY_DSN = "https://other@o999.ingest.us.sentry.io/111";
    expect(sentryDsnState()).toMatchObject({ projectId: "4511968494878720" });
  });

  it("falls back to the server-only DSN when the public one is absent", () => {
    process.env.SENTRY_DSN = REAL;
    expect(sentryDsnState()).toMatchObject({ state: "ok", projectId: "4511968494878720" });
  });
});
