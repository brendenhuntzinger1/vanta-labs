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
