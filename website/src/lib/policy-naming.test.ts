import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REQUIRED_CONFIRMATIONS } from "./checkout-confirmations";

// ---------------------------------------------------------------------------
// ONE POLICY, ONE NAME.
//
// The returns policy was called three different things at once: the page
// titled itself "Returns & Refunds", the footer said "Returns & Refunds", and
// the checkout acknowledgement said "Return & Reimbursement Policy". A shopper
// ticking a box that names a document, then landing on a page with a different
// name, has reasonable grounds to say they were shown something else.
//
// The canonical name is "Return & Reimbursement" because it is the honest one:
// Vanta RECORDS a reimbursement and sends it by hand. "Refund" implies the
// payment processor returns the money to the card, which is not what happens.
//
// This is about the NAME OF THE DOCUMENT only. The words "refund" and
// "refunded" remain correct everywhere they describe the mechanism — the
// payment_status column, a processor-initiated refund webhook, the refund
// amount on an order — and this file must never be extended to police those.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const CANONICAL = "Return & Reimbursement";
/** The names this document must no longer be given, anywhere a shopper reads. */
const RETIRED = ["Returns & Refunds", "Returns and Refunds", "Return & Refund Policy"];

const CUSTOMER_FACING = [
  "lib/legal-content.ts",
  "lib/checkout-confirmations.ts",
  "components/site-footer.tsx",
  "components/cart-drawer.tsx",
  "app/checkout/page.tsx",
  "app/account/(dashboard)/support/page.tsx",
];

describe("the returns policy has exactly one name", () => {
  it("the policy page titles itself with the canonical name", () => {
    const legal = read("lib/legal-content.ts");
    expect(legal).toContain(`title: "${CANONICAL} Policy"`);
  });

  it("the checkout acknowledgement names the same document", () => {
    const returns = REQUIRED_CONFIRMATIONS.find((i) => i.key === "returnsPolicy");
    expect(returns?.short).toContain(CANONICAL);
    expect(returns?.body).toContain(CANONICAL);
    expect(returns?.policyLabel).toContain(CANONICAL);
    // and points at the page that carries that title
    expect(returns?.policyHref).toBe("/legal/refund");
  });

  it("the footer link names the same document", () => {
    expect(read("components/site-footer.tsx")).toMatch(
      new RegExp(`label: "${CANONICAL}[^"]*", href: "/legal/refund"`),
    );
  });

  it("no customer-facing surface still uses a retired name", () => {
    for (const file of CUSTOMER_FACING) {
      const src = read(file);
      for (const retired of RETIRED) {
        expect(src, `${file} still calls the policy "${retired}"`).not.toContain(retired);
      }
    }
  });

  it("the rename did NOT touch the payment mechanism's vocabulary", () => {
    // Guard against over-correction. These are not the document's name; they
    // describe what actually happened to money, and renaming them would make
    // the system lie in the other direction.
    // Asserted as the ABSENCE of the over-correction, not the presence of one
    // surviving "non-refundable": a sabotage that renamed a single occurrence
    // left this green while another occurrence elsewhere satisfied it.
    for (const file of CUSTOMER_FACING) {
      expect(read(file), `${file} over-corrected the money vocabulary`).not.toMatch(
        /non-reimbursable|reimbursement_status|reimbursement_amount/,
      );
    }
    expect(read("lib/legal-content.ts")).toContain("non-refundable");
    // The processor-refund email still says refund, because a processor refund
    // is genuinely a refund.
    expect(read("lib/email/templates.ts")).toContain("refundConfirmationTemplate");
  });
});
