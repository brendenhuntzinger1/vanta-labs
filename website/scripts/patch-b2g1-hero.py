"""
Take the false claims out of the owner's Buy 2 Get 1 artwork, and change
nothing else about it.

The store's free_shipping_sitewide switch is off, so shipping is not free on
every order any more — it is free over $200 and $15 under. Six lines on this
banner said otherwise. They are removed here rather than re-typeset, because
the artwork's typeface is not on this machine and a substitute would read as
a patch. The two lines that ARE re-set (the deadline banner and the trust
bar's sub-line) are letterspaced caps and small grey caps respectively, where
the substitution does not show.

Erasing is per-column interpolation between a clean row above and a clean row
below. The anchor rows are box-smoothed along x first: this backdrop carries
film grain, and interpolating from raw anchors turns each grain speck into a
vertical streak down the whole patch. Grain is then added back at the level
measured just outside the patch, so the repair is not a suspiciously clean
rectangle against a grainy backdrop.
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np

SRC, OUT = "owner-hero.png", "owner-hero-final.png"
a = np.asarray(Image.open(SRC).convert("RGB")).astype(float).copy()
rng = np.random.default_rng(11)

CX, CY, R = 775.5, 692.5, 85.0
inside = lambda x, y, m=0.0: (x - CX) ** 2 + (y - CY) ** 2 < (R - m) ** 2


def smooth_rows(y, x0, x1, span=3, k=9):
    """A clean, de-grained sample of the background across one row."""
    band = a[y - span: y + span + 1, x0:x1].mean(axis=0)
    pad = k // 2
    ker = np.ones(k) / k
    out = np.empty_like(band)
    for ch in range(3):
        out[:, ch] = np.convolve(np.pad(band[:, ch], (pad, pad), mode="edge"), ker, mode="valid")
    return out


def grain_sigma(y0, y1, x0, x1):
    """High-frequency noise only. Measuring against the row mean instead
    catches the backdrop's own gradient and massively overstates it, which
    lands the repair as a visibly speckled rectangle."""
    patch = a[y0:y1, x0:x1]
    pad, k = 4, 9
    ker = np.ones(k) / k
    hi = np.empty_like(patch)
    for r in range(patch.shape[0]):
        for ch in range(3):
            sm = np.convolve(np.pad(patch[r, :, ch], (pad, pad), mode="edge"), ker, mode="valid")
            hi[r, :, ch] = patch[r, :, ch] - sm
    return float(np.clip(hi.std(), 0.15, 2.0))


def erase(x0, x1, y0, y1, above, below, feather=6):
    """Rebuild the box, then cross-fade its border into what surrounds it so
    the repair has no rectangular edge."""
    top, bot = smooth_rows(above, x0, x1), smooth_rows(below, x0, x1)
    sig = grain_sigma(above - 10, above - 2, x0, x1)
    new = np.empty((y1 - y0, x1 - x0, 3))
    for j, y in enumerate(range(y0, y1)):
        t = (y - above) / float(below - above)
        new[j] = top + (bot - top) * t + rng.normal(0, sig, (x1 - x0, 3))

    w = np.ones((y1 - y0, x1 - x0))
    ramp = lambda n: np.linspace(0, 1, n + 2)[1:-1]
    w[:feather, :] *= ramp(feather)[:, None]
    w[-feather:, :] *= ramp(feather)[::-1][:, None]
    w[:, :feather] *= ramp(feather)[None, :]
    w[:, -feather:] *= ramp(feather)[::-1][None, :]
    w = w[..., None]
    a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - w) + new * w


# ----------------------------------------------------------------- the disc
# "SAVE $64.99 / + $15 SHIPPING" loses its last two lines, and what is left
# moves down to sit in the middle of the circle again.
#
# The gold behind the type is modelled, not sampled from neighbouring rows.
# Rows above and below the type run off the edge of the circle near its left
# and right extremes, so anchoring on them paints backdrop-black into the
# gold and leaves two dark columns down the disc. A quadratic surface fitted
# to every non-type gold pixel has no such edge, and this disc is a smooth
# two-axis gradient that a quadratic fits almost exactly.
TOP, BOT = 626, 756          # the whole text zone
SAVE_T, SAVE_B = 634, 692    # SAVE + $64.99
SHIFT, INK = 30, 18.0
XL, XR, YT, YB = int(CX - R) - 2, int(CX + R) + 3, int(CY - R) - 2, int(CY + R) + 3

yy, xx = np.mgrid[YT:YB, XL:XR]
interior = (xx - CX) ** 2 + (yy - CY) ** 2 < (R - 2.0) ** 2
patch = a[YT:YB, XL:XR]

def design(x, y):
    x, y = (x - CX) / R, (y - CY) / R
    return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], axis=-1)

D = design(xx.astype(float), yy.astype(float))
keep = interior.copy()
for _ in range(3):
    A = D[keep]
    model = np.zeros_like(patch)
    for ch in range(3):
        coef, *_ = np.linalg.lstsq(A, patch[keep][:, ch], rcond=None)
        model[..., ch] = D @ coef
    resid = patch.mean(2) - model.mean(2)
    keep = interior & (resid > -22)      # type is much darker than the gold

# how much ink each SAVE / $64.99 pixel carries, against that modelled gold
sl = (slice(SAVE_T - YT, SAVE_B - YT), slice(None))
src, bg = patch[sl], model[sl]
alpha = np.clip((bg.mean(2) - src.mean(2)) / np.maximum(bg.mean(2) - INK, 1.0), 0, 1)
alpha[~interior[sl]] = 0

# wipe the type zone back to clean gold, then set the two lines down lower
zone = interior & (yy >= TOP) & (yy < BOT)
patch[zone] = model[zone]
for dy in range(SAVE_B - SAVE_T):
    row = SAVE_T + SHIFT + dy - YT
    if not (0 <= row < patch.shape[0]):
        continue
    al = alpha[dy][:, None]
    ok = (al[:, 0] > 0.004) & interior[row]
    patch[row][ok] = patch[row][ok] * (1 - al[ok]) + INK * al[ok]
a[YT:YB, XL:XR] = patch

# ------------------------------------------------ the claims that went false
# Each box is wide enough that its feathered border lands on backdrop the
# original type never touched — feather over the type and it ghosts back in.
erase(228, 662, 524, 610, above=519, below=615)      # "+ FREE SHIPPING" + "both offers"
erase(636, 794, 1183, 1204, above=1180, below=1208, feather=4)  # "+ $15 SHIPPING"
erase(183, 697, 1379, 1412, above=1375, below=1417)  # "...and free shipping are gone."
erase(228, 652, 232, 272, above=228, below=277)      # FINAL WEEKEND

im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
d = ImageDraw.Draw(im)
F = lambda p, s: ImageFont.truetype(f"/usr/share/fonts/truetype/liberation/LiberationSans-{p}.ttf", s)

# it is the last day, not the final weekend
t, track, font = "LAST CALL", 13, F("Bold", 27)
ws = [d.textlength(c, font=font) for c in t]
x = 439 - (sum(ws) + track * (len(t) - 1)) / 2
for c, w in zip(t, ws):
    d.text((x, 238), c, font=font, fill=(244, 225, 173)); x += w + track

# the trust bar said SITEWIDE; it is a threshold now
d.rectangle([410, 147, 545, 167], fill=(251, 249, 247))
d.text((418, 150), "ON ORDERS $200+", font=F("Regular", 13), fill=(105, 103, 104))

im.save(OUT, "PNG", optimize=True)
print("wrote", OUT, im.size)
