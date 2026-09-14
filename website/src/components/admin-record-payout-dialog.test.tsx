import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminRecordPayoutDialog, type RecordPayoutTarget } from "@/components/admin-record-payout-dialog";

// ---------------------------------------------------------------------------
// ONE DIALOG INSTEAD OF THREE POP-UPS.
//
// Marking an ambassador paid used to be window.confirm (threshold), then
// window.confirm ("have you ALREADY sent it?"), then window.prompt (reference),
// on a button at the far right of a ten-column table — and the button was
// disabled for the one case the owner actually had, a commission still inside
// its hold period. The dialog puts everything the owner needs to pay someone
// on one card: where they asked to be paid, what is ready, what is still held,
// and how the money went.
// ---------------------------------------------------------------------------

const flavia: RecordPayoutTarget = {
  id: "af0b3dd9-0000-4000-8000-000000000001",
  name: "Flavia Rossetti",
  referralCode: "FLAVIA",
  status: "approved",
  payoutMethod: "cashapp",
  payoutHandle: "$flavia",
  readyAmount: 0,
  heldAmount: 31.5,
};

function render(target: RecordPayoutTarget, overrides: Partial<{ minimumPayoutThreshold: number; commissionHoldDays: number }> = {}) {
  return renderToStaticMarkup(
    <AdminRecordPayoutDialog
      target={target}
      minimumPayoutThreshold={overrides.minimumPayoutThreshold ?? 100}
      commissionHoldDays={overrides.commissionHoldDays ?? 30}
      onClose={() => {}}
      onRecorded={() => {}}
    />,
  );
}

describe("the dialog says where to send the money", () => {
  it("shows the ambassador's requested method and handle", () => {
    const html = render(flavia);
    expect(html).toContain("Cash App · $flavia");
  });

  it("says so plainly when nothing is on file, rather than showing a blank", () => {
    const html = render({ ...flavia, payoutMethod: null, payoutHandle: null });
    expect(html).toMatch(/no payout method on file/i);
  });
});

describe("the held balance is a visible, explicit choice", () => {
  it("offers the held amount with the hold length, ticked by default when nothing else is payable", () => {
    // Flavia's case: $0 cleared, $31.50 in the hold, and the owner has
    // already sent it. The only useful default is to include it.
    const html = render(flavia);
    expect(html).toContain("$31.50");
    expect(html).toMatch(/30-day hold/);
    expect(html).toMatch(/name="includeHeld"[^>]*checked/);
  });

  it("leaves the held amount unticked when a cleared balance exists", () => {
    const html = render({ ...flavia, readyAmount: 60 });
    expect(html).toContain("$60.00");
    expect(html).toMatch(/name="includeHeld"/);
    expect(html).not.toMatch(/name="includeHeld"[^>]*checked/);
  });

  it("does not mention a hold when there is nothing in it", () => {
    const html = render({ ...flavia, readyAmount: 60, heldAmount: 0 });
    expect(html).not.toMatch(/name="includeHeld"/);
  });
});

describe("how the money went", () => {
  it("lets the owner record Zelle even though ambassadors cannot request it", () => {
    const html = render(flavia);
    expect(html).toMatch(/<option[^>]*value="zelle"[^>]*>Zelle<\/option>/);
  });

  it("defaults the channel to what the ambassador asked for", () => {
    const html = render(flavia);
    expect(html).toMatch(/<option[^>]*value="cashapp"[^>]*selected/);
  });
});

describe("guards the server also enforces are visible before the click", () => {
  it("warns when the total is below the minimum payout", () => {
    const html = render(flavia, { minimumPayoutThreshold: 100 });
    expect(html).toMatch(/below the \$100\.00 minimum/i);
  });

  it("explains, and blocks, when the ambassador is not approved", () => {
    // Andrew's case: money in the hold, application still in info_requested.
    const html = render({ ...flavia, name: "Andrew Hughes", status: "info_requested" });
    expect(html).toMatch(/info requested/i);
    expect(html).toMatch(/approve/i);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it("will not submit until the owner confirms the money has actually been sent", () => {
    const html = render({ ...flavia, readyAmount: 120, heldAmount: 0 });
    expect(html).toMatch(/name="confirmedTransferred"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});

describe("the roster no longer routes this through browser pop-ups", () => {
  const roster = readFileSync(join(process.cwd(), "src/components/admin-partners-client.tsx"), "utf8");

  it("has no confirm/prompt chain for marking paid", () => {
    expect(roster).not.toContain("Have you ALREADY sent");
    expect(roster).not.toContain("transfer/transaction reference");
  });

  it("opens the dialog instead", () => {
    expect(roster).toContain("AdminRecordPayoutDialog");
  });

  it("shows where each ambassador asked to be paid, next to the action", () => {
    expect(roster).toContain("describePayoutDestination");
  });
});
