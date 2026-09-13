import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { browserClassFromUserAgent } from "@/lib/browser-class";
import { groupLiveActivity, type LiveActivityRow, type SessionStartInfo } from "@/lib/live-visitor-grouping";

/**
 * How recently a session must have pinged to still count as "live" — the
 * requirement is ~60s; the client heartbeats every 15s, so a visitor who is
 * still here misses at most one beat before this would drop them.
 */
const LIVE_WINDOW_MS = 60_000;

/** The shape /admin/live actually renders. No raw user_agent, ever. */
export interface LiveVisitorView {
  key: string;
  displayName: string;
  isAnonymous: boolean;
  pagePath: string;
  deviceType: string;
  browserClass: string;
  location: string | null;
  firstSeen: string;
  lastSeen: string;
  isReturningVisitor: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

type RawRow = Record<string, unknown>;

function toActivityRow(row: RawRow): LiveActivityRow | null {
  const sessionId = row.session_id ? String(row.session_id) : null;
  const pagePath = row.page_path ? String(row.page_path) : null;
  const createdAt = row.created_at ? String(row.created_at) : null;
  if (!sessionId || !pagePath || !createdAt) {
    return null;
  }
  return {
    sessionId,
    userId: row.user_id ? String(row.user_id) : null,
    pagePath,
    deviceType: row.device_type ? String(row.device_type) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    country: row.country ? String(row.country) : null,
    city: row.city ? String(row.city) : null,
    isBot: Boolean(row.is_bot),
    createdAt,
  };
}

/**
 * session_start rows carry no window filter (a session could have started
 * well before the live window) — reduced here into one entry per session_id:
 * how many visits this session has ever recorded (new vs returning) and the
 * most recent visit's start time + attribution (what "here since" and UTM
 * mean for the CURRENT visit, not the visitor's very first one).
 */
function buildSessionStartMap(rows: RawRow[]): Map<string, SessionStartInfo> {
  const latestBySession = new Map<string, RawRow>();
  const countBySession = new Map<string, number>();

  for (const row of rows) {
    const sessionId = row.session_id ? String(row.session_id) : null;
    const createdAt = row.created_at ? String(row.created_at) : null;
    if (!sessionId || !createdAt) {
      continue;
    }
    countBySession.set(sessionId, (countBySession.get(sessionId) ?? 0) + 1);
    const current = latestBySession.get(sessionId);
    if (!current || createdAt > String(current.created_at)) {
      latestBySession.set(sessionId, row);
    }
  }

  const result = new Map<string, SessionStartInfo>();
  for (const [sessionId, latest] of latestBySession) {
    result.set(sessionId, {
      sessionId,
      createdAt: String(latest.created_at),
      visitCount: countBySession.get(sessionId) ?? 1,
      utmSource: latest.utm_source ? String(latest.utm_source) : null,
      utmMedium: latest.utm_medium ? String(latest.utm_medium) : null,
      utmCampaign: latest.utm_campaign ? String(latest.utm_campaign) : null,
    });
  }
  return result;
}

function formatLocation(country: string | null, city: string | null): string | null {
  if (city && country) return `${city}, ${country}`;
  return country ?? city ?? null;
}

/**
 * Look up a display name for each distinct signed-in visitor, for the live
 * rows only — never stored redundantly per-event (see the migration's
 * header comment on website_analytics_events.user_id). One failed lookup
 * (a since-deleted account, a transient auth-service hiccup) degrades to a
 * generic label rather than failing the whole read — the live count and
 * every other visitor must still render.
 */
async function resolveDisplayNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const { data } = await supabaseAdmin.auth.admin.getUserById(id);
        const user = data?.user;
        const fullName =
          typeof user?.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim() : "";
        names.set(id, fullName || user?.email || "Signed-in visitor");
      } catch (error) {
        console.error("[admin-live-visitors] could not resolve display name", id, error);
        names.set(id, "Signed-in visitor");
      }
    }),
  );
  return names;
}

