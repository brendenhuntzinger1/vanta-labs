/**
 * Omnisend configuration, read from what it is given and nothing else.
 *
 * Pure so the two decisions here can be tested without stubbing process.env:
 * whether the integration is CONFIGURED (an API key exists) and whether
 * Omnisend OWNS marketing sends (the cutover switch in the design spec §3.1).
 * Neither consults the environment gate — that lives in client.ts beside the
 * only code that can make a network call, so it cannot be bypassed by a caller
 * that forgot to ask.
 */

/** The API version every request pins. Omnisend rejects unversioned calls. */
export const OMNISEND_API_VERSION = "2026-03-15";

export type OmnisendConfigured = { configured: true; reason: null } | { configured: false; reason: string };

export function omnisendConfigured(env: NodeJS.ProcessEnv = process.env): OmnisendConfigured {
  const key = String(env.OMNISEND_API_KEY ?? "").trim();
  if (!key) return { configured: false, reason: "OMNISEND_API_KEY not set" };
  return { configured: true, reason: null };
}

/**
 * THE CUTOVER SWITCH. When true, the in-house cart-recovery ladder, retention
 * automations and campaign sender stand down so Omnisend's flows are the only
 * marketing mail a customer receives. Default unset, which is "nothing
 * changes" — the branch merges safely and the owner flips this the day the
 * Omnisend flows are enabled. Only the literal true/1/yes count; a typo is
 * treated as off, the direction that cannot double-mail anyone.
 */
export function omnisendOwnsMarketing(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.OMNISEND_MARKETING_OWNER ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}
