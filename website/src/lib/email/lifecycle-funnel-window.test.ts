import { describe, expect, it } from "vitest";

import { RESTRAINED_STAGES_SHIPPED_AT_MS, funnelWindowFor } from "@/lib/email/lifecycle-funnel";
import { funnelWindowLinks } from "@/lib/email/lifecycle-funnel-links";

// ---------------------------------------------------------------------------
// THE FUNNEL'S WINDOW STARTS WHERE THE NEW STAGES DID, unless the operator
// widens it. Sends before 2026-09-11 03:29 UTC carried the offer-card wording;
// a 28-day window that pooled them with the note-shaped sends would hide the
// one change the funnel was built to read.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

describe("funnelWindowFor", () => {
  it("defaults to the moment the note-shaped stages went live, and says so", () => {
    const now = RESTRAINED_STAGES_SHIPPED_AT_MS + 10 * DAY;
    const w = funnelWindowFor(undefined, now);
    expect(w.key).toBe("plain");
    expect(w.sinceMs).toBe(RESTRAINED_STAGES_SHIPPED_AT_MS);
    expect(w.windowDays).toBe(10);
    expect(w.label).toContain("since Sep 10, 2026");
    expect(w.label).toContain("note-shaped");
  });

  it("never starts in the future when read before the deploy moment", () => {
    const now = RESTRAINED_STAGES_SHIPPED_AT_MS - DAY;
    const w = funnelWindowFor("plain", now);
    expect(w.sinceMs).toBe(now);
    expect(w.windowDays).toBe(1);
  });

  it("offers 28 and 90 days back from now, and treats anything else as the default", () => {
    const now = RESTRAINED_STAGES_SHIPPED_AT_MS + 40 * DAY;
    expect(funnelWindowFor("28", now)).toMatchObject({ key: "28", sinceMs: now - 28 * DAY, windowDays: 28, label: "last 28 days" });
    expect(funnelWindowFor("90", now)).toMatchObject({ key: "90", sinceMs: now - 90 * DAY, windowDays: 90 });
    expect(funnelWindowFor(["90", "28"], now).key).toBe("90");
    expect(funnelWindowFor("7", now).key).toBe("plain");
    expect(funnelWindowFor("", now).key).toBe("plain");
  });
});

describe("funnelWindowLinks", () => {
  it("keeps the page's other parameters and marks the active window", () => {
    const links = funnelWindowLinks("/admin/email", { range: "30", window: "90", tab: ["a", "b"] }, "90");
    expect(links.map((l) => l.key)).toEqual(["plain", "28", "90"]);
    expect(links.find((l) => l.key === "28")?.href).toBe("/admin/email?range=30&tab=a&tab=b&window=28");
    expect(links.find((l) => l.key === "90")?.active).toBe(true);
    expect(links.filter((l) => l.active)).toHaveLength(1);
  });
});
