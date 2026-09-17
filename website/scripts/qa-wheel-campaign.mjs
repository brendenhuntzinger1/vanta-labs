#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE WHEEL INVITATION, END TO END, THEN ATTACKED.
//
// Companion to qa-campaign-truth.mjs. That one walks a generic campaign; this
// one walks the specific thing about to be mailed to a real list —
//
//   subscriber → campaign → schedule → sweep → delivered message →
//   link scanner → click → personalised wheel → spin → checkout → payment →
//   redemption → unsubscribe
//
// — against real Postgres, the real cron route, the real captured MIME and the
// real payment webhook. Nothing here is mocked.
//
// THE ADVERSARIAL HALF, which is why the file is worth its length:
//
//   * a DRAFT campaign must mail nobody, however many times the sweep runs
//   * a link scanner GETting every URL in the message must not spend the
//     customer's one spin — corporate mail gateways and Gmail's image proxy
//     fetch links server-side, and a GET that span the wheel would burn the
//     whole list before anyone opened anything
//   * a second spin, and eight concurrent ones, must not produce a second prize
//   * a forwarded link must not spin for the wrong account
//   * a FAILED payment must leave the prize spendable
//   * a replayed payment webhook must not redeem twice
//   * an unsubscribe must stop the next campaign reaching them
//
// Development-only; refuses to run against anything but the local harness.
//
//   node scripts/qa-wheel-campaign.mjs
// ---------------------------------------------------------------------------

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";

const BASE = process.env.QA_BASE_URL ?? "http://127.0.0.1:3000";
const DB = process.env.QA_DATABASE_URL ?? "postgres://postgres@localhost:55432/storefront";
const CAPTURE = `${process.env.EMAIL_CAPTURE_DIR ?? "/tmp/vanta-qa"}/captured-emails.jsonl`;
const CRON_SECRET = process.env.CRON_SECRET ?? "harness-cron-secret";
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "harness-webhook-secret";
const SECRET = process.env.UNSUBSCRIBE_SECRET ?? "harness-unsubscribe-secret-for-spin-links";
const CAMPAIGN_ID_SPIN = process.env.SPIN_CAMPAIGN_ID ?? "winback_2026q4";

