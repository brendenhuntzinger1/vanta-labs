import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// K-19 — EVERY OUTBOUND CALL GETS A DEADLINE.
//
// Eleven outbound `fetch` sites were tabulated across the codebase. The ad
// pixels and the label printer had timeouts. The payment processor, the
// membership processor and both email providers did not — the three that take
// or move money, and the one that tells the customer it happened.
//
// A `fetch` with no signal waits as long as the other end wants. On a request
// path that means the shopper sits on "Processing…" until the platform kills the
// function, and the code below the call never runs.
//
// WHY THIS IS A SOURCE-TEXT TEST AND NOT A BEHAVIOURAL ONE, STATED PLAINLY.
// Block E's whole finding was that source-text assertions read as coverage
// without being it, so this one is deliberately narrow: it asserts a property of
// the CALL SITE — "this fetch was given a deadline" — which is exactly what a
// behavioural test cannot observe without a hanging server per provider. It is a
// completeness check over a list, not a substitute for testing what the modules
// do. Each module's behaviour is covered by its own suite.
//
// The failure it prevents is a NEW outbound call arriving with no deadline,
// which is how the four here came to exist.
// ---------------------------------------------------------------------------

const CALLERS = [
  { file: "src/lib/payment-provider.ts", what: "the payment processor" },
  { file: "src/lib/veyra-membership.ts", what: "the membership processor" },
  { file: "src/lib/email/providers/resend.ts", what: "Resend" },
  { file: "src/lib/email/providers/sendgrid.ts", what: "SendGrid" },
  { file: "src/lib/shippo/client.ts", what: "Shippo" },
];

function read(file: string) {
  return readFileSync(path.resolve(process.cwd(), file), "utf8");
}

/**
 * Every `fetch(` call in a file, with the options object that follows it.
 *
 * Comments are stripped first. Without that, a long explanatory comment between
 * `fetch(` and `signal:` pushes the option outside the window and the test fails
 * on a call that IS timed out — which happened, and is exactly the kind of false
 * red that gets a test deleted rather than fixed.
 */
function fetchCalls(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const calls: string[] = [];
  const re = /\bfetch\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    // Balance to the call's own closing paren rather than taking a fixed
    // window: a fixed one either misses a long options object (a false red on a
    // call that IS timed out) or spills into the next call (a false green).
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < stripped.length; end += 1) {
      const c = stripped[end];
      if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) break; }
    }
    calls.push(stripped.slice(match.index, end + 1));
  }
  return calls;
}

describe("no outbound call waits for ever", () => {
  for (const { file, what } of CALLERS) {
    it(`gives every request to ${what} a deadline`, () => {
      const calls = fetchCalls(read(file));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toMatch(/signal:\s*AbortSignal\.timeout\(/);
      }
    });
  }

  /**
   * NEGATIVE CONTROL. If the matcher above cannot tell a timed-out call from an
   * untimed one, every assertion in this file is decorative.
   */
  it("the matcher actually distinguishes the two shapes", () => {
    const timed = `const r = await fetch("https://x", { signal: AbortSignal.timeout(1000), method: "POST" });`;
    const untimed = `const r = await fetch("https://x", { method: "POST" });`;

    expect(fetchCalls(timed)[0]).toMatch(/signal:\s*AbortSignal\.timeout\(/);
    expect(fetchCalls(untimed)[0]).not.toMatch(/signal:\s*AbortSignal\.timeout\(/);

    // And it must not let one timed call vouch for an untimed one beside it.
    const both = `${untimed}\n${timed}`;
    const [first, second] = fetchCalls(both);
    expect(first).not.toMatch(/signal:\s*AbortSignal\.timeout\(/);
    expect(second).toMatch(/signal:\s*AbortSignal\.timeout\(/);

    // A comment between the call and its options must not hide the option.
    const commented = `await fetch("https://x", {\n  // a long explanation\n  signal: AbortSignal.timeout(1000),\n});`;
    expect(fetchCalls(commented)[0]).toMatch(/signal:\s*AbortSignal\.timeout\(/);
  });

  /**
   * A timeout on the checkout call is only safe because a retry returns the SAME
   * session. Without the idempotency key, timing out and retrying would be a
   * second charge — so the two must not drift apart.
   */
  it("the checkout call that can now time out still sends an idempotency key", () => {
    const source = read("src/lib/payment-provider.ts");
    expect(source).toContain('"Idempotency-Key": input.orderId');
  });
});
