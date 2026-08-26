# Vanta Labs — Audit Coverage Matrix

**Purpose:** the master audit brief has 21 numbered phases *and* 23 additional
cross-cutting requirement sections. This file exists so none of them quietly
disappears because the audit got long — which the brief explicitly warns about.

**Companion files**
- [`FINAL-CERTIFICATION-AUDIT.md`](./FINAL-CERTIFICATION-AUDIT.md) — the ledger: findings, evidence grades, repairs
- [`PHASE1-SYSTEM-MAP.md`](./PHASE1-SYSTEM-MAP.md) — 11 subsystems, 183 recorded risks (none reproduced)

**Status key**

| | Meaning |
|---|---|
| ✅ | Done, with evidence in the ledger |
| 🟨 | Partially covered — the Phase 1 map surfaced leads, but nothing reproduced |
| ⬜ | Not started |
| 🔒 | Blocked on the network allowlist (needs a browser against the harness) |

---

## Part 1 — The 21 numbered phases

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Tooling / environment certification | ✅ | Superpowers, Playwright, Supabase, Vercel, Sentry, GitHub all invoked with evidence. Claude in Chrome confirmed unavailable. |
| 1 | System map | ✅ | 11 subsystems, 183 risks catalogued and ranked |
| 2 | Production data integrity | 🟨 | 12 findings; 2 later disproved. Read-only queries only. Row-cap risks unreproducible on 15 orders — needs generated data |
| 3 | Customer journey (Playwright) | 🔒 | Age gate PASS + trust claims captured. Everything data-driven blocked |
| 4 | Checkout / payments | 🟨 | Mapped in depth (both card and express lanes). 3 P1s recorded, none reproduced |
| 5 | Inventory / catalog | 🟨 | 1 P0, 5 P1 recorded. F-001 (31 of 36 products parent-zero) needs browser proof |
| 6 | Affiliate / ambassador | 🟨 | **F-009 and F-013 both fixed and LIVE in production; F-016 fixed in repo.** Remaining P0s: `markCommissionsPaid` ordering, `updatePartnerStatus` no-op, accrual/payout gated by different tables |
| 7 | Discounts / promotions / memberships | 🟨 | 1 P0, 5 P1. Includes the dormant Buy-3-Get-1 + coupon interaction |
| 8 | Emails | 🟨 | **F-017: historical defect #3 reproduced and repaired** — approval email quoted the pre-update `partners` copy. **Still NOT VERIFIED:** the `pending_emails` retry sweep P0 (sweep-then-retry can send a customer a second receipt), duplicate shipping emails, refund-confirmation dedupe |
| 9 | Fulfillment / Shippo / replacements | 🟨 | 2 P0, 4 P1. Replacements had no mapper — critic caught it |
| 10 | Financial reporting | 🟨 | No mapper owned it. Critic found 4 surfaces disagreeing on "an order", and a 4th hand-copy of the total formula |
| 11 | Admin | 🟨 | 4 P1 recorded. Not exercised as an operator |
| 12 | Auth / security / RLS | 🟨 | RLS re-certified 68/68 ✅. 4 P1 recorded. No IDOR testing done |
| 13 | Mobile / responsive / in-app | 🔒 | Nothing beyond the 390×844 tooling check |
| 14 | Performance / observability | 🟨 | Sentry reachable and alerting correctly (F-005). No performance work |
| 15 | Test quality / negative controls | 🟨 | 6 P0 targets identified. 9 mutation controls run (4 on F-009, 5 on F-013). **F-014: the database-backed proofs were skipping silently — the ledger's "loud skip" claim was false; fixed.** No CI exists at all, so the 14 proofs run only when a person sets `VANTA_TEST_DATABASE_URL` |
| 16 | Concurrency / idempotency | 🟨 | **F-016 found, reproduced with genuinely concurrent connections, and repaired** (sweep overwrote reversed/already-paid commissions → double payout). Certified under real contention: `markCommissionsPaid` exactly-once, both payout ledgers in step, paid-side-effects claim won by exactly 1 of 8. **Still NOT VERIFIED:** `markCommissionsPaid` ordering (paid before payout rows inserted), inventory/checkout concurrency, multi-tab |
| 17 | Cross-system collisions | ⬜ | Matrix not built |
| 18 | Complete browser regression | 🔒 | |
| 19 | Full test / typecheck / lint / build | ✅ | 3586 tests (204 files), tsc clean — at current HEAD. Re-run owed after each repair |
| 20 | Preview deployment verification | 🔒 | Vercel previews unreachable from the session |
| 21 | Final certification | ⬜ | Blocked until the rest lands |

---

## Part 2 — The 23 additional cross-cutting requirements

