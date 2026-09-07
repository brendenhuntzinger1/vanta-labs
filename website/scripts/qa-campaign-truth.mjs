#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE CAMPAIGN PATH, END TO END, AND THEN ATTACKED.
//
// Companion to qa-automation-truth.mjs. That one proves the automations fire on
// the right day; this one walks a campaign the whole way —
//
//   subscriber → consent → audience → campaign → personalisation →
//   suppression → sendMarketingEmail → provider → unsubscribe → suppression
//
// — against real Postgres and the real /api/cron/sweep, and then tries to break
// each guarantee rather than only confirming it.
//
// THE ADVERSARIAL HALF, which is the point of the file:
//
//   * unsubscribe through the REAL RFC 8058 one-click POST, using the token
//     taken out of the delivered message, then send a SECOND campaign and prove
//     it cannot reach them
//   * prove a GET on the same link changes nothing — link scanners fetch every
//     URL in a message, and a state-changing GET would unsubscribe people who
//     never asked
//   * prove a tampered token is refused
//   * prove a transactional message still reaches that same address, because
//     opting out of marketing must not cost someone their account mail
//   * run the sweep repeatedly and prove no recipient is mailed twice
//
// Development-only; refuses to run against anything but the local harness.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/qa-campaign-truth.mjs
// ---------------------------------------------------------------------------

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CAPTURE = `${process.env.EMAIL_CAPTURE_DIR ?? "/tmp/vanta-qa"}/captured-emails.jsonl`;
const CRON_SECRET = process.env.CRON_SECRET ?? "harness-cron-secret";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);
const DAY = 24 * 60 * 60 * 1000;
const stamp = randomBytes(3).toString("hex");
const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: section_, name, status: "pass", detail });
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`);
    return detail;
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0].slice(0, 300);
    results.push({ section: section_, name, status: "fail", detail: message });
    console.log(`  FAIL  ${name}\n        ${message}`);
    return null;
  }
}

// Byte offsets, not character offsets — statSync().size counts bytes and these
// messages carry em dashes. See the same note in qa-automation-truth.mjs.
const captureMark = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);
function capturedSince(offset) {
  if (!existsSync(CAPTURE)) return [];
  return readFileSync(CAPTURE).subarray(offset).toString("utf8")
    .split("\n").filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
async function waitForCapture(offset, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = capturedSince(offset);
    if (predicate(rows)) return rows;
    if (Date.now() > deadline) return rows;
    await sleep(250);
  }
}

const who = (tag) => `camp-${stamp}-${tag}@example.test`;
// The API refuses a cross-origin POST ("Invalid request origin"), which is a
// CSRF guard and not something to route around — a real browser sends these.
const SAME_ORIGIN = { Origin: BASE, "x-forwarded-proto": new URL(BASE).protocol.replace(":", "") };

async function sweep() {
  const r = await fetch(`${BASE}/api/cron/sweep`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  assert(r.status === 200, `sweep answered ${r.status}`);
  return (await r.json()).emailCampaigns ?? {};
}

/** A campaign with an explicit recipient list, exactly as the composer writes one. */
async function createCampaign(name, emails) {
  const id = randomUUID();
  await q(
    `insert into email_campaigns (id, name, subject, preview_text, headline, body, cta_label, cta_path,
       segment, status, recipient_count, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,'Shop','/products','all','sending',$7, now(), now())`,
    [id, name, `${name} subject`, "preview", "Headline", "Body copy for the campaign.", emails.length],
  );
  for (const email of emails) {
    await q(
      `insert into email_campaign_recipients (campaign_id, email, status, attempts, created_at)
       values ($1,$2,'pending',0, now())`,
      [id, email],
    );
  }
  return id;
}

async function recipientStates(campaignId) {
  const { rows } = await q(
    `select email, status, attempts from email_campaign_recipients where campaign_id = $1 order by email`,
    [campaignId],
  );
  return rows;
}

async function main() {
  console.log(`Campaign truth harness — run ${stamp}`);

  // -------------------------------------------------------------------------
  section("A campaign reaches exactly the right people");
  // -------------------------------------------------------------------------
  let campaignA;
  await step("subscribers, one of them already suppressed", async () => {
    for (const tag of ["a", "b", "sup"]) {
      await q(
        `insert into marketing_subscribers (email, source, opted_in_at) values ($1,'harness',$2)
         on conflict (email) do nothing`,
        [who(tag), new Date(Date.now() - 400 * DAY).toISOString()],
      );
    }
    await q(
      `insert into email_suppressions (email, reason, created_at) values ($1,'complained', now())
       on conflict (email) do update set reason = excluded.reason`,
      [who("sup")],
    );
    campaignA = await createCampaign(`qa-${stamp}-A`, [who("a"), who("b"), who("sup")]);
    return `campaign ${campaignA.slice(0, 8)} with 3 recipients`;
  });

  const markA = captureMark();
  await step("the sweep sends it, and the suppressed address is refused", async () => {
    // The campaign sender works in batches; keep sweeping until it settles.
    for (let i = 0; i < 6; i++) {
      const s = await sweep();
      const states = await recipientStates(campaignA);
      if (states.every((r) => r.status !== "pending" && r.status !== "claiming")) break;
      assert(!s.errors?.length, `campaign errors: ${JSON.stringify(s.errors)}`);
    }
    const states = await recipientStates(campaignA);
    const by = Object.fromEntries(states.map((r) => [r.email, r.status]));
    assert(by[who("a")] === "sent", `${who("a")} is ${by[who("a")]}`);
    assert(by[who("b")] === "sent", `${who("b")} is ${by[who("b")]}`);
    assert(by[who("sup")] === "suppressed", `a complained address is ${by[who("sup")]}, expected suppressed`);
    return states.map((r) => `${r.email.split("-").pop()}=${r.status}`).join(", ");
  });

  let unsubUrl = null;
  await step("the delivered campaign carries a per-recipient one-click opt-out", async () => {
    const rows = await waitForCapture(markA, (all) => all.some((m) => String(m.to) === who("a")));
    const mine = rows.filter((m) => String(m.to ?? "").startsWith(`camp-${stamp}-`));
    const a = mine.find((m) => String(m.to) === who("a"));
    const b = mine.find((m) => String(m.to) === who("b"));
    assert(a, `nothing captured for ${who("a")}`);
    assert(!mine.some((m) => String(m.to) === who("sup")), "the suppressed address received the campaign");

    const header = a.headers?.["list-unsubscribe"] ?? "";
    unsubUrl = header.match(/<(https?:\/\/[^>]+)>/)?.[1] ?? null;
    assert(unsubUrl, `no unsubscribe URL in List-Unsubscribe: ${header}`);
    assert(a.headers?.["list-unsubscribe-post"] === "List-Unsubscribe=One-Click", "no one-click header");
    assert(String(a.text ?? "").length > 0, "no plain-text part");
    assert(/Harness Way/.test(a.text), "no postal address in the plain-text part");
    if (b) {
      const bt = (b.headers?.["list-unsubscribe"] ?? "").match(/token=([0-9a-f]{64})/)?.[1];
      const at = header.match(/token=([0-9a-f]{64})/)?.[1];
      assert(at && bt && at !== bt, "two recipients share one unsubscribe token");
    }
    return "per-recipient token, one-click header, text part, postal address";
  });

  // -------------------------------------------------------------------------
  section("Attacking the opt-out");
  // -------------------------------------------------------------------------
  await step("a GET on the unsubscribe link changes NOTHING (link scanners)", async () => {
    const r = await fetch(unsubUrl, { redirect: "manual" });
    assert(r.status === 200, `GET answered ${r.status}`);
    const { rows } = await q(`select 1 from email_suppressions where email = $1`, [who("a")]);
    assert(rows.length === 0, "a GET suppressed the address — one link scan would opt everyone out");
    return "200, and no suppression row written";
  });

  await step("a tampered token is refused", async () => {
    const bad = unsubUrl.replace(/token=([0-9a-f])/, (m, c) => `token=${c === "a" ? "b" : "a"}`);
    const r = await fetch(bad, { method: "POST", redirect: "manual" });
    assert(r.status === 400, `a forged token answered ${r.status}, expected 400`);
    const { rows } = await q(`select 1 from email_suppressions where email = $1`, [who("a")]);
    assert(rows.length === 0, "a forged token suppressed the address");
    return "400, nothing written";
  });

  await step("the real one-click POST unsubscribes them", async () => {
    const r = await fetch(unsubUrl, { method: "POST", redirect: "manual" });
    assert(r.status === 200, `one-click POST answered ${r.status}`);
    const { rows } = await q(`select reason from email_suppressions where email = $1`, [who("a")]);
    assert(rows.length === 1, "the opt-out wrote no suppression row");
    assert(rows[0].reason === "unsubscribed", `reason is ${rows[0].reason}`);
    return `suppressed as "${rows[0].reason}"`;
  });

  // -------------------------------------------------------------------------
  section("And a second campaign cannot reach them");
  // -------------------------------------------------------------------------
  await step("a NEW campaign refuses the address that just opted out", async () => {
    // `c` has never been mailed, so it is the POSITIVE control: it proves the
    // second campaign really ran. `b` is expected to be DEFERRED rather than
    // sent — it received campaign A minutes ago and the 24-hour frequency guard
    // holds it, which is the guard working, not a failure. Asserting "b is
    // sent" here was this test being wrong about the product.
    await q(
      `insert into marketing_subscribers (email, source, opted_in_at) values ($1,'harness',$2)
       on conflict (email) do nothing`,
      [who("c"), new Date(Date.now() - 400 * DAY).toISOString()],
    );
    const campaignB = await createCampaign(`qa-${stamp}-B`, [who("a"), who("b"), who("c")]);
    for (let i = 0; i < 6; i++) {
      await sweep();
      const states = await recipientStates(campaignB);
      if (states.every((r) => r.status !== "pending" && r.status !== "claiming")) break;
    }
    const states = await recipientStates(campaignB);
    const by = Object.fromEntries(states.map((r) => [r.email, r.status]));
    assert(by[who("a")] === "suppressed", `the unsubscribed address is ${by[who("a")]}, expected suppressed`);
    assert(by[who("c")] === "sent", `the fresh control recipient is ${by[who("c")]}, expected sent`);
    const { rows: deferred } = await q(
      `select deferred_until from email_campaign_recipients where campaign_id = $1 and email = $2`,
      [campaignB, who("b")],
    );
    assert(by[who("b")] === "pending" && deferred[0]?.deferred_until,
      `the recently-mailed recipient is ${by[who("b")]} with deferred_until=${deferred[0]?.deferred_until}`);
    return `opted-out=suppressed, fresh control=sent, recently-mailed=deferred`;
  });

  await step("no campaign recipient was ever sent twice", async () => {
    const { rows } = await q(
      `select recipient_email, campaign_type, count(*)::int n
         from email_send_log
        where recipient_email like $1 and campaign_type = 'campaign' and status <> 'failed'
        group by 1,2 having count(*) > 1`,
      [`camp-${stamp}-%`],
    );
    assert(rows.length === 0, `duplicates: ${JSON.stringify(rows)}`);
    return "one send-log row per recipient per campaign";
  });

  // -------------------------------------------------------------------------
  section("Opting out of marketing does not cost them their account mail");
  // -------------------------------------------------------------------------
  await step("a transactional message still reaches the unsubscribed address", async () => {
    const mark = captureMark();
    const r = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...SAME_ORIGIN, "x-real-ip": `10.9.${Math.floor(Math.random() * 250)}.7` },
      // The store's own gate: signup requires both acknowledgements. Sending them
      // is what a real customer does, not a bypass.
      body: JSON.stringify({
        email: who("a"), password: "HarnessPass123!", fullName: "QA Optout",
        ageConfirmed: true, researchUseOnly: true,
      }),
    });
    assert(r.status < 400, `signup answered ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const rows = await waitForCapture(mark, (all) => all.some((m) => String(m.to) === who("a")));
    const got = rows.find((m) => String(m.to) === who("a"));
    assert(got, "the account confirmation never arrived at an address suppressed for MARKETING");
    // And it is transactional: no marketing opt-out furniture on it.
    assert(!got.headers?.["list-unsubscribe"], "a transactional message carries a marketing unsubscribe header");
    return `"${String(got.subject).slice(0, 48)}" delivered`;
  });

  await pool.end();
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  console.log(`\n${passed} passed, ${failed.length} failed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
