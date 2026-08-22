export type ProductBadge = "new" | "best_seller" | "sale" | null;

export type ProductFaqItem = {
  question: string;
  answer: string;
};

export type ProductImage = {
  id: string;
  imageUrl: string;
  altText: string | null;
  isPrimary: boolean;
  position: number;
};

export type ProductDose = {
  id: string;
  label: string;
  slugSuffix: string;
  sku?: string;
  price: string;
  compareAtPrice?: string;
  salePrice?: string;
  /** Internal cost (COGS) in cents — admin-only, populated only in admin
   *  contexts; never selected for or shown to customers. */
  productCostCents?: number;
  /**
   * Raw units on hand. ADMIN-ONLY: the public catalog reads deliberately leave
   * this undefined, because these objects are serialized into pages that
   * customers can view the source of. Server code that genuinely needs the real
   * figure calls getStockLevelsBySlugs() instead.
   */
  inventoryQuantity?: number;
  /**
   * How many units may be OFFERED to a shopper right now: on hand, less what
   * in-flight checkouts are holding, then clamped to the per-line order ceiling
   * before it leaves the server. It is what the quantity controls are capped
   * at. It is never rendered — customers see "out of stock" or nothing.
   *
   * `null` means availability is not being counted (inventory tracking is off
   * globally), which is a different statement from "zero available" and must
   * not be treated as one.
   */
  availableQuantity?: number | null;
  stockStatus?: "In Stock" | "Limited" | "Reserved" | "Out of Stock";
  batchNumber?: string;
  coaUrl?: string;
  imageUrl?: string;
  purityResult?: string;
  isDefault: boolean;
  isEnabled: boolean;
  position: number;
};

export type Product = {
  id?: string;
  slug: string;
  name: string;
  category: string;
  shortDescription?: string;
  longDescription?: string;
  price: string;
  compareAtPrice?: string;
  salePrice?: string;
  stockStatus: "In Stock" | "Limited" | "Reserved" | "Out of Stock";
  /** Raw units on hand. ADMIN-ONLY — see ProductDose.inventoryQuantity. */
  inventoryQuantity?: number;
  /** See ProductDose.availableQuantity — same contract, for the default dose. */
  availableQuantity?: number | null;
  isPublished?: boolean;
  isEnabled?: boolean;
  isArchived?: boolean;
  isFeatured?: boolean;
  badge?: ProductBadge;
  /** Auto-computed from real sales (units sold) — a current best seller. */
  isBestSeller?: boolean;
  position?: number;
  batchNumber: string;
  purityResult?: string;
  description: string;
  image: string;
  coverImage?: string;
  galleryImages?: ProductImage[];
  doses?: ProductDose[];
  defaultDoseId?: string | null;
  // Hidden admin cost/margin fields (never rendered to customers). Cents for
  // money, percent for the margin. Undefined when unset.
  productCostCents?: number;
  suggestedRetailCents?: number;
  minSellingPriceCents?: number;
  minProfitCents?: number;
  minProfitPercent?: number;
  testingDate: string;
  labName: string;
  coaUrl: string;
  molecularFormula?: string;
  // Premium research-data spec fields (all optional; rendered when present).
  molecularWeight?: string;
  casNumber?: string;
  peptideSequence?: string;
  storageRecommendation?: string;
  reconstitutionNote?: string;
  /**
   * Operator-set in Admin. True when the product ships lyophilized and
   * bacteriostatic water may be needed for laboratory reconstitution.
   *
   * Never inferred from the name, the category or a dose label. This is the
   * ONLY thing that qualifies a product for the BAC Water cross-sell — the
   * previous rule was "any product that is not BAC Water itself", which
   * offered reconstitution water for liquids too.
   *
   * Optional on the type so a cart persisted before this column existed reads
   * as undefined, which is falsy, which suppresses the upsell. Under-showing
   * is the safe direction.
   */
  requiresReconstitution?: boolean;
  faq?: ProductFaqItem[];
  seoTitle?: string;
  seoDescription?: string;
};

// COA records used to live here as a flattened product row. They are now their
// own batch-level entity — see `@/lib/coa-types`, backed by the `coa_records`
// table — because one product accumulates a COA per production batch.
