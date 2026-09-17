# The welcome code beside a wheel reward — measured, not described

You asked for **one simple rule** for a customer holding both, and said not to
invent a new stacking strategy. So this is what the checkout does **today**,
measured at the till on the harness, with the actual totals. Nothing here is a
proposal except the one line at the end marked as one.

Each row is a real quote against the real pricing pass.

---

## 1. A product prize + the 15% welcome code

Basket: 1 × KLOW ($119.99). Prize: free GHK-Cu, $75 minimum.

| what the customer does | total | discount | gift | code |
|---|--:|--:|---|---|
| prize only, no code typed | $134.99 | — | GHK-Cu | — |
| types the code, no choice made | **$116.99** | $18.00 | — | applied |
| types the code, chooses the wheel | $134.99 | — | GHK-Cu | — |
| types the code, chooses the code | $116.99 | $18.00 | — | applied |

**They do not stack.** The typed code wins by default and the gift is withdrawn;
an explicit choice switches it back. That is the rule you set in your earlier
correction — *the code the shopper deliberately typed is the choice they made*
— and it is doing exactly that.

Note the two outcomes are not comparable on price alone: the code saves $18,
the prize is a vial that retails at $39.99. Which is "better" is the customer's
call, which is the argument for showing both.

## 2. A percentage prize + the 15% welcome code

Basket: 1 × KLOW ($119.99). Prize: 20% off, no minimum.

| what the customer does | total | discount | code |
|---|--:|--:|---|
| prize only | $110.99 | $24.00 | — |
| types the code, no choice | $110.99 | $24.00 | not applied |
| chooses the wheel | $110.99 | $24.00 | not applied |
| chooses the code | $110.99 | $24.00 | not applied |

**All four are identical.** Two percentages compete automatically and the larger
one wins — 20% beats 15%, the code takes nothing off, and `benefitChoice` has no
effect because there is nothing to choose between. This is already the "apply
the better eligible discount" behaviour you asked for, and the code is not
consumed.

## 3. A free-shipping prize + the 15% welcome code

Basket: 1 × GHK-Cu ($39.99). Prize: free shipping, $35 minimum.

| what the customer does | total | discount | shipping | code |
|---|--:|--:|--:|---|
| prize only | **$39.99** | — | $0.00 | — |
| types the code, no choice | **$48.99** | $6.00 | $15.00 | applied |
| chooses the wheel | $39.99 | — | $0.00 | — |
| chooses the code | $48.99 | $6.00 | $15.00 | applied |

### This is the one that needs your decision

**The default costs the customer $9.** 15% of a $39.99 basket is $6; the free
shipping it displaces is worth $15. A customer who types their welcome code —
the obvious thing to do — silently pays more than if they had typed nothing.

It is not a bug in the sense of a broken rule: the rule is "the typed code is
the choice they made", and it is being honoured. It is a bug in the sense that
nobody would choose it if they could see both numbers.

---

## The one simple rule, as implemented

> **One promotional benefit per order.**
> A percentage prize and the welcome code compete automatically; the larger
> wins and the loser is not consumed.
> A product or shipping prize cannot combine with the code, so the customer
> chooses — and the typed code is the default.

## The one thing I would change, and did not

Show both totals at the point of choice. The machinery already exists —
`quoteOrder` returns `benefitChoice` with `choiceRequired`, the applied side and
what the other option is worth — so this is a checkout rendering change, not a
pricing change. I have not built it, because you paused the checkout-choice work
and told me not to invent a new rule while it is paused.

Until it exists, case 3 is a live way for a customer to lose money by doing the
obvious thing.

---

## What this means for the first campaign

The 77 eligible recipients holding a live `winback_60_percent_15` or
`cart_recovery_bac_water` offer are a **different** interaction from the one
above — those are `customer_offers` rows, not typed coupons, and only one offer
token can ride a checkout at a time, so they do not stack either. But a customer
holding a live win-back offer who then wins a wheel prize has two saved rewards
and one cookie, and which applies depends on which link they clicked last.

That is unresolved, it is your call, and it is why the proposed first audience
excludes them — 29 rather than 106.
