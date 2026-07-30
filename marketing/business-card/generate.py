#!/usr/bin/env python3
"""Assemble card.html from card.template.html.

Inlines the Manrope font (base64) and a freshly generated QR code so the
final card.html is fully self-contained. Re-run after editing the template,
the QR URL, or the promo code shown on the card.

Usage:
    python3 generate.py [--url https://vantalabsresearch.com]

Requires: pip install segno
"""
import argparse
import base64
import pathlib
import re

import segno

DIR = pathlib.Path(__file__).resolve().parent

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="https://vantalabsresearch.com",
                    help="URL the QR code opens (short URLs scan best)")
args = parser.parse_args()

# QR at error level H (30% damage tolerance) so the small center logo is safe.
# border=0 because the white tile in the card supplies the quiet zone.
qr = segno.make(args.url, error="h")
modules = qr.symbol_size(border=0)[0]
qr_svg = qr.svg_inline(border=0, dark="#0d0d11", omitsize=True)
# viewBox (segno omits it) so the SVG scales to fill the white tile
qr_svg = qr_svg.replace("<svg ", f'<svg class="qr" viewBox="0 0 {modules} {modules}" ', 1)
print(f"QR: version {qr.version}, {modules} modules, url={args.url}")

font_path = DIR / "fonts" / "manrope-var-latin.woff2"
font_b64 = base64.b64encode(font_path.read_bytes()).decode()

html = (DIR / "card.template.html").read_text()
html = html.replace("__MANROPE_B64__", font_b64)
html = html.replace("__QR_SVG__", qr_svg)
assert "__" not in re.sub(r"data:font[^)]+", "", html), "unresolved placeholder"

(DIR / "card.html").write_text(html)
print(f"wrote {DIR / 'card.html'}")
