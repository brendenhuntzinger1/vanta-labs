import { DISPLAY_TIME_ZONE } from "@/lib/format-date";

/**
 * Day, week, month and year boundaries cut in the store's own zone.
 *
 * WHY THIS EXISTS: every admin "today / this month" figure was cut at midnight
 * UTC, which is 8pm ET (9pm in winter). From 8pm onward, every evening, "today"
 * had already rolled into tomorrow — so an order paid at 5:20pm ET showed up in
 * SALES THIS MONTH and not in SALES TODAY, on the same screen, at the same
 * moment. The same 4-5 hour hole sits at the start of every month and year.
 *
 * The tiles were not wrong about the data; they were answering a different
 * question than the one an operator reads. format-date.ts already settled that
 * America/New_York is this business's zone and renders every displayed
 * timestamp in it, so a window cut in UTC disagreed with the dates printed
 * beside it.
 *
 * admin-analytics.ts used to carry the opposite instruction — pin every window
 * to UTC "so two tiles on one dashboard cannot disagree". The reason was right
 * and the zone was wrong: one definition, in the zone the store actually
 * operates in, is what makes those tiles agree with each other AND with the
 * timestamps under them.
 *
 * Every function here takes an instant and returns an instant, so callers keep
 * comparing UTC to UTC. Only the CUT moves.
 */
export const BUSINESS_TIME_ZONE = DISPLAY_TIME_ZONE;

const CIVIL = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** What the wall clock in the business zone reads at `instant`. */
function civil(instant: Date): Civil {
  const parts: Record<string, string> = {};
  for (const part of CIVIL.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some ICU builds render midnight as hour 24 under hour12:false. It is the
    // same instant as 00:00, but Date.UTC would read it as the next day.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The business zone's offset from UTC at `instant`, in ms. */
function offsetMs(instant: Date): number {
  const c = civil(instant);
  const wallClockAsUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  // Whole seconds on both sides: formatToParts has no millisecond field, so
  // comparing against a millisecond-precision instant would skew the offset.
  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which the business zone's clock reads midnight on y-m-d. */
function midnight(year: number, month: number, day: number): Date {
  const wallClock = Date.UTC(year, month - 1, day);
  // Two passes. The first offset is read at an instant that can sit on the far
  // side of a DST change from the answer; re-reading it at the corrected
  // instant lands on the right offset. (US clocks change at 2am, so local
  // midnight always exists — this is what keeps a zone that shifts AT midnight
  // from returning a time that never happened.)
  const firstPass = wallClock - offsetMs(new Date(wallClock));
  return new Date(wallClock - offsetMs(new Date(firstPass)));
}

/** Local midnight of `now`'s business day, offset by whole calendar days. */
export function startOfBusinessDay(now: Date = new Date(), dayOffset = 0): Date {
  const c = civil(now);
  // Shifted as a calendar date, not by 86_400_000ms, so "yesterday" is still
  // yesterday on the 23- and 25-hour days either side of a DST change.
  const shifted = new Date(Date.UTC(c.year, c.month - 1, c.day + dayOffset));
  return midnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Local midnight on the 1st of `now`'s business month. */
export function startOfBusinessMonth(now: Date = new Date()): Date {
  const { year, month } = civil(now);
  return midnight(year, month, 1);
}

/** Local midnight on January 1st of `now`'s business year. */
export function startOfBusinessYear(now: Date = new Date()): Date {
  return midnight(civil(now).year, 1, 1);
}

/** Local midnight on Monday of `now`'s business week (ISO weeks). */
export function startOfBusinessWeek(now: Date = new Date()): Date {
  const c = civil(now);
  const weekday = new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay(); // 0=Sun … 6=Sat
  return startOfBusinessDay(now, -((weekday + 6) % 7));
}

export function startOfBusinessDayIso(now: Date = new Date(), dayOffset = 0): string {
  return startOfBusinessDay(now, dayOffset).toISOString();
}

export function startOfBusinessMonthIso(now: Date = new Date()): string {
  return startOfBusinessMonth(now).toISOString();
}

/** `2026-09-01` — the business-zone calendar day `instant` falls on. */
export function businessDayKey(instant: Date): string {
  const { year, month, day } = civil(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `2026-09` — the business-zone calendar month `instant` falls in. */
export function businessMonthKey(instant: Date): string {
  const { year, month } = civil(instant);
  return `${year}-${String(month).padStart(2, "0")}`;
}
