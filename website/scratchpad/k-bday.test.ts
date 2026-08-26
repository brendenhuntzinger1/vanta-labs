import { describe, it, expect } from "vitest";

// membership.ts:606-608, transcribed verbatim.
function isBirthdayToday(nowIso: string, birthday: string): boolean {
  const today = new Date(nowIso);
  const birthdayDate = new Date(birthday);
  return today.getUTCMonth() === birthdayDate.getUTCMonth()
      && today.getUTCDate() === birthdayDate.getUTCDate();
}
const inZone = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

describe("birthday bonus day comparison (membership.ts:606-608)", () => {
  const birthday = "1990-05-14";
  it("is false for most of the member's actual birthday evening in the US", () => {
    const rows = [
      "2026-05-14T16:00:00Z",  // noon ET  — still their birthday
      "2026-05-15T00:30:00Z",  // 8:30 PM ET — still their birthday
      "2026-05-15T02:00:00Z",  // 10 PM ET / 7 PM PT — still their birthday in both zones
      "2026-05-15T06:30:00Z",  // 11:30 PM PT — still their birthday on the west coast
    ];
    for (const iso of rows) {
      const got = isBirthdayToday(iso, birthday);
      console.log(`  ${iso}  ET ${inZone(iso,"America/New_York").padEnd(24)} PT ${inZone(iso,"America/Los_Angeles").padEnd(24)} -> ${got}`);
    }
    expect(isBirthdayToday("2026-05-14T16:00:00Z", birthday)).toBe(true);
    expect(isBirthdayToday("2026-05-15T00:30:00Z", birthday)).toBe(false);   // 8:30 PM ET on their birthday
    expect(isBirthdayToday("2026-05-15T06:30:00Z", birthday)).toBe(false);   // 11:30 PM PT on their birthday
  });

  it("is TRUE the evening BEFORE, which then burns the once-a-year guard", () => {
    const early = "2026-05-14T02:00:00Z";   // 10 PM ET on May 13
    console.log(`  ${early}  ET ${inZone(early,"America/New_York")} -> ${isBirthdayToday(early, birthday)}`);
    expect(isBirthdayToday(early, birthday)).toBe(true);
    // membership.ts:613 currentYear = today.getUTCFullYear(); :620 returns false if already awarded this year
  });

  it("the eligible window in the member's own zone", () => {
    const startUtc = Date.parse("2026-05-14T00:00:00Z"), endUtc = Date.parse("2026-05-15T00:00:00Z");
    for (const [label, tz] of [["Eastern","America/New_York"],["Pacific","America/Los_Angeles"]] as const) {
      console.log(`  ${label.padEnd(8)} eligible from ${inZone(new Date(startUtc).toISOString(),tz)} to ${inZone(new Date(endUtc-1000).toISOString(),tz)}`);
    }
    expect(true).toBe(true);
  });
});
