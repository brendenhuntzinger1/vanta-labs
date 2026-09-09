import { describe, expect, it } from "vitest";

import { runSpendIngest, SPEND_INGEST_BUDGET_MS } from "./spend-ingest";
import { WINDSOR_REQUEST_TIMEOUT_MS } from "./windsor-client";

// ---------------------------------------------------------------------------
// THE SWEEP TIMED OUT AND THIS JOB WAS THE ONLY ONE STILL RUNNING.
//
// Production, 2026-09-08 00:01 UTC:
//
//   cron_sweep_timeout (critical) — "The scheduled sweep was still running
//   1 job(s) after 50s and will be cut off at the 60s function limit:
//   ad_spend_ingest."
//
// Every other job in the sweep finished. This one did not, and the cause was
// not slowness anywhere in this file's own logic: `fetchConnectorSpend` took an
// optional `signal`, passed it to `fetch`, and NO CALLER EVER PASSED ONE. So
// every Windsor request was unbounded, the connectors are fetched one after
// another, and a single hung request outlasted the whole 50s watchdog.
//
// That made it the only outbound call in the codebase without a deadline —
// shippo, veyra, resend, sendgrid, turnstile, payment-provider, express-reconcile
// and the sibling tiktok/reddit ad clients all bound theirs.
//
// An optional parameter that every caller forgets is not a parameter, it is a
// default waiting to be wrong. So the timeout is applied BY THE CLIENT rather
// than asked of the caller, and the job additionally refuses to start a
// connector once its own budget is gone. Both are asserted here: the first
// stops one hung request killing the tick, the second stops three slow ones
// adding up to the same thing.
// ---------------------------------------------------------------------------

/**
 * A fetch that never answers, exactly like the hung request that caused the
 * incident: it settles ONLY if something aborts it.
 *
 * Before the fix this never settles at all, which is precisely the bug — so
 * these tests fail by hanging until vitest's own timeout, for the right reason.
 */
function hangingFetch(): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // unbounded — the production behaviour being fixed
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ok = () => Promise.resolve({ error: null });
const NOW = new Date("2026-09-08T00:00:00Z");

describe("a hung Windsor request cannot outlast the sweep", () => {
  it("abandons a request that never answers, rather than hanging the tick", async () => {
    const result = await runSpendIngest({
      apiKey: "k",
      now: NOW,
      upsert: ok,
      connectors: ["facebook"],
      // Real timers, tiny budget: this exercises the actual AbortSignal path
      // rather than asserting that a constant has a particular value.
      requestTimeoutMs: 25,
      fetchImpl: hangingFetch(),
    // Every connector failing is an incident and still throws, which is right:
    // the feed genuinely did not update. What must NOT happen is hanging.
    }).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toMatch(/facebook/);
  });

  it("keeps a healthy connector's numbers when another one hangs", async () => {
    // Snapchat hanging must not cost the store its Meta spend — the same
    // isolation the file already promises for a connector that errors.
    const result = await runSpendIngest({
      apiKey: "k",
      now: NOW,
      upsert: ok,
      connectors: ["facebook", "snapchat"],
      requestTimeoutMs: 25,
      fetchImpl: (async (input: string, init?: { signal?: AbortSignal }) => {
        if (new URL(input).pathname.includes("snapchat")) {
          return hangingFetch()(input, init as RequestInit);
        }
        return jsonResponse({ data: [{ date: "2026-09-07", ad_id: "f1", spend: "7.00" }] });
      }) as unknown as typeof fetch,
    });

    const byName = Object.fromEntries(result.connectors.map((c) => [c.connector, c]));
    expect(byName.facebook.status).toBe("ok");
    expect(byName.facebook.written).toBe(1);
    expect(byName.snapchat.status).toBe("failed");
    expect(result.totalWritten).toBe(1);
  });

  it("stops starting connectors once the job's own budget is gone", async () => {
    // Three connectors that each stop at their own deadline still ADD UP, and
    // the sum is what outran the sweep. Driven by an injected clock rather than
    // by real waiting, so it asserts the budget arithmetic itself and cannot
    // flake on a slow runner.
    let elapsed = 0;
    const started: string[] = [];
    const result = await runSpendIngest({
      apiKey: "k",
      now: NOW,
      upsert: ok,
      connectors: ["facebook", "tiktok", "snapchat"],
      budgetMs: 50,
      elapsedNow: () => elapsed,
      fetchImpl: (async (input: string) => {
        started.push(new URL(input).pathname);
        elapsed += 30; // each connector burns more than a third of the budget
        return new Response("gateway timeout", { status: 504 });
      }) as unknown as typeof fetch,
    }).catch((error: unknown) => error);

    // Two connectors consumed 60ms of a 50ms budget, so the third is never
    // requested — the whole point, since requesting it is what overran the tick.
    expect(started).toHaveLength(2);
    // Every connector failed, so this still throws into the sweep's alerting
    // rather than reporting an empty feed as a quiet day.
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toMatch(/budget was spent/);
  });

  it("bounds every request by default, so no caller can forget", async () => {
    // The incident in one assertion: the client applies its own deadline, so a
    // caller that passes nothing still cannot issue an unbounded request.
    let sawSignal = false;
    await runSpendIngest({
      apiKey: "k",
      now: NOW,
      upsert: ok,
      connectors: ["facebook"],
      fetchImpl: (async (_url: string, init?: { signal?: AbortSignal }) => {
        sawSignal = Boolean(init?.signal);
        return jsonResponse({ data: [{ date: "2026-09-07", ad_id: "f1", spend: "1.00" }] });
      }) as unknown as typeof fetch,
    });

    expect(sawSignal).toBe(true);
  });

  it("budgets the whole job inside the sweep's 50s watchdog", () => {
    // The watchdog in api/cron/sweep/route.ts fires at 50s and needs the
    // remaining ten to write its alert. A budget at or above that would make
    // this job the thing that trips it, which is the bug.
    expect(SPEND_INGEST_BUDGET_MS).toBeLessThan(50_000);
    // And one connector must never be able to eat the whole budget.
    expect(WINDSOR_REQUEST_TIMEOUT_MS).toBeLessThan(SPEND_INGEST_BUDGET_MS);
  });
});
