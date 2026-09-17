import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// A COUNT THAT IS COMPUTED AND NEVER RENDERED IS A COUNT NOBODY HAS.
//
// admin-email.ts tallies five per-recipient outcomes — sent, failed,
// suppressed, pending, cancelled — and carries all five on CampaignSummary.
// The customer campaign table rendered two of them.
//
// That is only a reporting gap until you notice what it interacts with. A
// PARTIAL send failure deliberately leaves the campaign status reading "sent"
// (campaign-sender.ts: the people who received it did receive it, and telling
// the owner to resend would mail them twice). So the status column says "sent",
// the failed recipients appear nowhere on the screen, and the only way to learn
// they exist is to query email_campaign_recipients by hand.
//
// Both halves are needed for the owner to trust the number: "sent" means sent,
// and anyone who did not get it is named next to it.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const CLIENT = read("src/components/admin-email-client.tsx");
const DASHBOARD = read("src/lib/admin-email.ts");

describe("the campaign history shows every outcome it counts", () => {
  it("still counts all five outcomes server-side", () => {
    // If one is dropped from the tally the render below becomes dead code, and
    // this test should fail loudly rather than pass by accident.
    for (const outcome of ["sent", "failed", "suppressed", "pending", "cancelled"]) {
      expect(DASHBOARD, `admin-email.ts stopped tallying "${outcome}"`).toMatch(
        new RegExp(`${outcome}:\\s*number`),
      );
    }
  });

  it("renders the outcomes that mean somebody did not receive it", () => {
    // pending and cancelled were already shown; failed and suppressed are the
    // two that were computed and thrown away.
    for (const outcome of ["pending", "cancelled", "failed", "suppressed"]) {
      expect(
        CLIENT,
        `the campaign table computes campaign.${outcome} but never renders it`,
      ).toContain(`campaign.${outcome} > 0`);
    }
  });

  it("marks a genuine failure differently from a shrinking list", () => {
    // Suppressed is not a fault — the recipient unsubscribed or bounced before
    // the send reached them. Failed is. Colouring them the same would train the
    // owner to ignore both.
    const failedLine = CLIENT.slice(CLIENT.indexOf("campaign.failed > 0"));
    expect(failedLine.slice(0, 220)).toMatch(/text-rose-300/);
  });
});
