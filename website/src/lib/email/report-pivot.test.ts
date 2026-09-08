import { describe, expect, it } from "vitest";
import { aggregateReport, type ReportRow } from "@/lib/email/report-pivot";

const D = (iso: string) => Date.parse(iso);

function send(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    sentAt: D("2026-09-01T10:00:00Z"),
    activityId: "camp-1",
    activityType: "campaign",
    segment: "all",
    delivered: true,
    opened: false,
    clicked: false,
    unsubscribed: false,
    complained: false,
    orders: 0,
    revenueCents: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE PIVOT LAYER.
//
// automation-stats.ts already computes the numbers that matter, and computes
// them carefully — net of refunds, primary orders only, never crediting one
// order to two channels. What it could not do is SLICE them: every report was
// a flat total over one of four fixed ranges, so "which campaign, in which
// week, to which segment" had no answer short of a SQL console.
//
// This is the breakdown layer over the same rows. It deliberately does no
// loading and no attribution of its own — the numbers arrive already decided,
// so there is exactly one place in the system where "what counts as revenue"
// is answered, and it is not here.
// ---------------------------------------------------------------------------

describe("totals", () => {
  it("counts sends, opens, clicks and revenue", () => {
    const report = aggregateReport({
      rows: [
        send({ opened: true, clicked: true, orders: 1, revenueCents: 5_000 }),
        send({ opened: true }),
        send(),
      ],
      dimensions: [],
    });

    expect(report.totals.sent).toBe(3);
    expect(report.totals.opened).toBe(2);
    expect(report.totals.clicked).toBe(1);
    expect(report.totals.orders).toBe(1);
    expect(report.totals.revenueCents).toBe(5_000);
  });

  it("derives rates from sends", () => {
    const report = aggregateReport({
      rows: [send({ opened: true, clicked: true }), send({ opened: true }), send(), send()],
      dimensions: [],
    });

    expect(report.totals.openRate).toBeCloseTo(0.5, 5);
    expect(report.totals.clickRate).toBeCloseTo(0.25, 5);
  });

  // A rate over zero sends is not zero and it is not NaN — it is unknown. A
  // dashboard showing "0.00% open rate" for a campaign that has not sent yet
  // reads as a failure rather than an absence.
  it("reports an unknown rate as null rather than zero", () => {
    const report = aggregateReport({ rows: [], dimensions: [] });

    expect(report.totals.sent).toBe(0);
    expect(report.totals.openRate).toBeNull();
    expect(report.totals.revenuePerSentCents).toBeNull();
  });

  it("counts a failed send as sent but not delivered", () => {
    const report = aggregateReport({ rows: [send({ delivered: false }), send()], dimensions: [] });

    expect(report.totals.sent).toBe(2);
    expect(report.totals.delivered).toBe(1);
    expect(report.totals.failed).toBe(1);
    expect(report.totals.failRate).toBeCloseTo(0.5, 5);
  });

  it("tracks unsubscribes and complaints, which are the ones that cost the list", () => {
    const report = aggregateReport({
      rows: [send({ unsubscribed: true }), send({ complained: true }), send()],
      dimensions: [],
    });

    expect(report.totals.unsubscribed).toBe(1);
    expect(report.totals.complained).toBe(1);
    expect(report.totals.unsubscribeRate).toBeCloseTo(1 / 3, 5);
  });

  it("computes revenue per send in cents", () => {
    const report = aggregateReport({
      rows: [send({ revenueCents: 10_000 }), send(), send(), send()],
      dimensions: [],
    });

    expect(report.totals.revenuePerSentCents).toBe(2_500);
  });
});

describe("breaking down by dimension", () => {
  const rows = [
    send({ activityId: "camp-1", sentAt: D("2026-09-01T10:00:00Z"), clicked: true, revenueCents: 3_000 }),
    send({ activityId: "camp-1", sentAt: D("2026-09-02T10:00:00Z") }),
    send({ activityId: "camp-2", sentAt: D("2026-09-02T10:00:00Z"), clicked: true }),
  ];

  it("groups by activity", () => {
    const report = aggregateReport({ rows, dimensions: ["activity"] });

    const one = report.rows.find((row) => row.key.activity === "camp-1");
    const two = report.rows.find((row) => row.key.activity === "camp-2");
    expect(one?.metrics.sent).toBe(2);
    expect(one?.metrics.revenueCents).toBe(3_000);
    expect(two?.metrics.sent).toBe(1);
  });

  it("groups by day", () => {
    const report = aggregateReport({ rows, dimensions: ["date"], granularity: "day" });

    expect(report.rows).toHaveLength(2);
    expect(report.rows.find((row) => row.key.date === "2026-09-02")?.metrics.sent).toBe(2);
  });

  it("groups by week and month", () => {
    const spread = [
      send({ sentAt: D("2026-09-01T10:00:00Z") }),
      send({ sentAt: D("2026-09-15T10:00:00Z") }),
      send({ sentAt: D("2026-10-01T10:00:00Z") }),
    ];

    expect(aggregateReport({ rows: spread, dimensions: ["date"], granularity: "month" }).rows).toHaveLength(2);
    expect(aggregateReport({ rows: spread, dimensions: ["date"], granularity: "week" }).rows.length).toBeGreaterThan(2);
  });

  it("crosses two dimensions", () => {
    const report = aggregateReport({ rows, dimensions: ["date", "activity"], granularity: "day" });

    expect(report.rows).toHaveLength(3);
    const cell = report.rows.find((row) => row.key.date === "2026-09-02" && row.key.activity === "camp-2");
    expect(cell?.metrics.sent).toBe(1);
  });

  it("groups by segment and by activity type", () => {
    const mixed = [
      send({ segment: "high_value", activityType: "campaign" }),
      send({ segment: "all", activityType: "automation" }),
      send({ segment: "all", activityType: "automation" }),
    ];

    expect(aggregateReport({ rows: mixed, dimensions: ["segment"] }).rows).toHaveLength(2);
    const byType = aggregateReport({ rows: mixed, dimensions: ["activityType"] });
    expect(byType.rows.find((row) => row.key.activityType === "automation")?.metrics.sent).toBe(2);
  });

  // Breakdown rows must reconcile with the headline number, or the report is
  // lying somewhere and there is no way to tell where.
  it("breakdown rows sum back to the totals", () => {
    const report = aggregateReport({ rows, dimensions: ["date", "activity"], granularity: "day" });
    const summed = report.rows.reduce((total, row) => total + row.metrics.sent, 0);

    expect(summed).toBe(report.totals.sent);
  });

  it("sorts rows so the biggest sender is first", () => {
    const report = aggregateReport({ rows, dimensions: ["activity"] });
    expect(report.rows[0]?.key.activity).toBe("camp-1");
  });
});

describe("date range filtering", () => {
  const rows = [
    send({ sentAt: D("2026-08-01T10:00:00Z") }),
    send({ sentAt: D("2026-09-05T10:00:00Z") }),
    send({ sentAt: D("2026-09-20T10:00:00Z") }),
  ];

  it("keeps only sends inside the range", () => {
    const report = aggregateReport({
      rows,
      dimensions: [],
      range: { from: D("2026-09-01T00:00:00Z"), to: D("2026-09-10T00:00:00Z") },
    });

    expect(report.totals.sent).toBe(1);
  });

  it("treats the range as inclusive of from and exclusive of to", () => {
    const report = aggregateReport({
      rows: [send({ sentAt: D("2026-09-01T00:00:00Z") }), send({ sentAt: D("2026-09-10T00:00:00Z") })],
      dimensions: [],
      range: { from: D("2026-09-01T00:00:00Z"), to: D("2026-09-10T00:00:00Z") },
    });

    expect(report.totals.sent).toBe(1);
  });

  it("ignores a row with an unusable timestamp rather than counting it into the wrong bucket", () => {
    const report = aggregateReport({ rows: [send({ sentAt: Number.NaN }), send()], dimensions: ["date"], granularity: "day" });

    expect(report.totals.sent).toBe(1);
    expect(report.rows).toHaveLength(1);
  });
});
