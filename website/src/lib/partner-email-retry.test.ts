import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Audit E4 — ambassador email must not be able to fail silently again.
//
// The regression this pins is subtle and cost five stranded production rows:
// every send site in partner-portal.ts was written as
//
//     try { await sendEmail(...) } catch { /* non-critical */ }
//
// and sendEmail is documented to NEVER THROW — it returns { success: false }.
// So the catch was unreachable, the result was discarded, and a failed approval
// email left no trace in Sentry, in any log table, or on the dashboard. The bug
// is invisible at the call site: the code reads as if it handles failure.
//
// A behavioural test would need the Supabase admin client, a provider and the
// queue table. What actually regressed is the SHAPE of these call sites, so the
// shape is what is pinned.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");

/** Strip comments so prose about the old pattern can't satisfy or trip a check. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("ambassador email delivery", () => {
  it("routes every send through the helper that queues failures", () => {
    // One direct sendEmail call is expected: the one inside sendAmbassadorEmail.
    const direct = CODE.match(/await sendEmail\(/g) ?? [];
    expect(direct).toHaveLength(1);

    const helperBody = CODE.slice(
      CODE.indexOf("async function sendAmbassadorEmail("),
      CODE.indexOf("async function sendPartnerStatusEmail("),
    );
    expect(helperBody).toContain("await sendEmail(");
    expect(helperBody).toContain("enqueueFailedEmail");
  });

  it("checks the send result rather than relying on a throw", () => {
    const helperBody = CODE.slice(
      CODE.indexOf("async function sendAmbassadorEmail("),
      CODE.indexOf("async function sendPartnerStatusEmail("),
    );
    expect(helperBody).toContain("result.success");
  });

  it("covers each of the five ambassador emails", () => {
    // application received, owner alert, approved/rejected, referral code, payout
    const calls = CODE.match(/sendAmbassadorEmail\(/g) ?? [];
    // Five call sites plus the declaration itself.
    expect(calls.length).toBeGreaterThanOrEqual(5);

    for (const context of [
      '"application received"',
      '"new application (owner alert)"',
      '"referral code assigned"',
      '"payout sent"',
    ]) {
      expect(CODE).toContain(context);
    }
    expect(CODE).toContain("`ambassador ${input.status}`");
  });

  it("only closes the application queue row when the owner alert really went out", () => {
    // It used to be marked sent unconditionally, so the admin's pending count
    // reported work as handled that had never happened.
    expect(CODE).toContain("if (applicationQueueRowId && ownerAlerted) {");
  });

  it("no longer swallows a send outcome in an unreachable catch", () => {
    // Every try block that wraps an ambassador notification now logs in its
    // catch. An empty one is exactly how the original defect was spelled, so
    // check the neighbourhood of each send rather than the whole file (there
    // are unrelated, legitimate empty catches — a JSON.stringify fallback).
    const sites = [...CODE.matchAll(/sendAmbassadorEmail\(/g)].map((match) => match.index ?? 0);
    expect(sites.length).toBeGreaterThanOrEqual(5);

    for (const index of sites) {
      const neighbourhood = CODE.slice(index, index + 900);
      const emptyCatch = /\}\s*catch\s*\{\s*\}/.test(neighbourhood);
      expect(emptyCatch).toBe(false);
    }
  });
});
