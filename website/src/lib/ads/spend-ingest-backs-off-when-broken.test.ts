import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE SIX-HOUR GATE COULD NOT ENGAGE WHILE THE FEED WAS BROKEN.
//
// The freshness gate keys off `ingested_at` — the newest row that was
// successfully WRITTEN — so a run that writes nothing leaves it permanently
// disarmed. That is the live state of this store: Windsor answers every
// connector with a plan-limit notice in place of data, every row is rejected,
// nothing is written, and the job throws.
//
// vercel.json runs the sweep every thirty minutes. So the interval this module
// exists to enforce became:
//
//     192 Windsor calls a day, against a feed that is already refusing;
//     48 cron_sweep_failed criticals and 48 operator emails a day, because that
//     alert had no dedupe window (unlike the timeout alert fifteen lines above
//     it, whose comment says "That is ONE standing problem, not forty-eight
//     criticals and forty-eight emails a day").
//
// The interval is enforced on ATTEMPTS now, through the store's own rate
// limiter rather than a new table, so a failing feed backs off exactly as a
// healthy one does. An operator pressing refresh still bypasses it.
// ---------------------------------------------------------------------------

const limiter = vi.hoisted(() => ({
  calls: [] as Array<{ bucket: string; limit: number; windowSeconds: number }>,
  allowed: true,
}));
const ingestRuns = vi.hoisted(() => ({ count: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async (bucket: string, limit: number, windowSeconds: number) => {
    limiter.calls.push({ bucket, limit, windowSeconds });
    return limiter.allowed
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: 12_345 };
  },
}));
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            // Nothing has EVER been written — the broken-feed state, and the one
            // where the write-based gate cannot help.
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  },
}));

beforeEach(() => {
  vi.resetModules();
  limiter.calls.length = 0;
  limiter.allowed = true;
  ingestRuns.count = 0;
  process.env.WINDSOR_API_KEY = "test-key";
  // Windsor is never actually called here; the gate is the subject. A stub
  // rather than the real network so a passing gate cannot become a live fetch.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("a feed that has never written a row", () => {
  it("still asks the interval before calling the provider again", async () => {
    limiter.allowed = false;
    const { ingestAdSpend } = await import("@/lib/ads/spend-ingest");

    const result = await ingestAdSpend();

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("ATTEMPT");
    expect(limiter.calls).toHaveLength(1);
  });

  it("asks for one attempt per six hours, which is the module's own interval", async () => {
    limiter.allowed = false;
    const { ingestAdSpend } = await import("@/lib/ads/spend-ingest");
    const { MIN_HOURS_BETWEEN_RUNS } = await import("@/lib/ads/spend-ingest");

    await ingestAdSpend();

    expect(limiter.calls[0].limit).toBe(1);
    expect(limiter.calls[0].windowSeconds).toBe(MIN_HOURS_BETWEEN_RUNS * 3600);
  });

  it("proceeds when the interval has elapsed", async () => {
    limiter.allowed = true;
    const { ingestAdSpend } = await import("@/lib/ads/spend-ingest");

    const result = await ingestAdSpend();

    // It gets as far as the provider — which has no key-less path here, so what
    // matters is that the attempt gate did not stop it.
    expect(result.reason ?? "").not.toContain("ATTEMPT");
    expect(limiter.calls).toHaveLength(1);
  });
});

describe("an operator pressing refresh", () => {
  it("bypasses the attempt gate entirely", async () => {
    limiter.allowed = false;
    const { ingestAdSpend } = await import("@/lib/ads/spend-ingest");

    const result = await ingestAdSpend({ force: true });

    expect(limiter.calls, "force must not even consult the limiter").toHaveLength(0);
    expect(result.reason ?? "").not.toContain("ATTEMPT");
  });
});

describe("the sweep's failure alert", () => {
  it("carries a dedupe window, like the timeout alert beside it", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/cron/sweep/route.ts"),
      "utf8",
    );
    const block = route.slice(route.indexOf('type: "cron_sweep_failed"'));
    expect(block.slice(0, block.indexOf("});"))).toContain("dedupeWindowMs");
  });
});
