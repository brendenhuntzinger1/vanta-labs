#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE AUTOMATION ENGINE, AGAINST A REAL DATABASE, AT THE EXACT BOUNDARIES.
//
// automation-boundaries.test.ts proves selectAutomationTargets picks the right
// people. That is a pure function with an injected clock, which is the right
// way to test a threshold and the wrong way to answer the question the owner
// actually asked: does the thing RUN, against real rows, and does the message
// reach the provider.
//
// Between that function and a delivered email sit the parts a unit test cannot
// reach: the Postgres partial unique index that makes "exactly once" true
// across two processes, the frequency guard's advisory lock, the suppression
// read, the offer mint, the renderer, and the SMTP conversation. This drives
// all of it — the real /api/cron/lifecycle, against real Postgres, reading the
// messages that actually came out the other end.
//
// WHAT IT PROVES, and each is asserted by NAME, not by count:
//
//   1  day 29 / 30 / 31   only 30 and 31 receive the reorder reminder
//   2  day 39 / 40 / 41   only 40 and 41 receive win-back 1
//   3  day 49 / 50 / 51   only 50 and 51 receive win-back 2
//   4  an unsubscribed customer, standing exactly on day 30, receives nothing
//   5  a hard-bounced one receives nothing
//   6  a complained one receives nothing
//   7  a customer who never consented receives nothing
//   8  two sweeps racing send exactly one copy each — the real index, two
//      real HTTP requests, in flight at the same time
//   9  a second sweep afterwards sends nothing at all
//  10  the delivered message carries List-Unsubscribe, one-click, a plain-text
//      part, the postal address and a per-recipient signed token
//
// Development-only; refuses to run against anything but the local harness.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/qa-automation-truth.mjs
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
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
/** The automation configuration as this file found it. */
let ladderBefore = null;
const q = (text, params) => pool.query(text, params);
const DAY = 24 * 60 * 60 * 1000;
const stamp = randomBytes(3).toString("hex");
const results = [];
let section_ = "";
const section = (t) => { section_ = t; console.log(`\n${t}`); };
const assert = (c, m) => { if (!c) throw new Error(m); };

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

