import "server-only";

import { randomBytes, scryptSync } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { normalizeAdminRole, type AdminRole } from "@/lib/admin-roles";

export interface AdminAccountRow {
  id: string;
  username: string;
  role: AdminRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listAdminAccounts(): Promise<AdminAccountRow[]> {
  const { data, error } = await supabaseAdmin
    .from("admin_credentials")
    .select("id, username, role, is_active, created_at, updated_at")
    .order("username", { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    username: String(row.username),
    role: normalizeAdminRole(row.role),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// Mirrors scripts/create-admin-credential.mjs's hashing scheme exactly so
// accounts created here authenticate the same way through admin-auth.ts.
export async function createAdminAccount(input: { username: string; password: string; role: AdminRole }) {
  const username = input.username.trim().toLowerCase();
  if (!username) {
    throw new Error("Username is required");
  }
  if (input.password.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }

  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(input.password, salt, 64).toString("hex");

  const { error } = await supabaseAdmin
    .from("admin_credentials")
    .insert({
      username,
      password_salt: salt,
      password_hash: hash,
      role: input.role,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  if (error) {
    if (error.code === "23505") {
      throw new Error(`An account with username "${username}" already exists`);
    }
    throw error;
  }
}

// Sets a new password for an admin account (same scrypt scheme as login).
export async function setAdminPassword(username: string, newPassword: string) {
  if (newPassword.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(newPassword, salt, 64).toString("hex");

  const { error } = await supabaseAdmin
    .from("admin_credentials")
    .update({ password_salt: salt, password_hash: hash, updated_at: new Date().toISOString() })
    .eq("username", username.trim().toLowerCase());

  if (error) throw error;
}

// Renames an admin account and keeps its active sessions valid by moving them
// to the new username.
export async function renameAdminAccount(oldUsername: string, newUsername: string) {
  const from = oldUsername.trim().toLowerCase();
  const to = newUsername.trim().toLowerCase();
  if (!to || !/^[a-z0-9._-]{3,40}$/.test(to)) {
    throw new Error("Username must be 3–40 characters (letters, numbers, . _ -)");
  }

  const { data: existing } = await supabaseAdmin
    .from("admin_credentials")
    .select("username")
    .eq("username", to)
    .maybeSingle();
  if (existing) {
    throw new Error(`An account with username "${to}" already exists`);
  }

  const { error } = await supabaseAdmin
    .from("admin_credentials")
    .update({ username: to, updated_at: new Date().toISOString() })
    .eq("username", from);
  if (error) throw error;

  // Keep the current session logged in under the new username.
  await supabaseAdmin.from("admin_sessions").update({ username: to }).eq("username", from);
}

export async function updateAdminAccount(username: string, input: { role?: AdminRole; isActive?: boolean }) {
  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.role !== undefined) updatePayload.role = input.role;
  if (input.isActive !== undefined) updatePayload.is_active = input.isActive;

  const { error } = await supabaseAdmin
    .from("admin_credentials")
    .update(updatePayload)
    .eq("username", username.trim().toLowerCase());

  if (error) {
    throw error;
  }
}
