import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// WATCH FOR SIGNUPS THAT NEVER GET CONFIRMED (audit E7).
//
// The confirmation email is sent by Supabase Auth, not by this app, so it is
// invisible to everything we already monitor: it never touches sendEmail(), so
// it produces no `order_email_log` row, no `pending_emails` retry, and no event
// on the bounce/complaint webhook. A confirmation that silently fails to
// deliver therefore leaves NO trace anywhere in this system. The only evidence
// is negative — an `auth.users` row whose `email_confirmed_at` stays null — and
// nothing was looking at it.
//
// That is not hypothetical. At the time of the audit three of twenty-three
// production accounts were stuck unconfirmed, and one of them was an ambassador
// applicant. The clearest case: a Yahoo address signed up and never confirmed,
// while the same person's Gmail address, created thirty seconds later,
// confirmed in ten. Nobody found out by being told; it was found by reading the
// table by hand a fortnight later.
//
// This closes that loop. It does not fix delivery — it makes a delivery problem
// something an operator learns about while it is still happening.
// ---------------------------------------------------------------------------

/**
 * How long a signup may sit unconfirmed before it counts as stalled.
 *
 * Long enough that ordinary human latency — signing up at night and confirming
 * in the morning — is not an alert. Short enough to catch a provider that has
 * started refusing us within the same day.
 */
export const STALLED_SIGNUP_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * How far back to look. Beyond this an unconfirmed account is simply someone
 * who changed their mind, not a live delivery problem, and counting them for
 * ever would make the alert grow monotonically until it was ignored.
 */
export const STALLED_SIGNUP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Don't re-raise the same alert more than once a day. */
const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Bound on how many users to inspect, so this can never become a long job. */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

export interface StalledSignupSummary {
  scanned: number;
  stalled: number;
  /** Mailbox domains of the stalled accounts, with counts. Never full addresses. */
  domains: Record<string, number>;
  oldestCreatedAt: string | null;
  alerted: boolean;
}

interface AuthUserLike {
  created_at?: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  last_sign_in_at?: string | null;
}

/**
 * Which mailbox provider an address belongs to.
 *
 * Only the DOMAIN is ever recorded. The alert's job is to answer "is one
 * provider refusing us?", which the domain answers completely, and a system
 * alert is read by more people and retained longer than the auth table — so
 * putting customer addresses in it would be a privacy regression in exchange
 * for nothing.
 */
function domainOf(email: string | null | undefined): string {
  const at = String(email ?? "").lastIndexOf("@");
  if (at < 0) return "(unknown)";
  return String(email).slice(at + 1).toLowerCase() || "(unknown)";
}

export function summariseStalledSignups(users: AuthUserLike[], now: number): Omit<StalledSignupSummary, "alerted"> {
  const stalledBefore = now - STALLED_SIGNUP_AFTER_MS;
  const lookbackAfter = now - STALLED_SIGNUP_LOOKBACK_MS;

  const domains: Record<string, number> = {};
  let stalled = 0;
  let oldest: string | null = null;

  for (const user of users) {
    // `confirmed_at` is a generated column in newer GoTrue and can be set by a
    // phone confirmation; either one means this person got in.
    if (user.email_confirmed_at || user.confirmed_at) continue;
    // Someone who has signed in does not need the confirmation link.
    if (user.last_sign_in_at) continue;

    const createdAt = user.created_at ? Date.parse(user.created_at) : NaN;
    if (!Number.isFinite(createdAt)) continue;
    if (createdAt > stalledBefore) continue;   // still within the grace window
    if (createdAt < lookbackAfter) continue;   // old enough to be a change of mind

    stalled += 1;
    const domain = domainOf(user.email);
    domains[domain] = (domains[domain] ?? 0) + 1;
    if (!oldest || createdAt < Date.parse(oldest)) {
      oldest = user.created_at ?? null;
    }
  }

  return { scanned: users.length, stalled, domains, oldestCreatedAt: oldest };
}

export async function alertOnStalledSignups(): Promise<StalledSignupSummary> {
  const collected: AuthUserLike[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) {
      // A sweep job that throws takes the whole sweep's error budget with it.
      // Report and stop; the next tick tries again.
      console.error("[auth-health] unable to list users", error);
      break;
    }
    const users = (data?.users ?? []) as AuthUserLike[];
    collected.push(...users);
    if (users.length < PAGE_SIZE) break;
  }

  const summary = summariseStalledSignups(collected, Date.now());
  if (summary.stalled === 0) {
    return { ...summary, alerted: false };
  }

  const worstDomain = Object.entries(summary.domains).sort((a, b) => b[1] - a[1])[0];
  const domainNote = worstDomain && worstDomain[1] > 1
    ? ` ${worstDomain[1]} of them are @${worstDomain[0]} — check whether that provider is rejecting the Supabase Auth sender.`
    : "";

  await recordSystemAlert({
    type: "signup_confirmation_stalled",
    severity: "warning",
    message:
      `${summary.stalled} account(s) have been waiting on an email confirmation for more than `
      + `${Math.round(STALLED_SIGNUP_AFTER_MS / 3_600_000)}h and have never signed in.`
      + domainNote
      + " Confirmation email is sent by Supabase Auth, not by this app's provider, so it does not"
      + " appear in the email retry queue or the bounce webhook — check the Supabase project's SMTP"
      + " settings and its sending domain's reputation.",
    context: {
      stalled: summary.stalled,
      scanned: summary.scanned,
      domains: summary.domains,
      oldestCreatedAt: summary.oldestCreatedAt,
    },
    dedupeWindowMs: ALERT_DEDUPE_MS,
  });

  return { ...summary, alerted: true };
}
