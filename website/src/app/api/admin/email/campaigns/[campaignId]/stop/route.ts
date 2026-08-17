import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Stop a campaign that is already sending.
 *
 * WHY THIS EXISTS. Everything else in this system is designed so a send cannot
 * go wrong quietly — the audience count is exact before you press the button,
 * the queue can't double-send, a test can't reach customers. None of that helps
 * with the one mistake an operator actually makes: pressing Send on the wrong
 * audience, and realising three seconds later. Without this the campaign simply
 * continues, one cron batch at a time, and there is nothing to do but watch.
 *
 * WHAT IT DOES AND DOES NOT DO. It stops FURTHER sending. Mail already handed
 * to the provider is gone and no button can recall it — so this deliberately
 * does not pretend to "cancel" the campaign. It moves the campaign out of
 * 'sending' so the sweep stops picking it up, and returns every recipient who
 * has not yet been sent to a terminal 'cancelled' state so a later sweep cannot
 * resume them either. What was sent stays sent, stays counted, and stays
 * visible in the history — an operator needs to know exactly how far it got.
 *
 * Rows mid-flight in 'claiming' are cancelled too. A worker holding one may
 * still deliver it, which is why the count returned is "not sent" rather than
 * "definitely not delivered"; being honest about that beats a number that
 * implies more control than exists.
 */
export async function POST(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage email campaigns." }, { status: 403 });
  }

  const { campaignId } = await context.params;

  const { data: campaign } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, name, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  }
  if (!["sending", "scheduled"].includes(String(campaign.status))) {
    return NextResponse.json(
      { success: false, error: `This campaign is "${campaign.status}" — there is nothing in flight to stop.` },
      { status: 409 },
    );
  }

  // Take it out of the sweep's reach FIRST. If the two updates were the other
  // way round, a sweep landing in between would claim the rows we just
  // cancelled and carry on sending.
  const { error: statusError } = await supabaseAdmin
    .from("email_campaigns")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("id", campaignId);
  if (statusError) {
    return NextResponse.json({ success: false, error: statusError.message }, { status: 400 });
  }

  const { data: stopped, error: rowsError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "cancelled", claimed_at: null, error: "stopped by an administrator" })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "claiming"])
    .select("id");
  if (rowsError) {
    return NextResponse.json({ success: false, error: rowsError.message }, { status: 400 });
  }

  const notSent = (stopped ?? []).length;

  const { count: alreadySent } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "sent");

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "email_campaign_stopped",
    target_table: "email_campaigns",
    target_id: campaignId,
    metadata: {
      campaignName: campaign.name,
      alreadySent: alreadySent ?? 0,
      stoppedBeforeSending: notSent,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({
    success: true,
    alreadySent: alreadySent ?? 0,
    stoppedBeforeSending: notSent,
  });
}
