# Vanta Labs — Business Card

Print-ready business card promoting the first-order welcome offer.

- **Front** — V mark, VANTA LABS wordmark, "Premium Research Peptides"
- **Back** — "Scan for 10% off your first order · sitewide", QR code to
  [vantalabsresearch.com](https://vantalabsresearch.com), and the
  **WELCOME10** promo code (the storefront's live welcome-offer code)

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

## Tracking card performance

`WELCOME10` is also shown in the site's welcome banner, so it can't isolate
card traffic. To measure the cards separately, create a dedicated code
(e.g. `CARD10`, 10 % off, first order) in **Admin → Promotions**, update the
code in `card.template.html`, and rebuild before ordering.

## Rebuilding

```bash
pip install segno            # one-time
python3 generate.py          # optionally: --url https://vantalabsresearch.com
node build.mjs               # needs playwright + chromium (pre-installed in CI/dev container)
```

The welcome-offer code and percentage are editable in **Admin → Settings**;
if you change them there, keep the card in sync.
