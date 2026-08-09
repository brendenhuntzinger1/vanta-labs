import { describe, expect, it } from "vitest";
import {
  assessFreshness,
  decideRetry,
  describeStatDate,
  finishRun,
  ingestBatch,
  metricsKey,
  normalizeMetricsRow,
  startRun,
  type IngestionRun,
} from "./ingestion";
import {
  captureAnomaly,
  captureBaseline,
  headlineRoas,
  reconcile,
  type ConversionCount,
} from "./reconciliation";

const CTX = { source: "tiktok_reporting" as const, observedAt: "2026-08-09T12:00:00Z", sourceTimezone: "America/New_York" };
const run = () =>
  startRun({ runId: "r1", source: "tiktok_reporting", windowStart: "2026-08-01", windowEnd: "2026-08-08", sourceTimezone: "America/New_York", now: "2026-08-09T12:00:00Z" });

describe("normalization — rejects rather than guesses", () => {
  const valid = { creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok", spend: 10, impressions: 1000, clicks: 20 };

  it("accepts a well-formed row and stamps its provenance", () => {
    const out = normalizeMetricsRow(valid, CTX);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.key).toBe("tiktok|vl-a|2026-08-08");
    expect(out.row.observedAt).toBe(CTX.observedAt);
    expect(out.row.sourceTimezone).toBe("America/New_York");
  });

  it("parses numbers a platform may send as strings", () => {
    const out = normalizeMetricsRow({ ...valid, spend: "1,234.56", impressions: "1000" }, CTX);
    expect(out.ok && out.row.spend).toBe(1234.56);
  });

  const rejects: [string, Record<string, unknown>][] = [
    ["no creativeId — cannot be attributed", { ...valid, creativeId: "" }],
    ["a malformed date", { ...valid, statDate: "08/08/2026" }],
    ["no platform", { ...valid, platform: "" }],
    ["negative spend", { ...valid, spend: -5 }],
    ["clicks exceeding impressions", { ...valid, clicks: 2000, impressions: 100 }],
    ["a row with no metrics at all", { ...valid, spend: null, impressions: null, clicks: null }],
  ];
  for (const [label, row] of rejects) {
    it(`rejects ${label}`, () => {
      const out = normalizeMetricsRow(row, CTX);
      expect(out.ok, label).toBe(false);
      if (!out.ok) expect(out.reason).toBeTruthy();
    });
  }

  it("keeps zero distinct from not-reported", () => {
    const out = normalizeMetricsRow({ ...valid, clicks: 0 }, CTX);
    expect(out.ok && out.row.clicks).toBe(0);
  });
});

