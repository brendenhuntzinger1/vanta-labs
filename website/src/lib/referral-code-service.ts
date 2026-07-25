import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getControlSnapshot } from "@/lib/admin-control";
import {
  validateReferralCodeFormat,
  referralCodeFingerprint,
  normalizeReferralCode,
} from "@/lib/referral-code-validation";

// ============================================================================
// Ambassador referral-code management service. All writes are ATOMIC and
// idempotent; uniqueness is backstopped by the DB unique index (23505) so two
// ambassadors can never race into the same code. Requires the
// referral-code-management.sql migration.
// ============================================================================

export type ChangeLimitMode = "unlimited" | "once_ever" | "once_per_days" | "max_per_month";

export interface ReferralCodePolicy {
  minLength: number;
  maxLength: number;
  changeMode: ChangeLimitMode;
  changeIntervalDays: number;
  maxChangesPerMonth: number;
  redirectMode: "redirect" | "disable";
  redirectDays: number; // alias lifetime; 0 = forever
}

const DEFAULT_POLICY: ReferralCodePolicy = {
  minLength: 4,
  maxLength: 20,
  changeMode: "once_per_days",
  changeIntervalDays: 30,
  maxChangesPerMonth: 3,
  redirectMode: "redirect",
  redirectDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Admin-configurable (Admin → referral control snapshot → code_policy). Falls
// back to sane defaults so the feature works before any admin config exists.
export async function getReferralCodePolicy(): Promise<ReferralCodePolicy> {
  try {
    const snapshot = await getControlSnapshot("referral");
    const referral = ((snapshot as { referral?: Record<string, unknown> })?.referral ?? {}) as Record<string, unknown>;
    const c = (referral.code_policy ?? {}) as Record<string, unknown>;
    const changeMode: ChangeLimitMode = (["unlimited", "once_ever", "once_per_days", "max_per_month"] as const)
      .includes(c.change_mode as ChangeLimitMode) ? (c.change_mode as ChangeLimitMode) : DEFAULT_POLICY.changeMode;
    return {
      minLength: Math.max(3, num(c.min_length, DEFAULT_POLICY.minLength)),
      maxLength: Math.min(40, num(c.max_length, DEFAULT_POLICY.maxLength)),
      changeMode,
      changeIntervalDays: Math.max(1, Math.floor(num(c.change_interval_days, DEFAULT_POLICY.changeIntervalDays))),
      maxChangesPerMonth: Math.max(1, Math.floor(num(c.max_changes_per_month, DEFAULT_POLICY.maxChangesPerMonth))),
      redirectMode: c.redirect_mode === "disable" ? "disable" : "redirect",
      redirectDays: Math.max(0, Math.floor(num(c.redirect_days, DEFAULT_POLICY.redirectDays))),
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

interface AmbassadorCodeRow {
  id: string;
  referral_code: string | null;
  status: string;
  referral_code_locked: boolean | null;
  referral_code_changed_at: string | null;
}

async function loadAmbassadorByAuthUser(authUserId: string): Promise<AmbassadorCodeRow | null> {
  const { data } = await supabaseAdmin
    .from("ambassadors")
    .select("id, referral_code, status, referral_code_locked, referral_code_changed_at")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  return (data ?? null) as AmbassadorCodeRow | null;
}

async function loadAmbassadorById(ambassadorId: string): Promise<AmbassadorCodeRow | null> {
  const { data } = await supabaseAdmin
    .from("ambassadors")
    .select("id, referral_code, status, referral_code_locked, referral_code_changed_at")
    .eq("id", ambassadorId)
    .maybeSingle();
  return (data ?? null) as AmbassadorCodeRow | null;
}

// Look-alike-aware "is this code taken by someone else?" — compares fingerprints
// across live codes (both mirror tables) and active aliases. The DB unique index
// is the hard race backstop; this is for a friendly pre-check + look-alikes.
async function isCodeTakenByOther(fingerprint: string, exceptAmbassadorId: string): Promise<boolean> {
  const [{ data: ambassadors }, { data: partners }, { data: aliases }] = await Promise.all([
    supabaseAdmin.from("ambassadors").select("id, referral_code"),
    supabaseAdmin.from("partners").select("id, referral_code"),
    supabaseAdmin.from("referral_code_aliases").select("ambassador_id, alias_fingerprint").eq("active", true),
  ]);
  const taken = new Set<string>();
  for (const row of [...(ambassadors ?? []), ...(partners ?? [])] as Array<{ id: string; referral_code: string | null }>) {
    if (row.id !== exceptAmbassadorId && row.referral_code) taken.add(referralCodeFingerprint(row.referral_code));
  }
  for (const row of (aliases ?? []) as Array<{ ambassador_id: string; alias_fingerprint: string }>) {
    if (row.ambassador_id !== exceptAmbassadorId) taken.add(String(row.alias_fingerprint));
  }
  return taken.has(fingerprint);
}

export interface AvailabilityResult {
  available: boolean;
  code: string;
  current?: boolean;
  reason?: string;
  error?: string;
}

export async function checkReferralCodeAvailability(rawCode: string, authUserId?: string): Promise<AvailabilityResult> {
  const policy = await getReferralCodePolicy();
  const fmt = validateReferralCodeFormat(rawCode, { minLength: policy.minLength, maxLength: policy.maxLength });
  if (!fmt.ok) return { available: false, code: fmt.code, reason: fmt.reason, error: fmt.error };

  let selfId = "";
  if (authUserId) {
    const self = await loadAmbassadorByAuthUser(authUserId);
    selfId = self?.id ?? "";
    if (self && normalizeReferralCode(self.referral_code) === fmt.code) {
      return { available: true, code: fmt.code, current: true };
    }
  }
  if (await isCodeTakenByOther(fmt.fingerprint, selfId)) {
    return { available: false, code: fmt.code, reason: "taken", error: "That code is already taken." };
  }
  return { available: true, code: fmt.code };
}

async function assertWithinChangeLimit(ambassadorId: string, changedAt: string | null, policy: ReferralCodePolicy): Promise<void> {
  if (policy.changeMode === "unlimited") return;

  if (policy.changeMode === "once_ever") {
    const { count } = await supabaseAdmin
      .from("referral_code_changes").select("id", { count: "exact", head: true }).eq("ambassador_id", ambassadorId);
    if ((count ?? 0) >= 1) throw new Error("Your referral code can only be changed once.");
    return;
  }
  if (policy.changeMode === "once_per_days") {
    if (changedAt) {
      const nextAllowed = new Date(changedAt).getTime() + policy.changeIntervalDays * DAY_MS;
      if (Date.now() < nextAllowed) {
        throw new Error(`You can change your code again on ${new Date(nextAllowed).toLocaleDateString("en-US")}.`);
      }
    }
    return;
  }
  // max_per_month
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const { count } = await supabaseAdmin
    .from("referral_code_changes").select("id", { count: "exact", head: true })
    .eq("ambassador_id", ambassadorId).gte("created_at", since);
  if ((count ?? 0) >= policy.maxChangesPerMonth) {
    throw new Error(`You've reached the limit of ${policy.maxChangesPerMonth} code changes this month.`);
  }
}

interface ApplyCodeInput {
  ambassador: AmbassadorCodeRow;
  newCode: string;
  fingerprint: string;
  actor: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  policy: ReferralCodePolicy;
}

// The atomic core shared by self-service and admin force-change.
async function applyReferralCodeChange(input: ApplyCodeInput): Promise<{ code: string }> {
  const { ambassador, newCode, fingerprint, policy } = input;
  const oldCode = normalizeReferralCode(ambassador.referral_code);
  if (newCode === oldCode) return { code: oldCode };

  if (await isCodeTakenByOther(fingerprint, ambassador.id)) {
    throw new Error("That code is already taken.");
  }

  const now = new Date().toISOString();

  // Optimistic atomic update: only wins if the row STILL holds the old code and
  // isn't locked → defeats simultaneous edits. The unique index on referral_code
  // defeats two ambassadors racing for the same new code (23505).
  let update = supabaseAdmin
    .from("ambassadors")
    .update({ referral_code: newCode, referral_code_changed_at: now })
    .eq("id", ambassador.id)
    .eq("referral_code_locked", false);
  update = oldCode ? update.eq("referral_code", oldCode) : update.is("referral_code", null);
  const { data: updated, error: updateError } = await update.select("id");

  if (updateError) {
    if (updateError.code === "23505") throw new Error("That code was just taken. Please choose another.");
    throw updateError;
  }
  if (!updated || updated.length === 0) {
    throw new Error("Your code changed a moment ago — refresh and try again.");
  }

  // Mirror to the partners table (shared id).
  await supabaseAdmin
    .from("partners")
    .update({ referral_code: newCode, referral_code_changed_at: now })
    .eq("id", ambassador.id);

  // Immutable history (never deleted).
  await supabaseAdmin.from("referral_code_changes").insert({
    ambassador_id: ambassador.id,
    old_code: oldCode || null,
    new_code: newCode,
    actor: input.actor,
    reason: input.reason,
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
  });

  // A newly-claimed code must not still resolve to its previous owner.
  await supabaseAdmin.from("referral_code_aliases").update({ active: false }).eq("alias_code", newCode);

  // Keep old links working (or not) per admin policy.
  if (oldCode) {
    if (policy.redirectMode === "redirect") {
      const expiresAt = policy.redirectDays > 0 ? new Date(Date.now() + policy.redirectDays * DAY_MS).toISOString() : null;
      await supabaseAdmin.from("referral_code_aliases").upsert(
        {
          alias_code: oldCode,
          alias_fingerprint: referralCodeFingerprint(oldCode),
          ambassador_id: ambassador.id,
          active: true,
          expires_at: expiresAt,
        },
        { onConflict: "alias_code" },
      );
    } else {
      // "disable old codes immediately" — deactivate any alias for the old code.
      await supabaseAdmin.from("referral_code_aliases").update({ active: false }).eq("alias_code", oldCode);
    }
  }

  return { code: newCode };
}

// ── Ambassador self-service ─────────────────────────────────────────────────
export async function changeOwnReferralCode(input: {
  authUserId: string;
  requestedCode: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ code: string }> {
  const policy = await getReferralCodePolicy();
  const ambassador = await loadAmbassadorByAuthUser(input.authUserId);
  if (!ambassador || ambassador.status !== "approved") {
    throw new Error("Only approved ambassadors can set a referral code.");
  }
  if (ambassador.referral_code_locked) {
    throw new Error("Your referral code is locked. Contact support if you need it changed.");
  }
  const fmt = validateReferralCodeFormat(input.requestedCode, { minLength: policy.minLength, maxLength: policy.maxLength });
  if (!fmt.ok) throw new Error(fmt.error ?? "That code isn't valid.");

  if (fmt.code !== normalizeReferralCode(ambassador.referral_code)) {
    await assertWithinChangeLimit(ambassador.id, ambassador.referral_code_changed_at, policy);
  }
  return applyReferralCodeChange({
    ambassador, newCode: fmt.code, fingerprint: fmt.fingerprint,
    actor: "ambassador", reason: "self_service",
    ipAddress: input.ipAddress, userAgent: input.userAgent, policy,
  });
}

// ── Admin controls ──────────────────────────────────────────────────────────
export async function adminForceReferralCode(input: {
  ambassadorId: string; requestedCode: string; adminUsername: string; ipAddress?: string | null; userAgent?: string | null;
}): Promise<{ code: string }> {
  const policy = await getReferralCodePolicy();
  const ambassador = await loadAmbassadorById(input.ambassadorId);
  if (!ambassador) throw new Error("Ambassador not found.");
  const fmt = validateReferralCodeFormat(input.requestedCode, { minLength: policy.minLength, maxLength: policy.maxLength });
  if (!fmt.ok) throw new Error(fmt.error ?? "That code isn't valid.");
  // Admin override ignores per-ambassador change limits and lock.
  return applyReferralCodeChange({
    ambassador: { ...ambassador, referral_code_locked: false },
    newCode: fmt.code, fingerprint: fmt.fingerprint,
    actor: `admin:${input.adminUsername}`, reason: "admin_force",
    ipAddress: input.ipAddress, userAgent: input.userAgent, policy,
  });
}

export async function setReferralCodeLock(ambassadorId: string, locked: boolean): Promise<void> {
  await Promise.all([
    supabaseAdmin.from("ambassadors").update({ referral_code_locked: locked }).eq("id", ambassadorId),
    supabaseAdmin.from("partners").update({ referral_code_locked: locked }).eq("id", ambassadorId),
  ]);
}

export interface ReferralCodeChangeRecord {
  id: string; oldCode: string | null; newCode: string; actor: string; reason: string | null; createdAt: string;
}

export async function getReferralCodeHistory(ambassadorId: string): Promise<ReferralCodeChangeRecord[]> {
  const { data } = await supabaseAdmin
    .from("referral_code_changes")
    .select("id, old_code, new_code, actor, reason, created_at")
    .eq("ambassador_id", ambassadorId)
    .order("created_at", { ascending: false })
    .limit(100);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id), oldCode: r.old_code ? String(r.old_code) : null, newCode: String(r.new_code),
    actor: String(r.actor), reason: r.reason ? String(r.reason) : null, createdAt: String(r.created_at),
  }));
}

// Restore a previous code from history (admin), re-validating + re-checking
// uniqueness so a since-taken code can't be forced into a collision.
export async function restorePreviousReferralCode(input: {
  ambassadorId: string; targetCode: string; adminUsername: string; ipAddress?: string | null; userAgent?: string | null;
}): Promise<{ code: string }> {
  return adminForceReferralCode({
    ambassadorId: input.ambassadorId, requestedCode: input.targetCode,
    adminUsername: input.adminUsername, ipAddress: input.ipAddress, userAgent: input.userAgent,
  });
}

// Resolve a referral code (possibly an OLD/aliased one) to the ambassador's
// CURRENT live code. Used by /r/[code]. Returns null if unknown/expired/disabled.
export async function resolveReferralCode(rawCode: string): Promise<{ ambassadorId: string; currentCode: string } | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;

  // 1) Live code on the ambassadors table, then the partners mirror (so this
  //    never regresses attribution for a code that only matched the old path).
  const { data: live } = await supabaseAdmin
    .from("ambassadors").select("id, referral_code, status").eq("referral_code", code).maybeSingle();
  if (live && live.status === "approved" && live.referral_code) {
    return { ambassadorId: String(live.id), currentCode: String(live.referral_code) };
  }
  const { data: livePartner } = await supabaseAdmin
    .from("partners").select("id, referral_code, status").eq("referral_code", code).maybeSingle();
  if (livePartner && livePartner.status === "approved" && livePartner.referral_code) {
    return { ambassadorId: String(livePartner.id), currentCode: String(livePartner.referral_code) };
  }

  // 2) Aliased old code -> current code (redirect mode), if active + unexpired.
  const nowIso = new Date().toISOString();
  const { data: alias } = await supabaseAdmin
    .from("referral_code_aliases")
    .select("ambassador_id, active, expires_at")
    .eq("alias_code", code)
    .eq("active", true)
    .maybeSingle();
  if (alias && (!alias.expires_at || String(alias.expires_at) > nowIso)) {
    const { data: owner } = await supabaseAdmin
      .from("ambassadors").select("id, referral_code, status").eq("id", alias.ambassador_id).maybeSingle();
    if (owner && owner.status === "approved" && owner.referral_code) {
      return { ambassadorId: String(owner.id), currentCode: String(owner.referral_code) };
    }
  }
  return null;
}
