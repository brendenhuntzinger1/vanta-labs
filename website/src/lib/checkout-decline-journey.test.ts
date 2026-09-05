import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decideFromOrderStatus } from "@/lib/checkout-poll-decision";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAY_PAGE = "src/app/checkout/pay/[orderId]/VeyraCheckout.tsx";

// ---------------------------------------------------------------------------
// The decline journey, as a sequence rather than a single verdict.
//
// decideFromOrderStatus is pure, so a poll sequence is just a fold over its
// answers. That is the whole state machine the shopper experiences: the page
// polls, and each answer either settles it, fails it, or keeps it waiting.
//
// These pin the transitions that a real payment can produce out of order —
// networks retry, processors redeliver, and a 3DS retry inside one session can
// send failed before succeeded. None of those may leave the page contradicting
// the order.
// ---------------------------------------------------------------------------

/** The first non-wait answer, and how many polls it took to get there. */
function runPoll(sequence: unknown[]): { decision: string; pollsConsumed: number } {
  for (let i = 0; i < sequence.length; i += 1) {
    const decision = decideFromOrderStatus(sequence[i]);
    if (decision !== "wait") return { decision, pollsConsumed: i + 1 };
  }
  return { decision: "wait", pollsConsumed: sequence.length };
}

/**
 * The page's actual watch. A decline is announced once (declineShownRef) and
 * never repainted or withdrawn; the poll keeps running, and a settled answer
 * navigates (settledRef) whether or not a decline was shown first.
 */
function watch(sequence: unknown[]): { declineShown: boolean; settledAt: number | null } {
  let declineShown = false;
  for (let i = 0; i < sequence.length; i += 1) {
    const decision = decideFromOrderStatus(sequence[i]);
    if (decision === "settled") return { declineShown, settledAt: i + 1 };
    if (decision === "failed") declineShown = true;
  }
  return { declineShown, settledAt: null };
}

const PENDING = { paid: false, pending: true, status: "pending_payment" };
const DECLINED = { paid: false, pending: false, status: "payment_failed" };
const CANCELED = { paid: false, pending: false, status: "canceled" };
const PAID = { paid: true, pending: false, status: "paid" };
const DROPPED = null; // a request that failed mid-payment on mobile data

describe("the ordinary journeys", () => {
  it("waits through pending polls, then settles when payment lands", () => {
    const { decision, pollsConsumed } = runPoll([PENDING, PENDING, PENDING, PAID]);
    expect(decision).toBe("settled");
    expect(pollsConsumed).toBe(4);
  });

  it("waits through pending polls, then reports failure when the card is declined", () => {
    const { decision, pollsConsumed } = runPoll([PENDING, PENDING, DECLINED]);
    expect(decision).toBe("failed");
    // The defect this replaces would have returned "wait" here, for ever.
    expect(pollsConsumed).toBe(3);
  });

  it("reports failure on a cancelled session too", () => {
    expect(runPoll([PENDING, CANCELED]).decision).toBe("failed");
  });
});

describe("a settled page never contradicts itself", () => {
  it("a success already seen is not undone by a later decline", () => {
    // The page sets settledRef on the first non-wait answer and navigates away,
    // so a later event cannot repaint it. Modelled here as: the fold stops at
    // the success and never reads the decline.
    const { decision, pollsConsumed } = runPoll([PAID, DECLINED, DECLINED]);
    expect(decision).toBe("settled");
    expect(pollsConsumed).toBe(1);
  });

  it("a decline already shown stays shown, but a later success still settles the page", () => {
    // Server-side the late success DOES promote the order to paid, and that is
    // the truth the page has to end on. The DECLINE is one-way: later "failed"
    // answers neither repaint nor withdraw it. The WATCH is not: it keeps
    // asking, and a "settled" answer takes the shopper to their receipt.
    //
    // This used to stop at the decline for good. The order is already
    // payment_failed the moment the shopper reloads as the message tells them
    // to, so the reloaded page painted the banner at once, stopped watching,
    // and a successful retry in the freshly mounted form flipped the order to
    // paid while the page went on insisting the card had not been charged.
    expect(runPoll([DECLINED, PAID]).decision).toBe("failed");
    expect(watch([DECLINED, DECLINED, PAID])).toEqual({ declineShown: true, settledAt: 3 });
  });

  it("a reload after a decline sees the old decline first and still lands on the receipt", () => {
    // First poll on the reloaded page: the pre-existing payment_failed. Then
    // the retry lands.
    expect(watch([DECLINED, PENDING, PAID])).toEqual({ declineShown: true, settledAt: 3 });
  });

  it("a decline with no retry stays a decline", () => {
    expect(watch([PENDING, DECLINED, DECLINED, DROPPED])).toEqual({ declineShown: true, settledAt: null });
  });
});

