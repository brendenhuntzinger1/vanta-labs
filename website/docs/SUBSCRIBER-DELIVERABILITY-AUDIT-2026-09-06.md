# Subscriber marketing deliverability audit — 2026-09-06

**Scope.** The subscriber/customer marketing email system only. The affiliate
programme's recipients, templates, automations, tracking, commissions and emails
were read where they shared code, and **not modified**. `lib/partner-portal.ts`
appears in this audit exactly once: on an allowlist, marked out of scope and left
as it was.

**What this document does and does not claim.** Every controllable factor listed
below was checked against the live system — production DNS through three
independent resolvers, the live Resend account, the production database, and the
code as it actually runs. Where a factor is correct, that is stated with the
evidence. What follows is *not* a claim that mail cannot land in Spam. Nobody
can promise that, least of all for a sending subdomain that is four days old and
has sent one broadcast. Reputation is earned by sending wanted mail over time,
and the only honest summary is the one at the end of this file.

---

## 1. Confirmed defects found and fixed

### 1.1 Suppression was universal by inspection, not by construction — FIXED

`sendMarketingEmail` (`src/lib/email/marketing.ts`) is the single door every
promotional message goes through, and it is where the message meets the things
that make it lawful and safe to send:

| Gate | What it does |
|---|---|
| `isNonMailableAddress` | refuses provider sink addresses (`@resend.dev`) |
| `email_suppressions` read | unsubscribes, complaints, hard bounces — **fails closed**, so an unreadable table refuses the send rather than assuming consent |
| signed unsubscribe token | per-address HMAC, no login required |
| `List-Unsubscribe` + `List-Unsubscribe-Post` | RFC 8058 one-click opt-out |
| `marketingPostalAddress` | the CAN-SPAM physical address |
| `marketing_send_claim` | the frequency guard: an address-level lock, one marketing message per 24 h from **any** sender |

A sender that calls `sendEmail()` directly gets none of it. The failure mode is
not subtle — an unsubscribed customer receives marketing — but it is completely
silent: nothing throws, nothing logs, and the send looks like a success.

Today no such sender exists. That was established by reading all 25 direct
callers of `sendEmail()`, which is a fact about one afternoon rather than a
property of the codebase. The defect was the absence of anything holding it in
place.

**Fix:** `src/lib/email/marketing-choke-point.test.ts`. It walks `src/lib` and
`src/app`, strips comments so prose describing the rule is not mistaken for a
call, and requires every file that calls `sendEmail()` to appear on a documented
allowlist with a stated reason. A stale-entry assertion stops the allowlist
degrading into a rubber stamp, and a floor on the caller count stops a broken
directory walk from passing as a virtuous codebase. A second block asserts the
door is still locked — suppression read *before* the send, failing closed; sink
guard; both `List-Unsubscribe` headers; postal address; From and Reply-To
resolved separately; a text part carrying the unsubscribe URL.

**It is not vacuous, and proved that on its first run** by rejecting three errors
in the allowlist I had just written: five entries for files where `sendEmail(`
occurs only inside a comment, one real caller I had missed
(`app/api/admin/settings/route.ts`, the operator test send), and one reason
string too short to be a reason.

31 tests. Committed as `f739a4b`. The full email suite is 1,435 tests across 60
files, all passing.

### 1.2 Nothing else in the subscriber system was defective

This is the honest result and it is worth stating plainly rather than padding the
section. Everything else examined was already correct; §3 lists what was checked
and what the evidence was. Two items that are *not* defects but are worth your
attention are in §4.

**No customer-facing copy was changed.** No wording, no design, no template. The
brief was to change copy only on evidence of a deliverability, correctness,
compliance or rendering defect, and no such evidence appeared.

---

## 2. DNS and provider changes you need to make

There is **one** DNS change to make now, and it is additive and safe. Everything
else in this section is a "later, after you have data" item.

### 2.1 Add aggregate reporting to DMARC — do this now

**Current record**, identical from Google (8.8.8.8), Cloudflare (1.1.1.1) and
Quad9 (9.9.9.9):

```
_dmarc.vantalabsresearch.com    TXT    "v=DMARC1; p=none;"
```

**Replace the value with:**

