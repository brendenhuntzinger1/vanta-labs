export type ProductBadge = "new" | "best_seller" | "sale" | null;

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
  inventoryQuantity: number;
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
  inventoryQuantity?: number;
  isPublished?: boolean;
  isEnabled?: boolean;
  isArchived?: boolean;
  isFeatured?: boolean;
  badge?: ProductBadge;
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
  seoTitle?: string;
  seoDescription?: string;
};

export type CoaRecord = {
  slug: string;
  productName: string;
  category: string;
  batchNumber: string;
  purityResult: string;
  testingDate: string;
  labName: string;
  coaUrl: string;
};
