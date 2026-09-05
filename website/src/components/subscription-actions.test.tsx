import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { SubscriptionActions } from "@/components/subscription-actions";

// ---------------------------------------------------------------------------
// THE ACCOUNT PAGE'S PAUSE CONTROLS SAY WHAT THE CODE DOES, AND A PAUSED
// MEMBER CAN ALWAYS RESUME.
//
// A pause is one deferred cycle: the processor has no pause, so the next
// charge moves out one cycle and lands on that date whether or not the member
// resumed (pauseMembership). The confirm copy promised "you won't be charged
// while paused", which stopped being true after that cycle.
//
// And a member who paused and then cancelled was told "Resume any time" while
// the only control that could do it was hidden: canManage required
// !cancelAtPeriodEnd for every state, paused included.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

describe("what the pause copy promises", () => {
  it("does not promise that a paused member is never charged", () => {
    const source = readFileSync("src/components/subscription-actions.tsx", "utf8");
    expect(source).not.toMatch(/won't be charged while paused/i);
    expect(source).not.toMatch(/restarts from a fresh cycle/i);
  });

  it("describes the one-cycle deferral instead", () => {
    const source = readFileSync("src/components/subscription-actions.tsx", "utf8");
    expect(source).toMatch(/moves forward one billing cycle/i);
    expect(source).toMatch(/billing continues on/i);
  });
});

describe("which controls render", () => {
  it("offers Resume to a paused member who has also cancelled at period end", () => {
    const html = renderToStaticMarkup(
      <SubscriptionActions membership={{ status: "paused", billingCycle: "monthly", cancelAtPeriodEnd: true }} />,
    );
    expect(html).toContain("Resume membership");
    expect(html).not.toContain("Pause membership");
    expect(html).not.toContain("Skip next charge");
  });

  it("offers Resume to a paused member who is not ending", () => {
    const html = renderToStaticMarkup(
      <SubscriptionActions membership={{ status: "paused", billingCycle: "monthly", cancelAtPeriodEnd: false }} />,
    );
    expect(html).toContain("Resume membership");
  });

  it("still withholds Pause and Skip from an active plan that is ending", () => {
    const html = renderToStaticMarkup(
      <SubscriptionActions membership={{ status: "active", billingCycle: "monthly", cancelAtPeriodEnd: true }} />,
    );
    expect(html).toBe("");
  });

  it("still renders nothing for an annual plan", () => {
    const html = renderToStaticMarkup(
      <SubscriptionActions membership={{ status: "paused", billingCycle: "annual", cancelAtPeriodEnd: false }} />,
    );
    expect(html).toBe("");
  });

  it("offers Skip and Pause to an active, renewing monthly plan", () => {
    const html = renderToStaticMarkup(
      <SubscriptionActions membership={{ status: "active", billingCycle: "monthly", cancelAtPeriodEnd: false }} />,
    );
    expect(html).toContain("Skip next charge");
    expect(html).toContain("Pause membership");
  });
});

describe("the subscriptions page's idea of a paid plan", () => {
  it("does not read a free-tier row on a monthly cycle as an expired paid plan", () => {
    const source = readFileSync("src/app/account/(dashboard)/subscriptions/page.tsx", "utf8");
    expect(source).toContain('const hasPaidPlan = membership.billingCycle !== "free" && membership.tier.slug !== "free";');
  });
});
