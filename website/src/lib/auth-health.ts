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
  /**
   * The same for EVERY account scanned — the baseline `domains` has to be read
   * against before it can mean anything. Never full addresses.
   */
  scannedDomains: Record<string, number>;
  oldestCreatedAt: string | null;
  alerted: boolean;
}

/**
 * The smallest number of stalled accounts on one domain that could be a pattern.
 *
 * Below this a ratio is arithmetic on noise: two stalled accounts out of two on
 * a domain is 100% and means nothing. Crying wolf is what teaches an operator
 * to skim the alert, which costs the one time it is right.
 */
const DOMAIN_SIGNAL_MIN_STALLED = 5;

/** How much more often a domain must stall than it appears, before it is news. */
const DOMAIN_SIGNAL_RATIO = 1.5;

/**
 * The one domain whose stalled share is disproportionate to its share of signups.
 *
 * WHY A RATIO AND NOT A COUNT. This used to name whichever domain had more than
 * one stalled account, and then assert a cause: "check whether that provider is
 * rejecting or spam-filing our sending domain". Our customers are mostly on
 * Gmail and iCloud, so that condition holds almost always and the alert accused
 * Gmail nearly every time it fired.
 *
 * It did so on 2026-09-10 — "5 of them are @gmail.com" — and all nine of those
 * confirmations had been delivered in three to seven seconds, Gmail included,
 * one of them opened, none bounced, none suppressed. The alert cost its reader
 * an audit of sending-domain reputation for a problem that did not exist.
 *
 * A domain is evidence only when it stalls MORE than its presence explains, so
 * that is what this measures. Null is the common and correct answer.
 */
export function overRepresentedDomain(
  summary: Pick<StalledSignupSummary, "domains" | "scannedDomains" | "stalled">,
): { domain: string; stalled: number; stalledShare: number; baselineShare: number } | null {
  const scannedTotal = Object.values(summary.scannedDomains).reduce((a, b) => a + b, 0);
  if (scannedTotal === 0 || summary.stalled === 0) return null;

  let best: { domain: string; stalled: number; stalledShare: number; baselineShare: number } | null = null;

  for (const [domain, stalled] of Object.entries(summary.domains)) {
    if (stalled < DOMAIN_SIGNAL_MIN_STALLED) continue;

    const baselineShare = (summary.scannedDomains[domain] ?? 0) / scannedTotal;
    // A domain we have never otherwise seen has no baseline to be measured
    // against; the minimum count above is the only guard it gets.
    if (baselineShare === 0) continue;

    const stalledShare = stalled / summary.stalled;
    if (stalledShare < baselineShare * DOMAIN_SIGNAL_RATIO) continue;

    if (!best || stalledShare / baselineShare > best.stalledShare / best.baselineShare) {
      best = { domain, stalled, stalledShare, baselineShare };
    }
  }

  return best;
}

interface AuthUserLike {
  id?: string;
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
  const scannedDomains: Record<string, number> = {};
  let stalled = 0;
  let oldest: string | null = null;

  for (const user of users) {
    // The baseline is every account we looked at, counted BEFORE any of the
    // skips below — a domain's share of the customer base is not conditional on
    // whether these particular accounts confirmed.
    if (user.email) {
      const seen = domainOf(user.email);
      scannedDomains[seen] = (scannedDomains[seen] ?? 0) + 1;
    }

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

  return { scanned: users.length, stalled, domains, scannedDomains, oldestCreatedAt: oldest };
}

/**
 * Every auth user, paged. Shared by both checks in this file.
 *
 * Bounded by MAX_PAGES so a growing user table can never turn a sweep job into
 * a long one. A listUsers failure is reported and the partial list returned:
 * a sweep job that throws takes the whole sweep's error budget with it, and the
 * next tick tries again.
 */
async function listAllAuthUsers(): Promise<AuthUserLike[]> {
  const collected: AuthUserLike[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) {
      console.error("[auth-health] unable to list users", error);
      break;
    }
    const users = (data?.users ?? []) as AuthUserLike[];
    collected.push(...users);
    if (users.length < PAGE_SIZE) break;
  }

  return collected;
}

