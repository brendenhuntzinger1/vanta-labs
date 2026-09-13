import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EVERY OPEN AND CLICK IS KEPT, RAW, WITH WHAT FETCHED IT.
 *
 * The first-touch columns answer "did anyone ever open it"; they cannot say
 * whether the fetch at eight seconds was a person. These tests pin the writer
 * that keeps the evidence, and the two paths that feed it: the cart-recovery
 * trackers (addressed by reservation) and the provider webhook (addressed by
 * message id, which must be resolved even when the first touch was already
 * stamped).
 */

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  inserts: [] as Array<{ table: string; row: Row }>,
  failInserts: false,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "update" = "select";
    let patch: Row = {};
    // ORDER AND LIMIT ARE REAL HERE, not no-ops. stampSendLogEngagement picks
    // the NEWEST matching send, and a fake that ignores the ordering would
    // report a pass for code that stamped the oldest.
    let sortBy: { column: string; ascending: boolean } | null = null;
    let cap: number | null = null;
    const matching = () => {
      let rows = (db.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      if (sortBy) {
        const { column, ascending } = sortBy;
        rows = [...rows].sort((a, b) => {
          const left = String(a[column] ?? "");
          const right = String(b[column] ?? "");
          return ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
      }
      return cap === null ? rows : rows.slice(0, cap);
    };
    const settle = () => {
      const rows = matching();
      if (mode === "update") for (const row of rows) Object.assign(row, patch);
      return { data: rows, error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (value: Row) => { mode = "update"; patch = value; return builder; },
      insert: (value: Row) => {
        if (db.failInserts) throw new Error("insert refused");
        db.inserts.push({ table, row: value });
        return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
      },
      eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return builder; },
      in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return builder; },
      is: (col: string, value: unknown) => { filters.push((r) => (r[col] ?? null) === value); return builder; },
      order: (column: string, options?: { ascending?: boolean }) => {
        sortBy = { column, ascending: options?.ascending !== false };
        return builder;
      },
      limit: (n: number) => { cap = n; return builder; },
      maybeSingle: () => Promise.resolve({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return builder;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));

import {
  findSendLogIdentityByMessageId,
  recordEngagementEvent,
  stampCartRecoveryEngagement,
} from "@/lib/email/engagement";

beforeEach(() => {
  db.inserts = [];
  db.failInserts = false;
  db.tables = {
    email_send_log: [],
    abandoned_cart_emails: [],
    email_delivery_events: [],
    email_suppressions: [],
  };
});

describe("recordEngagementEvent", () => {
  it("writes the send identity, the kind, the source, the time and the agent", async () => {
    const ok = await recordEngagementEvent({
      kind: "opened",
      source: "pixel",
      campaignType: "cart_recovery_t30m",
      referenceId: "cart-1",
      recipientEmail: "Buyer@Example.com",
      userAgent: "Mozilla/5.0 (via ggpht.com GoogleImageProxy)",
      at: "2026-09-10T17:46:00.000Z",
    });
    expect(ok).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].table).toBe("email_engagement_events");
    expect(db.inserts[0].row).toMatchObject({
      kind: "opened",
      source: "pixel",
      campaign_type: "cart_recovery_t30m",
      reference_id: "cart-1",
      recipient_email: "buyer@example.com",
      user_agent: "Mozilla/5.0 (via ggpht.com GoogleImageProxy)",
      at: "2026-09-10T17:46:00.000Z",
    });
  });

  it("truncates a long user agent and keeps a missing one null", async () => {
    await recordEngagementEvent({ kind: "clicked", source: "click", campaignType: "campaign", referenceId: "c-1", recipientEmail: "a@b.co", userAgent: "x".repeat(1000) });
    await recordEngagementEvent({ kind: "clicked", source: "click", campaignType: "campaign", referenceId: "c-1", recipientEmail: "a@b.co", userAgent: null });
    expect(String(db.inserts[0].row.user_agent)).toHaveLength(300);
    expect(db.inserts[1].row.user_agent).toBeNull();
  });

  it("never throws: an insert failure returns false and records nothing", async () => {
    db.failInserts = true;
    await expect(recordEngagementEvent({ kind: "opened", source: "pixel", campaignType: "campaign", referenceId: "c-1", recipientEmail: null, userAgent: null })).resolves.toBe(false);
  });

  it("refuses to write a row with no send identity", async () => {
    await expect(recordEngagementEvent({ kind: "opened", source: "pixel", campaignType: "", referenceId: null, recipientEmail: null, userAgent: null })).resolves.toBe(false);
    expect(db.inserts).toHaveLength(0);
  });
});

describe("the cart-recovery tracker records an event beside the first-touch stamp", () => {
  it("resolves the reservation to the cart and stage, stamps first touch, and writes the event every time", async () => {
    db.tables.abandoned_cart_emails = [{ id: "res-1", abandoned_cart_id: "cart-9", stage: "t24h" }];
    db.tables.email_send_log = [{ id: "send-1", campaign_type: "cart_recovery_t24h", reference_id: "cart-9", sent_at: "2026-09-10T10:00:00.000Z", opened_at: null, recipient_email: "b@example.com" }];
    await stampCartRecoveryEngagement("opened", "res-1", { userAgent: "Mozilla/5.0 (iPhone)" });
    await stampCartRecoveryEngagement("opened", "res-1", { userAgent: "Mozilla/5.0 (iPhone)" });
    // First touch stamped once…
    expect(db.tables.email_send_log[0].opened_at).toBeTruthy();
    // …and two events kept, because the second open is still an open.
    const events = db.inserts.filter((i) => i.table === "email_engagement_events");
    expect(events).toHaveLength(2);
    expect(events[0].row).toMatchObject({ campaign_type: "cart_recovery_t24h", reference_id: "cart-9", kind: "opened", source: "pixel", user_agent: "Mozilla/5.0 (iPhone)" });
  });

  it("writes nothing for an unknown reservation", async () => {
    await stampCartRecoveryEngagement("clicked", "nope", { userAgent: "x" });
    expect(db.inserts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // ONE OPEN IS ONE OPEN, EVEN AFTER AN ADMIN RESEND.
  //
  // A cart-recovery stage is NOT one-row-per-reference, though this module used
  // to say it was: resendCartRecoveryEmail claims through marketing_send_claim
  // with the same campaign_type and the same cart id, so each press of the
  // resend button adds another email_send_log row under that one key. The stamp
  // was a filtered UPDATE, so a single fetch of a single pixel stamped BOTH —
  // and the ledger reported two opens for one.
  // -------------------------------------------------------------------------
  it("stamps only the newest send when a stage has been resent", async () => {
    db.tables.abandoned_cart_emails = [{ id: "res-1", abandoned_cart_id: "cart-9", stage: "t72h" }];
    db.tables.email_send_log = [
      { id: "original", campaign_type: "cart_recovery_t72h", reference_id: "cart-9", sent_at: "2026-09-10T10:00:00.000Z", opened_at: null },
      { id: "resend", campaign_type: "cart_recovery_t72h", reference_id: "cart-9", sent_at: "2026-09-12T10:00:00.000Z", opened_at: null },
    ];
    await stampCartRecoveryEngagement("opened", "res-1", { userAgent: "Mozilla/5.0 (iPhone)" });
    const stamped = db.tables.email_send_log.filter((row) => row.opened_at);
    expect(stamped).toHaveLength(1);
    expect(stamped[0].id).toBe("resend");
  });

  it("falls back to the earlier send once the newest is already stamped", async () => {
    // Not a second credit for the same fetch: this is a genuinely separate
    // open, and the row it lands on is the one still unaccounted for.
    db.tables.abandoned_cart_emails = [{ id: "res-1", abandoned_cart_id: "cart-9", stage: "t72h" }];
    db.tables.email_send_log = [
      { id: "original", campaign_type: "cart_recovery_t72h", reference_id: "cart-9", sent_at: "2026-09-10T10:00:00.000Z", opened_at: null },
      { id: "resend", campaign_type: "cart_recovery_t72h", reference_id: "cart-9", sent_at: "2026-09-12T10:00:00.000Z", opened_at: "2026-09-12T10:05:00.000Z" },
    ];
    await stampCartRecoveryEngagement("opened", "res-1", { userAgent: "Mozilla/5.0 (iPhone)" });
    expect(db.tables.email_send_log.find((row) => row.id === "original")?.opened_at).toBeTruthy();
  });
});

describe("findSendLogIdentityByMessageId", () => {
  it("returns the identity whether or not the first touch was already stamped", async () => {
    db.tables.email_send_log = [{ provider_message_id: "m-1", campaign_type: "automation:welcome_intro", reference_id: "a@b.co", recipient_email: "a@b.co", opened_at: "2026-09-10T00:00:00Z" }];
    await expect(findSendLogIdentityByMessageId("m-1")).resolves.toEqual({ campaignType: "automation:welcome_intro", referenceId: "a@b.co", recipientEmail: "a@b.co" });
    await expect(findSendLogIdentityByMessageId("m-2")).resolves.toBeNull();
    await expect(findSendLogIdentityByMessageId("")).resolves.toBeNull();
  });
});
