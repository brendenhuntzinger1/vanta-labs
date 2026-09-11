// Quiet hours. Pure, and the whole module is shaped by one awkward fact:
//
//     WE OFTEN DO NOT KNOW THE RECIPIENT'S TIMEZONE.
//
// The rule is 8am-9pm in the RECIPIENT'S local time. The obvious source for
// that is the area code, and the area code is wrong: number portability means
// an 813 number in Seattle is perfectly ordinary, and a Florida-registered
// number can belong to someone who moved to Oregon a decade ago. Inferring a
// timezone from it would produce a confident, defensible-looking answer that is
// simply false for some recipients — and the states with the strictest rules
// (FL, OK, WA, MD) are precisely the ones where being wrong costs the most.
//
// So this module NEVER looks at the area code. It resolves a timezone from real
// evidence when there is any, and otherwise falls back to a window that is
// inside 8am-9pm local for EVERY continental US zone at once.
//
// LEGAL NOTE, and it is deliberately not resolved in code: whether the
// 8am-9pm rule in 47 CFR 64.1200(c)(1) reaches consented texts to mobile
// numbers is actively litigated and courts are split. This implements the
// strictest reading, because the strictest reading is cheap and being wrong is
// not. It is not a legal opinion — see the blueprint's counsel list.

/** Where a resolved timezone came from. Recorded so an operator can audit it. */
export type TimezoneSource =
  /** The subscriber row's stored timezone, set from a real signal. */
  | "subscriber"
  /** Derived from the shipping state on one of their orders. */
  | "order_state"
  /** Nothing known. The continental-safe window applies. */
  | "fallback";

export type ResolvedTimezone = {
  /** IANA zone, or null when unknown. */
  timezone: string | null;
  source: TimezoneSource;
};

/**
 * US state/territory → IANA timezone, for the states this store ships to.
 *
 * Only used for a state that came off a real order's shipping address. States
 * that genuinely straddle two zones are mapped to the one containing most of
 * the population; the error is at most an hour and the fallback window below
 * absorbs it.
 */
const STATE_TIMEZONES: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago",
  ME: "America/New_York", MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit",
  MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York",
  NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago",
  TX: "America/Chicago", UT: "America/Denver", VT: "America/New_York", VA: "America/New_York",
  WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
  PR: "America/Puerto_Rico",
};

/**
 * THE CONTINENTAL-SAFE WINDOW, in America/New_York.
 *
 * 12:00-20:00 Eastern is:
 *   09:00-17:00 Pacific
 *   10:00-18:00 Mountain
 *   11:00-19:00 Central
 *   12:00-20:00 Eastern
 *
 * Every one of those sits inside 8am-9pm local, so a message sent in this
 * window is compliant for any CONTINENTAL US recipient without knowing which
 * zone they are in. (The binding constraints are 8am Pacific = 11:00 ET at the
 * start and 9pm Eastern = 21:00 ET at the end; 12:00-20:00 sits inside both
 * with an hour to spare.)
 *
 * THE ONE CASE THIS DOES NOT COVER, stated rather than hidden: a recipient in
 * Hawaii or Alaska whose timezone is ALSO unknown. 12:00 ET is 06:00 HST, which
 * is before 8am local. It is a narrow gap — marketing requires an on-site
 * opt-in, and a subscriber who opted in has almost always ordered, so
 * `resolveTimezone` finds their state and takes the real-zone path above
 * (AK and HI are both in STATE_TIMEZONES). Closing it entirely would mean a
 * 14:00 ET start, costing two send hours a day for every subscriber to cover a
 * case we can otherwise detect. If HI/AK volume ever becomes material, narrow
 * the start rather than leaving this comment as the only control.
 */
export const FALLBACK_START_HOUR_ET = 12;
export const FALLBACK_END_HOUR_ET = 20;

/** The ordinary rule, in the recipient's own zone. */
export const DEFAULT_START_HOUR = 8;
export const DEFAULT_END_HOUR = 21;

/**
 * States whose own statutes are stricter than the federal window.
 *
 * These are engineering approximations of the conservative reading, not legal
 * advice: Florida's FTSA and the Oklahoma, Washington and Maryland statutes
 * have each been amended and litigated, and the blueprint routes them to
 * counsel. Implementing the narrowest window costs a few send hours.
 */
const STRICTER_STATES: Readonly<Record<string, { start: number; end: number }>> = {
  FL: { start: 8, end: 20 },
  OK: { start: 8, end: 20 },
  WA: { start: 8, end: 20 },
  MD: { start: 8, end: 20 },
};