/**
 * Heartbeat rows are pure liveness pings — worthless once older than the 60s
 * live window, unlike page_view/session_start (which real funnel/attribution
 * reporting depends on and this never touches). 15 minutes is a comfortable
 * margin past that window so a slow or skipped cron tick can never delete a
 * row a concurrent live-visitor read still needed.
 */
const HEARTBEAT_RETENTION_MINUTES = 15;

/**
 * Delete stale heartbeat rows. Called from the existing /api/cron/sweep job
 * map (runs every 30 min already) — this is the only retention this table
 * has ever needed, since page_view/session_start were never unbounded in
 * the same way (one row per navigation, not one every 15s per open tab).
 */
export async function pruneStaleHeartbeats(): Promise<number> {
  const cutoffIso = new Date(Date.now() - HEARTBEAT_RETENTION_MINUTES * 60_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("website_analytics_events")
    .delete()
    .eq("event_type", "heartbeat")
    .lt("created_at", cutoffIso)
    .select("id");

  if (error) {
    throw error;
  }
  return data?.length ?? 0;
}

/**
 * Who is live on the site right now, deduped to one entry per real visitor.
 *
 * Two queries, same shape as the rest of this codebase's admin reads
 * (see admin/status/page.tsx's own "two queries, on purpose"): the live
 * activity window is cheap and narrow; session_start lookups are scoped to
 * exactly the session ids the first query found, never the whole table.
 */
export async function getLiveVisitors(): Promise<LiveVisitorView[]> {
  const now = new Date();
  const windowStartIso = new Date(now.getTime() - LIVE_WINDOW_MS).toISOString();

  const { data: activityData, error: activityError } = await supabaseAdmin
    .from("website_analytics_events")
    .select("session_id, user_id, page_path, device_type, user_agent, country, city, is_bot, created_at")
    .gte("created_at", windowStartIso)
    .in("event_type", ["heartbeat", "page_view", "session_start"])
    .eq("is_bot", false)
    // A ceiling on memory, not a guarantee of exactness — same reasoning as
    // getCurrentOnlineVisitorCount. A 60s window has never come near this.
    .order("created_at", { ascending: false })
    .limit(2000);

  if (activityError) {
    throw activityError;
  }

  const rows = (activityData ?? [])
    .map(toActivityRow)
    .filter((row): row is LiveActivityRow => row !== null);

  const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
  if (sessionIds.length === 0) {
    return [];
  }

  const { data: startData, error: startError } = await supabaseAdmin
    .from("website_analytics_events")
    .select("session_id, created_at, utm_source, utm_medium, utm_campaign")
    .eq("event_type", "session_start")
    .in("session_id", sessionIds)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (startError) {
    throw startError;
  }

  const sessionStarts = buildSessionStartMap(startData ?? []);
  const grouped = groupLiveActivity(rows, sessionStarts, now, LIVE_WINDOW_MS);

  const distinctUserIds = [...new Set(grouped.map((v) => v.userId).filter((id): id is string => id !== null))];
  const names = await resolveDisplayNames(distinctUserIds);

  return grouped
    .map((visitor): LiveVisitorView => ({
      key: visitor.key,
      displayName: visitor.userId ? names.get(visitor.userId) ?? "Signed-in visitor" : "Anonymous",
      isAnonymous: visitor.userId === null,
      pagePath: visitor.pagePath,
      deviceType: visitor.deviceType ?? "unknown",
      browserClass: browserClassFromUserAgent(visitor.userAgent),
      location: formatLocation(visitor.country, visitor.city),
      firstSeen: visitor.firstSeen,
      lastSeen: visitor.lastSeen,
      isReturningVisitor: visitor.isReturningVisitor,
      utmSource: visitor.utmSource,
      utmMedium: visitor.utmMedium,
      utmCampaign: visitor.utmCampaign,
    }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}
