# Email deliverability — verified state and the work code cannot do

**Audited 2026-09-02.** Scope: every path that sends mail — order and receipt
mail, affiliate/ambassador mail, auth (confirmation, password reset), cart
recovery, automations and campaigns.

The goal this was measured against: **no mail from this store lands in junk.**
That goal cannot be guaranteed by anyone — placement depends on each recipient's
own history with the sender, and no sender controls that. What can be done is
remove every signal known to count against you. This document records which of
those are already right, and which are settings on a DNS zone or a third-party
dashboard that no code change can reach.

---

## 1. What was verified, and how

Authentication was resolved live against `1.1.1.1` and `8.8.8.8`. Delivery
outcomes were read from production Supabase, read-only. No mail was sent.

### Authentication — all three pass and align

| Record | Host | Value | Verdict |
|---|---|---|---|
| SPF (envelope) | `send.vantalabsresearch.com` | `v=spf1 include:amazonses.com ~all` | ✅ |
| MAIL FROM MX | `send.vantalabsresearch.com` | `10 feedback-smtp.us-east-1.amazonses.com` | ✅ |
| DKIM | `resend._domainkey.vantalabsresearch.com` | RSA public key present | ✅ |
| DMARC | `_dmarc.vantalabsresearch.com` | `v=DMARC1; p=none;` | ⚠️ see §2.1 |
| SPF (root) | `vantalabsresearch.com` | `v=spf1 include:_spf.google.com ~all` | ✅ Workspace only, correct |

Resend's custom MAIL FROM is configured properly. The envelope sender sits on
`send.vantalabsresearch.com`, whose organisational domain is
`vantalabsresearch.com` — the same as the `From:` header — so **SPF aligns under
relaxed DMARC**. DKIM signs as `d=vantalabsresearch.com`, so **DKIM aligns too**.
DMARC therefore passes on both counts, which is the strongest position available.

The root SPF authorises only Google Workspace, and that is correct: Resend mail
is authorised through `send.`, not through the root. Do **not** add
`include:amazonses.com` to the root record — it authorises more than it needs to
and fixes nothing.

### Delivery outcomes — real data, not theory

From `email_delivery_events`, all of it since 2026-08-31:

- **41 delivered**
- **1 soft bounce** (transient — a full mailbox or a temporary defer)
- **0 hard bounces**
- **0 spam complaints**

Gmail's danger threshold is a 0.3% complaint rate. This is zero.

> **The limit of that evidence, stated plainly.** Resend's `delivered` event
> means *the receiving server accepted the message*. It does **not** distinguish
> the inbox from the spam folder. A message Gmail files in Junk is still
> reported as delivered. This data proves mail is being accepted; it does not
> prove it is being read. §3 is how you find out the difference.

### Code-side controls already correct

- One-click unsubscribe (RFC 8058) on every marketing send: `List-Unsubscribe`
  plus `List-Unsubscribe-Post`, with a working `POST /api/unsubscribe`. The
  `mailto:` is derived from the same resolved marketing From as the message, so
  turning on domain separation cannot introduce an unaligned opt-out header.
- CAN-SPAM postal address applied at the marketing wrapper, so a template added
  tomorrow inherits it. The campaign sender refuses to send while it is blank.
- Bounce and complaint webhooks feed `email_suppressions`; marketing consults it
  per send, and the audience query subtracts it up front as well.
- Consent is a floor, not a segment — every audience filter is applied on top of
  the opted-in set, never as a way to reach someone who did not opt in.
- Sends are serial, 25 per batch, swept every 30 minutes. No burst.
- Every template ships a plain-text alternative, is branded, renders a real
  button, and repeats its links in the text part — the last of which is what
  keeps a filtered message actionable, since Gmail strips anchors from anything
  it files as spam.
- **New (2026-09-02):** every template subject and all campaign copy is checked
  for pressure phrasing, shouting, punctuation padding and truncation length.
  See `src/lib/email/deliverability-check.ts`.

---

## 2. The work code cannot do

Three items. Each is a setting on a DNS zone or a third-party dashboard.

**Where these live.** DNS for `vantalabsresearch.com` is hosted at **Squarespace**
(`nsb1–nsb4.squarespacedns.com`); mailboxes are **Google Workspace** (`MX
smtp.google.com`). Records are edited under
**Settings → Domains → vantalabsresearch.com → DNS → Custom Records**.

> ⚠️ **Two Squarespace-specific traps, both of which silently break things.**
>
> 1. **The Host field takes the subdomain only, not the full name.** Squarespace
>    appends `.vantalabsresearch.com` for you. Resend will show you
>    `resend._domainkey.mail.vantalabsresearch.com`; you type
>    `resend._domainkey.mail`. Pasting the full name creates
>    `…mail.vantalabsresearch.com.vantalabsresearch.com`, which resolves to
>    nothing and gives no error.
> 2. **A `_dmarc` TXT record already exists — edit it, never add a second.** Two
>    DMARC records on one host make DMARC fail *entirely*, which is worse than
>    the weak policy you started with.

