import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// "NO ONE HAS OPENED THE EMAILS."
//
// They had. Cart recovery ran at a 40% open rate for six weeks and the number
// lived in `abandoned_cart_emails`, a table no report reads. Campaigns wrote
// theirs to `email_campaign_recipients`, automations to `email_send_log`, and
// the provider's own `email.opened` events were parsed into `kind: "ignored"`
// and dropped on the floor — so switching Resend's open tracking on would have
// recorded precisely nothing.
//
// Four channels, four different homes, no shared answer to "did they open it",
// and two of the four invisible. What these tests hold in place:
//
//   * the parser understands an open and a click, from either provider;
//   * an open reported by the provider is joined back to the send that caused
//     it, and mirrored into whichever per-channel table owns that send;
//   * a campaign open stamps ONE recipient's row, never every row sharing the
//     campaign's reference_id — that mistake reports 100% opens;
//   * the ledger separates "not opened" from "carries no tracking", because
//     collapsing those two is exactly what produced the belief above;
//   * a send with no message id (auth mail: GoTrue sends it, we never see the
//     provider's response) can still be shown as delivered, matched by address
//     and time, and is labelled as the weaker evidence it is.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Every update applied, so a test can assert what was written and where. */
  updates: [] as Array<{ table: string; patch: Row; matched: number }>,
}));

vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "update" | "upsert" = "select";
    let patch: Row = {};
    let limit = Infinity;
    let rangeFrom = 0;
    let rangeTo = Infinity;

    const matching = () => (db.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));

    const settle = () => {
      const rows = matching().slice(0, limit).slice(rangeFrom, rangeTo + 1);
      if (mode === "update") {
        for (const row of rows) Object.assign(row, patch);
        db.updates.push({ table, patch: { ...patch }, matched: rows.length });
      }
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (value: Row) => { mode = "update"; patch = value; return builder; },
      upsert: (value: Row) => { mode = "upsert"; (db.tables[table] ??= []).push({ ...value }); return builder; },
      eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return builder; },
      neq: (col: string, value: unknown) => { filters.push((r) => r[col] !== value); return builder; },
      in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return builder; },
      is: (col: string, value: unknown) => { filters.push((r) => (r[col] ?? null) === value); return builder; },
      order: () => builder,
      // The ledger's delivery-event joins are paged and time-bounded now: an
      // unpaged read silently returns a 1000-row prefix on real Supabase, and
      // the local stand-in caps nothing, so the read could only be wrong in
      // production. The fake models the shape rather than the cap.
      gte: (col: string, value: unknown) => { filters.push((r) => String(r[col] ?? "") >= String(value)); return builder; },
      range: (from: number, to: number) => { rangeFrom = from; rangeTo = to; return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  };
  return { supabaseAdmin: { from, auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } } } };
});

import { applyDeliveryEvents, parseDeliveryEvents } from "@/lib/email/delivery-events";
import { stampCampaignEngagement, stampCartRecoveryEngagement } from "@/lib/email/engagement";
import { channelHasOpenTracking, describeSendChannel, loadSendLedger } from "@/lib/email/send-ledger";

const RESEND_ID = "6229f547-f3f1-4b7f-b5f9-1a2b3c4d5e6f";
const resend = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, data: { email_id: RESEND_ID, to: ["Buyer@Example.com"], ...extra } });

beforeEach(() => {
  db.updates = [];
  db.tables = {
    email_send_log: [],
    email_delivery_events: [],
    email_campaign_recipients: [],
    abandoned_cart_emails: [],
    email_suppressions: [],
  };
});

// ---------------------------------------------------------------------------

describe("the parser understands engagement, not just failure", () => {
  it("reads email.opened as an open", () => {
    const [event] = parseDeliveryEvents(resend("email.opened"));
    expect(event.kind).toBe("opened");
    expect(event.providerMessageId).toBe(RESEND_ID);
  });

  it("reads email.clicked as a click", () => {
    expect(parseDeliveryEvents(resend("email.clicked"))[0].kind).toBe("clicked");
  });

  it("does not treat an open as any kind of failure", () => {
    // The suppression path keys off these two names. An open landing in either
    // would unsubscribe people for reading their mail.
    const [event] = parseDeliveryEvents(resend("email.opened"));
    expect(["hard_bounce", "soft_bounce", "complaint"]).not.toContain(event.kind);
  });

  it("reads SendGrid's open and click the same way", () => {
    const events = parseDeliveryEvents([
      { event: "open", email: "a@example.com", sg_message_id: "sg-1" },
      { event: "click", email: "b@example.com", sg_message_id: "sg-2" },
    ]);
    expect(events.map((e) => e.kind)).toEqual(["opened", "clicked"]);
  });

  it("still drops a genuinely unknown event kind rather than inventing one", () => {
    expect(parseDeliveryEvents(resend("email.scheduled"))[0].kind).toBe("ignored");
  });
});