| # | Requirement | Status | What exists / what's missing |
|---|---|---|---|
| 1 | Browser storage / cache / stale state | 🔒 | Map documents the referral cookie (`vl_referral_code`, 30d, non-httpOnly, never read server-side) and cart persistence. **No stale-state testing done** — stale price, stale rate, stale stock all untested |
| 2 | Multi-tab / multi-session | ⬜ | Not touched |
| 3 | Third-party failure / degraded mode | 🟨 | Map found several fail-open paths (inventory reservation fails open; Veyra empty rate list falls open to $0 shipping). No fault injection performed |
| 4 | Background jobs / cron / retries | 🟨 | Fully mapped. Single cron `/api/cron/sweep` every 30 min. 8 P1s including unbounded scans in a 60s budget and select-then-send with no claim |
| 5 | Migrations / deployment order | 🟨 | **F-011 found and baseline captured.** 4 migrations exist in the DB and were never committed. Full table/policy diff still owed |
| 6 | Backup / recovery / disaster | ⬜ | Not touched. No PITR capability check, no reconstruction analysis |
| 7 | Domain / DNS / TLS / redirects | 🔒 | Blocked — the production domain is unreachable from the session |
| 8 | SEO / crawlability / social | ⬜ | Not touched. `robots.txt` and `sitemap.xml` exist in the build output |
| 9 | Accessibility | 🔒 | Age-gate a11y tree captured incidentally. No keyboard, focus, contrast or screen-reader work |
| 10 | JS-disabled / hydration | 🟨 | Established that console noise here is HMR-only and that the app must be tested on a production build. No hydration audit |
| 11 | Analytics / attribution / pixels | 🟨 | Mapped. `ad_purchase_events_sent` dedupe exists. 2 P1s: Reddit purchase lacks durable idempotency; hardcoded production pixel ids as env fallbacks. Critic found express orders never attributed to a campaign |
| 12 | Time / date / timezone | ⬜ | Not touched |
| 13 | Money / numeric precision | 🟨 | Percentages stored as `numeric(5,2)`, money as `numeric(12,2)`, cents as integers. **No boundary or rounding testing** |
| 14 | Rate limiting / abuse | 🟨 | Rate limiting exists and is used. Critic found **three different client-IP resolvers**, making public rate limits bypassable |
| 15 | File / image / upload safety | ⬜ | Not touched. `/api/admin/upload-image` exists and is unaudited |
| 16 | Legal / policy / support | 🟨 | Critic found legal content is admin-editable with a silent revert to coded defaults. Trust claims captured in-browser. **COA claim unsubstantiated (F-006)** |
| 17 | Environment / secret / config drift | 🟨 | Mapped as Part C of the jobs/config sweep. Dangerous defaults catalogued |
| 18 | Dead / legacy / dormant code | 🟨 | Critic found: `product_subscriptions` written but never read; wholesale/contact leads never persisted; a dead admin shipping-email branch |
| 19 | Post-deployment certification | 🟨 | Done once, for F-009 — applied, verified in production, rollback path recorded. Not yet a repeatable gate |
| 20 | Rollback / blast radius | ✅ | Applied per-repair. F-009 has an exact revert (re-apply the baseline file) |
| 21 | Unknown-unknown pass | 🟨 | The critic pass was partly this — it found 12 subsystems no mapper owned. A deliberate pass without the historical bug list is still owed |
| 22 | Requirements traceability matrix | 🟨 | **This file is the start of it.** Needs per-requirement evidence links once phases complete |
| 23 | Final zero-regression gate | ⬜ | Not reached |

---

## Honest summary

Of 44 tracked items (21 phases + 23 requirements):

- **✅ 5 complete**
- **🟨 24 partially covered** — leads exist, nothing reproduced
- **🔒 6 blocked** on the network allowlist
- **⬜ 9 not started**

The map means the *unknown* work is now mostly *known* work, which is the
expensive part. But "mapped" is not "verified", and nothing in the 🟨 column
counts as evidence yet.

### The nine untouched items, and whether they matter for launch

| Item | Launch-critical? |
|---|---|
| Multi-tab / multi-session | **Yes** — two tabs racing one cart is a real oversell/double-charge path |
| Time / date / timezone | **Yes** — coupon and membership expiry boundaries decide who gets charged what |
| Concurrency / idempotency (Phase 16) | **Yes** — this is where duplicate charges and double commissions live |
| Cross-system collisions (Phase 17) | **Yes** — the brief's own point: individually-correct systems that break together |
| File / image / upload safety | Only if the admin uploads untrusted files |
| Backup / recovery | Not for launch, but before scale |
| SEO / crawlability | No — revenue-relevant, not correctness-relevant |
| Accessibility | Not for launch correctness; is a legal/ethical exposure |
| Zero-regression gate | Final step, by definition |

**The four "Yes" rows are the biggest remaining risk to a launch decision**, and
none of them has been started. They are all reproducible without a browser.
