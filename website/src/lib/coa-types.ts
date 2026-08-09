// Shapes shared between the server readers (src/lib/coa.ts, src/lib/admin-coa.ts)
// and the client surfaces that render them. No server imports here so the admin
// page and the public library can both pull the types in.

export type CoaStatus = "draft" | "published" | "archived";

/** How the document should be presented: inline PDF viewer, or an image. */
export type CoaFileKind = "pdf" | "image" | "link";

/**
 * One published Certificate of Analysis, as a customer sees it.
 *
 * Deliberately carries NO document URL. The file lives in a private bucket and
 * is reached through `/api/coa/{id}/file`, which re-checks the record is
 * published before minting a short-lived signed URL. Nothing in this payload
 * can leak a draft.
 */
export type PublicCoaDocument = {
  id: string;
  batchNumber: string;
  lotNumber: string | null;
  strength: string | null;
  labName: string | null;
  /** ISO `YYYY-MM-DD`, or null when the date was never recorded. */
  testDate: string | null;
  purity: string | null;
  identityResult: string | null;
  fileKind: CoaFileKind;
  fileName: string | null;
  /** False when the record exists but its document is missing/unreadable. */
  hasFile: boolean;
};

/** A product row in the public library — its imagery plus its batch history. */
export type CoaLibraryProduct = {
  productId: string;
  slug: string;
  name: string;
  category: string;
  /** Default dose label ("10mg"), when the product has one. */
  strength: string | null;
  imageUrl: string;
  documents: PublicCoaDocument[];
};

export type CoaLibrarySnapshot = {
  products: CoaLibraryProduct[];
  /** Products carrying at least one published COA. Drives the hero claims. */
  documentedProductCount: number;
  totalDocumentCount: number;
  /** True when at least one published record names a testing laboratory. */
  hasLabAttribution: boolean;
  /** True when at least one published record carries an identity result. */
  hasIdentityVerification: boolean;
};

/** The admin table row — everything, including drafts. */
export type AdminCoaRecord = {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  productDoseId: string | null;
  strength: string | null;
  batchNumber: string;
  lotNumber: string | null;
  labName: string | null;
  testDate: string | null;
  purity: string | null;
  identityResult: string | null;
  status: CoaStatus;
  fileKind: CoaFileKind;
  fileName: string | null;
  fileSizeBytes: number | null;
  hasFile: boolean;
  externalUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Product + its dosage labels, for the "Add COA" dropdowns. */
export type CoaProductOption = {
  id: string;
  name: string;
  slug: string;
  category: string;
  isPublished: boolean;
  strengths: Array<{ id: string; label: string }>;
};

export type CoaLibrarySettings = {
  /**
   * When true the public library lists products that have no published COA yet,
   * marked "Documentation Pending". When false those products are hidden
   * entirely. Defaults to true so the page never looks half-built while the
   * first batches are still being uploaded.
   */
  showPendingProducts: boolean;
};

export const DEFAULT_COA_LIBRARY_SETTINGS: CoaLibrarySettings = {
  showPendingProducts: true,
};
