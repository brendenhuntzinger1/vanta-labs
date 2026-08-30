import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUSTOMER_CHOSEN_SUPPRESSION_REASONS,
  PROVIDER_IMPOSED_SUPPRESSION_REASONS,
  isCustomerReversibleSuppression,
} from "@/lib/email/suppression-reasons";

// ---------------------------------------------------------------------------
// SAVING PREFERENCES PUT SPAM COMPLAINERS BACK ON THE LIST.
//
// POST /api/account/preferences mirrored the marketing toggle into
// email_suppressions, and on re-opt-in it ran an unconditional
//
//     .from("email_suppressions").delete().eq("email", email)
//
// with no filter on `reason`. But the delivery webhook writes rows into that
// same table with reason "complained" and "bounced" — the mailbox provider's
// verdict, not a preference. So the delete resurrected addresses that had
// pressed "report spam" or hard-bounced.
//
// And it did not need the customer to intend anything: a provider suppression
// never mirrored into customer_preferences, so the Notifications tab rendered
// "Product news and promotions" ALREADY TICKED for exactly those people, and
// any save of that panel POSTed marketingEmails: true.
//
// Mailing complainers is the fastest way there is to wreck a sending domain's
// reputation — and a wrecked reputation is what got a DELIVERED confirmation
// email filed as spam, with its links stripped, on 2026-08-29. Receipts,
// password resets and confirmations all ride on that same domain.
// ---------------------------------------------------------------------------

describe("who may lift a suppression", () => {
  it("lets a customer undo their own choices", () => {
    for (const reason of CUSTOMER_CHOSEN_SUPPRESSION_REASONS) {
      expect(isCustomerReversibleSuppression(reason), reason).toBe(true);
    }
  });

  it("never lets a preference save undo a provider's verdict", () => {
    for (const reason of PROVIDER_IMPOSED_SUPPRESSION_REASONS) {
      expect(isCustomerReversibleSuppression(reason), reason).toBe(false);
    }
  });

  it("treats an unknown reason as provider-imposed", () => {
    // The safe direction. A reason nobody recognises is not evidence the
    // customer chose it, and the costs are asymmetric: staying off a marketing
    // list is an annoyance support can fix, while mailing a complainer costs
    // the domain that carries every receipt.
    expect(isCustomerReversibleSuppression("something_new")).toBe(false);
    expect(isCustomerReversibleSuppression(null)).toBe(false);
    expect(isCustomerReversibleSuppression(undefined)).toBe(false);
    expect(isCustomerReversibleSuppression("")).toBe(false);
  });

  it("covers exactly the reasons anything actually writes", () => {
    // A reason written somewhere and classified nowhere falls into the
    // provider-imposed default and silently becomes unliftable — safe, but the
    // customer can no longer undo their own unsubscribe. This is the check that
    // catches a new reason being added without a decision about it.
    const written = new Set<string>();
    for (const path of [
      "src/app/api/account/preferences/route.ts",
      "src/app/api/unsubscribe/route.ts",
      "src/lib/email/delivery-events.ts",
    ]) {
      const src = stripComments(readFileSync(join(process.cwd(), path), "utf8"));
      // A literal `reason: "x"`, and the one place the value is chosen by a
      // ternary that is then assigned to `reason`.
      for (const match of src.matchAll(/reason:\s*"([a-z_]+)"/g)) written.add(match[1]);
      for (const match of src.matchAll(/const reason = [^;]*?"([a-z_]+)"\s*:\s*"([a-z_]+)"/g)) {
        written.add(match[1]);
        written.add(match[2]);
      }
    }

    const classified = new Set<string>([
      ...CUSTOMER_CHOSEN_SUPPRESSION_REASONS,
      ...PROVIDER_IMPOSED_SUPPRESSION_REASONS,
    ]);
    for (const reason of written) {
      expect(classified.has(reason), `"${reason}" is written but not classified`).toBe(true);
    }
    expect(written.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// The wiring. A behavioural test would need Supabase and the provider webhook;
// what regresses is which rows the delete is allowed to touch.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Strip comments, so prose about a rejected pattern cannot satisfy a check. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}
const PREFERENCES = read("src/app/api/account/preferences/route.ts");
const DELIVERY = read("src/lib/email/delivery-events.ts");

describe("re-opting in", () => {
  it("scopes the delete to customer-chosen reasons", () => {
    expect(PREFERENCES).toContain(".in(\"reason\", [...CUSTOMER_CHOSEN_SUPPRESSION_REASONS])");
  });

  it("no longer deletes every suppression for the address", () => {
    // The exact statement that caused it.
    expect(PREFERENCES).not.toContain('from("email_suppressions").delete().eq("email", email);');
  });
});

describe("a provider verdict", () => {
  it("mirrors into the preference, so the checkbox stops lying", () => {
    // Otherwise the Notifications tab renders "Product news and promotions"
    // ticked for a complainer and invites them to press Save.
    const fn = DELIVERY.slice(DELIVERY.indexOf("export async function applyDeliveryEvents("));
    expect(fn).toContain("customer_preferences");
    expect(fn).toContain("marketing_emails: false");
  });

  it("still lets the suppression itself be what gates the send", () => {
    // The mirror is a display fix. email_suppressions remains authoritative,
    // so a failed mirror must not stop the suppression being written.
    const fn = stripComments(DELIVERY).slice(
      stripComments(DELIVERY).indexOf("export async function applyDeliveryEvents("),
    );
    const mirrorAt = fn.indexOf("customer_preferences");
    const suppressAt = fn.indexOf("email_suppressions");
    expect(suppressAt).toBeLessThan(mirrorAt);
    // Wrapped, so a failed mirror cannot undo the suppression already written.
    expect(fn.slice(mirrorAt - 300, mirrorAt)).toContain("try {");
  });
});
