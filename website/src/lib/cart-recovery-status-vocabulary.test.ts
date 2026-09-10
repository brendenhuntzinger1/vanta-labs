import { describe, expect, it, vi } from "vitest";
import {
  CART_STATUSES,
  CART_STATUS_OPEN,
  CART_STATUS_TERMINAL,
  isOpenCartStatus,
} from "@/lib/cart-recovery";

// ---------------------------------------------------------------------------
// A STATUS THE SWEEP DOES NOT RECOGNISE MUST NOT SILENTLY END A SEQUENCE.
//
// Production, 2026-09-10: four carts sat at status='held' — 'magajisani' at
// $950.07 having received one of its four stages, and three more behind it,
// $1,980.90 in total at a $495 average against a $185 norm. Nothing in the
// repository wrote that status and nothing cleared it; the sweep selected
// `.eq("status", "active")` and markAbandonedCartsRecovered filtered the same
// way. So those carts could receive no further stage AND could never be
// recorded as recovered if the shopper came back. They were invisible in both
// directions, and nothing alerted.
//
// The defect is not the word "held". It is that the sweep's selection was an
// ALLOWLIST OF ONE, so any status outside it removed a cart from the programme
// with no alert and no way back. A vocabulary stated once, with the sweep
// selecting NON-TERMINAL rather than EQUAL-TO-ACTIVE, makes the whole class
// impossible: a new status is either terminal by intent or it keeps sending.
//
// These are pure assertions over the vocabulary itself, which is what the two
// query sites now derive their filters from.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/cart-recovery");

describe("the cart status vocabulary", () => {
  it("treats 'held' as open, so a held cart still receives its remaining stages", () => {
    expect(isOpenCartStatus("held")).toBe(true);
    expect(CART_STATUS_OPEN).toContain("held");
  });

  it("keeps 'active' open", () => {
    expect(isOpenCartStatus("active")).toBe(true);
  });

  it.each(["recovered", "cleared", "expired"])(
    "treats '%s' as terminal, so a closed cart is never mailed again",
    (status) => {
      expect(isOpenCartStatus(status)).toBe(false);
      expect(CART_STATUS_TERMINAL).toContain(status);
    },
  );

  it("never lets a status be both open and terminal", () => {
    for (const status of CART_STATUS_OPEN) {
      expect(CART_STATUS_TERMINAL).not.toContain(status);
    }
  });

  it("covers every status the vocabulary knows, so the two sets partition it", () => {
    expect([...CART_STATUSES].sort()).toEqual(
      [...CART_STATUS_OPEN, ...CART_STATUS_TERMINAL].sort(),
    );
  });

  // THE REGRESSION ITSELF. An unknown status must not read as open — that
  // would swap a silent stall for silent mailing, which is worse. It must be
  // recognised as unknown so the constraint and the stalled-cart watch can
  // report it, which is what the sweep's alert now does.
  it("does not treat an unknown status as open", () => {
    expect(isOpenCartStatus("parked")).toBe(false);
    expect(isOpenCartStatus("")).toBe(false);
    expect(CART_STATUSES).not.toContain("parked");
  });
});