describe("a dropped request is never mistaken for a decline", () => {
  it("keeps waiting through dropped polls and still settles", () => {
    expect(runPoll([DROPPED, DROPPED, PENDING, DROPPED, PAID]).decision).toBe("settled");
  });

  it("keeps waiting through dropped polls and still reports a real decline", () => {
    expect(runPoll([DROPPED, PENDING, DROPPED, DECLINED]).decision).toBe("failed");
  });

  it("never reports failure from transport noise alone", () => {
    // Every shape a broken response can take, none of which is evidence the
    // bank refused the card.
    for (const noise of [null, undefined, {}, "", "nonsense", [], { status: "payment_failed" }]) {
      expect(decideFromOrderStatus(noise)).toBe("wait");
    }
  });
});

describe("only the server's own verdict is terminal", () => {
  it("a status string alone never fails the page without pending:false", () => {
    // status is descriptive; pending is the computed verdict. Reading the
    // string instead would fail a page on any status we do not recognise.
    expect(decideFromOrderStatus({ status: "payment_failed" })).toBe("wait");
    expect(decideFromOrderStatus({ paid: false, status: "canceled" })).toBe("wait");
  });

  it("truthy-but-not-true values never settle or fail", () => {
    // A legal consent record and a money state both deserve strict equality.
    expect(decideFromOrderStatus({ paid: 1 })).toBe("wait");
    expect(decideFromOrderStatus({ paid: "true" })).toBe("wait");
    expect(decideFromOrderStatus({ pending: 0 })).toBe("wait");
    expect(decideFromOrderStatus({ pending: "false" })).toBe("wait");
  });
});

// ---------------------------------------------------------------------------
// What the shopper is actually told. The wording is the deliverable here — a
// page that stops polling but says nothing useful is the same dead end with a
// shorter spinner.
// ---------------------------------------------------------------------------
describe("the decline message tells the shopper the three things they need", () => {
  const page = read(PAY_PAGE);
  // The failed branch, bounded at its closing brace rather than by a byte
  // count: a fixed window runs into surrounding code, and this file is called
  // VeyraCheckout, so a "never names the processor" check on a loose window
  // fails on the component's own identifiers instead of on the copy.
  const branchStart = page.indexOf('decision === "failed"');
  const declineBranch = page.slice(branchStart, page.indexOf("\n      }", branchStart));
  // The shopper-visible sentence alone, for the wording assertions.
  const declineCopy = (declineBranch.match(/setMessage\(\s*"([^"]+)"/) ?? ["", ""])[1];

  it("says the payment did not go through", () => {
    expect(declineCopy).toMatch(/did not go through/i);
  });

  it("says explicitly that the card was NOT charged", () => {
    // The single most valuable sentence on the page. A shopper who retries
    // without it believes they may now be charged twice.
    expect(declineCopy).toMatch(/not been charged/i);
  });

  it("tells them what to do next", () => {
    expect(declineCopy).toMatch(/refresh|try again|different card/i);
  });

  it("never names the payment processor to the shopper", () => {
    // Same rule the iframe-load failure already follows: Vanta Labs is the only
    // brand a customer sees at the moment of payment.
    expect(declineCopy).not.toMatch(/veyra/i);
  });

  it("is a real sentence, not an empty match", () => {
    // Guards the extraction above: if the branch is refactored so the regex
    // stops matching, every wording assertion would vacuously pass on "".
    expect(declineCopy.length).toBeGreaterThan(40);
  });

  it("announces the decline once and keeps watching for settlement", () => {
    // The announcement is latched on its own ref. Latching the NAVIGATION ref
    // here is the defect: it silenced the poll, so an order that was later
    // paid never took the shopper to the receipt.
    expect(declineBranch).toMatch(/declineShownRef\.current = true/);
    expect(declineBranch).not.toMatch(/settledRef\.current = true/);
  });
});

describe("the poll consumes the decision helper rather than re-reading fields", () => {
  const page = read(PAY_PAGE);

  it("routes the response through decideFromOrderStatus", () => {
    expect(page).toMatch(/decideFromOrderStatus\(await response\.json\(\)\)/);
  });

  it("no longer reads `paid` directly in the poll", () => {
    // The exact shape of the original defect:
    //   const data = await response.json() as { paid?: boolean };
    //   if (data?.paid) goToConfirmation();
    expect(page).not.toMatch(/as \{ paid\?: boolean \}/);
  });
});
