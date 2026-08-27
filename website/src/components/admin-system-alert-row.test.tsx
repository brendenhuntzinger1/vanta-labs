import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminSystemAlertRow } from "@/components/admin-system-alert-row";
import type { SystemAlertRow } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// THE ALERT HAS TO LEAD SOMEWHERE.
//
// /admin/status rendered `type`, a timestamp and `message`, and nothing else.
// For shipping_cost_manual_entry_required that means the operator reads "2
// order(s) ... Enter the cost by hand in Admin -> Orders" and is given no way
// to find out which two -- the ids were in `context`, unread.
//
// extractAlertOrderIds is tested on its own. What these assert is the WIRING:
// that the row actually calls it and renders links a person can click. The
// version of this bug being fixed here is precisely a correct function nobody
// called, so a test that only covered the function would have passed against
// the broken page.
// ---------------------------------------------------------------------------

const SHIPPING_ALERT: SystemAlertRow = {
  id: "alert-1",
  type: "shipping_cost_manual_entry_required",
  severity: "warning",
  message:
    "2 order(s) have a label whose postage cannot be read back from Shippo. "
    + "Enter the cost by hand in Admin -> Orders; no automatic repair is possible.",
  context: {
    total: 2,
    orderIds: ["order-6d2fbba4", "order-ffca9ae8"],
    orders: [{ orderId: "order-6d2fbba4" }, { orderId: "order-ffca9ae8" }],
  },
  created_at: "2026-08-27T12:30:34.125Z",
  resolved_at: null,
};

describe("a system alert that names orders", () => {
  it("links each one to its order page", () => {
    const html = renderToStaticMarkup(<AdminSystemAlertRow alert={SHIPPING_ALERT} />);
    expect(html).toContain('href="/admin/orders/order-6d2fbba4"');
    expect(html).toContain('href="/admin/orders/order-ffca9ae8"');
  });

  it("links each order once, even though the context names it twice", () => {
    const html = renderToStaticMarkup(<AdminSystemAlertRow alert={SHIPPING_ALERT} />);
    const links = html.match(/href="\/admin\/orders\//g) ?? [];
    expect(links).toHaveLength(2);
  });

  it("still shows the message itself", () => {
    // The links are an addition, not a replacement — the sentence explaining
    // what to do is the reason the operator knows to click them at all.
    const html = renderToStaticMarkup(<AdminSystemAlertRow alert={SHIPPING_ALERT} />);
    expect(html).toContain("Enter the cost by hand");
  });
});

describe("a system alert that names no order", () => {
  it("renders no order links at all", () => {
    const html = renderToStaticMarkup(
      <AdminSystemAlertRow
        alert={{
          id: "alert-2",
          type: "inventory_rpc_failed",
          severity: "critical",
          message: "expire_stale_reservations failed.",
          context: { rpc: "expire_stale_reservations", orderId: null },
          created_at: "2026-08-27T12:00:20.431Z",
          resolved_at: null,
        }}
      />,
    );
    expect(html).not.toContain("/admin/orders/");
    expect(html).toContain("expire_stale_reservations failed.");
  });

  it("survives an alert whose context is null", () => {
    // getRecentSystemAlerts types context as nullable and the column really
    // does hold NULL for older rows. A status page that throws on one bad row
    // shows nothing about any of the others.
    const html = renderToStaticMarkup(
      <AdminSystemAlertRow
        alert={{
          id: "alert-3",
          type: "cron_sweep_failed",
          severity: "critical",
          message: "A scheduled job failed.",
          context: null,
          created_at: "2026-08-27T12:00:20.431Z",
          resolved_at: null,
        }}
      />,
    );
    expect(html).toContain("A scheduled job failed.");
  });
});
