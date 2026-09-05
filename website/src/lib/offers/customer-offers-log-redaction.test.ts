import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CQ-02 — NO CUSTOMER EMAIL ADDRESS IN CONSOLE OUTPUT.
//
// Sentry events pass through sentry-privacy.ts; Vercel runtime logs do not.
// customer-offers.ts interpolated the customer's address into six console
// lines, one of them on every paid order that closed an unused gift. Every
// address that reaches console.* in this module now goes through
// redactEmailForLog (first character + domain).
//
// Source-level, because the behaviour is a side effect on console inside a
// module with no seam for it — and because the rule is about the text of every
// log line, present and future.
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(process.cwd(), "src/lib/offers/customer-offers.ts"), "utf8");

/** Every console.* statement, as one line each (template literals kept intact). */
function consoleStatements(src: string): string[] {
  return [...src.matchAll(/console\.(?:log|error|warn|info)\(([^;]*)\);/g)].map((m) => m[0]);
}

describe("customer-offers.ts console output", () => {
  it("imports the redaction helper", () => {
    expect(source).toContain('import { redactEmailForLog } from "@/lib/log-redaction";');
  });

  it("never interpolates or passes a bare email address into console.*", () => {
    const offenders = consoleStatements(source).filter((statement) => {
      // A bare `email` argument or `${email}` interpolation is the leak; the
      // wrapped form is the fix.
      const stripped = statement.replace(/redactEmailForLog\([^)]*\)/g, "REDACTED");
      return /\$\{\s*email\s*\}/.test(stripped) || /[(,]\s*email\s*[,)]/.test(stripped) || /input\.email/.test(stripped);
    });
    expect(offenders).toEqual([]);
  });

  it("still logs the close-out, keyed by order id, so the event is not lost", () => {
    expect(source).toContain("closed ${closed} unused gift(s) for ${redactEmailForLog(email)}");
  });
});
