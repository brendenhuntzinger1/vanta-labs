# Email system verification — 2026-09-07

Scope: the **automated customer/subscriber email system** and the **subscriber
campaign system**. The affiliate programme was not modified. Day 30 / 40 / 50
were not changed. No customer-facing copy was rewritten.

**Verdict: READY WITH DOCUMENTED LIMITATIONS.** What that means, precisely, is
in the last section — including the four things that keep it from being a plain
READY.

---

## 0. The headline

The automations and the campaign path are demonstrated end to end, against real
Postgres and the real `/api/cron/sweep`, with the delivered messages read back
from the provider — not inferred from code and not inferred from a green suite.

That took repairing the test environment first, because **none of the email QA
suites could run at all**, and had not been able to for some time. That is the
most important finding in this document: the automations were not unverified
because anyone chose not to verify them, but because every attempt to do so
failed with an error that named something else.

---

## 1. Confirmed defects found and fixed

### 1.1 A campaign could send duplicates without limit — FIXED

Campaigns claim a recipient with a conditional `UPDATE` (`status = 'claiming'`),
which is a lock and not a record. A worker that dies **after** Resend accepts
the message but **before** writing `'sent'` leaves the row at `'claiming'`; ten
minutes later `reclaimStaleClaims` returns it to `'pending'` and another worker
sends it again.

Worse than reported in the previous audit, which said "up to 3 duplicates":
`attempts` is incremented only on a **handled** outcome (sent / suppressed /
failed). A crash is not a handled outcome, so the reclaimed row comes back with
`attempts` unchanged and the `MAX_ATTEMPTS` ceiling never binds. Against a
repeating crash in that window the true bound is **none**.

Automations never had this hole. `email_send_log_automation_once` is a partial
unique index over `(campaign_type, reference_id) WHERE status <> 'failed'`, so a
crashed send leaves the row at `'sending'` and the row itself goes on holding the
slot.

**Fix:** `sendMarketingEmail` now sends a Resend `Idempotency-Key`. The
plumbing already existed (`sendEmail` → `providers/resend.ts`); the wrapper
simply never supplied one.

The key hashes the **rendered subject and body** along with the addressing, and
that detail is the fix rather than an optimisation. Keyed on
`(campaignType, referenceId, recipient)` alone, an automation carrying a gift —
which mints a fresh one-time token on every render — would, after a legitimate
failure, re-render with a different token, collide with its own earlier attempt,
draw a `409`, and drop that customer from the sequence permanently and silently.
Hashing the body makes the key mean *this exact message to this exact person*:

- crash after Resend accepted → identical re-render → same key → Resend replays
  the original response and does not send again
- genuine retry after a failure → new token, new body → new key → sends

**Resend's semantics were verified, not assumed** (their documentation, checked
2026-09-07): keys live **24 hours**, max 256 characters, a repeat with an
identical payload returns the original response, and a differing payload returns
`409`. Every retry path here sits far inside that window — the reclaim cutoff is
ten minutes and the ceiling is three attempts.

### 1.2 The email QA suites could not run — FIXED

Five independent gaps, each surfacing as an error that pointed somewhere else:

| Gap | What it looked like |
|---|---|
| `CRON_SECRET` absent from `.env.test.local` | `/api/cron/sweep` answered **401**. `qa-retention-system`, `qa-lifecycle-email` and `qa-gift-wiring` could not take a single step. |
| `qa-harness-up.sh` started the app without `NODE_TLS_REJECT_UNAUTHORIZED=0` | `gotrue-tls-proxy` serves a self-signed cert and `.env.test.local` points the app at it. Every server-side Supabase call failed and burned its timeout: **the sweep went from 0.3 s to over 90 s** and was cut off, each job reporting its own unrelated-looking failure ("unable to list users", "RPC failed", "FAILING OPEN"). |
| `EMAIL_ENABLED=false` | The sweep reported "Email sending is turned off in Settings" and mailed nobody. |
| `EMAIL_PROVIDER=none` | Resolves to `smtp`, which then fails `isReady()`: "the email provider isn't fully configured". |
| the SMTP sink was never started | A missing sink looks exactly like "the send failed". |

