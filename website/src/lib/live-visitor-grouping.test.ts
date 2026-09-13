import { describe, expect, it } from "vitest";
import { groupLiveActivity, type LiveActivityRow, type SessionStartInfo } from "./live-visitor-grouping";

const NOW = new Date("2026-09-13T12:00:00.000Z");
const LIVE_WINDOW_MS = 60_000;

function row(overrides: Partial<LiveActivityRow> & { sessionId: string; createdAt: string }): LiveActivityRow {
  return {
    userId: null,
    pagePath: "/products/recon-water",
    deviceType: "desktop",
    userAgent: "Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36",
    country: "US",
    city: "Austin",
    isBot: false,
    ...overrides,
  };
}

function sessionStart(overrides: Partial<SessionStartInfo> & { sessionId: string; createdAt: string }): SessionStartInfo {
  return {
    visitCount: 1,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    ...overrides,
  };
}

describe("groupLiveActivity", () => {
  it("collapses multiple tabs of the same browser into one visitor", () => {
    const rows = [
      row({ sessionId: "s1", pagePath: "/products/recon-water", createdAt: "2026-09-13T11:59:50.000Z" }),
      row({ sessionId: "s1", pagePath: "/cart", createdAt: "2026-09-13T11:59:55.000Z" }),
    ];
    const starts = new Map([["s1", sessionStart({ sessionId: "s1", createdAt: "2026-09-13T11:55:00.000Z" })]]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors).toHaveLength(1);
    // The most recently active tab's page wins.
    expect(visitors[0].pagePath).toBe("/cart");
    expect(visitors[0].sessionIds).toEqual(["s1"]);
  });

  it("keeps two different anonymous sessions as two visitors", () => {
    const rows = [
      row({ sessionId: "s1", createdAt: "2026-09-13T11:59:50.000Z" }),
      row({ sessionId: "s2", createdAt: "2026-09-13T11:59:50.000Z" }),
    ];
    const starts = new Map([
      ["s1", sessionStart({ sessionId: "s1", createdAt: "2026-09-13T11:55:00.000Z" })],
      ["s2", sessionStart({ sessionId: "s2", createdAt: "2026-09-13T11:56:00.000Z" })],
    ]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors).toHaveLength(2);
  });

  it("merges the same signed-in customer browsing from two devices into one visitor", () => {
    const rows = [
      row({ sessionId: "phone", userId: "user-1", pagePath: "/account", createdAt: "2026-09-13T11:58:00.000Z" }),
      row({ sessionId: "laptop", userId: "user-1", pagePath: "/checkout", createdAt: "2026-09-13T11:59:58.000Z" }),
    ];
    const starts = new Map([
      ["phone", sessionStart({ sessionId: "phone", createdAt: "2026-09-13T11:50:00.000Z" })],
      ["laptop", sessionStart({ sessionId: "laptop", createdAt: "2026-09-13T11:56:00.000Z" })],
    ]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors).toHaveLength(1);
    expect(visitors[0].userId).toBe("user-1");
    // Current page comes from whichever device was active most recently.
    expect(visitors[0].pagePath).toBe("/checkout");
    // Duration is anchored to the EARLIEST of the merged sessions.
    expect(visitors[0].firstSeen).toBe("2026-09-13T11:50:00.000Z");
    expect(visitors[0].sessionIds.sort()).toEqual(["laptop", "phone"]);
  });

  it("logging in mid-session transitions the same entry from anonymous to named, without duplicating it", () => {
    // Same sessionId throughout — only the identity on the latest row changes.
    const rows = [
      row({ sessionId: "s1", userId: null, pagePath: "/products/recon-water", createdAt: "2026-09-13T11:59:00.000Z" }),
      row({ sessionId: "s1", userId: "user-9", pagePath: "/account", createdAt: "2026-09-13T11:59:50.000Z" }),
    ];
    const starts = new Map([["s1", sessionStart({ sessionId: "s1", createdAt: "2026-09-13T11:55:00.000Z" })]]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors).toHaveLength(1);
    expect(visitors[0].userId).toBe("user-9");
    expect(visitors[0].pagePath).toBe("/account");
    // Duration survives the login — still anchored to the session's own start.
    expect(visitors[0].firstSeen).toBe("2026-09-13T11:55:00.000Z");
  });

  it("logging out mid-session reverts the entry to anonymous without duplicating it", () => {
    const rows = [
      row({ sessionId: "s1", userId: "user-9", pagePath: "/account", createdAt: "2026-09-13T11:59:00.000Z" }),
      row({ sessionId: "s1", userId: null, pagePath: "/", createdAt: "2026-09-13T11:59:50.000Z" }),
    ];
    const starts = new Map([["s1", sessionStart({ sessionId: "s1", createdAt: "2026-09-13T11:55:00.000Z" })]]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors).toHaveLength(1);
    expect(visitors[0].userId).toBeNull();
    expect(visitors[0].pagePath).toBe("/");
  });

  it("drops rows classified as bots", () => {
    const rows = [row({ sessionId: "bot1", isBot: true, createdAt: "2026-09-13T11:59:50.000Z" })];
    const starts = new Map([["bot1", sessionStart({ sessionId: "bot1", createdAt: "2026-09-13T11:55:00.000Z" })]]);

    expect(groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS)).toHaveLength(0);
  });

  it("drops the admin's own session (any row on an /admin page)", () => {
    const rows = [row({ sessionId: "admin1", pagePath: "/admin/live", createdAt: "2026-09-13T11:59:50.000Z" })];
    const starts = new Map([["admin1", sessionStart({ sessionId: "admin1", createdAt: "2026-09-13T11:55:00.000Z" })]]);

    expect(groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS)).toHaveLength(0);
  });

  it("ages out a visitor whose last activity is outside the live window", () => {
    const rows = [row({ sessionId: "stale1", createdAt: "2026-09-13T11:58:30.000Z" })]; // 90s before NOW
    const starts = new Map([["stale1", sessionStart({ sessionId: "stale1", createdAt: "2026-09-13T11:50:00.000Z" })]]);

    expect(groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS)).toHaveLength(0);
  });

  it("keeps a visitor whose last activity is inside the live window", () => {
    const rows = [row({ sessionId: "fresh1", createdAt: "2026-09-13T11:59:05.000Z" })]; // 55s before NOW
    const starts = new Map([["fresh1", sessionStart({ sessionId: "fresh1", createdAt: "2026-09-13T11:50:00.000Z" })]]);

    expect(groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS)).toHaveLength(1);
  });

  it("marks a visitor returning only when their session has more than one recorded visit", () => {
    const rows = [
      row({ sessionId: "new1", createdAt: "2026-09-13T11:59:50.000Z" }),
      row({ sessionId: "returning1", createdAt: "2026-09-13T11:59:50.000Z" }),
    ];
    const starts = new Map([
      ["new1", sessionStart({ sessionId: "new1", createdAt: "2026-09-13T11:55:00.000Z", visitCount: 1 })],
      ["returning1", sessionStart({ sessionId: "returning1", createdAt: "2026-09-13T11:55:00.000Z", visitCount: 4 })],
    ]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);
    const byId = Object.fromEntries(visitors.map((v) => [v.sessionIds[0], v]));

    expect(byId.new1.isReturningVisitor).toBe(false);
    expect(byId.returning1.isReturningVisitor).toBe(true);
  });

  it("falls back sensibly when a live session has no matching session_start row", () => {
    // Shouldn't normally happen, but a heartbeat could in principle arrive
    // before its session_start write lands. Must not throw, and duration
    // degrades to "just arrived" rather than crashing the whole read.
    const rows = [row({ sessionId: "orphan1", createdAt: "2026-09-13T11:59:50.000Z" })];
    const starts = new Map<string, SessionStartInfo>();

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors).toHaveLength(1);
    expect(visitors[0].firstSeen).toBe("2026-09-13T11:59:50.000Z");
    expect(visitors[0].isReturningVisitor).toBe(false);
  });

  it("carries UTM attribution from the most recently active merged session", () => {
    const rows = [
      row({ sessionId: "phone", userId: "user-2", createdAt: "2026-09-13T11:58:00.000Z" }),
      row({ sessionId: "laptop", userId: "user-2", createdAt: "2026-09-13T11:59:58.000Z" }),
    ];
    const starts = new Map([
      [
        "phone",
        sessionStart({
          sessionId: "phone",
          createdAt: "2026-09-13T11:50:00.000Z",
          utmSource: "google",
          utmMedium: "cpc",
        }),
      ],
      [
        "laptop",
        sessionStart({
          sessionId: "laptop",
          createdAt: "2026-09-13T11:56:00.000Z",
          utmSource: "tiktok",
          utmMedium: "paid_social",
        }),
      ],
    ]);

    const visitors = groupLiveActivity(rows, starts, NOW, LIVE_WINDOW_MS);

    expect(visitors[0].utmSource).toBe("tiktok");
    expect(visitors[0].utmMedium).toBe("paid_social");
  });
});
