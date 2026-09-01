// A breadcrumb trail, shared by every page type that emits one.
//
// Lives apart from product-structured-data.ts because breadcrumbs are not a
// product concept — the research library needs the identical shape, and a
// second hand-rolled copy is how two trails end up disagreeing about whether
// the home crumb has a trailing slash.

export type Crumb = { name: string; url: string };

/**
 * Positions are 1-based and assigned here rather than by the caller, so a trail
 * cannot ship with a duplicated or skipped position.
 */
export function breadcrumbList(crumbs: Crumb[]) {
  return {
    "@context": "https://schema.org/",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.url,
    })),
  };
}
