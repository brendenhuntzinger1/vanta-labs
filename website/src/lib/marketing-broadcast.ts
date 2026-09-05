import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { couponAnnouncementTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";
import { readAllRowsBounded } from "@/lib/supabase-page";
import type { AdminCoupon } from "@/lib/admin-coupons";

// Emails of customers who opted into marketing (the "Marketing emails" toggle
// on their account). Deduped and lowercased. Guests and opted-out customers
// are excluded; unsubscribes are enforced separately by sendMarketingEmail's
// suppression check, so a customer who later unsubscribes is still skipped.
export async function getMarketingRecipientEmails(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("customer_preferences")
    .select("user_id")
    .eq("marketing_emails", true);

  if (error) {
    throw error;
  }

  const userIds = new Set((data ?? []).map((row) => row.user_id).filter(Boolean));

  const emails = new Set<string>();
  // Resolve opted-in user_ids → emails by PAGING the auth admin list once
  // (ceil(N/1000) calls) instead of one getUserById per opted-in customer,
  // which was O(N) serial round-trips to the rate-limited auth admin API and
  // would time out at thousands of subscribers.
  const PER_PAGE = 1000;
  const MAX_PAGES = 100; // safety backstop (100k users); logged if exceeded.
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    try {
      const { data: pageData, error: pageError } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (pageError) break;
      const users = pageData?.users ?? [];
      for (const user of users) {
        if (userIds.has(user.id)) {
          const email = user.email?.trim().toLowerCase();
          if (email) emails.add(email);
        }
      }
      if (users.length < PER_PAGE) break; // last page
    } catch {
      break; // partial list still sends; union below adds email-keyed opt-ins.
    }
  }
  if (page > MAX_PAGES) {
    console.warn(`getMarketingRecipientEmails: stopped paging auth users at ${MAX_PAGES} pages; some account opt-ins may be omitted.`);
  }

  // Union the email-keyed opt-in list (guests + at-checkout opt-ins). Best-
  // effort: if the table isn't present yet, fall back to account opt-ins only.
  try {
    // Paged: past the server's row cap an unpaged read silently returns a
    // short list, so the broadcast would skip subscribers without any error.
    const { rows: subs, truncated } = await readAllRowsBounded<{ email: string }>(
      (from, to) => supabaseAdmin
        .from("marketing_subscribers")
        .select("email")
        .is("unsubscribed_at", null)
        .order("email", { ascending: true })
        .range(from, to),
      { maxRows: 500_000, label: "broadcast subscriber read" },
    );
    // The catch below exists for "the table is not created yet". A read that
    // came back SHORT is a different thing and must not be absorbed by it:
    // this list decides who gets the mail (F-A-19).
    if (truncated) {
      throw new Error("Could not read the whole subscriber list; the broadcast was refused rather than sent to part of it.");
    }
    for (const row of subs) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (email) emails.add(email);
    }
  } catch {
    // marketing_subscribers not created yet — ignore.
  }

  return Array.from(emails);
}

// Records a marketing opt-in (guest OR account) keyed by email so the coupon
// broadcast can reach them. Best-effort by design — a failure here (incl. the
// table not existing yet) must NEVER block checkout.
//
// BEST-EFFORT IS NOT THE SAME AS UNOBSERVABLE, and this used to be both. The
// upsert's result was discarded and the catch was bare, so a refusal — the
// table missing, a constraint or column-type change, a service-key rotation —
// looked exactly like a success to every caller. The address simply never
// appeared in the subscribers admin and nothing anywhere said why.
//
// So it still never throws and still never blocks anything, but it now REPORTS:
// true when the row landed, false when it did not. Callers that care (the OAuth
// portal's optional consent box, whose entire purpose is that the address turns
// up on the list) can log the difference; callers that genuinely do not care
// can keep ignoring it exactly as before.
export async function recordMarketingOptIn(email: string, source: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;
  try {
    const { error } = await supabaseAdmin
      .from("marketing_subscribers")
      .upsert(
        { email: normalized, source, opted_in_at: new Date().toISOString(), unsubscribed_at: null },
        { onConflict: "email" },
      );
    if (error) {
      // PostgREST returns its refusals rather than throwing, so without this
      // the catch below is dead code for the failure that actually happens.
      console.error("[marketing] opt-in row was refused", { source, message: error.message });
      return false;
    }
    return true;
  } catch (err) {
    // Table missing (migration not run) or transient error — never fatal.
    console.error("[marketing] opt-in row could not be written", { source, err });
    return false;
  }
}

