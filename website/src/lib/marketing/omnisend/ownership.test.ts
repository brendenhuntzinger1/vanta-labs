import { afterEach, describe, expect, it } from "vitest";

import { MARKETING_OWNED_BY_OMNISEND, marketingSendBlockedByOmnisend } from "@/lib/marketing/omnisend/ownership";

/**
 * THE CUTOVER SWITCH, AS THE SENDERS SEE IT (spec §3.1).
 *
 * The in-house engine and Omnisend must never mail the same inbox on the same
 * day, and the 24-hour frequency guard cannot see Omnisend's sends, so the
 * answer is one owner rather than coordination. Every in-house marketing
 * sender asks this one function and stands down on a non-null answer; the
 * answer IS the reason that gets logged, so the cron response and the admin
 * refusal say the same thing.
 */
const env = (value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { OMNISEND_MARKETING_OWNER: value }) as NodeJS.ProcessEnv;

describe("marketingSendBlockedByOmnisend", () => {
  it.each(["true", "1", "yes", "TRUE", " Yes "])("returns the logged reason when the switch is %j", (value) => {
    expect(marketingSendBlockedByOmnisend(env(value))).toBe(MARKETING_OWNED_BY_OMNISEND);
  });

  it.each([undefined, "", "false", "0", "no", "off", "omnisend", "tru"])(
    "returns null when the switch is %j, so a typo cannot double-mail anyone",
    (value) => {
      expect(marketingSendBlockedByOmnisend(env(value))).toBeNull();
    },
  );

  it("names the reason the spec names, verbatim", () => {
    expect(MARKETING_OWNED_BY_OMNISEND).toBe("marketing owned by omnisend");
  });

  describe("reads process.env when given nothing", () => {
    const before = process.env.OMNISEND_MARKETING_OWNER;
    afterEach(() => {
      if (before === undefined) delete process.env.OMNISEND_MARKETING_OWNER;
      else process.env.OMNISEND_MARKETING_OWNER = before;
    });

    it("is blocked when the switch is set in the environment", () => {
      process.env.OMNISEND_MARKETING_OWNER = "true";
      expect(marketingSendBlockedByOmnisend()).toBe(MARKETING_OWNED_BY_OMNISEND);
    });

    it("is open when the switch is absent from the environment", () => {
      delete process.env.OMNISEND_MARKETING_OWNER;
      expect(marketingSendBlockedByOmnisend()).toBeNull();
    });
  });
});
