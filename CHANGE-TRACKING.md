# Change Tracking Log — Vanta Labs

Purpose: track every change made across **GitHub, Vercel, Supabase, and the live
website** while a third party reviews and edits the project, and explain in plain
English what each change did.

Each monitoring pass appends a dated entry below. The top section is the fixed
baseline the passes are compared against.

---

## Coverage & blind spots (read this first)

What can actually be observed depends on where a change lands:

| Platform  | What I can see | How |
|-----------|----------------|-----|
| **GitHub** | Everything — commits, PRs, branches, file diffs, reviews, CI results | Full API access |
| **Website (code)** | All of it — the site is built from this repo, so any code/UI/logic change is a GitHub commit | Via GitHub |
| **Vercel** | Only what reaches the repo (deploys are triggered by GitHub pushes) | Indirect |
| **Supabase** | Only schema changes committed as SQL files in `website/src/lib/sql/` | Indirect |

**Blind spots** (no direct API access from this environment):
- **Vercel dashboard-only changes** — environment variables, domains, project
  settings, redeploys, rollbacks. Not visible unless they touch the repo.
- **Supabase data/schema changes made directly** — products, prices, inventory,
  content edited through the admin dashboard or Supabase Studio live in the
  database, not in git, so they leave no trace here.

To close those blind spots, a **read-only** Vercel token and/or Supabase
(service-role or read-only DB) connection would be needed. Until then, GitHub is
the window, and it captures every *code* change completely.

---

## Baseline snapshot — 2026-07-28T17:55Z

**`main` HEAD:** `a8dea425ed1e1bed244d4a9433ff3cd48b71f1f4`
— "Add Vanta Labs favicon set (V monogram tabs + wordmark install icons) (#15)"

**Branches at baseline (11):**
| Branch | HEAD SHA |
|--------|----------|
| main | a8dea42 |
| claude/batch-testing-3pl-setup-2vf8su | af2ee9e |
| claude/chat-session-lhkhnz | 28dab8a |
| claude/continue-previous-work-kqo7s9 | 1a9ae84 |
| claude/continue-working-06kews | 9f0b660 |
| claude/ecommerce-platform-audit-h4oxln | 529a642 |
| claude/glp1-site-pricing-5a6860 | 5bf89c7 |
| claude/vanta-labs-connection-6wicam | 9ed80a0 |
| claude/vercel-migration-5jinmh | 188ab69 |
| claude/website-editing-gqujtb | f3329b2 |
| vercel-agent/launch-hardening | e69a83e |

**Pull requests at baseline:** #1–#15, all closed/merged. Latest merged: #15
(favicon set), #14 (non-payment launch hardening, opened by vercel[bot]).

**Open PRs:** none.

No third-party changes recorded yet — this is the starting line.

---

## Change log

_(New entries appended here, newest first, as changes are detected.)_