export function couponDiscountLabel(coupon: Pick<AdminCoupon, "discountType" | "discountValue">): string {
  return coupon.discountType === "fixed"
    ? `$${coupon.discountValue.toFixed(2)} off`
    : `${coupon.discountValue}% off`;
}

// Ceiling on the dedup read, matching the 500k the recipient read above uses:
// one row per (coupon, recipient) send, so it can only be as large as the list.
// It bounds memory; it never defines the answer — `truncated` is checked.
const MAX_DEDUP_ROWS = 500_000;

export interface BroadcastResult {
  recipients: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Held by the frequency guard and queued for the cron sweep. */
  queued: number;
}

// Sends a one-off coupon/promo announcement to every opted-in customer.
// Idempotent per (coupon, recipient): a recipient who already received THIS
// coupon announcement is skipped, so re-clicking "Email customers" won't
// double-send. Best-effort per recipient - one failure never aborts the run.
export async function broadcastCouponAnnouncement(input: {
  coupon: AdminCoupon;
  headline: string;
  message?: string;
}): Promise<BroadcastResult> {
  const emails = await getMarketingRecipientEmails();
  const shopUrl = `${getSiteUrl()}/products`;
  const discountLabel = couponDiscountLabel(input.coupon);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let queued = 0;

  // Load everyone who already received THIS coupon announcement in ONE paged
  // read, instead of a per-recipient lookup inside the loop (was O(N)
  // round-trips).
  //
  // PAGED for the same reason the subscriber read above is: this is the only
  // per-(coupon, recipient) dedup, and a short read of it does not fail — it
  // just stops mentioning people who already got the mail, and the next click
  // sends to them again. One send_log row is written per recipient, so the very
  // first broadcast to a list of 1000+ leaves a log this read cannot see the
  // end of. readAllRowsBounded throws on a page error, which keeps the existing
  // fail-closed behaviour: we must NOT proceed with an empty "already sent" set,
  // because that re-blasts the entire list. (sendMarketingEmail also suppresses
  // per-recipient, but we don't rely on that as the only guard.)
  const { rows: sentRows, truncated: sentTruncated } = await readAllRowsBounded<{ recipient_email: string | null }>(
    (from, to) => supabaseAdmin
      .from("email_send_log")
      .select("recipient_email")
      .eq("campaign_type", "coupon_announcement")
      .eq("reference_id", input.coupon.id)
      // ONLY A DELIVERED ROW COUNTS AS "ALREADY GOT IT". The log also holds
      // 'failed' rows (the provider refused that recipient) and stranded
      // 'sending' claims (a process died mid-send). Reading them all treated
      // every one of those as delivered, so a recipient the provider bounced
      // once was skipped on every later click and never received the code.
      // sendMarketingEmail's own send-once index still refuses a genuinely
      // in-flight duplicate, so narrowing this read cannot double-send.
      .eq("status", "sent")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Array<{ recipient_email: string | null }> | null; error: unknown }>,
    { maxRows: MAX_DEDUP_ROWS, label: "coupon broadcast dedup read" },
  );
  if (sentTruncated) {
    throw new Error(
      "Could not read the whole already-sent list for this coupon; the broadcast was refused rather than risk sending it twice.",
    );
  }
  const alreadySent = new Set(
    sentRows.map((row) => String(row.recipient_email ?? "").trim().toLowerCase()),
  );

  for (const email of emails) {
    // Don't re-announce the same coupon to someone who already got it.
    if (alreadySent.has(email.trim().toLowerCase())) {
      skipped++;
      continue;
    }

    const template = couponAnnouncementTemplate({
      headline: input.headline,
      code: input.coupon.code,
      discountLabel,
      message: input.message,
      endsAt: input.coupon.endsAt,
      shopUrl,
    });

    const result = await sendMarketingEmail({
      to: email,
      campaignType: "coupon_announcement",
        onDeferred: "queue",
      referenceId: input.coupon.id,
      templateKey: "coupon_announcement",
      ...template,
    });

    if (result.success) {
      sent++;
    } else if (result.suppressed) {
      skipped++;
    } else if (result.queued) {
      // Held by the frequency guard and parked for the cron sweep: it will go
      // out once the recipient's quiet window opens, so it is not a failure.
      queued++;
    } else {
      failed++;
    }
  }

  return { recipients: emails.length, sent, skipped, failed, queued };
}
