import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// EMAIL-08 (marketing). The coupon-announcement broadcast reads email_send_log
// to skip recipients who "already got it". It read EVERY row for the coupon,
// with no status filter — so a 'failed' row (the provider refused that address
// once) or a stranded 'sending' claim (a process died mid-send) counted as
// delivered, and that recipient was skipped on every later click, for ever.
// Only a row that reads 'sent' is a delivery.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  customer_preferences: [],
  marketing_subscribers: [],
  email_send_log: [],
};
const users = [
  { id: "u-ok", email: "delivered@example.test" },
  { id: "u-failed", email: "bounced-once@example.test" },
  { id: "u-stranded", email: "stranded@example.test" },
  { id: "u-new", email: "never@example.test" },
];

/** Every filter the dedup read applied, so the test can see the status gate. */
const sendLogFilters: Array<[string, unknown]> = [];

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    auth: { admin: { listUsers: async () => ({ data: { users }, error: null }) } },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (db[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const builder: Record<string, unknown> = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          if (table === "email_send_log") sendLogFilters.push([column, value]);
          filters.push((row) => String(row[column] ?? "") === String(value ?? ""));
          return builder;
        },
        is(column: string, value: unknown) { filters.push((row) => (row[column] ?? null) === value); return builder; },
        order() { return builder; },
        range(from: number, to: number) { return Promise.resolve({ data: rows().slice(from, to + 1), error: null }); },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: rows(), error: null }).then(resolve); },
      };
      return builder;
    },
  },
}));

const sent: string[] = [];
vi.mock("@/lib/email/marketing", () => ({
  sendMarketingEmail: async (input: { to: string }) => {
    sent.push(input.to);
    return { success: true };
  },
}));

const COUPON = {
  id: "coupon-1",
  code: "SPRING10",
  discountType: "percent" as const,
  discountValue: 10,
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  redemptionsCount: 0,
  active: true,
  createdAt: "2026-09-01T00:00:00.000Z",
};

beforeEach(() => {
  db.customer_preferences = users.map((user) => ({ user_id: user.id, marketing_emails: true }));
  db.marketing_subscribers = [];
  db.email_send_log = [];
  sent.length = 0;
  sendLogFilters.length = 0;
});

describe("the coupon broadcast's already-sent list", () => {
  it("skips a recipient whose row reads 'sent', and sends to one whose earlier attempt failed or was stranded", async () => {
    const { broadcastCouponAnnouncement } = await import("@/lib/marketing-broadcast");
    db.email_send_log = [
      { id: 1, campaign_type: "coupon_announcement", reference_id: "coupon-1", recipient_email: "delivered@example.test", status: "sent" },
      { id: 2, campaign_type: "coupon_announcement", reference_id: "coupon-1", recipient_email: "bounced-once@example.test", status: "failed" },
      { id: 3, campaign_type: "coupon_announcement", reference_id: "coupon-1", recipient_email: "stranded@example.test", status: "sending" },
    ];

    const result = await broadcastCouponAnnouncement({ coupon: COUPON as never, headline: "Spring sale" });

    expect(sent.sort()).toEqual(["bounced-once@example.test", "never@example.test", "stranded@example.test"]);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(3);
  });

  it("asks the log for delivered rows only", async () => {
    const { broadcastCouponAnnouncement } = await import("@/lib/marketing-broadcast");
    await broadcastCouponAnnouncement({ coupon: COUPON as never, headline: "Spring sale" });
    expect(sendLogFilters).toContainEqual(["status", "sent"]);
    expect(sendLogFilters).toContainEqual(["reference_id", "coupon-1"]);
  });

  it("a 'sent' row for a DIFFERENT coupon does not suppress this announcement", async () => {
    const { broadcastCouponAnnouncement } = await import("@/lib/marketing-broadcast");
    db.email_send_log = [
      { id: 1, campaign_type: "coupon_announcement", reference_id: "coupon-other", recipient_email: "delivered@example.test", status: "sent" },
    ];
    await broadcastCouponAnnouncement({ coupon: COUPON as never, headline: "Spring sale" });
    expect(sent).toContain("delivered@example.test");
  });
});
