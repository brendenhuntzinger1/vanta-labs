import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// SUPPRESSION IS UNIVERSAL ONLY FOR AS LONG AS EVERY MARKETING SENDER GOES
// THROUGH ONE DOOR.
//
// `sendMarketingEmail` (lib/email/marketing.ts) is where a promotional message
// meets everything that makes it lawful and safe to send:
//
//   * the suppression list — unsubscribes, complaints and hard bounces — read
//     with a FAIL-CLOSED guard, so an unreadable table refuses the send rather
//     than assuming consent
//   * the sink/non-mailable address guard
//   * the signed unsubscribe link and the List-Unsubscribe headers
//   * the CAN-SPAM postal address
//   * the frequency guard, which is what stops two automations landing on the
//     same person in the same hour
//
// A sender that calls `sendEmail()` directly gets NONE of that. It is not a
// subtle failure: an unsubscribed customer receives marketing, which is the one
// outcome the whole system exists to prevent, and it happens silently because
// nothing anywhere throws.
//
// Today every promotional path does go through the wrapper — verified by
// reading all 25 direct callers of sendEmail(). This test is what keeps that
// true. It is the same shape as own-boundary-auth.test.ts, and for the same
// reason: the mistake it catches is not "somebody wrote bad code", it is
// "somebody added a sender next month and did not know this rule existed".
//
// It is a tripwire, not a proof. It asserts that a file is either a known
// transactional sender or does not call sendEmail() at all. It cannot tell
// whether a message is promotional in content — that judgement is what the
// allowlist below records, one file at a time, with a reason.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");

/**
 * Files permitted to call `sendEmail()` directly.
 *
 * The bar is the CAN-SPAM transactional carve-out: a message sent because of
 * something this specific recipient did, whose primary purpose is to complete,
 * confirm or service that action. Receipts, auth, shipping, billing and
 * operator alerts qualify. "It is only a small promotion" does not.
 *
 * Adding a line here is a deliberate act. If the message would read as
 * marketing to the person receiving it, route it through sendMarketingEmail()
 * instead — that is not extra work, it is where the unsubscribe link and the
 * postal address come from.
 */
const TRANSACTIONAL_SENDERS = new Map<string, string>([
  // ---- The wrapper itself, and the plumbing underneath it ----
  ["lib/email/marketing.ts", "IS the marketing wrapper: it calls sendEmail() after applying every gate"],
  ["lib/email/send.ts", "the provider-facing send primitive"],
  ["lib/email/retry-queue.ts", "re-delivers messages that already passed their sender's gates"],
  ["app/api/admin/settings/route.ts", "operator test send from Admin \u2192 Settings, to an address the operator types"],
  ["lib/email/order-email-once.ts", "order confirmation / status mail, keyed by order id for exactly-once delivery"],

  // ---- Authentication. Never suppressible: a password reset must arrive. ----
  ["app/api/auth/signup/route.ts", "signup confirmation link"],
  ["app/api/auth/password-reset/route.ts", "password reset link, which must never be suppressible"],
  ["app/api/account/email-change/route.ts", "confirms a change of account address"],
  ["lib/auth-confirmation-email.ts", "the branded confirmation mail itself"],

  // ---- Orders, payment and fulfilment. Service mail about a purchase. ----
  ["app/api/checkout/submit-payment/route.ts", "order confirmation at the moment of purchase"],
  ["app/api/admin/orders/[orderId]/route.ts", "operator-initiated order correspondence"],
  ["app/api/admin/payments/[orderId]/route.ts", "payment status correspondence for a specific order"],
  ["lib/admin-orders.ts", "order status mail driven by an admin action"],
  ["lib/payment-webhook.ts", "settlement, refund and failure notices for a specific order"],
  ["lib/shippo/service.ts", "shipment and delivery notifications"],

  // ---- Billing. A charge notice is transactional; the membership MARKETING
  //      in the same module correctly uses sendMarketingEmail. ----
  ["lib/membership-billing.ts", "renewal receipts and billing failure notices"],

  // ---- Inbound forms: these mail the OPERATOR, not the submitter. ----
  ["app/api/contact/route.ts", "delivers a contact form submission to the store"],
  ["app/api/wholesale/route.ts", "delivers a wholesale enquiry to the store"],

  // ---- Operator alerting. ----
  ["lib/monitoring.ts", "system alerts to the operator"],

  // ---- Affiliate/partner transactional: approval, commission, payout. Out of
  //      scope of the subscriber system and deliberately left alone. ----
  ["lib/partner-portal.ts", "partner approval, commission and payout notices"],

  // ---- Campaign test send. Calls sendEmail() so a test is not logged as a
  //      real send, but checks isMarketingSuppressed() first and refuses a
  //      suppressed address — see the comment in that route. ----
  [
    "app/api/admin/email/campaigns/[campaignId]/send/route.ts",
    "operator test send; explicitly calls isMarketingSuppressed() and refuses a suppressed address",
  ],
]);

