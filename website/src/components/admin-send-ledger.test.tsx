import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminSendLedger } from "@/components/admin-send-ledger";
import type { SendLedger } from "@/lib/email/send-ledger";

// ---------------------------------------------------------------------------
// THE SEND LEDGER USED TO REPORT UTC AND CALL IT THE OPERATOR'S CLOCK.
//
// This panel is a SERVER component. It renders on Vercel, whose processes run in
// UTC, and it formatted every stamp with a bare `toLocaleDateString` /
// `toLocaleTimeString` — "format in whatever zone this code happens to be in".
//
// So a campaign the operator sent at 8:30 PM from Florida was stored as
// 2026-09-09T00:30:00Z and rendered back to them as "Sep 9 12:30 AM". Not just
// the wrong hour: the wrong DAY, for everything sent after 8 PM Eastern. The
// ledger and the operator's own memory of pressing send disagreed nightly, and
// the ledger looked authoritative.
//
// renderToStaticMarkup is the right instrument for this because it IS the server
// render. A browser check would have hidden the bug: a browser sitting in
// Eastern renders the correct time by accident, from the wrong zone.
// ---------------------------------------------------------------------------

/** 8:30 PM Sep 8 in Florida — the evening send that used to roll over to Sep 9. */
const EVENING_SEND = "2026-09-09T00:30:00Z";

function ledger(overrides: Partial<SendLedger> = {}): SendLedger {
  return {
    rows: [
      {
        id: "row-1",
        recipient: "buyer@example.com",
        channel: "Campaign · September drop",
        campaignType: "campaign",
        sentAt: EVENING_SEND,
        status: "sent",
        delivered: true,
        bounced: false,
        complained: false,
        failed: false,
        deliveryEvidence: "message-id",
        openedAt: "2026-09-09T01:15:00Z", // 9:15 PM Sep 8 ET
        clickedAt: null,
        openTracked: true,
      },
    ],
    channels: [
      {
        channel: "Campaign · September drop",
        sent: 1,
        delivered: 1,
        bounced: 0,
        deliveryKnown: 1,
        opened: 1,
        clicked: 0,
        openTracked: 1,
        lastSentAt: EVENING_SEND,
      },
    ],
    totals: { sent: 1, delivered: 1, deliveryKnown: 1, bounced: 0, opened: 1, openTracked: 1, clicked: 0 },
    truncated: false,
    error: null,
    ...overrides,
  };
}

/** Render the panel as if the process were in `tz`, the way Vercel picks UTC. */
function renderIn(tz: string): string {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return renderToStaticMarkup(<AdminSendLedger ledger={ledger()} />);
  } finally {
    process.env.TZ = original;
  }
}

describe("AdminSendLedger timestamps", () => {
  it("reports the operator's evening, not the UTC day it rolls into", () => {
    const html = renderIn("UTC");
    expect(html).toContain("Sep 8, 8:30 PM");
    // The exact string this panel used to print on a Vercel render.
    expect(html).not.toContain("Sep 9 12:30 AM");
    expect(html).not.toContain("Sep 9, 12:30 AM");
  });

  it("renders identically whatever zone the server process is in", () => {
    const seen = new Set(["UTC", "America/Los_Angeles", "Asia/Tokyo", "America/New_York"].map(renderIn));
    expect(seen.size).toBe(1);
  });

  it("shows the open time in Eastern too", () => {
    expect(renderIn("UTC")).toContain("Sep 8, 9:15 PM");
  });

  it("names the zone on the columns that carry a clock", () => {
    // A correct time the reader cannot attribute to a zone is still a guess.
    const html = renderIn("UTC");
    expect(html).toContain("Last sent");
    expect(html.match(/\(ET\)/g) ?? []).toHaveLength(2);
  });

  it("still renders a dash for a send with no timestamp", () => {
    const blank = ledger();
    blank.rows[0].sentAt = null;
    blank.rows[0].openedAt = null;
    blank.channels[0].lastSentAt = null;
    const html = renderToStaticMarkup(<AdminSendLedger ledger={blank} />);
    expect(html).toContain("—");
  });
});