describe("idempotency and deduplication", () => {
  it("keys a row so a re-run overwrites rather than doubles", () => {
    const a = metricsKey({ creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok" });
    const b = metricsKey({ creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok" });
    expect(a).toBe(b);
    expect(metricsKey({ creativeId: "vl-a", statDate: "2026-08-09", platform: "tiktok" })).not.toBe(a);
  });

  it("collapses a row repeated across pages, keeping the later copy", () => {
    const rows = [
      { creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok", spend: 10, impressions: 100, clicks: 5 },
      { creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok", spend: 12, impressions: 120, clicks: 6 },
    ];
    const { run: after, accepted } = ingestBatch(run(), rows, CTX);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].spend).toBe(12);
    expect(after.rowsDuplicate).toBe(1);
    expect(after.rowsAccepted).toBe(1);
  });

  it("records every rejection instead of dropping it silently", () => {
    const { run: after } = ingestBatch(run(), [
      { creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok", spend: 10 },
      { creativeId: "", statDate: "2026-08-08", platform: "tiktok", spend: 5 },
    ], CTX);
    expect(after.rowsFetched).toBe(2);
    expect(after.rowsAccepted).toBe(1);
    expect(after.rowsRejected).toBe(1);
    expect(after.rejections[0].reason).toMatch(/creativeId/);
  });

  it("marks a run partial when rows were lost, so a dip is explainable", () => {
    const { run: after } = ingestBatch(run(), [{ creativeId: "", statDate: "x", platform: "" }], CTX);
    expect(finishRun(after, "2026-08-09T12:05:00Z").status).toBe("partial");
  });

  it("marks a clean run complete and a thrown run failed", () => {
    const clean = ingestBatch(run(), [{ creativeId: "vl-a", statDate: "2026-08-08", platform: "tiktok", spend: 1 }], CTX);
    expect(finishRun(clean.run, "2026-08-09T12:05:00Z").status).toBe("complete");
    expect(finishRun(run(), "2026-08-09T12:05:00Z", "timeout").status).toBe("failed");
  });
});

describe("freshness", () => {
  const base = run();
  // startedAt must precede finishedAt, and recency is judged on startedAt —
  // so fixtures have to be internally coherent or they test nothing.
  const done = (startedAt: string, finishedAt: string, status: IngestionRun["status"] = "complete"): IngestionRun =>
    ({ ...base, startedAt, finishedAt, status });

  it("says so plainly when a source has never been ingested", () => {
    const f = assessFreshness("tiktok_reporting", [], "2026-08-09T12:00:00Z");
    expect(f.state).toBe("never");
    expect(f.caveat).toMatch(/never been ingested/);
  });

  it("is fresh within the window", () => {
    expect(assessFreshness("tiktok_reporting", [done("2026-08-09T10:55:00Z", "2026-08-09T11:00:00Z")], "2026-08-09T12:00:00Z").state).toBe("fresh");
  });

  it("goes stale and carries a caveat", () => {
    const f = assessFreshness("tiktok_reporting", [done("2026-08-09T03:55:00Z", "2026-08-09T04:00:00Z")], "2026-08-09T12:00:00Z");
    expect(f.state).toBe("stale");
    expect(f.caveat).toMatch(/480 minutes ago/);
  });

  it("reports failing when the latest attempt failed, but still dates the last good data", () => {
    const f = assessFreshness("tiktok_reporting", [
      done("2026-08-09T10:55:00Z", "2026-08-09T11:00:00Z"),
      { ...base, startedAt: "2026-08-09T11:50:00Z", status: "failed" },
    ], "2026-08-09T12:00:00Z");
    expect(f.state).toBe("failing");
    expect(f.lastSuccessfulAt).toBe("2026-08-09T11:00:00Z");
  });

  it("ignores runs from a different source", () => {
    expect(assessFreshness("site_analytics", [done("2026-08-09T11:55:00Z", "2026-08-09T11:59:00Z")], "2026-08-09T12:00:00Z").state).toBe("never");
  });
});

describe("retry policy", () => {
  it("honours the platform's own backoff on a rate limit", () => {
    const d = decideRetry({ status: 429, attempt: 1, retryAfterSeconds: 30 });
    expect(d.shouldRetry).toBe(true);
    expect(d.waitMs).toBe(30_000);
  });

  it("backs off exponentially on a server error", () => {
    expect(decideRetry({ status: 503, attempt: 1 }).waitMs).toBe(2000);
    expect(decideRetry({ status: 503, attempt: 3 }).waitMs).toBe(8000);
  });

  it("never retries an auth failure — that is how an app key gets suspended", () => {
    for (const status of [401, 403]) {
      const d = decideRetry({ status, attempt: 1 });
      expect(d.shouldRetry).toBe(false);
      expect(d.reason).toMatch(/auth/);
    }
  });

  it("never retries a malformed request", () => {
    expect(decideRetry({ status: 400, attempt: 1 }).shouldRetry).toBe(false);
  });

  it("gives up eventually", () => {
    expect(decideRetry({ status: 500, attempt: 5, maxAttempts: 5 }).shouldRetry).toBe(false);
  });
});

describe("timezone honesty", () => {
  it("flags a non-UTC source as not directly comparable", () => {
    const d = describeStatDate("2026-08-08", "America/New_York");
    expect(d.comparableWithUtc).toBe(false);
    expect(d.note).toMatch(/approximate/);
    expect(d.statDate).toBe("2026-08-08"); // stored as reported, never shifted
  });

  it("recognises a UTC source", () => {
    expect(describeStatDate("2026-08-08", "UTC").comparableWithUtc).toBe(true);
  });
});

describe("attribution reconciliation — two truths, never merged", () => {
  const row = (patch: Partial<ConversionCount> = {}): ConversionCount => ({
    creativeId: "vl-a", platformConversions: 10, platformValue: 1000,
    firstPartyConversions: 7, firstPartyValue: 700, spend: 200, ...patch,
  });

  it("keeps both sides and quantifies the gap", () => {
    const r = reconcile(row());
    expect(r.captureRate).toBeCloseTo(0.7, 5);
    expect(r.platformRoas).toBeCloseTo(5, 5);
    expect(r.firstPartyRoas).toBeCloseTo(3.5, 5);
    expect(r.flag).toBeNull();
    expect(r.interpretation).toMatch(/floor/);
  });

  it("flags the backwards case where we count more than the platform", () => {
    const r = reconcile(row({ firstPartyConversions: 14 }));
    expect(r.flag).toBe("first_party_exceeds_platform");
  });

  it("flags a collapsed capture rate as a likely tracking break", () => {
    const r = reconcile(row({ firstPartyConversions: 1 }));
    expect(r.flag).toBe("capture_collapsed");
    expect(r.interpretation).toMatch(/tracking break/);
  });

  it("flags orders the platform never reported", () => {
    expect(reconcile(row({ platformConversions: 0, platformValue: 0 })).flag).toBe("platform_reports_nothing");
  });

  it("says nothing to reconcile when neither side converted", () => {
    const r = reconcile(row({ platformConversions: 0, platformValue: 0, firstPartyConversions: 0, firstPartyValue: 0 }));
    expect(r.flag).toBe("no_conversions_either_side");
  });

  it("builds a median baseline and refuses one without volume", () => {
    expect(captureBaseline([row({ platformConversions: 2 })]).medianCaptureRate).toBeNull();
    const baseline = captureBaseline([
      row({ creativeId: "a", platformConversions: 10, firstPartyConversions: 6 }),
      row({ creativeId: "b", platformConversions: 10, firstPartyConversions: 7 }),
      row({ creativeId: "c", platformConversions: 10, firstPartyConversions: 8 }),
    ]);
    expect(baseline.medianCaptureRate).toBeCloseTo(0.7, 3);
    expect(baseline.sampledCreatives).toBe(3);
  });

  it("uses the median so one broken creative cannot mislabel the account", () => {
    const baseline = captureBaseline([
      row({ creativeId: "a", platformConversions: 10, firstPartyConversions: 7 }),
      row({ creativeId: "b", platformConversions: 10, firstPartyConversions: 7 }),
      row({ creativeId: "broken", platformConversions: 100, firstPartyConversions: 0 }),
    ]);
    expect(baseline.medianCaptureRate).toBeCloseTo(0.7, 3);
  });

  it("spots a creative losing parameters against the account norm", () => {
    const baseline = captureBaseline([
      row({ creativeId: "a", platformConversions: 10, firstPartyConversions: 7 }),
      row({ creativeId: "b", platformConversions: 10, firstPartyConversions: 7 }),
    ]);
    const suspect = reconcile(row({ creativeId: "c", platformConversions: 20, firstPartyConversions: 1 }));
    const check = captureAnomaly(suspect, baseline);
    expect(check.anomalous).toBe(true);
    expect(check.note).toMatch(/losing parameters/);
    expect(captureAnomaly(reconcile(row()), baseline).anomalous).toBe(false);
  });

  it("leads with the number we can defend, and shows the platform's beside it", () => {
    const head = headlineRoas(reconcile(row()));
    expect(head.side).toBe("first_party");
    expect(head.value).toBeCloseTo(3.5, 5);
    expect(head.caveat).toMatch(/At least 3\.50.*claims 5\.00/);
  });

  it("falls back to the platform figure only when we have proved nothing", () => {
    const head = headlineRoas(reconcile(row({ firstPartyConversions: 0, firstPartyValue: 0 })));
    expect(head.side).toBe("first_party");
    expect(head.value).toBe(0);
    const noSpend = headlineRoas(reconcile(row({ spend: 0 })));
    expect(noSpend.value).toBeNull();
  });
});
