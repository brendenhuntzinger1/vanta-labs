/**
 * What a new product, dose or COA record starts with in admin.
 *
 * The store owner's standing facts, written once here instead of retyped on
 * every form: every batch to date is Vanta184290, and every certificate on file
 * reads above 99% purity. Before these existed, each new row started blank and
 * the product page showed "Pending" beside four published certificates.
 *
 * These are admin PREFILLS, not storefront fallbacks. The customer-facing pages
 * render only what was saved, so an operator who clears the field ships a blank
 * and never an unbacked claim. coa-defaults.test.ts holds that line: nothing
 * under the storefront imports this module.
 */
export const DEFAULT_COA_PURITY = ">99%";
export const DEFAULT_COA_BATCH_NUMBER = "Vanta184290";
