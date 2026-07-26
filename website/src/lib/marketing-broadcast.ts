import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { couponAnnouncementTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";
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

  const userIds = Array.from(new Set((data ?? []).map((row) => row.user_id).filter(Boolean)));

  const emails = new Set<string>();
  for (const userId of userIds) {
    try {
      const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
      const email = userData?.user?.email?.trim().toLowerCase();
      if (email) {
        emails.add(email);
      }
    } catch {
      // Skip a user we can't resolve; the rest of the list still sends.
    }
  }

  // Union the email-keyed opt-in list (guests + at-checkout opt-ins). Best-
  // effort: if the table isn't present yet, fall back to account opt-ins only.
  try {
    const { data: subs } = await supabaseAdmin
      .from("marketing_subscribers")
      .select("email")
      .is("unsubscribed_at", null);
    for (const row of subs ?? []) {
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
export async function recordMarketingOptIn(email: string, source: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return;
  try {
    await supabaseAdmin
      .from("marketing_subscribers")
      .upsert(
        { email: normalized, source, opted_in_at: new Date().toISOString(), unsubscribed_at: null },
        { onConflict: "email" },
      );
  } catch {
    // Table missing (migration not run) or transient error — silently skip.
  }
}

export function couponDiscountLabel(coupon: Pick<AdminCoupon, "discountType" | "discountValue">): string {
  return coupon.discountType === "fixed"
    ? `$${coupon.discountValue.toFixed(2)} off`
    : `${coupon.discountValue}% off`;
}

export interface BroadcastResult {
  recipients: number;
  sent: number;
  skipped: number;
  failed: number;
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

  // Load everyone who already received THIS coupon announcement in ONE query,
  // instead of a per-recipient lookup inside the loop (was O(N) round-trips).
  const { data: sentRows } = await supabaseAdmin
    .from("email_send_log")
    .select("recipient_email")
    .eq("campaign_type", "coupon_announcement")
    .eq("reference_id", input.coupon.id);
  const alreadySent = new Set(
    (sentRows ?? []).map((row) => String(row.recipient_email ?? "").trim().toLowerCase()),
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
      referenceId: input.coupon.id,
      templateKey: "coupon_announcement",
      ...template,
    });

    if (result.success) {
      sent++;
    } else if (result.suppressed) {
      skipped++;
    } else {
      failed++;
    }
  }

  return { recipients: emails.length, sent, skipped, failed };
}
