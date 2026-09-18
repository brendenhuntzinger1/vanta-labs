# Phase A handoff — verified state, and the traps

Written at the end of the session that produced `f154d530` and `43d4014e`.
Everything here was checked against the repo or production, not remembered.

## State, verified

| | |
|---|---|
| Production / `origin/main` | `be25a5f0` — the completed wheel work |
| Branch | `claude/zealous-johnson-atb3n5` at `43d4014e`, pushed, tree clean |
| Ahead of main | exactly 2 commits, neither deployed |
| Last full suite | 757 files, 11,660 passed, 11 skipped; typecheck + lint clean |

**Do not deploy those two commits alone.** They retire the 15% acquisition
incentive. Until the wheel opt-in modal replaces it, deploying them leaves the
store advertising nothing.

## What is already done (do not redo)

- `welcome` codes no longer mint — gated at the only two call sites,
  `claimWelcomeOffer` and `grantWelcomeOfferForConsent`.
- `winback` (also 15%) and `recovery` (10%) untouched. The retirement is keyed
  on the code KIND, not the number.
- Existing holders keep their code: the live-code read runs BEFORE the gate.
- Checkout no longer advertises a discount. The consent checkbox, its wording,
  its disclosure and the consent POST are unchanged — the POST still writes the
  ledger row, it just no longer reads a code back.
- **Account settings already behaves correctly** and needs no change: it gates
  the welcome-code panel on `welcomeCode` being truthy, so it only ever speaks
  to a genuine historical holder. Verified, not assumed.

## Still carrying 15% acquisition copy

- `src/lib/offers/welcome-offer-copy.ts` — the single source for all of it
- `src/components/welcome-offer-signup.tsx` — catalogue bar + product link;
  `offerAvailable = offer.status === "eligible"` is what still turns the
  discount wording on
- `src/components/sms-invite-modal.tsx` — **dead**, mounted nowhere; safe to
  delete after confirming that again

## The entry modal, as it actually is

`src/components/entry-offer-modal.tsx`, mounted in `layout.tsx`.

- Signed-in shoppers ONLY. `/api/offers/welcome` returns `mayInterrupt: false`
  with no session.
- It DOES have an email input, but it is `readOnly` and pre-filled from the
  session; the POST discards anything typed. Keep it that way.
- Opens only on `/products` and `/products/*`, after `OPEN_AFTER_MS = 10000`.
- Suppression already exists and is server-decided: `mayInterrupt`,
  `dismissCooldownDays`, plus `vl_entry_offer_dismissed_at` /
  `vl_entry_offer_joined` in localStorage.
- **It is deliberately NOT the carrier-reviewed surface.** Its own header says
  so. The publicly reachable opt-in a carrier loads is the create-account form
  at `/account/login` (`account-auth-form.tsx`). Leave that alone.

## Traps that cost this session real time

**The local Postgres dies, repeatedly.** When it does you get ~33 failures
across affiliate / partner / financial / `sql/*` suites and a skipped count
jumping from 11 to ~237. That is NOT a regression. Restart and rerun:

    su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/vantapg \
      -o '-p 55432 -k /tmp -c listen_addresses=127.0.0.1 -c max_connections=300' \
      -l /tmp/vantapg/log start"

Run the suite with `VANTA_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres`.

**The harness ships six synthetic products, none of them wheel prizes.**
`qa-wheel-campaign.mjs` cannot walk the real prize table until the nine prize
products and their 17 doses are seeded into the harness DB. That seed is local
only and does not survive a fresh container.

**The payment stub must be running** or checkout steps fail with
`ECONNREFUSED 127.0.0.1:59999`: `node scripts/veyra-stub.mjs`.

**`qa-wheel-campaign.mjs` scores 28/36 — and so does `origin/main`.** That was
measured by building main in a worktree and running the identical script against
the identical database. The 8 failures are pre-existing harness gaps
(`readOfferStatus` returns null for the harness offer cookie), not regressions.
Do not chase them as if they were yours.

**`welcome-offer-placements.test.ts` is the guard.** Six of its cases were
rewritten to pin the ABSENCE of the incentive. If it fights a later change,
read it before weakening it.

## Production facts worth knowing

- `sms_signup.prompts_enabled = true` in production. It no longer controls any
  discount — the retirement is a code constant precisely so an operator cannot
  flip minting back on.
- `spin_wheel.enabled = true`, `campaignId = winback_2026q4`.
- Six spin rows; 0 cycle-closed; 2 live prizes (a Kisspeptin and a 20% off).
  Neither is a laddered product, so the GLP entry-minimum changes affect no
  existing holder.

## The one thing that cannot be closed here

The wheel's authenticated production observation needs a designated account.
There is none, `qa-seed-roles.mjs` refuses any non-local database by design, and
creating a production account is prohibited.

It is also **not deterministic**: the draw is uniform over 16 wedges and only 4
are laddered, so a single account has a 25% chance of drawing a multi-dose
prize. Do not rotate the campaign to force a retry — the token binds the
campaign inside its HMAC, so that would break the 104 live email links.
