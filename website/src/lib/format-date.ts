/**
 * The one way dates are formatted for a customer.
 *
 * WHY THIS EXISTS: every surface called `new Date(iso).toLocaleDateString("en-US", …)`
 * with no timeZone, which means "format in whatever zone this code happens to be
 * running in". That is two separate bugs:
 *
 * 1. WRONG DATE. Server rendering and email sending run on Vercel, which is UTC.
 *    A membership that renews at 2026-09-03T01:00:00Z is 8pm on September 2nd for
 *    a US customer, but every server-rendered page and every billing email called
 *    it "September 3". Any timestamp landing between 00:00 and ~05:00 UTC — i.e.
 *    any US evening — was reported a day late.
 *
 * 2. HYDRATION MISMATCH. In a client component that is server-rendered first, the
 *    server produced the UTC date and the browser produced the local one, so React
 *    hydrated onto different text.
 *
 * Pinning one zone fixes both: the server and the browser now compute the same
 * string, and it is the string a US customer expects. US Eastern is the business
 * zone; it is one constant to change if that ever moves. Eastern is also strictly
 * closer than UTC for every US customer — the worst case shrinks from an 5-8 hour
 * window of wrong dates to the 3-hour ET/PT offset.
 */

export const DISPLAY_TIME_ZONE = "America/New_York";

type DateInput = string | number | Date | null | undefined;

/** Null for anything that isn't a real date, so callers can choose the fallback. */
function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const STYLES = {
  /** September 3, 2026 */
  long: { year: "numeric", month: "long", day: "numeric" },
  /** Sep 3, 2026 */
  medium: { year: "numeric", month: "short", day: "numeric" },
  /** Sep 3 */
  short: { month: "short", day: "numeric" },
  /** Sep 3, 2026, 8:00 PM */
  datetime: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof STYLES;

/** A customer-facing date, identical on the server and in the browser. */
export function formatDisplayDate(value: DateInput, style: DateStyle = "long"): string | null {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", { ...STYLES[style], timeZone: DISPLAY_TIME_ZONE }).format(date);
}

/**
 * Calendar days from now until `value`, counted in the display zone so that
 * "3 days remaining" flips at local midnight rather than at 7pm.
 *
 * TIME-DEPENDENT: this reads the clock, so it can differ between a server render
 * and the browser's hydration. Call it from an effect (or behind a mounted gate),
 * never during the first render of a server-rendered component.
 */
export function daysUntil(value: DateInput, now: Date = new Date()): number | null {
  const date = toDate(value);
  if (!date) return null;
  return Math.max(0, Math.ceil((startOfDayUtcMs(date) - startOfDayUtcMs(now)) / 86_400_000));
}

/**
 * The instant's calendar day in the display zone, as a UTC-midnight timestamp —
 * so subtracting two of them counts whole days without DST drift.
 */
function startOfDayUtcMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  // en-CA yields YYYY-MM-DD.
  return Date.parse(`${parts}T00:00:00Z`);
}