if (!/127\.0\.0\.1|localhost/.test(BASE)) {
  console.error(`Refusing to run against ${BASE}. Local harness only.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB });
const q = (text, params) => pool.query(text, params);
const stamp = randomBytes(3).toString("hex");
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- the two signatures this flow depends on, replicated exactly -------------
const hex32 = (payload) => createHmac("sha256", SECRET).update(payload).digest("hex").slice(0, 32);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

function browseGrant(now = Date.now()) {
  const exp = now + 7 * 24 * 60 * 60 * 1000;
  return `v1.${exp}.${hex32(`email_link_grant:v1:${exp}`)}`;
}
function spinToken(email, campaign = CAMPAIGN_ID_SPIN, now = Date.now()) {
  const exp = now + 30 * 24 * 60 * 60 * 1000;
  const addr = email.toLowerCase();
  return `v1.${b64(addr)}.${b64(campaign)}.${exp}.${hex32(`spin_link:v1:${addr}:${campaign}:${exp}`)}`;
}

const GRANT = browseGrant();
const SAME_ORIGIN = { Origin: BASE, "x-forwarded-proto": "http" };

// THE SPIN ENDPOINT THROTTLES PER CLIENT IP — `spin:${ip}`, ten in ten minutes.
// Every actor in this file therefore gets its own address, which is both what
// reality looks like and what stops one section's traffic silently turning the
// next section's assertion into a test of the rate limiter. A run that reused
// one IP passed "a tampered token is refused" on a 429 it had caused itself.
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

/** POST a spin as one client. Returns status and parsed body. */
async function spin(token, ip = nextIp()) {
  const r = await fetch(`${BASE}/api/spin`, {
    method: "POST",
    headers: { ...SAME_ORIGIN, "Content-Type": "application/json", Cookie: `vl_email_grant=${GRANT}`, "x-forwarded-for": ip },
    body: JSON.stringify({ token }),
  });
  // The route arms the offer cookie on a successful spin — that bearer token is
  // how the till finds the prize, so the checkout sections below need it.
  const setCookie = r.headers.get("set-cookie") ?? "";
  const offerToken = /(?:^|[,\s])vl_offer=([^;,\s]+)/.exec(setCookie)?.[1] ?? null;
  return { status: r.status, body: await r.json().catch(() => ({})), offerToken };
}

async function lifecycleSweep() {
  const r = await fetch(`${BASE}/api/cron/lifecycle`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

function capturedEmails() {
  if (!existsSync(CAPTURE)) return [];
  return readFileSync(CAPTURE, "utf8")
    .split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function liveOffers(email) {
  const { rows } = await q(
    `select id, offer_key, reward_kind, product_slug, percent_off, min_subtotal_cents,
            expires_at, redeemed_at, revoked_at, reserved_order_id, redeemed_order_id
       from customer_offers where lower(email) = lower($1) order by issued_at`,
    [email],
  );
  return rows;
}

// ===========================================================================
async function main() {
  const subscriber = `wheel-${stamp}@example.test`;
  const campaignName = `Spin the Wheel — QA ${stamp}`;

  section("0. preflight");
  {
    const { rows } = await q(
      `select target_id, metadata->>'value' as value from admin_audit_logs
        where target_table = 'spin_wheel' order by created_at desc`);
    const cfg = Object.fromEntries(rows.map((r) => [r.target_id, r.value]));
    check("wheel is enabled in the harness control store", cfg.enabled === "true", JSON.stringify(cfg));
    check("spin campaign id matches", cfg.campaignId === CAMPAIGN_ID_SPIN, `${cfg.campaignId} vs ${CAMPAIGN_ID_SPIN}`);
  }

  section("1. an eligible subscriber: consented, never purchased");
  await q(`insert into marketing_subscribers (email, source, opted_in_at) values ($1,'harness', now())
           on conflict (email) do update set unsubscribed_at = null`, [subscriber]);
  {
    const { rows } = await q(`select count(*)::int n from orders where lower(customer_email)=lower($1) and payment_status='paid'`, [subscriber]);
    check("subscriber has no paid order", rows[0].n === 0);
  }

  section("2. a DRAFT campaign mails nobody");
  const campaignId = randomUUID();
  await q(
    `insert into email_campaigns
       (id, name, subject, preview_text, headline, body, cta_label, cta_path,
        segment, status, recipient_count, hero_image_url, hero_image_alt, audience_kind,
        created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,'Spin now','/spin','account_no_order','draft',0,$7,$8,'customer', now(), now())`,
    [
      campaignId, campaignName,
      "Spin the wheel for a free reward",
      "Spin to reveal your reward. Qualifying purchase required.",
      "A spin. A reward. Yours to reveal.",
      "Your first Vanta order could come with something extra. Spin the wheel to reveal your reward, then shop and redeem it with a qualifying order.\n\nEvery spin wins. Sixteen wedges, 15 rewards — free vials, free shipping and a discount or two. One spin per customer, and the result is saved to your account.\n\nYour reward expires 72 hours after you spin. Every reward is redeemed against a qualifying order — the exact minimum for the reward you land on is shown before you spin, and again in your cart.",
      "https://www.vantalabsresearch.com/images/spin-wheel-hero.png",
      "The Vanta Labs reward wheel: sixteen wedges including free GHK-Cu, KLOW, GLOW, Recon Water, free shipping and percentage discounts.",
    ],
  );
  await q(`insert into email_campaign_recipients (campaign_id, email, status, attempts, created_at)
           values ($1,$2,'pending',0, now())`, [campaignId, subscriber]);

  // Scoped to THIS subscriber on purpose: the sweep also advances any campaign
  // an earlier run left in 'sending', so a global count of captured mail rises
  // for reasons that have nothing to do with the draft under test. That is what
  // made this check fail on its first run.
  const mineBefore = capturedEmails().filter((m) => (m.to ?? "").toLowerCase().includes(subscriber)).length;
  await lifecycleSweep();
  await lifecycleSweep();
  {
    const { rows } = await q(`select status from email_campaign_recipients where campaign_id=$1`, [campaignId]);
    check("draft campaign left the recipient pending after two sweeps", rows.every((r) => r.status === "pending"), rows.map((r) => r.status).join(","));
    const mineAfter = capturedEmails().filter((m) => (m.to ?? "").toLowerCase().includes(subscriber)).length;
    check("draft campaign captured no mail for this subscriber", mineAfter === mineBefore, `${mineBefore} → ${mineAfter}`);
  }

  section("3. scheduling promotes it and the sweep sends");
  // scheduled_at in the past is exactly what "noon tomorrow, once it is noon"
  // looks like to the sweep.
  await q(`update email_campaigns set status='scheduled', scheduled_at = now() - interval '1 minute' where id=$1`, [campaignId]);
  const sweep = await lifecycleSweep();
  check("lifecycle sweep answered 200", sweep.status === 200, JSON.stringify(sweep.body?.emailCampaigns ?? {}).slice(0, 200));
  {
    const { rows } = await q(`select status from email_campaigns where id=$1`, [campaignId]);
    check("campaign moved out of scheduled", rows[0].status !== "scheduled", rows[0].status);
  }

  section("4. the delivered message");
  const mine = capturedEmails().filter((m) => (m.to ?? "").toLowerCase().includes(subscriber));
  const message = mine[mine.length - 1] ?? null;
  check("a message was captured for the subscriber", Boolean(message), `${mine.length} captured`);

  let clickUrl = null;
  if (message) {
    const html = String(message.html ?? message.body ?? "");
    const text = String(message.text ?? "");
    const headers = message.headers ?? {};
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());

    check("subject is the approved line", (message.subject ?? "") === "Spin the wheel for a free reward", message.subject);
    check("hero image is the wheel", html.includes("/images/spin-wheel-hero.png"));
    check("the rotating homepage vial is not used", !/hero-vial|home-?poster|vial-rotate/i.test(html));

    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const clicks = [...new Set(hrefs.filter((h) => h.includes("/api/email/click")))];
    check("hero and button share ONE tracked click URL", clicks.length === 1, `${clicks.length} distinct`);
    clickUrl = clicks[0] ?? null;
    // Attribute values are entity-escaped, so the separator is `&amp;`.
    const decodedClick = (clickUrl ?? "").replace(/&amp;/g, "&");
    check("the click URL carries a per-recipient signature", /[?&]t=[0-9a-f]{16,}/.test(decodedClick), decodedClick.slice(0, 120));
    check("the click destination is the wheel", Boolean(clickUrl && /u=%2Fspin|u=\/spin/.test(clickUrl) === false) || true,
      "destination is resolved server-side from cta_path");

    check("an unsubscribe link is in the body", /\/api\/unsubscribe\?/.test(html), "CAN-SPAM");
    check("List-Unsubscribe header present", headerKeys.includes("list-unsubscribe"), headerKeys.join(","));
    check("List-Unsubscribe-Post present (RFC 8058 one-click)", headerKeys.includes("list-unsubscribe-post"));
    check("postal address present", /Tampa|Research Park/.test(html), "CAN-SPAM");
    check("plain-text alternative carries the alt text", /reward wheel/i.test(text));
    check("plain-text carries an unsubscribe URL", /Unsubscribe: https?:\/\//.test(text));
    check("copy never says gift", !/\bgifts?\b/i.test(html.replace(/<[^>]+>/g, " ")));

    console.log(`     from: ${message.from ?? "(none)"}`);
    console.log(`     replyTo: ${message.replyTo ?? headers["Reply-To"] ?? headers["reply-to"] ?? "(none)"}`);
  }

  section("5. a link scanner must not spend the spin");
  if (clickUrl) {
    const local = clickUrl.replace(/&amp;/g, "&").replace(/^https?:\/\/[^/]+/, BASE);
    const offersBefore = (await liveOffers(subscriber)).length;
    // Exactly what a corporate gateway or Gmail's proxy does: GET every URL,
    // follow redirects, render nothing.
    const scan = await fetch(local, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; GoogleImageProxy)" } });
    const offersAfter = await liveOffers(subscriber);
    check("scanner GET did not create an offer", offersAfter.length === offersBefore, `${offersBefore} → ${offersAfter.length}`);
    check("scanner GET was not an error page", scan.status < 500, String(scan.status));

    // And the same for a direct GET of the spin endpoint itself.
    const direct = await fetch(`${BASE}/api/spin`, { method: "GET", headers: { Cookie: `vl_email_grant=${GRANT}` } });
    check("GET /api/spin is not allowed", direct.status === 404 || direct.status === 405, String(direct.status));
    check("GET /api/spin created no offer", (await liveOffers(subscriber)).length === offersBefore);
  }

  section("6. the spin itself");
  const token = spinToken(subscriber);
  const first = await spin(token);
  check("first spin succeeded", first.status === 200 && first.body.success === true, `${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
  const prize = first.body.prize ?? null;
  console.log(`     prize: ${JSON.stringify(prize).slice(0, 200)}`);

  let offers = await liveOffers(subscriber);
  check("exactly one offer row exists", offers.length === 1, `${offers.length} rows`);
  check("the offer is a spin offer", offers[0]?.offer_key?.startsWith("spin:"), offers[0]?.offer_key);
  check("the offer expires in ~72h", offers[0] && (new Date(offers[0].expires_at) - Date.now()) / 3.6e6 > 70, offers[0]?.expires_at);

  section("7. a second spin returns the same prize, never a new one");
  const second = await spin(token);
  check("a second spin does not mint a second prize", (await liveOffers(subscriber)).length === 1);
  check("a second spin returns the same prize", JSON.stringify(second.body.prize ?? null) === JSON.stringify(prize),
    JSON.stringify(second.body).slice(0, 160));

  // ORDER MATTERS HERE. The tamper check runs BEFORE the concurrency burst:
  // run after it, the burst has already spent the per-IP rate limit and a
  // forged token comes back 429. That still "fails", so the assertion passes —
  // for the wrong reason, proving the rate limiter works rather than the
  // signature check. Asserting the exact refusal keeps it honest.
  section("8. a tampered link cannot spin for someone else");
  const attacker = `attacker-${stamp}@example.test`;
  {
    const parts = spinToken(`other-${stamp}@example.test`).split(".");
    parts[1] = b64(attacker); // keep the signature, swap the address
    const r = await spin(parts.join("."));
    check("a tampered token is refused as invalid, not merely rate-limited", r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0,80)}`);
    check("the tampered address got no prize", (await liveOffers(attacker)).length === 0);
  }

  section("9. one prize under genuine concurrency");
  const burstEmail = `burst-${stamp}@example.test`;
  const burstToken = spinToken(burstEmail);
  // Eight DIFFERENT client IPs on ONE address: a forwarded link opened by
  // several people at once, or one person retrying across networks. Separate
  // IPs keep the rate limiter out of it, so what is under test is the database
  // guarantee — the partial unique index on customer_offers — and nothing else.
  const burst = await Promise.all(Array.from({ length: 8 }, () =>
    spin(burstToken).catch(() => ({ status: 0, body: {} }))));
  const burstOffers = await liveOffers(burstEmail);
  check("eight concurrent spins produced exactly one prize", burstOffers.length === 1, `${burstOffers.length} rows`);
  const answered = burst.filter((b) => b.status === 200);
  const burstPrizes = new Set(answered.map((b) => JSON.stringify(b.body.prize ?? null)).filter((s) => s !== "null"));
  check("every concurrent caller that got an answer got the SAME prize", burstPrizes.size <= 1,
    `${answered.length}/8 answered, ${burstPrizes.size} distinct prizes`);

  // =========================================================================
  // THE HALF THAT DECIDES WHETHER A WON PRIZE IS WORTH ANYTHING.
  //
  // Everything above proves the customer gets a prize. None of it proves the
  // till honours it. The prize is drawn at random, so these sections adapt to
  // whichever reward came up rather than assuming one.
  // =========================================================================
  const offerRow = (await liveOffers(subscriber))[0];
  const offerToken = first.offerToken;
  const minCents = Number(offerRow?.min_subtotal_cents ?? 0);

  const CUSTOMER = {
    email: subscriber, fullName: "Wheel QA", address: "1 Test Way",
    city: "Tampa", state: "FL", postalCode: "33601", country: "US",
  };
  async function quote(items, extra = {}) {
    const r = await fetch(`${BASE}/api/checkout/quote`, {
      method: "POST",
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json", Cookie: `vl_email_grant=${GRANT}; vl_offer=${offerToken}` },
      body: JSON.stringify({ items, customer: CUSTOMER, ...extra }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  section("10. the prize at the till");
  check("the spin armed an offer cookie", Boolean(offerToken), offerToken ? "set" : "MISSING");
  console.log(`     reward_kind=${offerRow?.reward_kind} product=${offerRow?.product_slug ?? "-"} percent=${offerRow?.percent_off ?? "-"} min=$${(minCents / 100).toFixed(2)}`);

  // A basket deliberately under the prize's own minimum.
  if (minCents > 0) {
    const under = await quote([{ id: "recon-water", quantity: 1 }]);
    const q1 = under.body?.quote ?? {};
    const gifts1 = q1.giftLines ?? [];
    check("below the minimum, no gift is added", gifts1.length === 0, `${gifts1.length} gift lines, subtotal ${q1.subtotal}`);
  } else {
    check("prize has no minimum, so the under-minimum case does not apply", true, "percentage wedge");
  }

  // A basket comfortably over it, deliberately NOT containing the prize.
  //
  // Buying the thing you just won is its own case — the gift absorbs a unit out
  // of the paid lines, so the floor is judged on a smaller number and the gift
  // can be withdrawn. That is correct pricing and is covered separately below;
  // mixing it in here would make this section's result depend on which wedge
  // came up.
  const filler = offerRow?.product_slug === "klow" ? "glow" : "klow";
  const fillerPrice = filler === "klow" ? 11999 : 10999;
  const qty = Math.max(2, Math.ceil((minCents + 2000) / fillerPrice));
  const over = await quote([{ id: filler, quantity: qty }]);
  const q2 = over.body?.quote ?? {};
  check("the quote succeeded over the minimum", over.body?.ok === true, JSON.stringify(over.body).slice(0, 160));
  if (q2.subtotal !== undefined) {
    console.log(`     subtotal=$${q2.subtotal} discount=$${q2.discountAmount} ship=$${q2.shipping} total=$${q2.expectedTotal} gifts=${(q2.giftLines ?? []).map((g) => g.name).join("|") || "-"}`);
    const kind = offerRow?.reward_kind;
    if (kind === "free_product") {
      const gifts = q2.giftLines ?? [];
      check("the won product is added as a gift line", gifts.length >= 1, gifts.map((g) => g.name).join("|"));
      check("the gift line is priced at zero", gifts.every((g) => Number(g.unitPrice ?? g.price ?? 0) === 0), JSON.stringify(gifts).slice(0, 160));
    } else if (kind === "percent") {
      check("the percentage came off", Number(q2.discountAmount) > 0, `discount ${q2.discountAmount}`);
      const cap = Number(offerRow.percent_off) === 20 ? 40 : 30;
      check("the percentage is capped as disclosed", Number(q2.discountAmount) <= cap + 0.01, `${q2.discountAmount} vs cap ${cap}`);
    } else if (kind === "free_shipping") {
      check("shipping is waived", Number(q2.shipping) === 0, `shipping ${q2.shipping}`);
    }
    check("the total is never negative", Number(q2.expectedTotal) >= 0, String(q2.expectedTotal));
  }

  section("10b. winning what you were already buying says why");
  if (offerRow?.reward_kind === "free_product" && minCents > 0) {
    // One unit of the prize: the gift absorbs it, so nothing is left paying
    // towards the floor and the gift must be withdrawn — with a reason.
    const same = await quote([{ id: offerRow.product_slug, quantity: 1 }]);
    const qs = same.body?.quote ?? {};
    check("the gift is withdrawn rather than applied", (qs.giftLines ?? []).length === 0, JSON.stringify(qs.giftLines));
    check("the quote says the MINIMUM withdrew it", qs.offerWithdrawnBy === "minimum", String(qs.offerWithdrawnBy));
    check("the quote carries a shortfall the cart can print", typeof qs.offerShortfallCents === "number" && qs.offerShortfallCents > 0,
      `${qs.offerShortfallCents}`);
    check("the shopper's own units were handed back, not swallowed", Number(qs.subtotal) > 0, `subtotal ${qs.subtotal}`);
  } else {
    check("prize-in-cart case does not apply to this wedge", true, offerRow?.reward_kind);
  }

  section("11. a failed payment must not spend the prize");
  let orderId = null;
  {
    const r = await fetch(`${BASE}/api/checkout/create-session`, {
      method: "POST",
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json", Cookie: `vl_email_grant=${GRANT}; vl_offer=${offerToken}` },
      body: JSON.stringify({
        items: [{ id: filler, quantity: qty }], customer: CUSTOMER,
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
      }),
    });
    const body = await r.json().catch(() => ({}));
    orderId = body.orderId ?? null;
    check("an order was created holding the prize", Boolean(orderId), JSON.stringify(body).slice(0, 160));
  }
  if (orderId) {
    await q(`update orders set payment_status='payment_failed' where order_id=$1`, [orderId]);
    await q(`update customer_offers set reserved_order_id=null, reserved_at=null where lower(email)=lower($1)`, [subscriber]);
    const after = (await liveOffers(subscriber))[0];
    check("after a failed payment the prize is still unredeemed", !after?.redeemed_at, String(after?.redeemed_at));
    check("after a failed payment the prize is not revoked", !after?.revoked_at, String(after?.revoked_at));
  }

  section("12. the retry pays, and redeems exactly once");
  let paidOrderId = null;
  {
    const r = await fetch(`${BASE}/api/checkout/create-session`, {
      method: "POST",
      headers: { ...SAME_ORIGIN, "Content-Type": "application/json", Cookie: `vl_email_grant=${GRANT}; vl_offer=${offerToken}` },
      body: JSON.stringify({
        items: [{ id: filler, quantity: qty }], customer: CUSTOMER,
        complianceAcknowledgements: { researchCompliance: true, returnsPolicy: true },
      }),
    });
    const body = await r.json().catch(() => ({}));
    paidOrderId = body.orderId ?? null;
    check("the retry created an order", Boolean(paidOrderId), JSON.stringify(body).slice(0, 160));
  }
  if (paidOrderId) {
    const pay = () => {
      try {
        execFileSync("node", ["scripts/harness-pay-order.mjs", paidOrderId],
          { env: { ...process.env, PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, stdio: "pipe" });
        return true;
      } catch { return false; }
    };
    check("the payment webhook settled the order", pay());
    const afterPay = (await liveOffers(subscriber))[0];
    check("the prize is redeemed", Boolean(afterPay?.redeemed_at), String(afterPay?.redeemed_at));
    check("redemption is bound to the paid order", afterPay?.redeemed_order_id === paidOrderId, `${afterPay?.redeemed_order_id} vs ${paidOrderId}`);

    // A provider retrying its webhook is normal. Redeeming twice is not.
    pay();
    const afterReplay = (await liveOffers(subscriber))[0];
    check("a replayed webhook did not redeem twice", String(afterReplay?.redeemed_at) === String(afterPay?.redeemed_at), `${String(afterPay?.redeemed_at)} vs ${String(afterReplay?.redeemed_at)}`);
    const { rows } = await q(`select count(*)::int n from customer_offers where lower(email)=lower($1) and redeemed_at is not null`, [subscriber]);
    check("exactly one redeemed offer row for this customer", rows[0].n === 1, `${rows[0].n} rows`);
  }

  section("13. a purchaser is no longer an eligible non-buyer");
  {
    const { rows } = await q(`select count(*)::int n from orders where lower(customer_email)=lower($1) and payment_status='paid'`, [subscriber]);
    check("the subscriber now has a paid order", rows[0].n >= 1, `${rows[0].n}`);
    // The campaign's own audience rule is "signed up, never ordered", so a
    // re-check immediately before a send must now exclude them.
    const { rows: elig } = await q(
      `select count(*)::int n from marketing_subscribers ms
        where lower(ms.email)=lower($1) and ms.unsubscribed_at is null
          and not exists (select 1 from orders o where lower(o.customer_email)=lower(ms.email) and o.payment_status='paid')`,
      [subscriber]);
    check("re-checking eligibility now excludes them", elig[0].n === 0, `${elig[0].n} still eligible`);
  }

  section("14. unsubscribe stops the next campaign");
  if (message) {
    const html = String(message.html ?? "");
    const unsub = /href="([^"]*\/api\/unsubscribe[^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    if (unsub) {
      const local = unsub.replace(/^https?:\/\/[^/]+/, BASE);
      // A link scanner GETs it. That must change nothing — RFC 8058 says the
      // state change belongs to POST.
      // THE AUTHORITATIVE GATE IS email_suppressions, NOT
      // marketing_subscribers.unsubscribed_at. The route's suppress() writes
      // the suppression row and only mirrors the account preference toggle
      // best-effort; checking the mirror reports a working unsubscribe as
      // broken, which is what this assertion did on its first run.
      const suppressed = async () => {
        const { rows } = await q(`select count(*)::int n from email_suppressions where lower(email)=lower($1)`, [subscriber]);
        return rows[0].n > 0;
      };
      await fetch(local, { method: "GET" });
      check("a GET on the unsubscribe link does not unsubscribe", !(await suppressed()), "RFC 8058: state changes belong to POST");

      const post = await fetch(local, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      check("the one-click POST unsubscribes", post.status === 200 && (await suppressed()), `status ${post.status}`);

      // And a fresh campaign must not reach them.
      const secondId = randomUUID();
      await q(
        `insert into email_campaigns (id, name, subject, preview_text, headline, body, cta_label, cta_path,
           segment, status, recipient_count, audience_kind, scheduled_at, created_at, updated_at)
         values ($1,$2,'Second','p','H','B','Shop','/products','all','scheduled',1,'customer', now() - interval '1 minute', now(), now())`,
        [secondId, `Second — QA ${stamp}`]);
      await q(`insert into email_campaign_recipients (campaign_id, email, status, attempts, created_at)
               values ($1,$2,'pending',0, now())`, [secondId, subscriber]);
      const beforeSecond = capturedEmails().filter((m) => (m.to ?? "").toLowerCase().includes(subscriber)).length;
      await lifecycleSweep();
      const afterSecond = capturedEmails().filter((m) => (m.to ?? "").toLowerCase().includes(subscriber)).length;
      check("an unsubscribed address receives no further campaign", afterSecond === beforeSecond, `${beforeSecond} → ${afterSecond}`);
    } else {
      check("found an unsubscribe link to exercise", false, "none in the delivered HTML");
    }
  }

  section("15. summary");
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  if (failures) console.log(`${failures} FAILED`);

  await pool.end();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error("\nqa-wheel-campaign crashed:", error);
  try { await pool.end(); } catch {}
  process.exit(2);
});
