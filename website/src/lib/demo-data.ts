export type Product = {
  slug: string;
  name: string;
  category: string;
  price: string;
  stockStatus: "In Stock" | "Limited" | "Reserved";
  batchNumber: string;
  purityResult?: string;
  description: string;
  image: string;
  testingDate: string;
  labName: string;
  coaUrl: string;
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

export const products: Product[] = [
  {
    slug: "aurelium-reference-standard",
    name: "Aurelium Reference Standard",
    category: "Analytical Reference",
    price: "$1,240",
    stockStatus: "In Stock",
    batchNumber: "AR-2407A",
    purityResult: "99.8%",
    description:
      "A premium demo reference standard for lawful laboratory research workflows and controlled analytical evaluation. This sample record is intended for demonstration purposes only.",
    image: "/product-aurelium.svg",
    testingDate: "2026-06-12",
    labName: "North Meridian Analytical Labs",
    coaUrl: "/demo-coa.pdf",
  },
  {
    slug: "cobalt-trace-matrix",
    name: "Cobalt Trace Matrix",
    category: "Reference Standard",
    price: "$890",
    stockStatus: "Limited",
    batchNumber: "CTM-2408B",
    purityResult: "99.4%",
    description:
      "A controlled trace matrix designed for calibration validation and documented material characterization in laboratory settings. Demo data only.",
    image: "/product-cobalt.svg",
    testingDate: "2026-06-21",
    labName: "Apex Verification Services",
    coaUrl: "/demo-coa.pdf",
  },
  {
    slug: "lumina-calibration-blend",
    name: "Lumina Calibration Blend",
    category: "Calibration Blend",
    price: "$1,540",
    stockStatus: "Reserved",
    batchNumber: "LCB-2409C",
    purityResult: "99.6%",
    description:
      "A demonstration calibration blend designed for analytical consistency studies and laboratory documentation workflows. All listed details are sample data.",
    image: "/product-lumina.svg",
    testingDate: "2026-07-03",
    labName: "Vanta Independent Testing Group",
    coaUrl: "/demo-coa.pdf",
  },
];

export const coaRecords: CoaRecord[] = products.map((product) => ({
  slug: product.slug,
  productName: product.name,
  category: product.category,
  batchNumber: product.batchNumber,
  purityResult: product.purityResult ?? "Pending",
  testingDate: product.testingDate,
  labName: product.labName,
  coaUrl: product.coaUrl,
}));