### 2.1 Strengthen DMARC — highest value, lowest effort

Today `_dmarc.vantalabsresearch.com` reads:

```
v=DMARC1; p=none;
```

That satisfies the Gmail/Yahoo bulk-sender minimum, and nothing else. There is
no `rua`, so **no reports are being sent anywhere** — if authentication started
failing tomorrow, nothing would tell you. Replace it with:

```
v=DMARC1; p=none; rua=mailto:dmarc@vantalabsresearch.com; fo=1; adkim=r; aspf=r
```

**Choosing the `rua` address — the trap here is not obvious.**

A `rua` address on a *different* domain than the one publishing the record only
works if that other domain authorises it, by publishing
`vantalabsresearch.com._report._dmarc.<their-domain>` (RFC 7489 §7.1). You
cannot add records to `gmail.com`, so **pointing `rua` at a personal Gmail
address silently receives nothing** — Google itself enforces this strictly. It
is the most common way this step appears to be done and is not.

Two options that actually work:

- **A free DMARC reporting service (recommended, and needs no mailbox at all).**
  Postmark's free DMARC monitor, EasyDMARC and dmarcian all have free tiers.
  They give you a `rua` address on their own domain, publish the authorisation
  record for it themselves, and email you a readable weekly summary instead of
  raw XML. Sign up with any address you already read — a personal Gmail is fine,
  because *they* are mailing you, not the reporting servers.
- **A real mailbox on `vantalabsresearch.com`.** Same-domain `rua` needs no
  authorisation, so this works with no extra setup — but only if the domain
  actually receives mail. See §2.4, which is worth checking regardless.