`NODE_EXTRA_CA_CERTS` does **not** fix the second one — a depth-zero self-signed
leaf is refused however the CA store is loaded. Both the runbook and
`gotrue-tls-proxy.mjs`'s own header already said to use
`NODE_TLS_REJECT_UNAUTHORIZED=0`; the script bypassed them.

`qa-harness-up.sh` now checks every required variable **by name**, starts the
sink, and sets the TLS variable — so the next person is told what is missing
instead of finding them one rebuild-and-rerun at a time.

### 1.3 The harness could not observe two of the properties the audit claims — FIXED

`smtp-sink.mjs` extracted the `text/html` part and stopped. Every captured
message came back with an `html` and no `text` and no `replyTo`, so **no
end-to-end test could see**:

- that a bulk message is multipart rather than HTML-only (HTML-only is a
  long-standing spam signal)
- that the unsubscribe URL is readable to a client that blocks HTML
- that marketing replies go to a mailbox that receives, because the marketing
  From is a send-only subdomain with no MX

The message on the wire was always correct — verified against the raw MIME — but
"correct and untestable" is how a regression ships. The sink now surfaces both
parts and `Reply-To`.

### 1.4 `qa-harness-up.sh`'s readiness probe reported a broken store on a healthy one — FIXED

It asked `/api/catalog/products` anonymously and expected products. `access-policy.ts`
closed that default, so the correct `{"success":false,"error":"Sign in to continue"}`
was read as **"CATALOGUE EMPTY OR FAILING"** on every healthy run. It now asks the
shim for the data and separately confirms the app enforces the wall.

---

## 2. What is now proved, and how

### 2.1 The boundaries, one day either side

`src/lib/email/automation-boundaries.test.ts` (29 tests) puts **three customers
in front of one sweep** — a day short, exactly on the threshold, a day past —
and names who is selected. The existing replay walks one customer forward
through time, which cannot catch an off-by-one: firing a day early still
produces a "day 30" line in the calendar, one row lower.

It also wires `ladderPredecessor` the way `runAutomationSweep` does. **The
existing replay never passes it**, so win-back 2's gate was being asserted under
a rule the real sweep does not use — agreeing only because 50 − 40 happens to
equal the ten days the gate demands. Move win-back 2 to day 45 and the replay
would still pass while production held the message back.

### 2.2 The same thing against a real database

`scripts/qa-automation-truth.mjs` — **12/12 passing** — drives the real
`/api/cron/sweep` against real Postgres and reads the messages back out of the
provider:

```
PASS  day 29 waits; day 30 and day 31 get the reorder reminder
PASS  day 39 waits; day 40 and day 41 get win-back 1
PASS  day 49 waits; day 50 and day 51 get win-back 2
PASS  an unsubscribed customer on day 30 receives nothing
PASS  a hard-bounced address receives nothing
PASS  a complained address receives nothing
PASS  someone who never consented receives nothing
PASS  the delivered message carries every deliverability header
PASS  two sweeps in flight at the same time send no duplicates
PASS  a further sweep sends nothing to anyone already mailed
```

Every excluded customer stands **exactly on day 30**, so silence cannot be
explained away as ineligibility. The concurrency case is two real HTTP requests
genuinely in flight at once, resolved by the real partial unique index.

### 2.3 The campaign path, then attacked

`scripts/qa-campaign-truth.mjs` — **9/9 passing** — walks subscriber → consent →
audience → campaign → personalisation → suppression → wrapper → provider →
unsubscribe → suppression, then tries to break each guarantee:

- a **GET** on the unsubscribe link changes nothing (200, no suppression row).
  Link scanners fetch every URL in a message and the token never expires; a
  state-changing GET would opt out people who never asked.
- a **tampered token** is refused (400, nothing written).
- the real **RFC 8058 one-click POST**, using the token lifted out of the
  delivered message, suppresses the address.
- a **second campaign** then refuses that address — with a never-mailed third
  recipient as the positive control proving the campaign actually ran.
- the same person **still receives their account mail**: the signup confirmation
  arrives at an address suppressed for marketing, and carries no
  `List-Unsubscribe` header, because it is not marketing.

Two of these failed first time and **both were the test being wrong about the
product**, which is worth recording because the instinct is to reach for the
source: the recently-mailed recipient was `pending` because the 24-hour
frequency guard correctly deferred them, and signup answered 403/400 because the
harness was not sending the same-origin header or the 21+ and research-use
acknowledgements a real customer sends.

### 2.4 The tests can detect failure

Every protection below was broken deliberately and the suite confirmed red, then
restored (`scripts/mutate.sh`, which restores from a copy rather than
`git checkout`):

| Mutation | Result |
|---|---|
| boundary comparison `>` → `>=` | RED |
| ladder gate disabled | RED |
| grace window removed | RED |
| quiet period disabled | RED |
| idempotency key not passed | RED |
| key ignores the body | RED |
| key ignores the recipient | RED |
| `Idempotency-Key` header removed from the provider | RED |

**Suppression produced a more interesting result than expected**, and it is the
strongest single answer in this document to "if someone unsubscribes, can any
marketing path still reach them?":

| Mutation | Result |
|---|---|
| per-send suppression check removed | still silent — the audience subtraction catches it |
| audience subtraction removed | still silent — the per-send check catches it |
| **both removed** | **all three addresses mailed; the harness fails, correctly** |

Suppression is enforced **twice, independently**. You would have to break both
layers, and the harness sees it when you do.

---

## 3. Production deliverability

### 3.1 DNS, re-verified with a real resolver

Resolved through Google (8.8.8.8), Cloudflare (1.1.1.1) and Quad9 (9.9.9.9),
identical from all three. Unchanged from the 2026-09-06 audit: SPF, DKIM (both
selectors, both domains), DMARC `p=none`, MX, the SES feedback MX on both
`send.` subdomains, and the correct **absence** of MX/A/TXT on
`mail.vantalabsresearch.com` (send-only).

### 3.2 Resend delivery history, last 30 days

| | All | `vantalabsresearch.com` (transactional) | `mail.vantalabsresearch.com` (marketing) |
|---|---|---|---|
| sent | 199 | 160 | 39 |
| delivered | 194 (97.49%) | 155 (96.88%) | **39 (100%)** |
| bounced | 5 (3 permanent, 2 transient) | 5 | **0** |
| complained | 1 (0.5%) | 1 | **0** |
| opened | 9 / 8 unique | 0 (tracking off) | 9 / 8 unique (20.51%) |
| unsubscribed | 0 | 0 | 0 |
| delivery delayed | 19 | 19 | 0 |

**The complaint and one permanent bounce are our own test sends.** Resend's
webhook event log shows `email.complained` at `2026-08-31T03:08:51.9Z` and
`email.bounced` at `03:08:35.4Z`, matching our two `email_suppressions` rows to
the second — both `@resend.dev`, Resend's sandbox, mailed deliberately while the
webhook was being tested. **Real-customer complaints in 30 days: zero.**

Stated plainly because the raw number invites the wrong conclusion: a 0.5%
complaint rate would be above Gmail's 0.3% guidance if it were real. It is not.

### 3.3 The webhook is healthy

Every event Resend has delivered to `/api/webhooks/email` since the endpoint was
created (2026-08-31 02:58) shows status **success** — 139 events reviewed across
two pages, including the bounce and complaint above. Bounce and complaint
handling works: those two events wrote their suppression rows.