```
v=DMARC1; p=none; rua=mailto:dmarc@vantalabsresearch.com; fo=1
```

| Field | Where | Value |
|---|---|---|
| Type | | `TXT` |
| Name / Host | | `_dmarc` (i.e. `_dmarc.vantalabsresearch.com`) |
| Value | | `v=DMARC1; p=none; rua=mailto:dmarc@vantalabsresearch.com; fo=1` |
| TTL | | leave as-is, or 3600 |

**Why.** `p=none` with no `rua` is a policy that asks receivers to do nothing and
tell nobody. It is the only DMARC configuration that produces no information at
all. Adding `rua` changes nothing about how your mail is treated — the policy is
still `none` — but it makes Gmail, Yahoo, Microsoft and the rest send you a
daily XML summary of every IP sending mail as `vantalabsresearch.com`, whether it
passed SPF and DKIM, and whether those passes aligned. That report is the
evidence you would need before ever tightening the policy, and it is also how
you would find out that someone is spoofing your domain. `fo=1` asks for a
failure report when either mechanism fails, which is the useful setting when you
have no other visibility.

**Before you publish it:** `dmarc@vantalabsresearch.com` must be able to receive
mail. Your org domain has Google Workspace MX (`1 smtp.google.com`), so create it
in Google Workspace as an alias or group pointing at your own mailbox. Because
the reporting address is on the same domain as the record, no external-destination
authorisation record is needed. If you would rather not read raw XML — and it is
genuinely unpleasant to read — point `rua` at a DMARC analytics service instead
(Postmark's free DMARC digest, dmarcian, Valimail). Those are external
destinations, so the provider will additionally give you a record of the form
`vantalabsresearch.com._report._dmarc.<their-domain>` to publish; follow their
instructions rather than mine, because the value is theirs.

### 2.2 Do NOT move to `p=quarantine` or `p=reject` yet — but here is the evidence for later

You asked me to establish that every legitimate sender is aligned before
recommending any tightening. **They are — all three, on both mechanisms.**
Verified by resolving each record:

| Sender | Header `From` | SPF path | SPF aligned? | DKIM selector | DKIM aligned? |
|---|---|---|---|---|---|
| Google Workspace (you, by hand) | `…@vantalabsresearch.com` | `v=spf1 include:_spf.google.com ~all` on the org domain | strict | `google._domainkey.vantalabsresearch.com` | strict |
| Resend — transactional | `orders@vantalabsresearch.com` | envelope `send.vantalabsresearch.com` → `include:amazonses.com ~all` | relaxed | `resend._domainkey.vantalabsresearch.com` | strict |
| Resend — subscriber marketing | `news@mail.vantalabsresearch.com` | envelope `send.mail.vantalabsresearch.com` → `include:amazonses.com ~all` | relaxed | `resend._domainkey.mail.vantalabsresearch.com` | strict |

"Relaxed" is the DMARC default (`aspf` and `adkim` both default to `r`), and it
matches on the organisational domain — `send.mail.vantalabsresearch.com` and
`mail.vantalabsresearch.com` both reduce to `vantalabsresearch.com`, so they
align. Every one of the three also passes DKIM with an exact domain match, which
survives forwarding in a way SPF does not. There is no legitimate sender in this
setup that a `p=quarantine` would break *as far as I can see from the DNS*.

**"As far as I can see from the DNS" is exactly why I am not recommending the
change today.** DNS shows me the senders that are configured. It cannot show me
a sender nobody remembered — a form provider, an invoicing tool, a scheduler, a
CRM, a shipping notifier, something a past integration set up on your behalf. In
this configuration those all fail DMARC *right now*; under `p=none` that failure
is invisible and harmless, and under `p=quarantine` it becomes mail your
customers stop receiving. The `rua` reports in §2.1 are what turn that unknown
into a list of IPs and domains you can read.

**The staged path, when you want it:**

1. Publish the `rua` record. Wait **at least 30 days** of normal operation,
   including a month-end (invoicing and accounting tools are a classic surprise
   sender).
2. Read the reports. Confirm every source is either one of the three above, or
   something you recognise and can fix, or spoofing you.
3. `v=DMARC1; p=quarantine; pct=25; rua=mailto:…; fo=1` for two weeks. `pct=25`
   applies the policy to a quarter of failing mail, so a mistake is a quarter of
   a mistake.
4. `pct=100`, then `p=reject` only if the reports stay clean.

Note one thing about step 3 that is easy to miss: **the org-domain policy governs
the marketing subdomain too.** `sp` is absent, and an absent `sp` defaults to the
value of `p`, so tightening `_dmarc.vantalabsresearch.com` tightens
`mail.vantalabsresearch.com` at the same moment. That is fine here — the
marketing sender is aligned on both mechanisms — but it means there is no
"tighten the main domain only" half-step, unless you deliberately add
`sp=none`.

### 2.3 Optional, low priority, genuinely optional

- **MTA-STS and TLS-RPT** (`_mta-sts` and `_smtp._tls`) — absent. These enforce
  TLS on mail *arriving* at your Workspace domain. Worth doing eventually for
  inbound security; irrelevant to whether your marketing reaches an inbox.
- **BIMI** (`default._bimi`) — absent. Puts your logo beside the message in Gmail
  and Yahoo. Requires `p=quarantine` or stricter *first*, plus a Verified Mark
  Certificate (a trademark registration and roughly $1–1.5k/yr). Not worth it at
  17 subscribers; revisit if the list reaches five figures.

### 2.4 Nothing to change in Resend

Both domains are `verified` and `Sending: enabled` in the live account. Click
tracking is **off** on the marketing domain, which is the better setting and is
worth keeping — link rewriting through a shared tracking host is a well-known way
to inherit somebody else's reputation. Open tracking is on; see §4.3.

---

## 3. Subscriber deliverability protections verified

Each of these was checked against the running system, not inferred.

### 3.1 Authentication — verified against three resolvers

Resolved with Node's `dns/promises` against 8.8.8.8, 1.1.1.1 and 9.9.9.9. All
three returned identical answers, so this is not one resolver's cached view.
(Stated explicitly because an earlier pass in this session reported these records
missing; that was a shell error in my own command, not a fact about your DNS, and
it was retracted. The resolver script is the replacement, and its output is
reproduced below.)

```
vantalabsresearch.com                 TXT   v=spf1 include:_spf.google.com ~all
                                      TXT   google-site-verification=Xo3XQyDO5C7m…
                                      MX    1 smtp.google.com
_dmarc.vantalabsresearch.com          TXT   v=DMARC1; p=none;
resend._domainkey.vantalabsresearch.com       TXT  p=MIGfMA0GCSqGSIb3DQ… (218 chars)
google._domainkey.vantalabsresearch.com       TXT  v=DKIM1; k=rsa; p=MIIBIjANBg… (410 chars)

send.vantalabsresearch.com            TXT   v=spf1 include:amazonses.com ~all
                                      MX    10 feedback-smtp.us-east-1.amazonses.com

mail.vantalabsresearch.com            —     no A, no MX, no TXT  (correct: send-only)
resend._domainkey.mail.…              TXT   p=MIGfMA0GCSqGSIb3DQ… (218 chars)
send.mail.vantalabsresearch.com       TXT   v=spf1 include:amazonses.com ~all
                                      MX    10 feedback-smtp.us-east-1.amazonses.com
links.mail.vantalabsresearch.com      CNAME links1.resend-dns.com
```

The feedback MX records on both `send.` subdomains are what let Amazon SES
receive bounce and complaint notifications, which is how the suppression list
below gets fed.

### 3.2 The `From` / `Reply-To` split is correct

- Marketing sends from `Vanta Labs <news@mail.vantalabsresearch.com>` — a
  dedicated subdomain, so a campaign that ever draws complaints damages *that*
  domain's reputation and not the one carrying receipts and password resets.
- `mail.vantalabsresearch.com` has **no MX**, because it is a sending domain and
  not a mailbox. A reply to it would go nowhere.
- Therefore `Reply-To` resolves separately, to `orders@vantalabsresearch.com`,
  which sits behind Google Workspace MX and receives.
- The `List-Unsubscribe` **mailto is derived from the resolved Reply-To, not from
  the From**, so the opt-out address is one that a human actually reads. A
  mailto pointing at a domain with no MX is a broken opt-out, and filters score
  broken opt-outs.

### 3.3 One-click unsubscribe is correct and safe

`src/app/api/unsubscribe/route.ts` implements both halves properly:

- `POST` is RFC 8058 one-click — what Gmail's and Yahoo's own Unsubscribe button
  calls. It reads no cookies and requires no interaction; the signed HMAC token
  in the URL is the whole authorisation. It answers a bare `200`, and **5xx on
  failure**, so the mail client retries rather than silently dropping an opt-out.
- `GET` renders a confirmation page and **changes nothing**. That is not a
  nicety: corporate and ISP link scanners (Outlook Safe Links, Proofpoint,
  Mimecast) fetch every link in a message, and the token is per-address and does
  not expire — a state-changing GET would mean one scan silently unsubscribing
  that recipient forever.
- The route is exempt from the site's account wall, so an unsubscribe link works
  for a guest who has no account at all.

### 3.4 Suppression is honoured everywhere, and fails closed

- The `email_suppressions` read happens *before* the send, and a read **error**
  refuses the send rather than being treated as "not suppressed". That
  distinction is the whole risk: a database blip that reads as consent mails
  everyone who ever opted out.
- Suppression is also subtracted when the audience is resolved, so the recipient
  count you see before pressing Send is the truth rather than an overestimate
  that quietly shrinks.
- Both campaigns (`campaign-sender.ts`) and automations (`automations.ts`) route
  through `sendMarketingEmail`; neither has its own send path.
- Even the operator's campaign **test send**, which calls `sendEmail()` directly
  so a test is not logged as a real send, calls `isMarketingSuppressed()` first
  and refuses a suppressed address.
- Transactional mail is deliberately *not* suppressible. A password reset must
  arrive even for someone who has opted out of marketing, and the unsubscribe
  confirmation page says so in as many words.

### 3.5 Consent is double-gated, and truncation fails loudly

`lib/email/audience.ts` builds the audience from two independent stores —
`customer_preferences.marketing_emails` and `marketing_subscribers` — then
subtracts suppressions. If the audience query would be truncated by a page limit
it **throws `AUDIENCE_TRUNCATED`** rather than sending to a silently partial
list, which is the failure that would otherwise be invisible.

Live counts: 17 marketing subscribers (0 unsubscribed), 12 accounts opted in, 4
opted out, 2 suppressions.

### 3.6 Bounce and complaint handling

`lib/email/delivery-events.ts` distinguishes hard from soft bounces. A hard
bounce and a spam complaint both suppress the address immediately. A soft bounce
does not — it is tracked, and only escalates to suppression after a run of
consecutive failures, so one full mailbox does not cost you a customer.

**Live delivery record**, from `email_delivery_events`:

| Event | Count | Window |
|---|---|---|
| `email.delivered` | 116 | 2026-08-31 → 2026-09-06 |
| `email.opened` | 7 | 2026-09-06 |
| `email.bounced:transient` | 1 | 2026-09-01 (soft; correctly did **not** suppress) |
| hard bounce | 0 | — |
| complaint | 0 | — |

The two rows in `email_suppressions` are `bounced` and `complained` against
addresses at **`resend.dev`** — Resend's sandbox simulator, deliberately mailed
on 2026-08-31 seventeen seconds apart while the delivery webhook was being
tested. Neither is a subscriber. So the complaint count from real recipients is
zero. That is the correct number to report, and it is also not evidence of a good
reputation: 19 delivered marketing messages is far too small a sample to
establish one either way. See §4.1.

The same episode is why `isNonMailableAddress` exists — mailing
`complained@resend.dev` records a spam complaint against your domain *on
purpose, every time* — and the guard is deliberately narrow, covering only
provider sinks rather than anything that looks like test data.

### 3.7 Message construction

- Every message carries a plain-text part alongside the HTML; `text` is a
  required field on the send type, so an HTML-only bulk message cannot be
  constructed. HTML-only is a long-standing spam signal, and the text part is
  where the unsubscribe URL stays readable to a client that blocks HTML.
- The CAN-SPAM physical postal address is attached at the choke point, in both
  the HTML and the text part, and marketing is blocked entirely until it is
  configured (`marketingReady`). It is currently set.
- Each audience gets a reason line stating why this person is receiving the
  message.

### 3.8 Sending mechanics

- Campaigns send **serially**, in batches of 25, rather than firing hundreds of
  concurrent requests — smoother for the receiving side and for Resend's rate
  limits.
- Claiming a batch is a conditional update used as a lock, so two overlapping
  runs cannot both take the same recipients.
- The frequency guard takes a lock **on the address** and enforces one marketing
  message per 24 hours from any sender. Two automations firing on the same
  person the same afternoon results in one email and one deferral, not two
  emails.

---

## 4. Remaining risks

### 4.1 The domain is cold and the list has never been mailed — the biggest real risk

`mail.vantalabsresearch.com` was created on 2026-09-02 and has sent exactly one
broadcast, to 19 recipients. There are 17 active subscribers and one campaign
sent, ever.

This is not a defect and there is no configuration that fixes it. A new sending
subdomain has no reputation, and the only thing that builds one is a history of
mail people open and don't complain about. Until that history exists, every
receiver is guessing about you, and some of them will guess Promotions or Spam.

It also means **no deliverability claim about this domain can rest on its
history, because it does not have one.** 19 sends and 0 complaints is not a clean
record; it is an empty one.

The corollary matters for the ad launch: if paid traffic adds subscribers
quickly, resist the urge to greet the whole new list with a large one-off blast.
Growth through the welcome automation is self-warming, because those are the most
engaged messages you will ever send.

### 4.2 Campaigns and automations set no Resend idempotency key — reported, not fixed

`order-email-once.ts` sends an `Idempotency-Key`; the campaign and automation
paths do not. Combined with `reclaimStaleClaims` returning a `claiming` row to
`pending` after 10 minutes and `MAX_ATTEMPTS = 3`, a process that dies *after*
Resend accepted a message but *before* the outcome is written can send that
recipient up to three copies.

The exposure today is small — 17 recipients, batches of 25, so a campaign is one
short-lived batch — and it grows with the list.

**I deliberately did not ship a fix.** Adding a key is three lines; the risk is
in Resend's replay semantics for a *reused* key after an error, which I could not
verify from here without sending real mail through the production account. Get
that wrong and a transient failure becomes a permanent one for that recipient,
campaign-wide — a worse failure than the duplicate it prevents. The right next
step is to confirm the semantics against Resend's current API documentation, then
key each send on `campaign_id + recipient_id` (and `automation_run_id +
recipient_id`), which is stable across retries by construction.

### 4.3 Open tracking is on

Resend has open tracking enabled on `mail.vantalabsresearch.com`. That inserts a
1×1 remote image, which is how you get the 7 open events in §3.6. It is a normal
setting and I have not changed it — it is your decision, not a defect. Two things
are true about it: opens are the only engagement signal you currently have and
they are worth having, and a remote tracking pixel is a mild promotional-mail
signal and it inflates apparent engagement whenever an image proxy prefetches it.
Keep it while the list is small and you need the signal.

### 4.4 The tripwire is a tripwire, not a proof

`marketing-choke-point.test.ts` asserts that a file either calls `sendEmail()`
and is allowlisted, or does not call it. It cannot judge whether a message is
promotional *in content* — that judgement is what the allowlist records, one file
at a time, with a written reason. Adding a line to that list is a deliberate act
and should be read as one in review.

### 4.5 One sender is out of scope by instruction

The affiliate programme sends to a different audience under a different consent
model, deliberately, and it was left untouched. It shares the suppression list
and the same choke point, so an unsubscribe still stops affiliate marketing —
but nothing else about that system was audited here.

---

## 5. Recommended sending cadence for the next 30 days

Sized to the list you actually have: **17 subscribers**, a four-day-old sending
subdomain, one broadcast ever, and 6 enabled automations.

**Volume ramping is not the lever here, and you should not try to run one.**
Classic domain warm-up schedules are written in thousands of messages a day; you
cannot ramp 17 addresses, and splitting them into daily tranches would produce a
stranger sending pattern than simply mailing all 17 at once. What builds
reputation at this size is *consistency and engagement*, not volume curves.

| Week | Broadcasts | Recipients | Notes |
|---|---|---|---|
| 1 | 1 | all 17 | Send something a person who opted in would expect. |
| 2 | 1 | all 17 | Same weekday, roughly the same hour. |
| 3 | 1 | all 17 | |
| 4 | 1 | all 17 | Review opens before deciding week 5. |

**≈4 broadcasts, ≈68 marketing messages in 30 days**, plus whatever the 6
automations fire. That is a deliberately conservative floor; it is not the
maximum a list this size can take, it is the pace that costs you nothing while
the domain has no history.

Rules to hold to during those 30 days:

1. **One marketing message per person per week.** The code already enforces a
   24-hour floor per address; a weekly rhythm sits comfortably inside it and
   leaves room for an automation to fire without colliding.
2. **Same day, same rough hour, every week.** Predictable cadence is itself a
   positive signal; long silence followed by a burst is the pattern that reads as
   a compromised or rented list.
3. **Never import or buy a list, and never mail an address that did not opt in
   here.** This is the single fastest way to destroy a new subdomain, and it is
   irreversible on a timescale that matters.
4. **Watch the automations, because they are your real volume.** Six are enabled
   and they fire per-customer. If ad traffic starts converting, they will
   out-send your broadcasts without anyone deciding that.
5. **Keep transactional on `vantalabsresearch.com` and marketing on
   `mail.vantalabsresearch.com`.** The separation is the reason a bad campaign
   cannot take password resets down with it. Do not "simplify" it later.
6. **If the list grows past a few hundred, re-read this section.** At that point
   volume ramping becomes a real consideration and this cadence becomes too
   conservative.
7. **After 30 days, read the DMARC aggregate reports** from §2.1 before deciding
   anything about `p=quarantine`.

---

## 6. What is not controllable by us

Stated plainly, because the difference between "configured correctly" and
"guaranteed to land in Primary" is where email advice usually stops being honest.

- **Gmail's Primary / Promotions / Updates tab.** This is Gmail's classification
  of the *content and relationship*, not a header we set and not something
  authentication influences. A message with a bulk unsubscribe header,
  promotional language, images, offers and links is a promotional message, and
  Gmail is entitled to file it as one. **We are not going to try to
  circumvent that**, and I would advise against anyone who offers to: the
  techniques that "beat" the Promotions tab are the techniques spam filters are
  built to detect, and getting caught costs the Spam folder rather than the
  Promotions tab. A subscriber who wants your mail in Primary can drag one
  message there or add the sender to their contacts, and Gmail will honour it for
  that person. That is the only legitimate lever, and it belongs to them.
- **Whether any individual message reaches the inbox at all.** Every receiver
  runs its own filters against its own signals, including how *that specific
  recipient* has treated your mail before. Correct SPF, DKIM, DMARC and opt-out
  handling remove reasons to reject you; they do not compel acceptance.
- **Reputation, which is earned and not configured.** A four-day-old subdomain
  has none. It accrues from delivered mail that people open and do not report,
  over weeks. Nothing in this audit shortens that.
- **Recipient-side rules.** Corporate filters, personal filters, aggressive
  security gateways, forwarding (which breaks SPF — DKIM is what survives it,
  and yours is aligned), and image proxies that distort open rates.
- **What a subscriber does.** Anyone can hit "Report spam" instead of
  "Unsubscribe" on mail they genuinely asked for. The one-click unsubscribe
  header exists to make the cheaper option the easier one, which is the most we
  can do.
- **Provider-side incidents.** Resend, Amazon SES and the receiving providers all
  have outages, IP-pool reputation events and policy changes we neither see nor
  control.

---

## Conclusion

**All controllable deliverability factors for the subscriber marketing system are
correctly configured, and no known defects remain.** One defect was found and
fixed — the absence of anything holding the marketing choke point in place — and
it is now covered by a test that proved its own worth by rejecting three errors
in my first attempt at it. One DNS change is recommended and is described exactly
in §2.1. One known gap is documented rather than papered over in §4.2.

That is a different statement from "your mail will not land in Spam", and it is
deliberately different. Nobody can make the second claim. What can be said is
that the parts of the outcome that belong to us are in order, that the parts that
do not are named in §6, and that the remaining variable — reputation on a
four-day-old sending subdomain — is bought with time and wanted mail, on the
cadence in §5.