export async function alertOnStalledSignups(): Promise<StalledSignupSummary> {
  const collected = await listAllAuthUsers();

  const summary = summariseStalledSignups(collected, Date.now());
  if (summary.stalled === 0) {
    return { ...summary, alerted: false };
  }

  // Only when the domain stalls out of proportion to how often it appears —
  // see overRepresentedDomain for the alert this sentence used to misdirect.
  // The percentages travel with it so the reader can weigh the claim rather
  // than take it on trust.
  const skewed = overRepresentedDomain(summary);
  const pct = (share: number) => `${Math.round(share * 100)}%`;
  const domainNote = skewed
    ? ` ${skewed.stalled} of them are @${skewed.domain}, which is ${pct(skewed.stalledShare)} of the`
      + ` stalled accounts but only ${pct(skewed.baselineShare)} of those scanned — check whether that`
      + " provider is rejecting or spam-filing our sending domain."
    : "";

  await recordSystemAlert({
    type: "signup_confirmation_stalled",
    severity: "warning",
    message:
      `${summary.stalled} account(s) have been waiting on an email confirmation for more than `
      + `${Math.round(STALLED_SIGNUP_AFTER_MS / 3_600_000)}h and have never signed in.`
      + domainNote
      // AN ALERT THAT NAMES THE WRONG SYSTEM IS WORSE THAN NO ALERT.
      //
      // This used to read "Confirmation email is sent by Supabase Auth, not by
      // this app's provider, so it does not appear in the email retry queue or
      // the bounce webhook — check the Supabase project's SMTP settings". That
      // was true when it was written and is now false in every clause:
      // /api/auth/signup mints the link with generateLink (which sends
      // nothing) and delivers it through sendEmail, so the send IS in the
      // retry queue and the bounce webhook, and the Supabase SMTP settings
      // have nothing to do with it.
      //
      // It matters because this is the alert that fires during an email
      // incident, and it was sending whoever answered it to go and inspect a
      // system that is not in the path. The one incident this text has ever
      // had to survive — Gmail filing a confirmation as spam and stripping its
      // links — is precisely the case it would have misdirected.
      //
      // Supabase's own sender is still reachable, but only as the fallback
      // that fallBackToSupabaseConfirmation uses when OUR send has already
      // failed, so it is worth naming second rather than first.
      + " The confirmation is minted by this app and sent through its own email provider. Look up"
      + " these addresses in email_send_log under campaign_type 'auth:signup_confirmation': a row"
      + " with status 'sent' means WE handed it to the provider, 'failed' carries the provider's"
      + " reason in reference_id, and NO row means the send was never attempted."
      // 'sent' IS NOT 'DELIVERED', AND READING IT THAT WAY IS WHY THIS ALERT
      // WASTED AN AFTERNOON. It records our own call returning, nothing more.
      // The provider's verdict lives in email_delivery_events, and joining the
      // two needs the provider_message_id that auth rows now carry — before
      // 2026-09-10 they all held NULL, so the only available join was on
      // address and a time window, which paired one customer's delivery with a
      // send that happened ninety-two seconds after it.
      //
      // Every stalled account in that alert turned out to have been delivered
      // within seconds. The commonest outcome here is a customer who got the
      // email and did not click it, and the alert should let its reader
      // establish that in one query instead of assuming an outage.
      + " 'sent' means only that we handed it over — for the provider's verdict join"
      + " email_delivery_events on provider_message_id and read `kind` ('delivered', 'soft_bounce',"
      + " 'hard_bounce', 'opened'). Delivered-and-never-clicked is the ordinary case and needs no"
      + " action. Then check email_suppressions for a prior bounce. Note it is not in the retry"
      + " queue by design — a failed send falls back to Supabase's own sender immediately instead.",
    context: {
      stalled: summary.stalled,
      scanned: summary.scanned,
      domains: summary.domains,
      // The baseline the stalled mix has to be read against. Without it the
      // reader of `domains` alone re-derives the wrong conclusion by eye.
      scannedDomains: summary.scannedDomains,
      oldestCreatedAt: summary.oldestCreatedAt,
    },
    dedupeWindowMs: ALERT_DEDUPE_MS,
  });

  return { ...summary, alerted: true };
}

// ---------------------------------------------------------------------------
// WATCH FOR AMBASSADORS WHO CANNOT GET IN.
//
// The check above is about SIGNUPS, and it is deliberately time-boxed: past
// STALLED_SIGNUP_LOOKBACK_MS an unconfirmed account is treated as somebody who
// changed their mind, because otherwise the number only grows. That is right
// for a shopper and wrong for an ambassador, and the difference is money.
//
// An APPROVED ambassador has a live referral code. It is in their bio, it is
// being handed out, it resolves at checkout, and it accrues commission — all of
// which keeps working whether or not they can ever open the portal to see it.
// So the very condition that stops mattering for a shopper after seven days is
// the one that matters MOST here, and for as long as it lasts.
//
// That gap is not hypothetical. Ambassador ZAIN was invited on 2026-08-23,
// approved an hour later, and never confirmed and never signed in; the signup
// alert reported them twice and would have gone quiet on 2026-08-30 with
// nothing fixed and the code still live. Nobody was going to be told again.
//
// This is the check that does not expire. It joins the ambassadors an operator
// has actually approved against auth, and reports the ones who have never once
// signed in — whatever the reason, and however long ago.
// ---------------------------------------------------------------------------

/**
 * Grace period before an approved ambassador counts as locked out.
 *
 * They have to receive the mail, find it, and act on it. A day is comfortably
 * longer than that and still inside the window where an invite link is valid,
 * so this fires while the link can still be re-sent rather than after.
 */
export const PARTNER_LOCKED_OUT_AFTER_MS = 24 * 60 * 60 * 1000;

