import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// "SOMEONE ELSE IS STILL WORKING ON IT" IS NOT "ALREADY DONE".
//
// claimEvent returned a boolean, and two very different states collapsed into
// its false: an event that had genuinely been processed, and an event whose
// claim row was still open because another invocation held it. Both were
// reported to the caller as `duplicate: true`, and the route answered 200.
//
// A 200 tells a payment processor the event is delivered and it stops retrying.
// So when the invocation holding the claim died before markEventProcessed — a
// crash, a timeout, a deploy landing mid-request — that event was never
// delivered again. The claim row sat unprocessed forever, the card had been
// charged, and the order stayed pending_payment with nothing left to settle it
// but the half-hourly reconcile sweep.
//
// The irony is that the code already knew how to recover: the STALE_CLAIM_MS
// reclaim exists precisely so a stranded claim can be retaken by a later
// delivery. It could never run, because the sender had been told to stop
// sending.
//
// Three states now. "processed" keeps its 200. "in_flight" answers 409 with a
// Retry-After, which is retryable and cannot double-apply anything: the claim
// still guards the work, so a retry either finds the event finished or reclaims
// a stale claim and processes it exactly once.
// ---------------------------------------------------------------------------

type EventRow = { processed_at: string | null; claimed_at: string };

const state: { events: Map<string, EventRow>; now: number } = { events: new Map(), now: Date.now() };

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "payment_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          const id = String(row.event_id);
          if (state.events.has(id)) return { error: { code: "23505", message: "duplicate key" } };
          state.events.set(id, { processed_at: null, claimed_at: String(row.claimed_at) });
          return { error: null };
        },
        upsert: async () => ({ error: null }),
        select: () => {
          let id = "";
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            async maybeSingle() { return { data: state.events.get(id) ?? null, error: null }; },
          };
          return b;
        },
        update: () => {
          let id = "";
          let needsUnprocessed = false;
          let staleBefore = "";
          const b: Record<string, unknown> = {
            eq(_c: string, v: string) { id = v; return b; },
            is(_c: string, v: unknown) { needsUnprocessed = v === null; return b; },
            lt(_c: string, v: string) { staleBefore = v; return b; },
            async select() {
              const row = state.events.get(id);
              if (!row) return { data: [], error: null };
              if (needsUnprocessed && row.processed_at !== null) return { data: [], error: null };
              if (staleBefore && !(row.claimed_at < staleBefore)) return { data: [], error: null };
              row.claimed_at = new Date().toISOString();
              return { data: [{ event_id: id }], error: null };
            },
          };
          return b;
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    const noop: Record<string, unknown> = {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    };
    return noop;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({ verifyWebhookSignature: () => true }),
}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));

const ORDER_ID = "order-inflight-0001";
const body = JSON.stringify({
  type: "payment.succeeded",
  paymentId: "vs_one",
  data: { object: { metadata: { order_id: ORDER_ID } } },
});

async function deliver(eventId: string) {
  const { processPaymentWebhook } = await import("@/lib/payment-webhook");
  return processPaymentWebhook(body, "sig", "secret", eventId);
}

beforeEach(() => {
  state.events = new Map();
});

describe("an event whose claim is still open", () => {
  it("is reported as in flight, not as a finished duplicate", async () => {
    // First delivery claims it. Nothing marks it processed, which is exactly
    // what a crashed or timed-out invocation leaves behind.
    state.events.set("evt-open", { processed_at: null, claimed_at: new Date().toISOString() });

    const result = await deliver("evt-open") as { duplicate?: boolean; inFlight?: boolean };
    expect(result.duplicate).toBe(true);
    expect(result.inFlight).toBe(true);
  });

  it("is NOT reported as in flight once it has genuinely been processed", async () => {
    state.events.set("evt-done", {
      processed_at: new Date().toISOString(),
      claimed_at: new Date().toISOString(),
    });

    const result = await deliver("evt-done") as { duplicate?: boolean; inFlight?: boolean };
    expect(result.duplicate).toBe(true);
    // The sender must stop retrying this one. A 409 here would loop forever.
    expect(result.inFlight).toBeFalsy();
  });

  it("still reclaims a STALE claim, which is the whole point", async () => {
    // Older than STALE_CLAIM_MS (five minutes). The owner is gone; this delivery
    // takes over. Before the fix the sender was told 200 on its first retry and
    // never came back, so this reclaim path could not be reached at all.
    //
    // Asserted on the CLAIM ROW rather than on a settled order: this file fakes
    // only payment_events, so processing runs on past the claim and dies on a
    // table it does not model. What matters here is which of the three answers
    // claimEvent gave, and a retaken claim stamps a fresh claimed_at.
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    state.events.set("evt-stale", { processed_at: null, claimed_at: stale });

    await deliver("evt-stale").catch(() => null);

    expect(state.events.get("evt-stale")?.claimed_at).not.toBe(stale);
  });

  it("leaves a live claim's timestamp alone, so nothing is retaken early", async () => {
    const fresh = new Date().toISOString();
    state.events.set("evt-live", { processed_at: null, claimed_at: fresh });

    await deliver("evt-live").catch(() => null);

    expect(state.events.get("evt-live")?.claimed_at).toBe(fresh);
  });
});

describe("the route turns that into an answer the processor acts on", () => {
  const route = () => readFileSync(join(process.cwd(), "src/app/api/webhooks/payment/route.ts"), "utf8");

  it("answers a retryable 409 with a Retry-After, not a 200", () => {
    const source = route();
    expect(source).toMatch(/inFlight/);
    expect(source).toMatch(/status:\s*409/);
    expect(source).toMatch(/Retry-After/);
  });

  it("still answers 200 for everything else", () => {
    expect(route()).toMatch(/NextResponse\.json\(\{ success: true, \.\.\.result \}\)/);
  });
});