/**
 * Resolve a timezone from the best real evidence available.
 *
 * NEVER falls back to the area code. The parameter is not even accepted, so a
 * future caller cannot pass one by mistake.
 */
export function resolveTimezone(input: {
  /** `sms_subscribers.timezone`, if set. */
  subscriberTimezone?: string | null;
  /** Shipping state from the subscriber's most recent order. */
  lastOrderState?: string | null;
}): ResolvedTimezone {
  const stored = (input.subscriberTimezone ?? "").trim();
  if (stored) return { timezone: stored, source: "subscriber" };

  const state = (input.lastOrderState ?? "").trim().toUpperCase();
  if (state && STATE_TIMEZONES[state]) {
    return { timezone: STATE_TIMEZONES[state], source: "order_state" };
  }

  return { timezone: null, source: "fallback" };
}

/** The hour (0-23) in a given IANA zone at a given instant. */
function hourIn(timezone: string, at: Date): number | null {
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(at);
    const hour = Number(formatted);
    return Number.isFinite(hour) ? hour % 24 : null;
  } catch {
    // An unknown or malformed zone. Treated as unknown rather than assumed.
    return null;
  }
}

export type QuietHoursDecision = {
  allowed: boolean;
  /** Operator-facing account of the decision. */
  reason: string;
  /** Which window was applied. */
  window: { start: number; end: number; timezone: string };
  source: TimezoneSource;
};

/**
 * May we send a MARKETING message right now?
 *
 * Transactional messages do not call this: an order confirmation at 11pm is
 * information the customer asked for by ordering, and the exemption is the
 * reason the two classes are separated everywhere else in this programme.
 *
 * FAILS CLOSED. An unresolvable timezone, an unparseable clock, anything
 * unexpected — the answer is "not now", because the alternative is sending at
 * 3am on a guess.
 */
export function marketingSendAllowedAt(input: {
  now: Date;
  subscriberTimezone?: string | null;
  lastOrderState?: string | null;
  /** Overrides the window when a state statute is stricter. */
  lastOrderStateCode?: string | null;
}): QuietHoursDecision {
  const resolved = resolveTimezone(input);
  const stateCode = (input.lastOrderStateCode ?? input.lastOrderState ?? "").trim().toUpperCase();
  const stricter = STRICTER_STATES[stateCode];

  if (resolved.timezone) {
    const hour = hourIn(resolved.timezone, input.now);
    if (hour === null) {
      return {
        allowed: false,
        reason: `Could not read the clock in ${resolved.timezone}; refusing rather than guessing.`,
        window: { start: DEFAULT_START_HOUR, end: DEFAULT_END_HOUR, timezone: resolved.timezone },
        source: resolved.source,
      };
    }
    const window = stricter ?? { start: DEFAULT_START_HOUR, end: DEFAULT_END_HOUR };
    const allowed = hour >= window.start && hour < window.end;
    return {
      allowed,
      reason: allowed
        ? `${hour}:00 in ${resolved.timezone} is inside ${window.start}:00-${window.end}:00.`
        : `${hour}:00 in ${resolved.timezone} is outside ${window.start}:00-${window.end}:00${stricter ? ` (${stateCode} window)` : ""}.`,
      window: { ...window, timezone: resolved.timezone },
      source: resolved.source,
    };
  }

  // UNKNOWN TIMEZONE. The continental-safe window, evaluated in Eastern.
  const eastern = "America/New_York";
  const hour = hourIn(eastern, input.now);
  if (hour === null) {
    return {
      allowed: false,
      reason: "Could not read the Eastern clock; refusing.",
      window: { start: FALLBACK_START_HOUR_ET, end: FALLBACK_END_HOUR_ET, timezone: eastern },
      source: "fallback",
    };
  }
  const allowed = hour >= FALLBACK_START_HOUR_ET && hour < FALLBACK_END_HOUR_ET;
  return {
    allowed,
    reason: allowed
      ? `Timezone unknown; ${hour}:00 ET is inside the continental-safe window.`
      : `Timezone unknown; ${hour}:00 ET is outside the continental-safe window (${FALLBACK_START_HOUR_ET}:00-${FALLBACK_END_HOUR_ET}:00 ET).`,
    window: { start: FALLBACK_START_HOUR_ET, end: FALLBACK_END_HOUR_ET, timezone: eastern },
    source: "fallback",
  };
}
