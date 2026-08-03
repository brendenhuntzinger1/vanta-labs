import { describe, expect, it } from "vitest";
import { isMembershipActive } from "@/lib/membership-status";

// Regression suite for the false-activation defect: a FAILED first payment was
// creating a full membership record (tier, start date, renews-at, next-billing)
// with status "past_due", so the account displayed as a paid member that had
// never paid. These lock the status contract that every benefit gate depends on.

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

describe("membership activation contract", () => {
  describe("only a confirmed payment grants benefits", () => {
    it("active + unexpired period is the ONLY paid-benefit state", () => {
      expect(isMembershipActive({ status: "active", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(true);
    });

    it("past_due grants nothing — a failed renewal is not a member in good standing", () => {
      expect(isMembershipActive({ status: "past_due", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
    });

    it("pending grants nothing — payment started but never confirmed", () => {
      expect(isMembershipActive({ status: "pending", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
    });

    it("none grants nothing", () => {
      expect(isMembershipActive({ status: "none", nextBillingAt: null, renewsAt: null })).toBe(false);
    });

    it("cancelled and expired grant nothing", () => {
      expect(isMembershipActive({ status: "cancelled", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
      expect(isMembershipActive({ status: "expired", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
    });

    it("paused grants nothing", () => {
      expect(isMembershipActive({ status: "paused", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
    });

    it("an unknown/garbage status is treated as inactive, never as a member", () => {
      expect(isMembershipActive({ status: "", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
      expect(isMembershipActive({ status: "definitely-not-a-status", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(false);
    });
  });

  describe("a paid term cannot outlive what was paid for", () => {
    it("an active row whose period ended long ago is inactive even if the sweep never ran", () => {
      expect(isMembershipActive({ status: "active", nextBillingAt: PAST, renewsAt: PAST })).toBe(false);
    });

    it("cancel-at-period-end keeps benefits until the paid-through date", () => {
      // cancel_at_period_end is a flag, not a status — the row stays "active"
      // until the date passes, which is exactly the intended behaviour.
      expect(isMembershipActive({ status: "active", nextBillingAt: FUTURE, renewsAt: FUTURE })).toBe(true);
    });

    it("a membership with no dates at all (comp) stays active on status alone", () => {
      expect(isMembershipActive({ status: "active", nextBillingAt: null, renewsAt: null })).toBe(true);
    });
  });

  describe("grace window", () => {
    it("a member one day past renewal keeps benefits while the sweep catches up", () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      expect(isMembershipActive({ status: "active", nextBillingAt: yesterday, renewsAt: yesterday })).toBe(true);
    });

    it("but the grace window does not extend indefinitely", () => {
      const longGone = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      expect(isMembershipActive({ status: "active", nextBillingAt: longGone, renewsAt: longGone })).toBe(false);
    });
  });
});
