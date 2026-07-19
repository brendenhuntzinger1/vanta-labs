import { randomUUID } from "crypto";

export function generateReferralCode(seed?: string) {
  const normalized = (seed ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const prefix = normalized.slice(0, 6) || "PARTNR";
  return `${prefix}-${randomUUID().slice(0, 6).toUpperCase()}`;
}