// ---------------------------------------------------------------------------

describe("a provider open is joined back to the send that caused it", () => {
  it("stamps the send log and mirrors a campaign open onto that recipient's row", async () => {
    db.tables.email_send_log = [{
      id: "log-1",
      campaign_type: "campaign",
      reference_id: "camp-1",
      recipient_email: "buyer@example.com",
      status: "sent",
      provider_message_id: RESEND_ID,
      opened_at: null,
      clicked_at: null,
    }];
    db.tables.email_campaign_recipients = [
      { campaign_id: "camp-1", email: "buyer@example.com", opened_at: null },
      { campaign_id: "camp-1", email: "someone-else@example.com", opened_at: null },
    ];

    const outcome = await applyDeliveryEvents(parseDeliveryEvents(resend("email.opened")));

    expect(outcome.engaged).toBe(1);
    expect(outcome.suppressed).toBe(0);
    expect(db.tables.email_send_log[0].opened_at).toBeTruthy();
    expect(db.tables.email_campaign_recipients[0].opened_at).toBeTruthy();
    // The other recipient of the same campaign did not open anything.
    expect(db.tables.email_campaign_recipients[1].opened_at).toBeNull();
  });

  it("mirrors a cart-recovery open onto the right stage of the right cart", async () => {
    db.tables.email_send_log = [{
      id: "log-2",
      campaign_type: "cart_recovery_t24h",
      reference_id: "cart-9",
      recipient_email: "buyer@example.com",
      status: "sent",
      provider_message_id: RESEND_ID,
      opened_at: null,
      clicked_at: null,
    }];
    db.tables.abandoned_cart_emails = [
      { id: "res-1", abandoned_cart_id: "cart-9", stage: "t24h", opened_at: null, clicked_at: null },
      { id: "res-2", abandoned_cart_id: "cart-9", stage: "t72h", opened_at: null, clicked_at: null },
    ];

    await applyDeliveryEvents(parseDeliveryEvents(resend("email.opened")));

    expect(db.tables.abandoned_cart_emails[0].opened_at).toBeTruthy();
    expect(db.tables.abandoned_cart_emails[1].opened_at).toBeNull();
  });

  it("records a click in clicked_at and leaves opened_at alone", async () => {
    db.tables.email_send_log = [{
      id: "log-3", campaign_type: "automation:welcome_intro", reference_id: "u-1",
      recipient_email: "buyer@example.com", status: "sent", provider_message_id: RESEND_ID,
      opened_at: null, clicked_at: null,
    }];

    await applyDeliveryEvents(parseDeliveryEvents(resend("email.clicked")));

    expect(db.tables.email_send_log[0].clicked_at).toBeTruthy();
    expect(db.tables.email_send_log[0].opened_at).toBeNull();
  });

  it("keeps the first open, so the timestamp means when they first read it", async () => {
    db.tables.email_send_log = [{
      id: "log-4", campaign_type: "campaign", reference_id: "camp-1",
      recipient_email: "buyer@example.com", status: "sent", provider_message_id: RESEND_ID,
      opened_at: "2026-09-01T00:00:00.000Z", clicked_at: null,
    }];

    const outcome = await applyDeliveryEvents(parseDeliveryEvents(resend("email.opened")));

    expect(db.tables.email_send_log[0].opened_at).toBe("2026-09-01T00:00:00.000Z");
    // Nothing was matched, so nothing is claimed to have been.
    expect(outcome.engaged).toBe(0);
  });

  it("survives an open for a message id no send recorded", async () => {
    // Auth mail, or anything sent before message-id capture landed. The event
    // is still logged; there is simply nothing to join it to.
    const outcome = await applyDeliveryEvents(parseDeliveryEvents(resend("email.opened")));
    expect(outcome.engaged).toBe(0);
    expect(outcome.writeFailed).toBe(false);
  });

  it("never suppresses anyone for opening or clicking", async () => {
    db.tables.email_send_log = [{
      id: "log-5", campaign_type: "campaign", reference_id: "camp-1",
      recipient_email: "buyer@example.com", status: "sent", provider_message_id: RESEND_ID,
      opened_at: null, clicked_at: null,
    }];
    await applyDeliveryEvents(parseDeliveryEvents(resend("email.opened")));
    await applyDeliveryEvents(parseDeliveryEvents(resend("email.clicked")));
    expect(db.tables.email_suppressions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("first-party trackers write to the same one table", () => {
  it("a campaign pixel stamps only the recipient who opened", async () => {
    db.tables.email_send_log = [
      { id: "a", campaign_type: "campaign", reference_id: "camp-1", recipient_email: "one@example.com", opened_at: null },
      { id: "b", campaign_type: "campaign", reference_id: "camp-1", recipient_email: "two@example.com", opened_at: null },
    ];

    expect(await stampCampaignEngagement("opened", "camp-1", "ONE@example.com")).toBe(true);
    expect(db.tables.email_send_log[0].opened_at).toBeTruthy();
    expect(db.tables.email_send_log[1].opened_at).toBeNull();
  });

  it("an affiliate broadcast is matched too — same table, different campaign_type", async () => {
    db.tables.email_send_log = [
      { id: "a", campaign_type: "affiliate_campaign", reference_id: "camp-2", recipient_email: "amb@example.com", clicked_at: null },
    ];
    expect(await stampCampaignEngagement("clicked", "camp-2", "amb@example.com")).toBe(true);
    expect(db.tables.email_send_log[0].clicked_at).toBeTruthy();
  });

  it("a cart-recovery pixel resolves its reservation to the cart and stage", async () => {
    db.tables.abandoned_cart_emails = [{ id: "res-1", abandoned_cart_id: "cart-9", stage: "t30m" }];
    db.tables.email_send_log = [
      { id: "a", campaign_type: "cart_recovery_t30m", reference_id: "cart-9", recipient_email: "x@example.com", opened_at: null },
      { id: "b", campaign_type: "cart_recovery_t72h", reference_id: "cart-9", recipient_email: "x@example.com", opened_at: null },
    ];

    expect(await stampCartRecoveryEngagement("opened", "res-1")).toBe(true);
    expect(db.tables.email_send_log[0].opened_at).toBeTruthy();
    expect(db.tables.email_send_log[1].opened_at).toBeNull();
  });

  it("an unknown reservation stamps nothing and does not throw", async () => {
    expect(await stampCartRecoveryEngagement("opened", "does-not-exist")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the ledger tells untracked apart from unopened", () => {
  it("names each kind of mail in words rather than slugs", () => {
    expect(describeSendChannel("cart_recovery_t24h")).toBe("Cart recovery · 24 h");
    expect(describeSendChannel("auth:password_reset")).toBe("Password reset");
    expect(describeSendChannel("automation:welcome_intro")).toBe("Automation · welcome intro");
    expect(describeSendChannel("campaign")).toBe("Campaign");
  });

  it("knows account mail carries no open tracking, and marketing mail does", () => {
    // A remote image in a password reset is a phishing signature. Reporting
    // that as a 0% open rate is what made every channel look dead.
    expect(channelHasOpenTracking("auth:signup_confirmation")).toBe(false);
    expect(channelHasOpenTracking("cart_recovery_t30m")).toBe(true);
    expect(channelHasOpenTracking("campaign")).toBe(true);
  });

  it("keeps untracked sends out of the open denominator entirely", async () => {
    db.tables.email_send_log = [
      { id: "1", campaign_type: "auth:signup_confirmation", recipient_email: "a@example.com", status: "sent", sent_at: "2026-09-05T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: null },
      { id: "2", campaign_type: "cart_recovery_t30m", recipient_email: "b@example.com", status: "sent", sent_at: "2026-09-05T09:00:00.000Z", opened_at: "2026-09-05T09:10:00.000Z", clicked_at: null, provider_message_id: "m-2" },
    ];
    db.tables.email_delivery_events = [];

    const ledger = await loadSendLedger();

    expect(ledger.totals.sent).toBe(2);
    // One tracked send, one open. Not "one open out of two", which would read
    // as a 50% open rate over a message that cannot be opened-tracked at all.
    expect(ledger.totals.openTracked).toBe(1);
    expect(ledger.totals.opened).toBe(1);
    expect(ledger.rows.find((r) => r.id === "1")?.openTracked).toBe(false);
  });

  it("proves delivery of auth mail by address and time, and says that is how", async () => {
    db.tables.email_send_log = [{
      id: "1", campaign_type: "auth:signup_confirmation", recipient_email: "a@example.com",
      status: "sent", sent_at: "2026-09-05T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: null,
    }];
    db.tables.email_delivery_events = [
      { provider_message_id: "unknown-to-us", recipient_email: "a@example.com", kind: "delivered", received_at: "2026-09-05T10:00:12.000Z" },
    ];

    const ledger = await loadSendLedger();
    const row = ledger.rows[0];

    expect(row.delivered).toBe(true);
    expect(row.deliveryEvidence).toBe("address");
    expect(ledger.totals.deliveryKnown).toBe(1);
  });

  it("will not credit a delivery from hours later to this send", async () => {
    db.tables.email_send_log = [{
      id: "1", campaign_type: "auth:signup_confirmation", recipient_email: "a@example.com",
      status: "sent", sent_at: "2026-09-05T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: null,
    }];
    db.tables.email_delivery_events = [
      { provider_message_id: "x", recipient_email: "a@example.com", kind: "delivered", received_at: "2026-09-05T18:00:00.000Z" },
    ];

    const ledger = await loadSendLedger();
    expect(ledger.rows[0].delivered).toBe(false);
    expect(ledger.rows[0].deliveryEvidence).toBe("none");
    // Unknown, not "not delivered": the denominator excludes it.
    expect(ledger.totals.deliveryKnown).toBe(0);
  });

  it("counts an open as proof of delivery, because it is stronger than a receipt", async () => {
    // A mail client cannot fetch an image out of a message that never arrived.
    // Without this, a send whose only event was an open read "0 of 1 delivered"
    // on the same row as "1 opened".
    db.tables.email_send_log = [{
      id: "1", campaign_type: "campaign", recipient_email: "a@example.com",
      status: "sent", sent_at: "2026-09-05T10:00:00.000Z", opened_at: "2026-09-05T10:05:00.000Z",
      clicked_at: null, provider_message_id: "m-1",
    }];
    db.tables.email_delivery_events = [
      { provider_message_id: "m-1", recipient_email: "a@example.com", kind: "opened", received_at: "2026-09-05T10:05:00.000Z" },
    ];

    const ledger = await loadSendLedger();
    expect(ledger.rows[0].delivered).toBe(true);
    expect(ledger.totals.delivered).toBe(1);
  });

  it("names the Supabase-sent confirmation rather than showing its slug", () => {
    expect(describeSendChannel("auth:signup_confirmation_supabase_fallback"))
      .toBe("Signup confirmation (Supabase)");
  });

  it("prefers the exact message-id join when one exists", async () => {
    db.tables.email_send_log = [{
      id: "1", campaign_type: "campaign", recipient_email: "a@example.com",
      status: "sent", sent_at: "2026-09-05T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: "m-1",
    }];
    db.tables.email_delivery_events = [
      { provider_message_id: "m-1", recipient_email: "a@example.com", kind: "delivered", received_at: "2026-09-05T10:00:05.000Z" },
    ];

    const ledger = await loadSendLedger();
    expect(ledger.rows[0].deliveryEvidence).toBe("message-id");
  });

  it("shows a failed send but counts it in no denominator", async () => {
    db.tables.email_send_log = [
      { id: "1", campaign_type: "campaign", recipient_email: "a@example.com", status: "failed", sent_at: "2026-09-05T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: null },
    ];

    const ledger = await loadSendLedger();
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.totals.sent).toBe(0);
    expect(ledger.totals.openTracked).toBe(0);
  });

  it("groups by kind of mail so cart recovery is visible on its own", async () => {
    db.tables.email_send_log = [
      { id: "1", campaign_type: "cart_recovery_t30m", recipient_email: "a@example.com", status: "sent", sent_at: "2026-09-05T10:00:00.000Z", opened_at: "x", clicked_at: null, provider_message_id: null },
      { id: "2", campaign_type: "cart_recovery_t30m", recipient_email: "b@example.com", status: "sent", sent_at: "2026-09-04T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: null },
      { id: "3", campaign_type: "auth:password_reset", recipient_email: "c@example.com", status: "sent", sent_at: "2026-09-03T10:00:00.000Z", opened_at: null, clicked_at: null, provider_message_id: null },
    ];

    const ledger = await loadSendLedger();
    const recovery = ledger.channels.find((c) => c.channel === "Cart recovery · 1 h");

    expect(recovery).toBeDefined();
    expect(recovery?.sent).toBe(2);
    expect(recovery?.opened).toBe(1);
    expect(recovery?.openTracked).toBe(2);
    expect(ledger.channels.find((c) => c.channel === "Password reset")?.openTracked).toBe(0);
  });
});
