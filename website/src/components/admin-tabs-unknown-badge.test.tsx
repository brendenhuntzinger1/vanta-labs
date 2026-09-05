import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// ADM-05 — THE BADGE MUST NEVER READ AS ALL-CLEAR WHEN THE COUNT FAILED.
//
// AdminTabs draws no badge at zero, so a critical-alert read that did not
// answer used to render the same nav bar as a store with nothing open. The
// layout now names the badge kinds whose read failed, and the tab draws an
// error mark in their place.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => {
    const attrs = Object.fromEntries(
      Object.entries(rest).filter(([key]) => key !== "prefetch" && key !== "scroll"),
    );
    return <a href={href} {...attrs}>{children}</a>;
  },
}));

const { AdminTabs } = await import("./admin-tabs");
const { summarizeWorkQueue, EMPTY_WORK_QUEUE } = await import("@/lib/admin-work-queue");

describe("AdminTabs when a badge count could not be read", () => {
  it("draws an error mark on the System Status tab instead of nothing", () => {
    const html = renderToStaticMarkup(<AdminTabs work={EMPTY_WORK_QUEUE} unknownBadges={["critical"]} />);

    expect(html).toContain('data-testid="badge-unknown-critical"');
    expect(html).toContain("Critical alert count could not be loaded");
    // The mobile summary pill says so too, rather than staying blank.
    expect(html).toContain('data-testid="badge-unknown-total"');
  });

  it("keeps drawing the count that DID load", () => {
    const work = summarizeWorkQueue(
      [{ id: "ready", label: "Ready", description: "", operational: true, count: 7 }],
      0,
    );
    const html = renderToStaticMarkup(<AdminTabs work={work} unknownBadges={["critical"]} />);

    expect(html).toContain("7 orders waiting");
    expect(html).toContain('data-testid="badge-unknown-critical"');
    expect(html).not.toContain('data-testid="badge-unknown-work"');
  });

  it("draws no error mark when every read answered", () => {
    const html = renderToStaticMarkup(<AdminTabs work={EMPTY_WORK_QUEUE} />);

    expect(html).not.toContain("badge-unknown");
    expect(html).not.toContain("could not be loaded");
  });
});
