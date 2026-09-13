import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// A JOURNEY HARNESS CANNOT SILENTLY STOP EXERCISING THE LIVE ROUTE.
//
// qa-gift-wiring proved nothing for two days. It had been pointed at an
// endpoint that no longer existed; every request 404'd, every assertion was
// written against the harness's own fallback, and it reported a clean pass. A
// harness that fails is a nuisance. A harness that passes without touching the
// product is worse than not having one, because it is counted as coverage.
//
// Two guards, in both directions, and both are cheap:
//
//   EVERY PATH A HARNESS DRIVES MUST EXIST. A renamed or deleted route breaks
//   this test at `npm test` time — in the suite everyone runs — rather than
//   silently in a script somebody runs occasionally.
//
//   EVERY HARNESS MUST STILL DRIVE THE ROUTE IT EXISTS FOR. The first guard
//   alone does not catch a harness quietly rewritten to assert against a
//   fixture instead of the product; this one names what each must reach.
//
// It reads the scripts as text on purpose: importing them would start a
// browser and a database.
// ---------------------------------------------------------------------------

const SCRIPTS = path.resolve(__dirname, "../../scripts");
const APP = path.resolve(__dirname, "../app");

/** The harnesses that stand in for a customer journey. Add one when you write one. */
const JOURNEY_HARNESSES = [
  "qa-gift-wiring.mjs",
  "qa-guest-recovery.mjs",
  "qa-offer-checkout-journey.mjs",
  "qa-purchase-path.mjs",
  "qa-customer-journey.mjs",
  "qa-cart-recovery-override.mjs",
];

/**
 * What each harness must still be reaching. Not every path it touches — the
 * few whose absence would mean the harness has stopped testing its subject.
 */
const MUST_DRIVE: Record<string, string[]> = {
  "qa-gift-wiring.mjs": [
    // The real sweep, not a hand-minted token: every offer in that file has to
    // come from the cron the product actually runs.
    "/api/cron/lifecycle",
    // The click tracker, the attestation step and the endpoint behind it.
    "/api/email/automation-click",
    "/attest",
    "/api/attest",
    // And a real order, priced by the real checkout.
    "/api/checkout/create-session",
  ],
  "qa-guest-recovery.mjs": ["/cart/restore"],
  // This one had drifted exactly as qa-gift-wiring did: it drove
  // /api/cron/sweep, which stopped running cart recovery when lifecycle mail
  // moved to its own route and budget. The sweep still answered 200, so every
  // one of its forty assertions ran against zero captured emails and reported
  // forty product failures that were one wrong URL.
  "qa-cart-recovery-override.mjs": ["/api/cron/lifecycle", "/cart/restore", "/api/checkout/create-session"],
  "qa-offer-checkout-journey.mjs": ["/api/checkout/create-session"],
};

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => statSync(path.join(dir, entry)).isDirectory());
  } catch {
    return [];
  }
}

/** Does a Next route or page exist at this pathname? Dynamic segments count. */
function appPathExists(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const walk = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) {
      if (["route.ts", "route.tsx", "route.js", "page.tsx", "page.ts", "page.js"]
        .some((leaf) => existsSync(path.join(dir, leaf)))) return true;
      // A route group holds the leaf without appearing in the URL: /account is
      // src/app/account/(dashboard)/page.tsx. Checked here as well as below,
      // because the leaf case used to return before ever looking.
      return childDirs(dir).some((entry) => /^\(.+\)$/.test(entry) && walk(path.join(dir, entry), rest));
    }
    const [head, ...tail] = rest;
    const exact = path.join(dir, head);
    if (existsSync(exact) && statSync(exact).isDirectory() && walk(exact, tail)) return true;
    // [slug], [...slug] and route groups like (marketing) are all real
    // directories the URL never spells.
    for (const entry of childDirs(dir)) {
      const child = path.join(dir, entry);
      if (/^\[.+\]$/.test(entry) && walk(child, tail)) return true;
      if (/^\(.+\)$/.test(entry) && walk(child, rest)) return true;
    }
    return false;
  };
  return walk(APP, segments);
}

/**
 * Paths a harness names that this app was never going to serve: the shims it
 * talks to, and the machine it runs on. Listed rather than pattern-guessed,
 * because a silent exclusion here would reopen exactly the hole this file
 * closes.
 */
const NOT_OURS = [
  /^\/api\/(auth|webhooks)\//,  // GoTrue and the payment provider's shims
  /^\/auth\/v1\//,              // GoTrue's own surface, served by the shim
  /^\/_next\//,
  /^\/(tmp|opt|usr|var|home|etc|dev|root)\b/,  // filesystem, not a URL
];

function pathsIn(source: string): string[] {
  // Quoted, absolute, no interpolation — anything computed is not something a
  // static check can honestly verify, so it is left alone rather than guessed at.
  const found = new Set<string>();
  for (const match of source.matchAll(/["'`](\/(?:api\/)?[a-z0-9][a-z0-9/_-]*)(?=["'`?])/g)) {
    const value = match[1];
    if (value.length < 2 || value.endsWith("/")) continue;
    if (NOT_OURS.some((pattern) => pattern.test(value))) continue;
    found.add(value);
  }
  return [...found];
}

const read = (file: string) => readFileSync(path.join(SCRIPTS, file), "utf8");

describe("every path a journey harness drives still exists", () => {
  it.each(JOURNEY_HARNESSES.filter((file) => existsSync(path.join(SCRIPTS, file))))(
    "%s",
    (file) => {
      const missing = pathsIn(read(file)).filter((pathname) => !appPathExists(pathname));
      expect(missing, `${file} drives paths this app no longer serves: ${missing.join(", ")}`).toEqual([]);
    },
  );
});

describe("every journey harness still drives the route it exists for", () => {
  it.each(Object.entries(MUST_DRIVE))("%s", (file, required) => {
    const source = read(file);
    for (const pathname of required) {
      expect(source.includes(pathname), `${file} no longer mentions ${pathname}`).toBe(true);
      expect(appPathExists(pathname), `${pathname} is named by ${file} but this app does not serve it`).toBe(true);
    }
  });
});
