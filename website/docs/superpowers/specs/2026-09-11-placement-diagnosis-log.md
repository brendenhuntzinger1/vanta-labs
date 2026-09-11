# Placement diagnosis log — 2026-09-11

Companion to `2026-09-11-recovery-to-benchmark-design.md` §5. Records what was
sent, to whom, and what could and could not be read. Nothing in production
changed: no DNS, no sender, no template, no customer received anything.

## What was sent

Each message was rendered by the real template functions with a representative
three-line cart, wrapped with the exact footer, postal address and pixel markup
that `sendMarketingEmail` appends, and sent through the production Resend
account from the real marketing From with the real Reply-To and both
List-Unsubscribe headers. Tracking links carry a null id, so nothing was
stamped. The temporary render file was deleted after use and never committed.

| # | Stage | Display name | To | Resend id |
|---|---|---|---|---|
| 1 | t30m | Vanta Labs | btunchi88@gmail.com | 05eef34b-f798-44f4-a5bd-6d0d58fbb8de |
| 2 | t12h | Vanta Labs | btunchi88@gmail.com | 38d8e334-e1b4-451a-a180-a2b52665b861 |
| 3 | t24h | Vanta Labs | btunchi88@gmail.com | 2afa68f5-b38f-4c43-913d-edefad254b3c |
| 4 | t72h | Vanta Labs | btunchi88@gmail.com | 0fd04c70-dd49-4ec8-99eb-b7b9fa809031 |
| 5 | t30m | Brenden at Vanta Labs | btunchi88@gmail.com | 0d8367a8-2520-42e5-af0f-a9296adddb59 |
| 6 | t30m | Vanta Labs | support@vantalabsresearch.com | ec2ba259-3ee4-4298-a893-df22fd25765c |

Seed 6 exists because the Gmail account connected to this session turned out
to be the support mailbox (Google Workspace), not the consumer address the
first five went to. It is the one message whose headers and folder could be
read from here.

## What was read

