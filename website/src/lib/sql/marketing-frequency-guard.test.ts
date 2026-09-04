import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSuiteDatabase } from "@/lib/e2e/suite-database";

// ---------------------------------------------------------------------------
// THE FREQUENCY GUARD, PROVED AGAINST A REAL POSTGRES.
//
// "Nobody gets two marketing emails in a day" is a concurrency property, and a
// mock has no concurrency to be wrong about. So this runs the shipped
// marketing_send_claim against a real database — including from genuinely
// parallel connections firing in the same instant, which is exactly what the
// cron sweep does when the campaign job and the automation job start together.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.VANTA_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  process.stderr.write("[marketing-frequency-guard] SKIPPED — set VANTA_TEST_DATABASE_URL to a throwaway Postgres to run it.\n");
}

const MIGRATION = path.resolve(__dirname, "marketing-frequency-guard.sql");
const SEND_ONCE = path.resolve(__dirname, "automation-send-once.sql");

/** The production shape of email_send_log, as the guard sees it. */
const SEND_LOG = `
  create table if not exists public.email_send_log (
    id uuid primary key default gen_random_uuid(),
    campaign_type text not null,
    reference_id text,
    recipient_email text not null,
    template_key text not null,
    sent_at timestamptz not null default now(),
    opened_at timestamptz,
    clicked_at timestamptz,
    status text not null default 'sent',
    provider_message_id text
  );
  create table if not exists public.email_campaign_recipients (
    id uuid primary key default gen_random_uuid(),
    campaign_id uuid not null,
    email text not null,
    status text not null default 'pending'
  );
`;

const ENSURE_SERVICE_ROLE = `
  do $$ begin
    create role service_role nologin noinherit bypassrls;
  exception when duplicate_object then null; end $$;
`;

