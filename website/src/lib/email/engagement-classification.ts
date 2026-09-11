/**
 * WHAT FETCHED THE PIXEL, AND DOES IT COUNT.
 *
 * Every open and click the system hears about is kept raw in
 * `email_engagement_events` with its user agent and its time. This module is
 * the only place that decides whether one of those rows was a person, and it
 * is pure, so the rule can be argued about with a test rather than a
 * database.
 *
 * WHY A TIME RULE. Measured 2026-09-11 on real recovery sends: opens at 8, 10,
 * 11, 14 and 39 seconds after the send, then nothing under five minutes. The
 * fast ones are Apple Mail Privacy Protection fetching on delivery, corporate
 * link scanners, and security gateways — none of them a read. A person needs
 * the message to arrive, a notification to land and a thumb to move, and the
 * September data shows the two populations separated cleanly at a minute.
 *
 * WHY THE RULE IS CONSERVATIVE IN THE HONEST DIRECTION. A genuinely instant
 * read is called "too soon" and lost from the human count; a prefetch called
 * human would flatter the programme. The strict funnel does not rest on opens
 * at all (restored carts and paid orders do that work), so the cost of the
 * false negative is a slightly low open number, and the cost of the false
 * positive is a decision made on a number that lies.
 *
 * WHY THE SCANNER LIST IS SHORT. Only agents that name themselves. Gmail's
 * image proxy ("via ggpht.com GoogleImageProxy") fetches on behalf of a real
 * open and is deliberately NOT here; Apple's proxy sends a bare "Mozilla/5.0"
 * that nothing can distinguish, which is why the time rule exists.
 */

export const HUMAN_OPEN_MIN_DELAY_MS = 60_000;
export const HUMAN_CLICK_MIN_DELAY_MS = 10_000;

/** Agents that announce themselves as scanners or automated fetchers. */
export const SCANNER_USER_AGENT_PATTERNS: readonly RegExp[] = [
  /barracuda/i,
  /mimecast/i,
  /proofpoint/i,
  /symantec/i,
  /fireeye/i,
  /trendmicro/i,
  /zscaler/i,
  /sophos/i,
  /forcepoint/i,
  /safelinks/i,
  /python-requests/i,
  /go-http-client/i,
  /\bcurl\//i,
  /\bwget\//i,
  /\bjava\//i,
  /okhttp/i,
  /headlesschrome/i,
  /phantomjs/i,
];

export type EngagementKind = "opened" | "clicked";

export type EngagementVerdict =
  | { human: true; reason: "ok" }
  | { human: false; reason: "too_soon" | "scanner" | "unknown_send_time" };

export function isScannerUserAgent(userAgent: string | null | undefined): boolean {
  const agent = String(userAgent ?? "");
  if (!agent) return false;
  return SCANNER_USER_AGENT_PATTERNS.some((pattern) => pattern.test(agent));
}

/**
 * Was this open or click a person? Pure.
 *
 * Order matters: a scanner is a scanner however late it fetches; a send time
 * we do not know makes the time rule unanswerable, and "unanswerable" is not
 * "human".
 */
export function classifyEngagement(input: {
  kind: EngagementKind;
  /** When the event happened, ms since epoch. */
  at: number;
  /** When the message was sent, ms since epoch, or null when not known. */
  sentAt: number | null;
  userAgent: string | null | undefined;
}): EngagementVerdict {
  if (isScannerUserAgent(input.userAgent)) return { human: false, reason: "scanner" };
  if (input.sentAt === null || !Number.isFinite(input.sentAt)) return { human: false, reason: "unknown_send_time" };
  const minimum = input.kind === "opened" ? HUMAN_OPEN_MIN_DELAY_MS : HUMAN_CLICK_MIN_DELAY_MS;
  if (input.at - input.sentAt < minimum) return { human: false, reason: "too_soon" };
  return { human: true, reason: "ok" };
}

export interface SendEngagementSummary {
  openedAny: boolean;
  openedHuman: boolean;
  clickedAny: boolean;
  clickedHuman: boolean;
}

export const NO_ENGAGEMENT: SendEngagementSummary = Object.freeze({
  openedAny: false, openedHuman: false, clickedAny: false, clickedHuman: false,
});

/**
 * Per send, whether anything and whether anyone opened or clicked it.
 *
 * `key` is whatever the caller uses to identify a send — the funnel uses
 * `${campaign_type}|${reference_id}` and, for campaigns, the recipient too.
 * Events for a key that is not among the sends are ignored: they belong to a
 * send outside the window being reported, and counting them would credit a
 * window with engagement on mail it did not send.
 */
export function summarizeSendEngagement(
  sends: ReadonlyArray<{ key: string; sentAt: number | null }>,
  events: ReadonlyArray<{ key: string; kind: EngagementKind; at: number; userAgent: string | null | undefined }>,
): Map<string, SendEngagementSummary> {
  const summary = new Map<string, SendEngagementSummary>();
  const sentAtByKey = new Map<string, number | null>();
  for (const send of sends) {
    summary.set(send.key, { ...NO_ENGAGEMENT });
    sentAtByKey.set(send.key, send.sentAt);
  }
  for (const event of events) {
    const entry = summary.get(event.key);
    if (!entry) continue;
    const verdict = classifyEngagement({
      kind: event.kind,
      at: event.at,
      sentAt: sentAtByKey.get(event.key) ?? null,
      userAgent: event.userAgent,
    });
    if (event.kind === "opened") {
      entry.openedAny = true;
      if (verdict.human) entry.openedHuman = true;
    } else {
      entry.clickedAny = true;
      if (verdict.human) entry.clickedHuman = true;
    }
  }
  return summary;
}
