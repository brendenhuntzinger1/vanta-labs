-- ---------------------------------------------------------------------------
-- WHICH PRODUCTS MAY OFFER BACTERIOSTATIC WATER.
--
-- The BAC Water cross-sell previously qualified a product with
-- `slug !== 'bacteriostatic-water'`, which means it offered reconstitution
-- water for the entire catalogue — including products that ship as a liquid
-- and have nothing to reconstitute. Recommending a laboratory preparation
-- step that does not apply to the item in the cart is both wrong and, for a
-- research-use-only store, the kind of wrongness that reads as carelessness
-- about the science.
--
-- Eligibility is now an explicit, operator-set property. It is deliberately
-- NOT derived from the product name, the category, or the presence of "mg" in
-- a dose label: those are guesses, and a guess that silently starts qualifying
-- a new liquid product is exactly the failure this column exists to prevent.
--
-- DEFAULT false is the safe direction. A product offers BAC Water only once
-- somebody has said so in Admin. The cost of that choice is that the upsell is
-- dark until the lyophilized products are flagged; the alternative — defaulting
-- true — would silently re-create the current bug for every product added from
-- now on.
-- ---------------------------------------------------------------------------

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS requires_reconstitution boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN products.requires_reconstitution IS
  'Operator-set. True when the product ships lyophilized and bacteriostatic water may be needed for laboratory reconstitution. Drives the BAC Water cross-sell. Never inferred from name or category.';

-- Bacteriostatic water can never require reconstituting with itself. This is
-- belt-and-braces: the UI also refuses to cross-sell a product to itself.
UPDATE products
   SET requires_reconstitution = false
 WHERE slug = 'bacteriostatic-water';
