/**
 * Pure grouping/dedup logic for the live-visitor dashboard (/admin/live).
 *
 * Deliberately free of any Supabase or network dependency — everything this
 * needs arrives as plain data, so every dedup rule (multi-tab, multi-device
 * same customer, login/logout mid-session, bot/admin exclusion, staleness)
 * is unit-testable without a database. admin-live-visitors.ts is the thin
 * I/O layer that fetches rows and hands them to this.
 */

export interface LiveActivityRow {
  sessionId: string;
  userId: string | null;
  pagePath: string;
  deviceType: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
  isBot: boolean;
  createdAt: string;
}

export interface SessionStartInfo {
  sessionId: string;
  /** When this browsing session began — the anchor for "here since". */
  createdAt: string;
  /** How many session_start events this session_id has ever recorded. */
  visitCount: number;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

export interface GroupedLiveVisitor {
  /** Stable key for a UI list: one merged visitor, not one row. */
  key: string;
  sessionIds: string[];
  userId: string | null;
  pagePath: string;
  deviceType: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
  /** ISO timestamp this visit began (survives login/logout on the session). */
  firstSeen: string;
  /** ISO timestamp of the most recent activity across every merged session. */
  lastSeen: string;
  isReturningVisitor: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

type SessionSnapshot = {
  sessionId: string;
  userId: string | null;
  pagePath: string;
  deviceType: string | null;
  userAgent: string | null;
  country: string | null;
  city: string | null;
  lastSeen: string;
  firstSeen: string;
  isReturningVisitor: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};

/**
 * Group raw activity rows into one entry per real visitor.
 *
 * `rows` should already be scoped to the live window by the caller's query
 * (for DB efficiency), but staleness is re-checked here too — the query is
 * an optimization, this is the contract. A session with NO row inside
 * `liveWindowMs` of `now` never appears in the result, however old the rows
 * passed in.
 */
export function groupLiveActivity(
  rows: readonly LiveActivityRow[],
  sessionStarts: ReadonlyMap<string, SessionStartInfo>,
  now: Date,
  liveWindowMs: number,
): GroupedLiveVisitor[] {
  // Step 1: bots and the admin's own pages never count as "a visitor".
  const eligible = rows.filter((row) => !row.isBot && !row.pagePath.startsWith("/admin"));

  // Step 2: collapse every tab of one browser (same sessionId) down to its
  // single most-recently-active row. This is what makes multi-tab free.
  const latestBySession = new Map<string, LiveActivityRow>();
  for (const row of eligible) {
    const current = latestBySession.get(row.sessionId);
    if (!current || row.createdAt > current.createdAt) {
      latestBySession.set(row.sessionId, row);
    }
  }

  // Step 3: attach each session's own "here since" / return-visit info.
  const snapshots: SessionSnapshot[] = [];
  for (const [sessionId, latest] of latestBySession) {
    const start = sessionStarts.get(sessionId);
    snapshots.push({
      sessionId,
      userId: latest.userId,
      pagePath: latest.pagePath,
      deviceType: latest.deviceType,
      userAgent: latest.userAgent,
      country: latest.country,
      city: latest.city,
      lastSeen: latest.createdAt,
      // No session_start on record (e.g. a heartbeat that raced ahead of it)
      // degrades to "just arrived" rather than throwing — a session that
      // exists at all is at least as old as its own latest row.
      firstSeen: start?.createdAt ?? latest.createdAt,
      isReturningVisitor: (start?.visitCount ?? 1) > 1,
      utmSource: start?.utmSource ?? null,
      utmMedium: start?.utmMedium ?? null,
      utmCampaign: start?.utmCampaign ?? null,
    });
  }

  // Step 4: merge sessions that share one signed-in identity (e.g. the same
  // customer open on a phone and a laptop) into a single visitor. Sessions
  // with no identity stay one-per-session — already deduped in step 2.
  const byUser = new Map<string, SessionSnapshot[]>();
  const anonymous: SessionSnapshot[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.userId) {
      const group = byUser.get(snapshot.userId) ?? [];
      group.push(snapshot);
      byUser.set(snapshot.userId, group);
    } else {
      anonymous.push(snapshot);
    }
  }

  const merged: GroupedLiveVisitor[] = [];

  for (const snapshot of anonymous) {
    merged.push({
      key: `session:${snapshot.sessionId}`,
      sessionIds: [snapshot.sessionId],
      userId: null,
      pagePath: snapshot.pagePath,
      deviceType: snapshot.deviceType,
      userAgent: snapshot.userAgent,
      country: snapshot.country,
      city: snapshot.city,
      firstSeen: snapshot.firstSeen,
      lastSeen: snapshot.lastSeen,
      isReturningVisitor: snapshot.isReturningVisitor,
      utmSource: snapshot.utmSource,
      utmMedium: snapshot.utmMedium,
      utmCampaign: snapshot.utmCampaign,
    });
  }

  for (const [userId, group] of byUser) {
    // Whichever of this customer's sessions was active most recently wins
    // the displayed page/device/location/attribution — that's "where they
    // are right now". Duration is anchored to the EARLIEST of their merged
    // sessions, so switching devices mid-visit doesn't reset the clock.
    const mostRecent = group.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a));
    const earliestFirstSeen = group.reduce((a, b) => (b.firstSeen < a.firstSeen ? b : a)).firstSeen;
    const latestLastSeen = group.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a)).lastSeen;

    merged.push({
      key: `user:${userId}`,
      sessionIds: group.map((s) => s.sessionId),
      userId,
      pagePath: mostRecent.pagePath,
      deviceType: mostRecent.deviceType,
      userAgent: mostRecent.userAgent,
      country: mostRecent.country,
      city: mostRecent.city,
      firstSeen: earliestFirstSeen,
      lastSeen: latestLastSeen,
      isReturningVisitor: group.some((s) => s.isReturningVisitor),
      utmSource: mostRecent.utmSource,
      utmMedium: mostRecent.utmMedium,
      utmCampaign: mostRecent.utmCampaign,
    });
  }

  // Step 5: re-check staleness against the merged lastSeen, independent of
  // whatever window the caller's query already applied.
  const cutoff = now.getTime() - liveWindowMs;
  return merged.filter((visitor) => new Date(visitor.lastSeen).getTime() >= cutoff);
}
