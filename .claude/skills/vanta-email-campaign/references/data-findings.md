# Catalogue facts that shape a campaign email

Read on 2026-09-11 from the production database (read-only) while building
the approved mockups. Re-check before relying on any of them; they change.

## Where the photos are

Public bucket, production project `mlpimwgkwuqpsvsrlpqv`:

    https://mlpimwgkwuqpsvsrlpqv.supabase.co/storage/v1/object/public/product-images/<product-id>/<file>.webp

Read the current URLs with the Supabase MCP (read-only), for example:

```sql
select slug, name, category, image_url, batch_number, testing_date, coa_url is not null as has_coa
from products
where is_published = true and coalesce(is_archived, false) = false
order by position nulls last, name;
```

Then `scripts/fetch-products.mjs products.json` downloads each `image_url`
to `products/<slug>.jpg` (WebP converted with sharp from `website/node_modules`).

## What the data looked like

- 35 published products. All but four have a photo: **BPC-157, GLP-2, GLP-3
  and Recon water have none** and render the placeholder tile.
- Every photo is the same studio setup: light grey gradient field, silver cap,
  glossy floor with a reflection, 928 by 1152 WebP. Grids and mosaics line up;
  the cut-out route works on all of them.
- **Every product carries the same `batch_number`, `Vanta184290`, and
  `testing_date` is null on all of them.** The photographed labels read
  `Lot VL25001`, which matches neither. Until batch numbers are real per
  product, the batch strip shows a link to the certificate and no number, and
  no creative carries a lot number.
- Photos are WebP. Chromium renders them, Outlook for Windows and some older
  clients do not. Emails use the JPEG conversion the fetch script writes.
- Product names as stored: "GHK-Cu", "BPC-157 + TB-500", "NAD+", "Cagrilintide",
  "Tesamorelin", "KLOW", "Semax", "Epithalon", "MOTS-C", "CJC-1295 + Ipamorelin",
  "GLOW", "Thymosin Alpha-1". Strengths are printed on the labels (GHK-Cu 50 mg,
  BPC-157 + TB-500 20 mg, NAD+ 500 mg) and are not in the product row; read
  them off the photo or the product page before putting them on a card.
- Categories in use include Repair & Recovery Research, Growth Hormone, GLP
  Research, Metabolic Research, Cognitive Research, Longevity Research,
  Specialty, Blends, Solvents & Solutions.

## Cut-outs already made

`assets/vials/` holds transparent, trimmed PNGs for GHK-Cu, BPC-157 + TB-500
and NAD+. They were produced with one background-removal job each on the
connected image account. Reuse them; make a new one only when the campaign's
hero product is a different vial.
