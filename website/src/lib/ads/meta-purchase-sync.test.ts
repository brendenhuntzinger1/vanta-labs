import { describe, expect, it } from "vitest";
import { ordersNeedingMetaPurchase } from "./meta-purchase-sync";

const now = new Date("2026-09-14T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

describe("ordersNeedingMetaPurchase", () => {
  it("picks paid orders from the last seven days that have no Meta ledger row", () => {
    const pending = ordersNeedingMetaPurchase(
      [
        { order_id: "a", payment_status: "paid", paid_at: daysAgo(1) },
        { order_id: "b", payment_status: "paid", paid_at: daysAgo(2) },
        { order_id: "c", payment_status: "pending", paid_at: daysAgo(1) },
        { order_id: "d", payment_status: "paid", paid_at: daysAgo(9) },
        { order_id: "e", payment_status: "paid", created_at: daysAgo(3) },
      ],
      [
        { order_id: "b", platform: "meta", delivered: true },
        // A TikTok row is not a Meta row: the platforms are reported separately.
        { order_id: "a", platform: "tiktok", delivered: true },
      ],
      now,
    );
    expect(pending.map((order) => order.order_id)).toEqual(["a", "e"]);
  });

  it("treats a claimed-but-undelivered Meta row as done, so a rejected send is not retried every tick", () => {
    // Same rule as the TikTok ledger: `delivered` is for later repair, not for
    // an automatic retry loop against a platform that already said no.
    const pending = ordersNeedingMetaPurchase(
      [{ order_id: "a", payment_status: "paid", paid_at: daysAgo(1) }],
      [{ order_id: "a", platform: "meta", delivered: false }],
      now,
    );
    expect(pending).toEqual([]);
  });
});