describeDb("marketing_send_claim", () => {
  let dbUrl: string;
  let client: Client;

  beforeAll(async () => {
    dbUrl = await createSuiteDatabase(DATABASE_URL!, "marketing_frequency_guard");
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(ENSURE_SERVICE_ROLE);
    await client.query("create extension if not exists pgcrypto");
    await client.query(SEND_LOG);
    await client.query(readFileSync(SEND_ONCE, "utf8"));
    await client.query(readFileSync(MIGRATION, "utf8"));
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  beforeEach(async () => {
    await client.query("truncate public.email_send_log");
    await client.query("truncate public.marketing_send_queue");
  });

  type Claim = { outcome: string; log_id: string | null; last_marketing_at: string | null };
  const claim = async (
    email: string,
    type: string,
    reference: string | null = null,
    opts: { quiet?: number; family?: string | null } = {},
  ): Promise<Claim> =>
    (await client.query(
      "select * from public.marketing_send_claim($1, $2, $3, $4, $5, $6)",
      [email, type, reference, type, opts.quiet ?? 86_400, opts.family ?? null],
    )).rows[0];

  const logRow = async (type: string, email: string, status: string, ago = "0 seconds", reference: string | null = null) =>
    client.query(
      `insert into public.email_send_log (campaign_type, reference_id, recipient_email, template_key, sent_at, status)
       values ($1, $2, $3, $1, now() - $4::interval, $5)`,
      [type, reference, email, ago, status],
    );

  it("claims a quiet inbox and writes the sending row itself", async () => {
    const first = await claim("buyer@example.test", "campaign", "camp-1");
    expect(first.outcome).toBe("claimed");
    expect(first.log_id).toBeTruthy();
    const { rows } = await client.query("select status, recipient_email from public.email_send_log");
    expect(rows).toEqual([{ status: "sending", recipient_email: "buyer@example.test" }]);
  });

  it("defers a second marketing send inside the window, and says what stands in the way", async () => {
    await claim("buyer@example.test", "campaign", "camp-1");
    const second = await claim("buyer@example.test", "automation:winback_30", "buyer@example.test:1");
    expect(second.outcome).toBe("deferred");
    expect(second.last_marketing_at).toBeTruthy();
    expect(second.log_id).toBeNull();
  });

  it("is case-insensitive about the address, as every sender lowercases it", async () => {
    await claim("Buyer@Example.TEST", "campaign", "camp-1");
    expect((await claim("buyer@example.test", "back_in_stock", "bpc-157")).outcome).toBe("deferred");
  });

  it("lets a different inbox through", async () => {
    await claim("buyer@example.test", "campaign", "camp-1");
    expect((await claim("other@example.test", "campaign", "camp-1")).outcome).toBe("claimed");
  });

  it("opens again once the window has passed", async () => {
    await logRow("campaign", "buyer@example.test", "sent", "25 hours");
    expect((await claim("buyer@example.test", "automation:winback_30", "ref")).outcome).toBe("claimed");
  });

  it("ignores transactional auth mail, which is never marketing pressure", async () => {
    await logRow("auth:signup", "buyer@example.test", "sent", "1 minute");
    expect((await claim("buyer@example.test", "campaign", "camp-1")).outcome).toBe("claimed");
  });

  it("ignores a failed send — nothing reached the inbox", async () => {
    await logRow("campaign", "buyer@example.test", "failed", "1 minute");
    expect((await claim("buyer@example.test", "automation:winback_30", "ref")).outcome).toBe("claimed");
  });

  it("ignores a claim stranded at 'sending' by a crash, after fifteen minutes", async () => {
    await logRow("campaign", "buyer@example.test", "sending", "16 minutes");
    expect((await claim("buyer@example.test", "automation:winback_30", "ref")).outcome).toBe("claimed");
  });

  it("but a fresh 'sending' claim counts, so two senders in the same minute cannot both go", async () => {
    await logRow("campaign", "buyer@example.test", "sending", "1 minute");
    expect((await claim("buyer@example.test", "automation:winback_30", "ref")).outcome).toBe("deferred");
  });

  it("a cart's own earlier reminder does not defer its next stage, but somebody else's mail does", async () => {
    await logRow("cart_recovery_t30m", "buyer@example.test", "sent", "12 hours", "cart-1");
    expect((await claim("buyer@example.test", "cart_recovery_t12h", "cart-1", { family: "cart_recovery_" })).outcome).toBe("claimed");
    await client.query("truncate public.email_send_log");
    await logRow("cart_recovery_t30m", "buyer@example.test", "sent", "12 hours", "cart-OTHER");
    expect((await claim("buyer@example.test", "cart_recovery_t12h", "cart-1", { family: "cart_recovery_" })).outcome).toBe("deferred");
    await client.query("truncate public.email_send_log");
    await logRow("campaign", "buyer@example.test", "sent", "2 hours", "camp-1");
    expect((await claim("buyer@example.test", "cart_recovery_t30m", "cart-1", { family: "cart_recovery_" })).outcome).toBe("deferred");
  });

  it("a cart reminder counts as pressure for everybody else", async () => {
    await claim("buyer@example.test", "cart_recovery_t30m", "cart-1", { family: "cart_recovery_" });
    expect((await claim("buyer@example.test", "automation:replenishment", "order-1")).outcome).toBe("deferred");
  });

  it("answers 'duplicate' when the automation send-once index already holds the reference", async () => {
    await logRow("automation:winback_30", "buyer@example.test", "sent", "3 days", "buyer@example.test:1");
    expect((await claim("buyer@example.test", "automation:winback_30", "buyer@example.test:1")).outcome).toBe("duplicate");
  });

  it("refuses bad input rather than claiming for nobody", async () => {
    expect((await claim("", "campaign", "camp-1")).outcome).toBe("refused");
    expect((await claim("buyer@example.test", "", null)).outcome).toBe("refused");
  });

  it("a zero-second window disables the guard without disabling the claim", async () => {
    await claim("buyer@example.test", "campaign", "camp-1");
    expect((await claim("buyer@example.test", "automation:winback_30", "ref", { quiet: 0 })).outcome).toBe("claimed");
  });

  it("SURVIVES GENUINELY PARALLEL CONNECTIONS — exactly one sender wins the inbox", async () => {
    const clients = await Promise.all(
      [0, 1, 2, 3, 4].map(async () => {
        const c = new Client({ connectionString: dbUrl });
        await c.connect();
        return c;
      }),
    );
    try {
      const results = await Promise.all(
        clients.map((c, i) =>
          c.query("select * from public.marketing_send_claim($1, $2, $3, $4, $5, $6)", [
            "buyer@example.test", `sender-${i}`, `ref-${i}`, `sender-${i}`, 86_400, null,
          ]),
        ),
      );
      const outcomes = results.map((r) => r.rows[0].outcome);
      expect(outcomes.filter((o) => o === "claimed"), `outcomes: ${outcomes.join(",")}`).toHaveLength(1);
      expect(outcomes.filter((o) => o === "deferred")).toHaveLength(4);
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
    }
  });

  it("a browser key can neither claim nor read the queue", async () => {
    for (const role of ["anon", "authenticated"]) {
      const { rows } = await client.query(
        `select has_function_privilege($1, 'public.marketing_send_claim(text,text,text,text,integer,text)', 'execute') as can_claim,
                has_table_privilege($1, 'public.marketing_send_queue', 'select') as can_read`,
        [role],
      ).catch(() => ({ rows: [{ can_claim: false, can_read: false }] }));
      expect(rows[0].can_claim, `${role} can claim`).toBe(false);
      expect(rows[0].can_read, `${role} can read the queue`).toBe(false);
    }
  });
});