---

## 4. Remaining risks and outstanding items

### 4.1 Two real hard-bounced addresses are missing from our suppression list

Resend's own suppression list holds two addresses added by hard bounce on
**2026-08-23** and **2026-08-27** — both **before** the webhook existed
(2026-08-31), so those events were never delivered to us. Our
`email_suppressions` does not contain either.

**Live exposure: none.** Neither address is on the marketing list, and Resend
refuses them at the provider regardless. But our table should carry them for
correctness and for provider portability. It is a two-row backfill.

### 4.2 `RESEND_WEBHOOK_SIGNING_SECRET` is NOT set — CONFIRMED, and it is the one open security item

The webhook route supports Svix signature verification, but only when that
variable is set. **It is not set in production.** Established by probe against
the live endpoint on 2026-09-07:

| Probe | Response | Meaning |
|---|---|---|
| no secret at all | **401** | the URL secret is enforced |
| correct URL secret, no Svix headers | 200 | unsigned deliveries pass **by design** — SendGrid sends none, and this endpoint serves both providers |
| correct URL secret, **deliberately invalid** Svix signature | **200** | the signature is not being checked, so the variable is absent |

The third row is the discriminator. With the signing secret set,
`verifySvixSignature` returns `bad-signature` and the route answers 401; it
answered 200. The second row is what makes a missing-header probe useless and is
why the invalid-signature form was needed.

**The probe wrote nothing.** Both requests carried a body with no `type` field
beginning `email.` and no `event` field, so `parseDeliveryEvents` returns an
empty array and the handler returns before `applyDeliveryEvents` is reached.
Both responses were `{"received":0,"suppressed":0}`, which is that path
reporting itself.

**Consequence**, in the route's own words: authentication binds to the URL and
nothing else. Possession of the webhook URL is **full write access to the
suppression list** — one forged `email.complained` per address lands an
unliftable suppression and flips that customer's marketing preference off, which
they cannot undo from their account page by design. Addresses are guessable for
any customer whose email is known. The URL is obtainable from the Resend
dashboard, a proxy or CDN access log, or a screenshot of the webhook
configuration.

**The fix**, which needs the owner because this session has no Vercel token, no
CLI and no environment-variable tool:

    Vercel → vanta-labs → Settings → Environment Variables
      Name         RESEND_WEBHOOK_SIGNING_SECRET
      Value        the endpoint's signing secret, from
                   Resend → Webhooks → this endpoint → Signing Secret
                   (a value beginning `whsec_`)
      Environment  Production

Then redeploy — an environment variable only takes effect on a new build. The
probe above re-run should answer **401** on the third row.

**Rotate the URL secret at the same time.** It currently travels in the query
string, where Resend's dashboard, proxies and CDN logs all record it, and its
value reads like a personal password rather than a generated secret. The route
already accepts the `x-email-webhook-secret` header form, which keeps it out of
URLs entirely.

**Related, and worth doing either way:** the webhook secret currently travels in
the URL query string, where proxies, CDN logs and dashboard screenshots
routinely record it, and its value reads like a personal password rather than a
generated secret. Rotate it to a random value, and prefer the
`x-email-webhook-secret` header form the route already accepts.

### 4.3 `qa-retention-system.mjs` is a sixth stale harness — diagnosed, not repaired

It fails at 29 of 31 steps with `Sign in to continue`: it drives checkout,
quote and tracking as an anonymous fetch client, and `access-policy.ts` closed
that default. It is the same staleness class as the five harnesses repaired in
the launch audit; this one was not among them.

It needs a post-wall customer session, the way `qa-purchase-path.mjs` was
repaired. I scoped that out rather than half-repair a 31-step suite under
budget. **What it uniquely covers and this audit therefore does not:** gift
minting against competing discounts, cart-recovery interaction, the reorder link
across session states, and the admin statistics panel. The email behaviour it
covers — the day 30/40/50 ladder, campaign-and-automation collision, suppression
— is covered by the two new harnesses.

