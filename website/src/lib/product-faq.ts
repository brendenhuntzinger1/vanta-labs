import type { ProductFaqItem } from "@/lib/catalog-types";

// Normalizes the products.product_faq jsonb column (or an admin form value) into
// a clean ProductFaqItem[]. Accepts an array of {question, answer} objects or a
// JSON string of the same; drops anything malformed or empty so the UI never
// renders a blank/half FAQ row. Pure and dependency-free so it can be unit
// tested and reused on both the read path and the admin write path.
export function parseProductFaq(raw: unknown): ProductFaqItem[] {
  let value = raw;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const items: ProductFaqItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const answer = typeof record.answer === "string" ? record.answer.trim() : "";
    if (question && answer) {
      items.push({ question, answer });
    }
  }

  return items;
}

// Serialize a FAQ list back to the value stored in the jsonb column, keeping
// only valid rows.
export function serializeProductFaq(items: unknown): ProductFaqItem[] {
  return parseProductFaq(items);
}
