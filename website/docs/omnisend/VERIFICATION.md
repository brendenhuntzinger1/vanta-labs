# Omnisend transition: verification record

Every row is one of: **configuration check** (read the configured object),
**unit test** (vitest, deterministic), **harness** (the local Next.js harness
against a local Postgres with the real schema, Omnisend gate OFF so nothing
leaves the machine), **seed test** (a real message delivered to an owner
mailbox or phone — only with the owner's authorisation), **production
evidence** (a real event observed after cutover). A row is PASS only with
the evidence named. "API accepted the request" is never inbox delivery.

Statuses: PASS · FAIL · BLOCKED (named dependency) · UNTESTED.

| # | Scenario | Method | Status | Evidence |
|---|---|---|---|---|
| 1 | New signup, email consent only → contact subscribed (email), no phone identifier, welcome code minted | unit + harness | UNTESTED | |
| 2 | New signup with email and SMS consent → phone identifier with sms subscribed and consent source/time | unit | UNTESTED | |
| 3 | Phone supplied without SMS consent → no phone identifier pushed | unit | UNTESTED | |
| 4 | Previously unsubscribed / suppressed address in the import → pushed as unsubscribed, never re-subscribed by write-back | unit | UNTESTED | |
| 5 | Duplicate event and retried webhook → one ledger row, one send | unit + harness | UNTESTED | |
| 6 | Cart abandoned → updated → recovered → purchased: events sent, exit on order, cart offers not minted after purchase | unit + harness | UNTESTED | |
| 7 | Purchase immediately before a queued recovery send → Omnisend exit condition (placed order) documented; store side stops minting | configuration + unit | UNTESTED | |
| 8 | Failed payment vs confirmed paid order → no paid event on failure | unit (source) | UNTESTED | |
| 9 | Existing customer midway through the legacy cart sequence → finishes in-house, no Omnisend cart event | unit | UNTESTED | |
| 10 | Old in-house recovery link after cutover → still restores the cart | harness | UNTESTED | |
| 11 | Every active gift/discount tier → code percent and gift text per band; checkout enforces assigned address, single use, expiry, minimum | unit | UNTESTED | |
| 12 | Out-of-stock gift → dropped from the offer; expired offer → not promised | unit | UNTESTED | |
| 13 | Email unsubscribe in Omnisend → store suppression; SMS STOP → sms_opted_out_at | unit (plan) | UNTESTED | |
| 14 | Opt-out while a message is queued → Omnisend sending thresholds (configuration); store re-reads consent before every push | configuration + unit | UNTESTED | |
| 15 | Quiet hours → Omnisend account setting (owner); SMS blocks only in flows | configuration | BLOCKED (owner: SMS settings) | |
| 16 | Provider/API outage and recovery → hook never throws, ledger releases claim, backstop retries paid orders | unit | UNTESTED | |
| 17 | Rollback without replaying completed marketing steps → ledger rows survive; in-house resumes; consent unchanged | unit + doc | UNTESTED | |
| 18 | Password reset, receipt and shipping email still function through Resend (unchanged paths) | unit (existing suites) | UNTESTED | |
| 19 | Omnisend link route: logged-out desktop and mobile (390x844) land on the target page past the account wall; expired token → sign-in | harness | UNTESTED | |
| 20 | Template render at 600 and 390 wide: hierarchy, one primary action, alt text, links carry the grant | preview render | UNTESTED | |
| 21 | Seed sends of each template to an owner mailbox | seed | BLOCKED (owner authorisation; sender domain) | |
| 22 | Production: first real event of each type observed in omnisend_events_sent and in Omnisend | production evidence | BLOCKED (cutover) | |
