# Vanta Labs — Business Card

Print-ready business card promoting the first-order welcome offer.

- **Front** — V mark, VANTA LABS wordmark, "Premium Research Peptides"
- **Back** — "Scan for 10% off your first order · sitewide", QR code to
  [vantalabsresearch.com](https://vantalabsresearch.com), and the dedicated
  **CARD10** promo code (10% off, first order only, private — see below)

## Files

| File | What it is |
| --- | --- |
| `out/vanta-labs-business-card-print.pdf` | **Send this to the printer.** 2 pages (front/back), bleed included |
| `out/preview-front.png` / `out/preview-back.png` | 300 DPI previews |
| `card.template.html` | Design source (edit this) |
| `card.html` | Assembled self-contained file (generated — don't edit) |
| `generate.py` / `build.mjs` | Build scripts |

## Print specs

- **Trim size:** 3.5 × 2 in (standard US business card)
- **PDF page size:** 3.75 × 2.25 in — includes the standard **0.125 in bleed**
  on all sides, so upload it as-is to Vistaprint / Moo / GotPrint etc. and
  pick "my file includes bleed" if asked. No crop marks needed.
- All text sits ≥ 0.25 in from the page edge (inside the safe area).

**Stock recommendation (this is where it stands out in hand):** heavy
32 pt / 600 gsm **suede or soft-touch matte** black-friendly stock. If the
printer offers **raised spot gloss / spot UV**, apply it to the V mark and
"10% OFF" — gloss-on-matte black reads as very premium. Avoid glossy
lamination over the QR side; matte scans more reliably under light.

## QR code notes

- Encodes plain `https://vantalabsresearch.com` — short URL = coarse,
  reliable modules, and the phone's camera preview shows a clean domain.
- Error correction level **H** (30 % damage tolerance) covers the center
  logo with a wide margin; decode was verified from the rendered preview.
- The QR is printed dark-on-white deliberately — inverted (white-on-black)
  QR codes fail on many phone scanners. Don't restyle it onto the black
  background.

## The CARD10 code — activate BEFORE ordering cards

The card prints the dedicated code **CARD10**: 10 % off, **first-order-only**
(rejected for any email that already has a paid order, same rule as the
welcome offer) and **private** (never advertised on the storefront). Because
the site never shows it, every CARD10 redemption is someone who got a card —
filter orders on `coupon_code = CARD10` to measure card ROI. (Some card
recipients will use the public WELCOME10 banner code instead, so the CARD10
count is a floor, not an exact total.)

The code does not exist until you create it — do this before handing out
cards, in either of two ways:

1. **One paste (recommended):** run
   `website/src/lib/sql/card10-first-order-coupon.sql` in the Supabase SQL
   editor. It adds the `first_order_only` coupon column and creates CARD10.
2. **Admin UI:** after deploying and running that SQL file for the column,
   codes like this can also be created in **Admin → Coupons** — check
   "Private code" and "First order only".

Then verify: enter CARD10 at checkout on a fresh email — it should apply 10 %.

## Rebuilding

```bash
pip install segno            # one-time
python3 generate.py          # optionally: --url https://vantalabsresearch.com
node build.mjs               # needs playwright + chromium (pre-installed in CI/dev container)
```

CARD10 is managed like any coupon in **Admin → Coupons** (disable it there to
end the promotion). If you ever change the code or percentage, update
`card.template.html` and rebuild so the printed cards stay in sync.