/** Everything captured since a mark, so one run cannot read another's mail. */
function capturedSince(offset) {
  if (!existsSync(CAPTURE)) return [];
  // BYTES, NOT CHARACTERS. The mark comes from statSync().size, which is a byte
  // count; slicing the decoded string instead counts UTF-16 units, and these
  // messages are full of em dashes and curly quotes. The two drift apart by one
  // position per multi-byte character, so the window opened PAST the start of
  // the run and silently dropped its first messages — which read as "the send
  // log says it went, but nothing was captured".
  return readFileSync(CAPTURE)
    .subarray(offset)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
const captureMark = () => (existsSync(CAPTURE) ? statSync(CAPTURE).size : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the capture file to contain what the send log already claims.
 *
 * The sweep's HTTP response returns when the sends have RESOLVED, not when the
 * sink has finished writing them down: the SMTP conversation and its appendFile
 * both finish after the response is on its way back. Reading the file the
 * instant the sweep returns therefore passes or fails on timing, which is how
 * this assertion produced a message-not-captured failure on one run and six
 * intact messages on the next, against identical code.
 *
 * Polling for the row we are about to assert on removes the race without
 * weakening the assertion — a message that never arrives still fails, it just
 * fails for the real reason after a bounded wait rather than immediately for a
 * false one.
 */
async function waitForCapture(offset, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = capturedSince(offset);
    if (predicate(rows)) return rows;
    if (Date.now() > deadline) return rows;
    await sleep(250);
  }
}

const who = (tag) => `auto-${stamp}-${tag}@example.test`;

/**
 * THE LIFECYCLE ROUTE, NOT THE SWEEP ROUTE.
 *
 * The jobs that put a message in front of a customer — cart recovery, the
 * retention automations, campaigns, the marketing queue, the email retry and
 * the order-email reaper — moved to /api/cron/lifecycle on 2026-09-10, so a
 * closing recovery window could not be lost to a sweep that overran on
 * twenty-seven unrelated jobs. This file kept calling /api/cron/sweep.
 *
 * That route still answers 200 and still returns a body, so nothing failed
 * loudly — it just stopped being evidence. `body.emailAutomations` was simply absent, `?? {}`
 * turned the miss into an empty object, and every count this file prints read
 * `undefined` — "sent undefined, deferred undefined, skipped undefined". The
 * cohort assertions then compared real seeded state against an empty sweep and
 * reported each customer as one lifecycle stage behind, which reads exactly
 * like an off-by-one in the scheduler and is one wrong URL.
 *
 * THE KEY IS ASSERTED, not just the status. A 200 from a route that no longer
 * runs this job is exactly what made the old call look healthy, so if the jobs
 * move again this fails HERE, naming the reason, rather than as a screenful of
 * unrelated-looking assertion failures downstream.
 */
async function sweep() {
  const r = await fetch(`${BASE}/api/cron/lifecycle`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  assert(r.status === 200, `lifecycle sweep answered ${r.status}`);
  const body = await r.json();
  assert(
    body && Object.prototype.hasOwnProperty.call(body, "emailAutomations"),
    `the lifecycle route ran no emailAutomations job — has it moved again? got: ${Object.keys(body ?? {}).join(", ")}`,
  );
  return body.emailAutomations;
}

/**
 * One customer: a consented subscriber with one paid order `ageDays` old.
 *
 * `sentAlready` pre-writes email_send_log rows for the earlier rungs, because
 * that is the only way a customer legitimately ARRIVES at day 40 or day 50 —
 * they were mailed on day 30 first. Without it the sweep hands them the reorder
 * reminder (it runs earlier in priority order) and the quiet period then holds
 * the win-back, so a day-50 assertion would be measuring the wrong rung.
 */
async function seedCustomer({ tag, ageDays, consent = true, suppress = null, sentAlready = [] }) {
  const email = who(tag);
  const orderAt = new Date(Date.now() - ageDays * DAY);
  const orderId = `order-${stamp}-${tag}`;

  if (consent) {
    await q(
      `insert into marketing_subscribers (email, source, opted_in_at, unsubscribed_at)
       values ($1,'harness',$2,null) on conflict (email) do nothing`,
      // Long before any welcome window, so the welcome flows never claim this
      // address and steal the rung under test.
      [email, new Date(Date.now() - 400 * DAY).toISOString()],
    );
  }
  // A PAID CUSTOMER HAS AN ACCOUNT, AND SINCE THE WALL WENT UP THEY CANNOT NOT
  // HAVE ONE.
  //
  // This cohort seeded marketing_subscribers and a paid order and stopped
  // there, which was a complete customer until two things changed. The store is
  // default-deny now (lib/access-policy.ts), so /cart and /checkout are
  // unreachable without an account — an address that paid for something and
  // holds no auth record is a state the storefront can no longer produce.
  //
  // And partitionByAttestation (narrowed 2026-09-13) withholds any
  // GIFT-BEARING automation from an address with no account, because the click
  // would land them on "Sign in to continue" holding a real minted token they
  // cannot spend. replenishment, winback_30 and winback_60 all carry an
  // offer_key, so every rung this file exists to measure was withheld — the
  // sweep reported `sent 0` against a correctly seeded thirteen-customer cohort
  // and said why in its own errors array:
  //
  //   "replenishment: withheld 12 gift-bearing message(s) — no account exists
  //    for the recipient, so the offer has nowhere to be redeemed yet."
  //
  // Five of this file's remaining passes were vacuous underneath that: the
  // suppressed, bounced, complained and never-consented controls all assert
  // SILENCE, and everything was silent. A control that cannot fail is not a
  // control.
  //
  // The account is confirmed but carries no consent of its own — consent stays
  // where it was, in marketing_subscribers — so the consent control below still
  // measures consent and not account existence.
  await q(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, created_at)
     values ($1,'harness-not-a-real-password',$2,$2) on conflict (email) do nothing`,
    [email, orderAt.toISOString()],
  );
  await q(
    `insert into orders (order_id, customer_email, payment_status, order_type, amount_paid, created_at)
     values ($1,$2,'paid','product',100,$3)`,
    [orderId, email, orderAt.toISOString()],
  );
  if (suppress) {
    await q(
      `insert into email_suppressions (email, reason, created_at) values ($1,$2,now())
       on conflict (email) do update set reason = excluded.reason`,
      [email, suppress],
    );
  }
  for (const { key, referenceId, daysAgo } of sentAlready) {
    await q(
      `insert into email_send_log (campaign_type, reference_id, recipient_email, template_key, sent_at, status)
       values ($1,$2,$3,$1,$4,'sent')`,
      [
        `automation:${key}`,
        referenceId === "order" ? orderId : `${email}:${orderAt.getTime()}`,
        email,
        new Date(Date.now() - daysAgo * DAY).toISOString(),
      ],
    );
  }
  return { email, orderId, orderAt };
}

/** Which automations reached each of our addresses, from the real send log. */
async function sentByAddress() {
  const { rows } = await q(
    `select recipient_email, campaign_type, status from email_send_log
      where recipient_email like $1 and campaign_type like 'automation:%' and status <> 'failed'`,
    [`auto-${stamp}-%`],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.recipient_email)) map.set(r.recipient_email, []);
    map.get(r.recipient_email).push(r.campaign_type.replace("automation:", ""));
  }
  return map;
}

/**
 * THE LADDER THIS FILE MEASURES, CONFIGURED BY THIS FILE.
 *
 * Every boundary below — day 29/30/31, 39/40/41, 49/50/51 — is written against
 * replenishment at 30 days, win-back 1 at 40 and win-back 2 at 50, and against
 * all three being switched ON. None of that was ever established here. A FRESH
 * harness ships the automations DISABLED, with winback_30 at 30 and winback_60
 * at 60, so the sweep correctly mails nobody and nine assertions fail on
 * timings the store was not configured for.
 *
 * It passed only on a database where some earlier run had happened to enable
 * and re-time them, which is not a property of the code under test. A suite
 * whose result depends on what ran before it is not evidence.
 *
 * The previous configuration is restored afterwards so this file leaves the
 * store as it found it for everything else sharing the database.
 */
const LADDER = [
  { key: "replenishment", delay: 30 },
  { key: "winback_30", delay: 40 },
  { key: "winback_60", delay: 50 },
];

async function configureLadder() {
  const { rows } = await q(
    `select key, enabled, delay_days from email_automations where key = any($1)`,
    [LADDER.map((l) => l.key)],
  );
  for (const { key, delay } of LADDER) {
    await q(
      `update email_automations set enabled = true, delay_days = $2 where key = $1`,
      [key, delay],
    );
  }
  return rows;
}

async function restoreLadder(previous) {
  for (const row of previous ?? []) {
    await q(
      `update email_automations set enabled = $2, delay_days = $3 where key = $1`,
      [row.key, row.enabled, row.delay_days],
    ).catch(() => {});
  }
}

async function main() {
  console.log(`Automation truth harness — run ${stamp}`);
  ladderBefore = await configureLadder();
  await step("the ladder under test is switched on at 30/40/50 days", async () => {
    const { rows } = await q(
      `select key, enabled, delay_days from email_automations where key = any($1) order by delay_days`,
      [LADDER.map((l) => l.key)],
    );
    const shape = rows.map((r) => `${r.key}=${r.delay_days}${r.enabled ? "" : " (OFF)"}`).join(", ");
    assert(rows.length === 3 && rows.every((r) => r.enabled), `the ladder is not fully enabled: ${shape}`);
    return shape;
  });

  // -------------------------------------------------------------------------
  section("Seeding a cohort standing on each boundary");
  // -------------------------------------------------------------------------
  const cohort = {};
  await step("the cohort is seeded in real Postgres", async () => {
    // Reorder reminder, day 30. Nothing sent yet.
    for (const age of [29, 30, 31]) cohort[`r${age}`] = await seedCustomer({ tag: `r${age}`, ageDays: age });

    // Win-back 1, day 40. They already had their day-30 reminder.
    for (const age of [39, 40, 41]) {
      cohort[`w${age}`] = await seedCustomer({
        tag: `w${age}`, ageDays: age,
        sentAlready: [{ key: "replenishment", referenceId: "order", daysAgo: age - 30 }],
      });
    }

    // Win-back 2, day 50. Day 30 and day 40 both went; the ladder's ten days
    // have passed since win-back 1.
    for (const age of [49, 50, 51]) {
      cohort[`v${age}`] = await seedCustomer({
        tag: `v${age}`, ageDays: age,
        sentAlready: [
          { key: "replenishment", referenceId: "order", daysAgo: age - 30 },
          { key: "winback_30", referenceId: "episode", daysAgo: age - 40 },
        ],
      });
    }

    // The four who must receive nothing, every one of them standing exactly on
    // day 30 so silence cannot be explained by ineligibility.
    cohort.unsub = await seedCustomer({ tag: "unsub", ageDays: 30, suppress: "unsubscribed" });
    cohort.bounced = await seedCustomer({ tag: "bounced", ageDays: 30, suppress: "bounced" });
    cohort.complained = await seedCustomer({ tag: "complained", ageDays: 30, suppress: "complained" });
    cohort.noconsent = await seedCustomer({ tag: "noconsent", ageDays: 30, consent: false });

    return `${Object.keys(cohort).length} customers`;
  });

  // -------------------------------------------------------------------------
  section("One real sweep decides all of them");
  // -------------------------------------------------------------------------
  const mark = captureMark();
  const summary = await step("the sweep runs and reports no errors", async () => {
    const s = await sweep();
    assert(!s.errors?.length, `sweep errors: ${JSON.stringify(s.errors)}`);
    return `sent ${s.sent}, deferred ${s.deferred}, skipped ${s.skipped}, failed ${s.failed}`;
  });

  const sent = await sentByAddress();
  const got = (tag) => (sent.get(who(tag)) ?? []).sort().join(",");

  await step("day 29 waits; day 30 and day 31 get the reorder reminder", () => {
    assert(got("r29") === "", `day 29 received ${got("r29") || "nothing"} — it is a day early`);
    assert(got("r30") === "replenishment", `day 30 received "${got("r30")}"`);
    assert(got("r31") === "replenishment", `day 31 received "${got("r31")}"`);
    return "29 none, 30 and 31 replenishment";
  });

  await step("day 39 waits; day 40 and day 41 get win-back 1", () => {
    assert(got("w39") === "replenishment", `day 39 received "${got("w39")}" — expected only the seeded day-30 mail`);
    assert(got("w40") === "replenishment,winback_30", `day 40 received "${got("w40")}"`);
    assert(got("w41") === "replenishment,winback_30", `day 41 received "${got("w41")}"`);
    return "39 none new, 40 and 41 winback_30";
  });

  await step("day 49 waits; day 50 and day 51 get win-back 2", () => {
    assert(got("v49") === "replenishment,winback_30", `day 49 received "${got("v49")}"`);
    assert(got("v50") === "replenishment,winback_30,winback_60", `day 50 received "${got("v50")}"`);
    assert(got("v51") === "replenishment,winback_30,winback_60", `day 51 received "${got("v51")}"`);
    return "49 none new, 50 and 51 winback_60";
  });

  await step("an unsubscribed customer on day 30 receives nothing", () => {
    assert(got("unsub") === "", `an unsubscribed address received ${got("unsub")}`);
    return "silent";
  });

  await step("a hard-bounced address receives nothing", () => {
    assert(got("bounced") === "", `a bounced address received ${got("bounced")}`);
    return "silent";
  });

  await step("a complained address receives nothing", () => {
    assert(got("complained") === "", `a complained address received ${got("complained")}`);
    return "silent";
  });

  await step("someone who never consented receives nothing", () => {
    assert(got("noconsent") === "", `a non-consenting address received ${got("noconsent")}`);
    return "silent";
  });

  // -------------------------------------------------------------------------
  section("What actually came out of the provider");
  // -------------------------------------------------------------------------
  await step("the delivered message carries every deliverability header", async () => {
    const rows = await waitForCapture(mark, (all) => all.some((m) => String(m.to ?? "") === who("r30")));
    const mine = rows.filter((m) => String(m.to ?? "").includes(`auto-${stamp}-`));
    assert(mine.length > 0, "no captured messages for this run");
    const m = mine.find((x) => String(x.to) === who("r30"));
    assert(m, `no message captured for ${who("r30")}`);

    const listUnsub = m.headers?.["list-unsubscribe"] ?? "";
    assert(/^<https?:\/\//.test(listUnsub), `List-Unsubscribe is not a URL: ${listUnsub}`);
    assert(/token=[0-9a-f]{64}/.test(listUnsub), "the unsubscribe link carries no signed token");
    assert(
      m.headers?.["list-unsubscribe-post"] === "List-Unsubscribe=One-Click",
      `List-Unsubscribe-Post is "${m.headers?.["list-unsubscribe-post"]}"`,
    );
    assert(String(m.html ?? "").length > 0, "no HTML part");
    assert(String(m.text ?? "").length > 0, "NO PLAIN-TEXT PART — an HTML-only bulk message");
    assert(/Unsubscribe: https?:/i.test(m.text), "the plain-text part carries no unsubscribe URL");
    assert(/Harness Way/.test(m.text), "the plain-text part carries no postal address");

    // Per recipient, not per campaign: two recipients must not share a token.
    const other = mine.find((x) => String(x.to) === who("r31"));
    if (other) {
      const t = (s) => String(s.headers?.["list-unsubscribe"] ?? "").match(/token=([0-9a-f]{64})/)?.[1];
      assert(t(m) && t(other) && t(m) !== t(other), "two recipients share one unsubscribe token");
    }
    return `${mine.length} messages, headers intact`;
  });

  // -------------------------------------------------------------------------
  section("Exactly once, under a real race");
  // -------------------------------------------------------------------------
  await step("two sweeps in flight at the same time send no duplicates", async () => {
    // A fresh cohort, so this measures the race and not the first sweep's work.
    for (const age of [30, 31]) await seedCustomer({ tag: `race${age}`, ageDays: age });
    const [a, b] = await Promise.all([sweep(), sweep()]);

    const { rows } = await q(
      `select recipient_email, campaign_type, count(*)::int n from email_send_log
        where recipient_email like $1 and campaign_type like 'automation:%' and status <> 'failed'
        group by 1,2 having count(*) > 1`,
      [`auto-${stamp}-race%`],
    );
    assert(rows.length === 0, `duplicate sends: ${JSON.stringify(rows)}`);

    const after = await sentByAddress();
    for (const age of [30, 31]) {
      const list = after.get(who(`race${age}`)) ?? [];
      assert(list.length === 1 && list[0] === "replenishment", `race${age} got ${JSON.stringify(list)}`);
    }
    return `both sweeps returned (sent ${a.sent}/${b.sent}); one message each`;
  });

  await step("a further sweep sends nothing to anyone already mailed", async () => {
    const before = await sentByAddress();
    const total = (m) => [...m.values()].reduce((n, v) => n + v.length, 0);
    const s = await sweep();
    const after = await sentByAddress();
    assert(total(after) === total(before), `the log grew by ${total(after) - total(before)} rows on a repeat sweep`);
    return `no change (sweep reported sent ${s.sent}, skipped ${s.skipped})`;
  });

  // Leave the store's automation configuration as this file found it.
  await restoreLadder(ladderBefore);
  await pool.end();
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail");
  console.log(`\n${passed} passed, ${failed.length} failed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await restoreLadder(ladderBefore).catch(() => {});
  process.exit(1);
});
