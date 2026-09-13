// ---------------------------------------------------------------------------
// A JOURNEY HARNESS READS THE HARNESS'S OWN ENVIRONMENT.
//
// Three of these scripts mint a signed grant or a signed token, and each took
// the signing secret from whatever happened to be exported in the calling
// shell. That made them pass or fail on the OPERATOR'S TERMINAL rather than on
// the product:
//
//   * qa-guest-recovery exits at line 1 with "cannot mint grants" and runs
//     nothing at all — thirty-four assertions about the guest recovery journey
//     silently stop being made, and the run looks like a configuration note
//     rather than lost coverage;
//   * qa-gift-wiring gets further and fails ONE step with the same cause, which
//     reads exactly like a product defect and is not one. That is the more
//     expensive failure, because somebody then goes looking for the bug.
//
// The harness server already runs from these files. Reading them here means the
// two cannot drift, and a harness cannot quietly stop exercising the thing it
// exists to exercise. An ambient value still wins, so a one-off override works.
//
// This is NOT a way to reach a real environment: only .env.test.local and
// .env.local are read, both of which point at the local harness, and every
// caller independently refuses to run against a non-local base URL.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";

const FILES = [".env.test.local", ".env.local"];

/**
 * Fill process.env from the harness's own env files, without overwriting
 * anything already set. Returns the names it filled in, for a harness that
 * wants to say so.
 */
export function loadHarnessEnv(root = new URL("../../", import.meta.url)) {
  const filled = [];
  for (const file of FILES) {
    const path = new URL(file, root);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (!value || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = value;
      filled.push(match[1]);
    }
  }
  return filled;
}

/**
 * The secret link-grant.ts, cart-recovery-grant.ts and attestation-handoff.ts
 * all sign with, resolved the same way they resolve it. Throws rather than
 * returning undefined: a harness that carries on without it produces a run of
 * failures whose cause is not the product.
 */
export function harnessSigningSecret() {
  loadHarnessEnv();
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error(
      "No signing secret: set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY, or run "
      + "website/scripts/setup-local-harness.sh so .env.test.local exists.",
    );
  }
  return secret;
}
