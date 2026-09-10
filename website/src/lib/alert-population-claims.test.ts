import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// EVERY ALERT THAT COUNTS A POPULATION MUST KNOW IF IT READ ALL OF IT.
//
// Derived, not hand-listed, for the reason auth-email-audit.test.ts already
// gives about its own sweep: "A list you maintain by hand only ever covers what
// you remembered." That is not hypothetical here.
// commission-accrual-repair.ts solved this exact problem — it reports
// `scanTruncated` and says "Silent truncation is how the old `.limit()` scan hid
// the backlog in the first place, so it is said out loud" — and the lesson
// stayed in that one file. Two weeks later auth-health.ts shipped the identical
// bug and told an operator that twenty named ambassadors could not sign in.
// Every one of them could.
//
// So the rule is enforced against the SOURCE, and a new sweep fails it the day
// it is written rather than the day it lies to somebody.
//
// WHAT COUNTS AS A POPULATION CLAIM. Both signals together, because either one
// alone is too blunt:
//
//   1. the message interpolates something numeric — `.length`, a count, a
//      total, `stalled`, `lockedOut`;
//   2. immediately followed by the thing being counted — "order(s)",
//      "account(s)", "member(s)", or a bare plural.
//
// `${orderId} was captured after cancellation` trips neither and is left alone,
// which matters: of 75 recordSystemAlert call sites this selects 11. A check
// with false positives gets its failures waved away, and then the true one is
// waved away with them.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Comments are stripped: several files DISCUSS these alerts in prose. */
const codeOf = (file: string) => readFileSync(file, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * The argument object of every recordSystemAlert call in a file.
 *
 * Brace-counted rather than regex-matched: these blocks nest template literals,
 * ternaries and object context, and a lazy `\}\)` match ends at the first inner
 * brace, silently truncating the very field being looked for.
 */
function alertCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "recordSystemAlert({";
  let at = source.indexOf(marker);

  while (at !== -1) {
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(at + marker.length, i));
    at = source.indexOf(marker, i);
  }

  return calls;
}

const NUMERIC = /\.length\b|\b(count|total|attempts|stale|stalled|lockedOut|failures|failed|scanned|pending|backlog|unresolved|remaining|deferred|repaired)\b/i;
const COUNTED_NOUN = /^\s*(?:\+\s*")?\s*(?:[\w-]+\s+){0,3}(?:[\w -]*\(s\)|(?:orders|accounts|members|carts|jobs|partners|ambassadors|emails|shipments|records|rows|users)\b)/;

/** Does this alert's message state "<number> <things>"? */
function populationClaim(call: string): string | null {
  const message = /message:\s*([\s\S]*?)(?:\n\s*(?:context|severity|dedupeWindowMs|scan|type):)/.exec(call);
  const text = message ? message[1] : call;

  for (const hit of text.matchAll(/\$\{([^}]+)\}/g)) {
    if (!NUMERIC.test(hit[1])) continue;
    const after = text.slice((hit.index ?? 0) + hit[0].length, (hit.index ?? 0) + hit[0].length + 60);
    if (COUNTED_NOUN.test(after)) {
      return `${hit[0]}${after}`.replace(/\s+/g, " ").slice(0, 70);
    }
  }
  return null;
}

const declaresScan = (call: string) => /(^|[\s,{])scan:/.test(call);

/**
 * Alerts that count something WITHOUT reading a source that could be short.
 *
 * The escape hatch, and deliberately a narrow one. An entry needs a reason, and
 * the last test in this file fails when one stops matching anything — a stale
 * exemption is how a rule quietly stops applying to the file it was written for.
 *
 * Prefer passing `scan: { truncated: false }` to adding an entry here: if the
 * set really is complete, saying so in the code is better than saying so in a
 * test, because the alert row then carries the fact too.
 */
const EXEMPT: Array<{ file: string; because: string }> = [];

const claims = walk(SRC).flatMap((file) =>
  alertCalls(codeOf(file)).flatMap((call) => {
    const claim = populationClaim(call);
    return claim ? [{ file: file.replace(`${process.cwd()}/`, ""), claim, call }] : [];
  }),
);

describe("alerts that count a population", () => {
  it("finds them at all, so an empty sweep cannot pass silently", () => {
    // If a refactor renames recordSystemAlert or reshapes its calls, this
    // number collapses to zero and every test below passes vacuously.
    expect(claims.length).toBeGreaterThanOrEqual(8);
  });

  for (const { file, claim, call } of claims) {
    const exempt = EXEMPT.find((entry) => entry.file === file);
    if (exempt) continue;

    it(`${file} — "${claim.trim()}" declares how completely it scanned`, () => {
      expect(declaresScan(call),
        `This alert states a count of a population. That sentence is only true if the whole `
        + `population was read, and it is exactly what partner_locked_out got wrong when it named `
        + `twenty ambassadors who had all signed in.\n\n`
        + `Pass \`scan\` to recordSystemAlert: { truncated } straight from a BoundedRead, or `
        + `{ truncated: false } when the set is genuinely complete. If a short read could `
        + `MANUFACTURE this finding rather than merely undercount it, withhold the alert instead `
        + `— see canConcludeLockout in auth-health.ts.`).toBe(true);
    });
  }

  it("has no stale exemptions", () => {
    // An exemption that matches nothing is worse than none: it reads as a
    // considered decision while protecting a file that may no longer exist.
    for (const entry of EXEMPT) {
      expect(claims.some((c) => c.file === entry.file),
        `${entry.file} is exempted ("${entry.because}") but no longer makes a counted claim. `
        + "Remove the exemption.").toBe(true);
    }
  });
});