**Authentication (seed 6, from Google's own `Authentication-Results`):**

| Check | Result | Domain |
|---|---|---|
| DKIM | pass | `mail.vantalabsresearch.com`, selector `resend` |
| DKIM | pass | `amazonses.com` (the relay's own signature) |
| SPF | pass | `send.mail.vantalabsresearch.com` (return path), relay 54.240.9.10 |
| DMARC | pass | `header.from=vantalabsresearch.com`, `p=NONE sp=NONE` |

Both mechanisms align with the From domain, so authentication is not a
placement factor. Delivered over TLS 1.3.

**Folder (seed 6):** Inbox, not Spam. The support mailbox shows no category
labels on any of its mail, so it cannot say Primary versus Promotions.

**Delivery (seeds 1 to 5):** Resend reports `delivered` to the Gmail address.
Their folder and tab are not readable from this session.

**Two things noticed in the raw message, neither a defect:**

- Resend's own open-tracking pixel is appended after ours, because open
  tracking is switched on for the marketing domain at the provider. Every
  marketing message therefore carries two pixels. Harmless, but it means the
  provider's open count and ours are two views of the same fetch.
- Gmail's `dmarc=pass` line evaluates the organisational domain
  (`vantalabsresearch.com`); the subdomain publishes no `_dmarc` record of its
  own. This is expected and is left alone per §12 of the design.

## Still open

| Item | Who | What is needed |
|---|---|---|
| Gmail tab for seeds 1 to 5 | owner | In btunchi88@gmail.com: for each of the five messages, note Primary, Promotions, Updates or Spam. Different names on seeds 1 and 5 make them two entries in one thread. |
| Outlook, Yahoo, iCloud seeds | owner | One address each; the same six-message set will be sent and the folder read back by the owner from a checklist. |
| Google Postmaster Tools | owner | Enrol `vantalabsresearch.com` (covers the subdomain). Observation only. |

## Reading it

Authentication passes cleanly on every axis, so if the consumer seeds land in
Promotions or Spam the cause is reputation or content, not setup. The design's
decision rules in §5 apply once the tab readings arrive.

## Round one readings (owner, consumer Gmail)

| Seed | Stage | Tab |
|---|---|---|
| 1 | t30m reminder | Primary |
| 2 | t12h COA report | Primary |
| 3 | t24h free gifts | **Promotions** |
| 4 | t72h 10% off + gifts | **Promotions** |
| 5 | t30m, "Brenden at Vanta Labs" | threaded with seed 1; not separately read |

Authentication is clean (above), so the split is content. The two stages that
carry an incentive are the two classified as promotions, and they are also the
two that opened worst in September's real sends (7/18 and 5/11 against 10/24
and 13/21). The display name did not move anything. The shape did: "free
gifts" and "10% off" in the subject, a "FREE GIFT" badge, a dashed code box and
a "Claim my offer" button.

## Round two: plain-shape candidates

Same offer, same terms, in the shape of stage 1: a note that the cart is still
there, one sentence saying the gift is in the box, the terms in muted text, the
same "Complete my order" button, no badge, no code box, no "free" in the subject.
Copy written under the brand voice and compliance rules. Sent three minutes
apart so each can be read on arrival.

| # | Id | Subject | What it tests | Resend id |
|---|---|---|---|---|
| 1 | C3-A | A GHK-Cu has been added to your cart | stage 3, plain body, subject names the gift | 24be08e4-e906-48d8-992e-160351c13bb9 |
| 2 | C3-B | Your GHRP-2 5mg is still saved | stage 3, same body, subject names the cart only | b69afb8a-df87-4436-a3a9-07bb170d4eaa |
| 3 | C4-A | One last note about your GHRP-2 5mg | stage 4, plain body, no percentage in subject, no code shown | 936441ea-c50d-4ae1-9f05-2a14111bcb20 |
| 4 | C4-B | One last note, with 10% off your GHRP-2 5mg | stage 4, same body, "10% off" in subject | 20ee8ee5-744b-4a58-9823-fff39ae92f49 |
| 5 | W0 | A gift toward your first Vanta Labs order | welcome first-order offer exactly as configured today | ab727a10-dbda-4cf4-b2fa-95c362bbf230 |
| 6 | W1 | Before your first order | welcome offer, plain candidate | 09b3a89f-b351-4a9d-97f5-937f9b9617e1 |

W0 is seeded as a control because the configured copy has the same shape as
the two Promotions stages: an all-caps "YOUR FIRST ORDER IS 15% OFF" headline
and an offer box. It also carries "Every batch is third-party tested", which
the compliance reference calls a blanket claim that is false the moment one
product lacks a published report; W1 drops it. Neither W0 nor W1 changes the
configured automation; both are seeds only.

Reading rule: C3-B versus C3-A isolates the subject; C4-A versus C4-B isolates
"% off" in the subject; W1 versus W0 isolates the welcome copy. Anything that
lands in Primary is a candidate for the real template; the decision is then
made on stage 3 and 4 clicks, restores and orders, not on the tab.

## Round two readings (owner screenshot, 9:29 PM ET, "All promotions" view)

| Id | Subject | Tab |
|---|---|---|
| C3-A | A GHK-Cu has been added to your cart | **Promotions** |
| C3-B | Your GHRP-2 5mg is still saved | **Promotions** |
| C4-A | One last note about your GHRP-2 5mg | **Promotions** |
| seeds 1 + 5 (thread) | Your GHRP-2 5mg is still in your cart | now listed in **Promotions** |
| seed 2 | Every batch has a published report | not in the list, so Primary |
| C4-B, W0, W1 | | not yet arrived at screenshot time |

Removing the badge, the code box and the promotional wording did not move the
offer stages. The one message Gmail keeps out of Promotions is the one whose
subject and opening are informational (the COA report). Stage 1's earlier
Primary reading is now doubtful: its thread sits in Promotions after the
second message joined it.

Caveat: by this point the seed inbox had received nine similar messages from
the same sender within half an hour, which makes it a noisier instrument than
at the start. Results from a fresh seed inbox would be cleaner.

## Round three: two probes, one hypothesis each

| Id | Subject | What it changes | Resend id |
|---|---|---|---|
| P1-plain | Holding your GHRP-2 5mg | Same stage 3 offer as a short text note on a white background: no product images, no cart table, no gold button, one text link | c1c11954-3eff-4fa3-9954-ea7be934952d |
| P2-doc | Search the COA library before you order | The current dark card, cart table and button, but the subject and opening lead with the COA library the way stage 2 does; the gift comes second | 2cb1900a-cf74-4fb9-8d39-23d989a776cf |

Reading rule: P1 in Primary means the layout (images, prices, button) is the
trigger. P2 in Primary means the subject and opening are the trigger. Both in
Promotions is inconclusive in this inbox and the next round goes to a fresh
seed. Neither probe is a shipping candidate as written; each isolates one
variable.