Then **wait two to four weeks**, confirm the reports show only your own senders
passing, and tighten to:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@vantalabsresearch.com; fo=1; adkim=r; aspf=r
```

Do not skip the waiting period and do not jump straight to `p=reject`. A policy
tightened before you have read a single report is a policy applied to senders
you have not yet discovered — and the mail it silently quarantines is your own.

Note that a DMARC policy covers subdomains unless `sp=` overrides it, so the
marketing subdomain in §2.2 inherits this automatically. That is what you want.

### 2.2 Give marketing its own sending subdomain

`marketing_from` is currently empty, so campaigns go out as
`orders@vantalabsresearch.com` — the same identity that carries receipts,
password resets and affiliate mail. **A spam complaint from a campaign lands on
the reputation those depend on.** This is the single largest structural risk to
"no mail goes to junk", because the mail it would damage is the mail a customer
actually needs.

The code has supported the split since the field was added. It is unset because
pointing it at an unverified domain would stop marketing mail dead — so the
order matters:

1. In Resend → Domains, add `mail.vantalabsresearch.com`.
2. Publish the DNS records Resend gives you. They will be, on that subdomain,
   the same shape as the ones the root domain already has: a DKIM key at
   `resend._domainkey.mail.vantalabsresearch.com`, and an SPF `TXT` plus an `MX`
   at `send.mail.vantalabsresearch.com`.
3. **Wait for Resend to report the domain Verified.** Do not proceed on a
   pending domain.
4. Only then, in Admin → Settings → Email, set the Marketing From address to
   something on that subdomain, e.g. `Vanta Labs <news@mail.vantalabsresearch.com>`.
5. Send yourself a test campaign and confirm it passes §3 before sending a real one.

> ⚠️ **`mail.vantalabsresearch.com` currently has no DNS records at all.**
> Setting the Marketing From before step 3 completes means every campaign fails
> SPF, DKIM and DMARC simultaneously. Order matters more than speed here.

After the split, a new subdomain has no sending reputation. Send it modest
volume for the first few weeks rather than your largest campaign first.

### 2.3 Make sure `orders@vantalabsresearch.com` is read by a person

The `List-Unsubscribe` header offers a `mailto:` fallback for clients that do
not implement one-click, and it points at the From address. RFC 8058 expects a
sender to honour those opt-outs **within two days**. An unread mailbox turns an
unsubscribe request into a spam complaint, which is the single most damaging
signal a mailbox provider can record against you.

Confirm someone reads that mailbox, or route it somewhere that is read.

---

### 2.4 Confirm the domain can still RECEIVE mail

DNS says mail for `vantalabsresearch.com` is routed to Google — `MX 1
smtp.google.com`, `v=spf1 include:_spf.google.com ~all`, and a
`google-site-verification` token. That is a Google Workspace configuration.

**The owner reports not having Google Workspace.** DNS cannot settle this: the
records say where mail is *routed*, not whether a subscription and mailboxes
still exist behind them. A lapsed or cancelled Workspace leaves exactly these
records in place, and mail to the domain then goes nowhere.

This is not a side issue. Two addresses depend on it:

- `orders@vantalabsresearch.com` — the `From:` on every message this store
  sends, and the `mailto:` in every `List-Unsubscribe` header.
- `support@vantalabsresearch.com` — printed in the footer of all 43 templates
  by `renderLayout`.

If neither receives mail, every customer reply and every opt-out request
bounces. Beyond the customer-service cost, sending from an address that cannot
accept replies is itself a signal filters weigh, and an unhonoured opt-out is
the complaint that follows.

**The 30-second test:** from a phone or personal account, send a message to
`orders@vantalabsresearch.com` and another to `support@vantalabsresearch.com`.

- Arrives → Workspace is live; either address can carry `rua`, and §2.3 is
  answered at the same time.
- Bounces, or vanishes → the domain receives no mail. Use a free DMARC service
  for §2.1, and treat restoring a working inbox as its own piece of work:
  either re-establish Workspace, or point the `MX` at a mail host you do have
  and update `Reply-To`/`support@` to match.

## 3. How to actually find out where mail lands

Everything above is upstream of the only question that matters, and neither the
provider dashboard nor this repository can answer it. Two ways:

**Seed testing — do this after any change in §2.** Create real accounts on
Gmail, Outlook/Hotmail and Yahoo. Send yourself one of each kind of mail: an
order confirmation, an affiliate application acknowledgement, a password reset,
and a test campaign. Note the folder each lands in. In Gmail, open
**⋮ → Show original** and confirm all three lines read `PASS`:

```
SPF:   PASS with domain send.vantalabsresearch.com
DKIM:  PASS with domain vantalabsresearch.com
DMARC: PASS
```

The `DKIM` domain is the one to check most carefully — it must be
`vantalabsresearch.com` (or `mail.vantalabsresearch.com` once §2.2 is done), not
a Resend-owned domain. That is what proves alignment on a real message rather
than in a DNS lookup.

**Google Postmaster Tools** — add `vantalabsresearch.com` at
<https://postmaster.google.com>. It reports domain reputation, spam rate and
authentication success for Gmail specifically, which is where most of this
store's recipients are. It needs a few days of volume before it shows anything,
and it is the only free source of truth on inbox placement you will get.

---

## 4. Standing rules

- Marketing copy goes through the composer's deliverability panel. A high-risk
  campaign takes a deliberate confirmation; that prompt is not there to be
  clicked past.
- A new template must pass `template-standards.test.ts`, which now includes
  subject-line hygiene. If it fails, fix the subject rather than the test.
- Never mail an address in `email_suppressions`. The suppression path exists
  because repeatedly mailing dead addresses and people who complained is the
  fastest way to lose the domain.
- Watch the complaint rate. Above 0.1% is worth investigating; Gmail's stated
  threshold is 0.3%, and by the time you reach it the damage is already done.

## 5. Open items

| # | Item | Owner | Status |
|---|---|---|---|
| 2.2a | Create + verify `mail.vantalabsresearch.com` in Resend | Resend | ☑ 2026-09-02 |
| 2.2b | Publish its DKIM / SPF / Return-Path records | DNS | ☑ 2026-09-02 |
| 2.2c | **Deploy the `resolveMarketingReplyTo` commit, THEN set Marketing From** | Deploy → Admin | ☐ |
| 2.1 | DMARC `rua`, then `p=quarantine` | DNS | ☐ |
| 2.3 | Confirm `orders@` is monitored | Ops | ☐ |
| 3 | Seed test across Gmail / Outlook / Yahoo | Ops | ☐ |

> **2.2c — the ordering is not optional, and it is the reason this is still open.**
>
> The subdomain is verified and its DNS is correct. Marketing From was set on
> 2026-09-02 and **deliberately reverted the same day**, because a Resend
> sending domain is send-only: with the reply-path fix undeployed, campaigns
> would have gone out from an address that bounces both replies and the
> `List-Unsubscribe` mailto. Cart recovery and the automations run through
> `sendMarketingEmail`, so that window was live, not theoretical.
>
> Deploy first. Then set Marketing From to
> `Vanta Labs <news@mail.vantalabsresearch.com>` in Admin → Settings → Email.
> Nothing else needs redoing — Resend and DNS are already in place.
| 3 | Seed test across Gmail / Outlook / Yahoo | Ops | ☐ |
| 3 | Enrol in Google Postmaster Tools | Ops | ☐ |
