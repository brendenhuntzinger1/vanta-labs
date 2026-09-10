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

  // THE COPY MOVED OUT OF THE BRANCH, and that is the point of the change these
  // assertions were rewritten for. The page used to hold ONE sentence, asserting
  // that a BANK declined the card and that the card was NOT CHARGED — neither of
  // which is knowable from payment_failed alone. That status is also written for
  // an abandoned verification, an expired session, a processor event carrying no
  // reason, and an order retired by hand; on this store sixteen of eighteen
  // failed orders had no processor event at all.
  //
  // So there are now two texts, chosen by what the server actually knows, and
  // the assertions below check each says what it is entitled to say.
  const messages = (() => {
    // The copy moved into the shared module both surfaces import, so the
    // payment page and the confirmation page cannot describe one event two ways.
    const shared = read("src/lib/checkout-poll-decision.ts");
    const start = shared.indexOf("export const DECLINE_MESSAGE");
    const block = shared.slice(start, shared.indexOf("};", start));
    const declined = (block.match(/declined:\s*\n?\s*"([\s\S]*?)",\n\s*unknown:/) ?? ["", ""])[1];
    const unknown = (block.match(/unknown:\s*\n?\s*"([\s\S]*?)",?\s*$/) ?? ["", ""])[1];
    // The sources concatenate with +, so strip the quoting between fragments.
    const clean = (t: string) => t.replace(/"\s*\+\s*"/g, "").replace(/\s+/g, " ").trim();
    return { declined: clean(declined), unknown: clean(unknown) };
  })();

  it("both texts say the payment did not complete", () => {
    expect(messages.declined).toMatch(/declined/i);
    expect(messages.unknown).toMatch(/didn't go through|did not go through/i);
  });

  it("claims the card was not charged ONLY when the processor said it declined", () => {
    // The single most valuable sentence on the page — and the one it was least
    // entitled to. Keep it where a bank genuinely refused, and nowhere else: a
    // stalled 3-D Secure step and an expired session both land on the same
    // status, and neither tells us whether an authorisation is outstanding.
    expect(messages.declined).toMatch(/not charged|not been charged/i);
    expect(messages.unknown).not.toMatch(/not charged|not been charged/i);
  });

  it("tells them what to do next, in both", () => {
    expect(messages.declined).toMatch(/try again|different card/i);
    expect(messages.unknown).toMatch(/try again|different card|contact us/i);
  });

  it("tells them to approve their bank's prompt first — the step that recovers the sale", () => {
    // Nowhere in the customer-facing product said this, and it is exactly how
    // David's decline became a paid order 71 seconds later.
    for (const text of [messages.declined, messages.unknown]) {
      expect(text).toMatch(/bank/i);
      expect(text).toMatch(/approve/i);
    }
  });

  it("never names the payment processor to the shopper", () => {
    // Same rule the iframe-load failure already follows: Vanta Labs is the only
    // brand a customer sees at the moment of payment.
    expect(messages.declined).not.toMatch(/veyra/i);
    expect(messages.unknown).not.toMatch(/veyra/i);
  });

  it("is a real sentence, not an empty match", () => {
    // Guards the extraction above: if the copy is refactored so the regexes stop
    // matching, every wording assertion would vacuously pass on "".
    expect(messages.declined.length).toBeGreaterThan(40);
    expect(messages.unknown.length).toBeGreaterThan(40);
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
    // The body is parsed once and passed to BOTH helpers now — the decision and
    // the failure kind — so this no longer expects the call to be inlined.
    expect(page).toMatch(/const body = await response\.json\(\)/);
    expect(page).toMatch(/decideFromOrderStatus\(body\)/);
    expect(page).toMatch(/failureKindFromStatus\(body\)/);
  });

  it("no longer reads `paid` directly in the poll", () => {
    // The exact shape of the original defect:
    //   const data = await response.json() as { paid?: boolean };
    //   if (data?.paid) goToConfirmation();
    expect(page).not.toMatch(/as \{ paid\?: boolean \}/);
  });
});