/** Why this ambassador cannot sign in. Each needs a different repair. */
export type PartnerLockoutReason =
  /** Approved, has an auth account, has never once signed in. */
  | "never_signed_in"
  /** Approved with no auth account at all — nothing to sign in to. */
  | "no_auth_user"
  /** Approved, but the auth account it points at no longer exists. */
  | "auth_user_missing";

export interface LockedOutPartner {
  partnerId: string;
  /** Public already, and the thing an operator searches /admin/partners by. */
  referralCode: string | null;
  reason: PartnerLockoutReason;
  approvedAt: string | null;
}

export interface LockedOutPartnerSummary {
  checked: number;
  lockedOut: number;
  partners: LockedOutPartner[];
  alerted: boolean;
}

export interface PartnerLike {
  id?: string;
  status?: string | null;
  referral_code?: string | null;
  auth_user_id?: string | null;
  approved_at?: string | null;
  created_at?: string | null;
}

/**
 * Approved ambassadors who have never signed in.
 *
 * NO EMAIL IS RECORDED, for the same reason domainOf exists above: a system
 * alert is read by more people and retained longer than the tables behind it.
 * The referral code identifies the row in /admin/partners and is public
 * anyway, so it costs nothing and is the fastest thing to act on.
 */
export function summarisePartnersLockedOut(
  partners: PartnerLike[],
  users: AuthUserLike[],
  now: number,
): Omit<LockedOutPartnerSummary, "alerted"> {
  const usersById = new Map<string, AuthUserLike>();
  for (const user of users) {
    if (user.id) usersById.set(user.id, user);
  }

  const lockedOutBefore = now - PARTNER_LOCKED_OUT_AFTER_MS;
  const lockedOut: LockedOutPartner[] = [];
  let checked = 0;

  for (const partner of partners) {
    // Only APPROVED ambassadors. A pending applicant who cannot sign in is the
    // signup check's business; a rejected or disabled one is nobody's.
    if (String(partner.status ?? "").toLowerCase() !== "approved") continue;
    checked += 1;

    // Date the grace period from approval where we have it — that is the moment
    // the code went live — and from row creation otherwise.
    const since = partner.approved_at ?? partner.created_at ?? null;
    const sinceMs = since ? Date.parse(since) : NaN;
    // An unparseable date must not silently exempt a locked-out ambassador, so
    // only a date we can read and that is still inside the grace window skips.
    if (Number.isFinite(sinceMs) && sinceMs > lockedOutBefore) continue;

    const authUserId = partner.auth_user_id ?? null;
    let reason: PartnerLockoutReason;
    if (!authUserId) {
      reason = "no_auth_user";
    } else {
      const user = usersById.get(authUserId);
      if (!user) {
        reason = "auth_user_missing";
      } else if (user.last_sign_in_at) {
        continue; // They have been in. Whatever else is true, they are not locked out.
      } else {
        reason = "never_signed_in";
      }
    }

    lockedOut.push({
      partnerId: String(partner.id ?? ""),
      referralCode: partner.referral_code ?? null,
      reason,
      approvedAt: partner.approved_at ?? null,
    });
  }

  return { checked, lockedOut: lockedOut.length, partners: lockedOut };
}

export async function alertOnPartnersLockedOut(): Promise<LockedOutPartnerSummary> {
  const { data, error } = await supabaseAdmin
    .from("partners")
    .select("id, status, referral_code, auth_user_id, approved_at, created_at")
    .eq("status", "approved");

  if (error) {
    // Same contract as the check above: report and return, never throw. A sweep
    // job that throws spends the whole sweep's error budget on itself.
    console.error("[auth-health] unable to read partners", error);
    return { checked: 0, lockedOut: 0, partners: [], alerted: false };
  }

  const partners = (data ?? []) as PartnerLike[];
  if (partners.length === 0) {
    return { checked: 0, lockedOut: 0, partners: [], alerted: false };
  }

  const users = await listAllAuthUsers();
  const summary = summarisePartnersLockedOut(partners, users, Date.now());
  if (summary.lockedOut === 0) {
    return { ...summary, alerted: false };
  }

  const codes = summary.partners
    .map((partner) => partner.referralCode)
    .filter((code): code is string => Boolean(code));
  const codeNote = codes.length > 0 ? ` Referral code(s): ${codes.join(", ")}.` : "";

  await recordSystemAlert({
    type: "partner_locked_out",
    severity: "warning",
    message:
      `${summary.lockedOut} approved ambassador(s) have never signed in.`
      + codeNote
      + " Their referral codes are live and earning commission they cannot see."
      + " An invited ambassador has no password until they open their invite link, so re-send it"
      + " (or have them use Forgot Password) rather than waiting — unlike the signup alert this"
      + " condition does not expire, and it will keep reporting until they get in or are disabled.",
    context: {
      lockedOut: summary.lockedOut,
      checked: summary.checked,
      partners: summary.partners,
    },
    dedupeWindowMs: ALERT_DEDUPE_MS,
  });

  return { ...summary, alerted: true };
}