### 4.4 The idempotency fix's effect is verified by documentation, not observed locally

The local harness sends over SMTP to a sink, which has no idempotency semantics.
What is proved locally: the key is computed correctly, is stable for an
identical message, changes when the body changes, differs per recipient, fits
the 256-character limit, and reaches the provider as an `Idempotency-Key`
header. What is taken from Resend's documentation: that they collapse a repeat
carrying it. Confirming the end-to-end effect would mean deliberately crashing a
real campaign mid-send against the live account, which is not worth doing.

### 4.5 The tripwire is a tripwire

`marketing-choke-point.test.ts` asserts a file either calls `sendEmail()` and is
allowlisted, or does not call it. It cannot judge whether a message is
promotional *in content* — that judgement is what the allowlist reasons record.

### 4.6 Unrelated pre-existing failure

`src/lib/typescript-lsp-runs.test.ts` fails in this container. Confirmed
pre-existing by stashing every change in this audit and re-running. It concerns
the TypeScript language-server configuration, not email, and was left alone.

---

## 5. The acceptance questions, answered

1. **A new subscriber is stored correctly?** Yes — two consent stores, verified
   in `qa-campaign-truth.mjs`.
2. **The correct email is generated and sent when they become eligible?** Yes —
   `qa-automation-truth.mjs`, real sweep, message read back from the provider.
3. **Day 30 / 40 / 50 execute at the intended times?** Yes, exactly, proved one
   day either side against a real database.
4. **Can the same customer receive duplicates?** Automations: no — a real unique
   index, proved under two concurrent sweeps. Campaigns: there was an unbounded
   window; it is closed (§1.1), with the caveat in §4.4.
5. **If someone unsubscribes, can any marketing path reach them?** No, and you
   would have to break **two independent layers** — demonstrated by mutation.
6. **Can a bounced or complained address be mailed again?** No; same two layers,
   same demonstration.
7. **Do campaigns genuinely reach the provider?** Yes — messages read back with
   their headers intact, not merely marked sent internally.
8. **Are the delivery webhooks reflected in our database?** Yes for everything
   since the endpoint was created; two pre-webhook bounces are missing (§4.1).
9. **Are SPF/DKIM/DMARC and alignment correct in real DNS?** Yes — three
   resolvers, all three senders aligned on both mechanisms.
10. **Anything configured in a way likely to damage reputation?** One, confirmed
    by probe: the webhook signing secret is not set, so the URL alone can write
    to the suppression list (§4.2). It is an access-control risk rather than a
    sending one, but a forged complaint is an unliftable suppression.
11. **Are transactional emails isolated from marketing suppression?** Yes —
    proved by delivering an account confirmation to an address suppressed for
    marketing.
12. **Can an automation fail silently?** The known silent-failure modes are
    closed: a missing offer token closes the slot `failed` and reports the
    reason; a failed quiet-period read fails the whole sweep closed; a
    suppression read error refuses the send. What *was* failing silently was the
    testing, and that is §1.2.

---

## 6. Why READY WITH DOCUMENTED LIMITATIONS, not READY

The automations and campaigns are demonstrated end to end and no known defect
remains in them. Four things are honestly short of proved:

1. The webhook signing secret is **confirmed absent** (§4.2) — the one item with
   a real security consequence, and it needs you. Until it is set, possession of
   the webhook URL is write access to the suppression list.
2. Two suppression rows are un-backfilled (§4.1) — no live exposure.
3. `qa-retention-system.mjs` remains stale (§4.3), so the gift-versus-discount
   and cart-recovery interactions are not covered end to end by this audit.
4. The idempotency fix's provider-side effect rests on Resend's documentation
   rather than an observed crash (§4.4).

None of these is a reason to hold the system. All four are reasons not to call
it unconditionally READY, which was the standard you set.