/** Every .ts file under src/, excluding tests and type-only modules. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(join(dir, entry.name), rel));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    out.push(rel);
  }
  return out;
}

/** Strip comments, so prose describing the rule is not mistaken for a call. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

const CALLS_SEND_EMAIL = /\bsendEmail\s*\(/;

const callers = ["lib", "app"]
  .flatMap((root) => sourceFiles(root, root))
  .filter((rel) => CALLS_SEND_EMAIL.test(code(readFileSync(join(SRC, rel), "utf8"))));

describe("every promotional send goes through the marketing wrapper", () => {
  it("finds the senders at all, so a broken scan cannot pass silently", () => {
    // If this ever collapses to a handful, the walk is broken rather than the
    // codebase suddenly virtuous.
    expect(callers.length).toBeGreaterThan(15);
  });

  it.each(callers)("%s is a known transactional sender", (rel) => {
    expect(
      TRANSACTIONAL_SENDERS.has(rel),
      `${rel} calls sendEmail() directly and is not on the transactional allowlist.\n\n`
        + "If it sends MARKETING, route it through sendMarketingEmail() — that is where suppression,\n"
        + "the unsubscribe link, the List-Unsubscribe headers, the CAN-SPAM postal address and the\n"
        + "frequency guard come from. A direct sendEmail() gets none of them, and an unsubscribed\n"
        + "customer will receive it.\n\n"
        + "If it is genuinely transactional, add it to TRANSACTIONAL_SENDERS with the reason.",
    ).toBe(true);
  });

  it("keeps the allowlist honest: no entry for a file that no longer sends", () => {
    // A stale entry is how an allowlist quietly grows into a rubber stamp.
    const stale = [...TRANSACTIONAL_SENDERS.keys()].filter((rel) => !callers.includes(rel));
    expect(stale, `allowlisted files that no longer call sendEmail(): ${stale.join(", ")}`).toEqual([]);
  });

  it("records a real reason against every entry", () => {
    for (const [rel, reason] of TRANSACTIONAL_SENDERS) {
      expect(reason.length, `${rel} has no reason recorded`).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// AND THE GATES THEMSELVES ARE STILL IN THE WRAPPER.
//
// The tripwire above proves everything routes through one door. These prove the
// door is still locked — a wrapper that stopped reading the suppression list
// would satisfy every assertion above.
// ---------------------------------------------------------------------------
describe("the wrapper still applies each gate", () => {
  const wrapper = code(readFileSync(join(SRC, "lib/email/marketing.ts"), "utf8"));
  const handler = wrapper.slice(wrapper.indexOf("export async function sendMarketingEmail"));

  it("reads the suppression list before sending", () => {
    const suppressionAt = handler.indexOf('from("email_suppressions")');
    const sendAt = handler.indexOf("await sendEmail(");
    expect(suppressionAt, "the wrapper no longer reads email_suppressions").toBeGreaterThan(-1);
    expect(sendAt, "the wrapper no longer sends").toBeGreaterThan(-1);
    expect(suppressionAt, "suppression is checked AFTER the send").toBeLessThan(sendAt);
  });

  it("fails closed when the suppression list cannot be read", () => {
    // The dangerous version of this bug is not "it throws" — it is a read error
    // being indistinguishable from "not suppressed".
    expect(handler).toContain("suppressionError");
    expect(handler).toMatch(/if \(suppressionError\)/);
  });

  it("refuses provider sink addresses at the choke point", () => {
    expect(handler).toContain("isNonMailableAddress");
  });

  it("attaches the one-click unsubscribe headers", () => {
    expect(handler).toContain('"List-Unsubscribe"');
    expect(handler).toContain('"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"');
  });

  it("attaches the CAN-SPAM postal address", () => {
    expect(handler).toContain("marketingPostalAddress");
  });

  it("sends from the marketing identity with a replyable Reply-To", () => {
    // FROM a send-only subdomain, REPLY-TO a mailbox that receives: a sending
    // domain is not a mailbox, and the List-Unsubscribe mailto has to reach one.
    expect(handler).toContain("resolveMarketingFrom");
    expect(handler).toContain("resolveMarketingReplyTo");
  });

  it("carries a plain-text part alongside the HTML", () => {
    // A HTML-only bulk message is a well-known spam signal, and the text part
    // is where the unsubscribe URL is readable to a client that blocks HTML.
    expect(handler).toContain("text:");
    expect(handler).toContain("Unsubscribe: ${unsubscribeUrl}");
  });
});
