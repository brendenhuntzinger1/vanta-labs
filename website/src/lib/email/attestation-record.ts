import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { findUserByEmail } from "@/lib/auth-confirmation-email";

/**
 * RECORD THE 21+ / RESEARCH-USE REPRESENTATIONS ON THE AUTHORITATIVE RECORD.
 *
 * There is exactly one place this store keeps those two facts:
 * `auth.users.raw_user_meta_data`, holding `age_confirmed_21` and
 * `research_use_only_agreed`. /api/auth/signup writes them when the form's
 * boxes are ticked, and /api/auth/session writes them for an OAuth account that
 * arrived carrying only an identity. `auth_user_attested_by_email` — the
 * function every gate in the email system reads — asks that record and nothing
 * else.
 *
 * So this writes the SAME TWO FIELDS through the SAME ADMIN CALL, and creates
 * no second register of who has attested. A parallel compliance table would be
 * worse than no table: two answers to one legal question, and the gates would
 * go on reading the other one.
 *
 * WRITTEN ONCE, NEVER OVERWRITTEN — the rule /api/auth/session already states
 * and the reason it gives is the right one: re-stamping an existing attestation
 * would replace a real first-time representation with today's date and destroy
 * the only evidence of when it was actually made. An already-attested account
 * returns "already" and is not touched.
 *
 * IT CANNOT CREATE AN ACCOUNT. An address with no auth user returns
 * "no_account" and the caller routes that person into sign-up, where they make
 * the representations on the ordinary form. Manufacturing an account so that
 * something could be written against it would be inventing a customer to hold a
 * consent record, which is the opposite of what a consent record is for.
 *
 * IT INFERS NOTHING. Nothing here reads an order, a shipping address or a
 * marketing subscription. Having bought before is why somebody is being written
 * to; it is not evidence of their age, and this function is never called except
 * from an explicit act on the interstitial.
 */

export type AttestationOutcome =
  /** The representations were recorded on the account just now. */
  | "recorded"
  /** The account already carried both. Untouched, and its original date kept. */
  | "already"
  /** No auth account for this address. Nothing written; sign-up is the path. */
  | "no_account"
  /** The directory or the write refused. Nothing written; nothing assumed. */
  | "failed";

export async function recordAttestationForEmail(email: string): Promise<AttestationOutcome> {
  const target = String(email ?? "").trim().toLowerCase();
  if (!target) return "failed";

  let user: { id?: string; user_metadata?: Record<string, unknown> | null } | null = null;
  try {
    user = await findUserByEmail(target);
  } catch {
    return "failed";
  }
  if (!user?.id) return "no_account";

  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  if (meta.age_confirmed_21 === true && meta.research_use_only_agreed === true) return "already";

  try {
    // Errors are RETURNED here, not thrown — admin.updateUserById catches every
    // GoTrue non-2xx and hands it back as `{ error }`. A try/catch alone would
    // report a refused write as a recorded attestation, which is the one
    // mistake this function must never make.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...meta,
        age_confirmed_21: true,
        research_use_only_agreed: true,
        attested_at: new Date().toISOString(),
        // Says WHERE the representation was made, so the record can be audited
        // back to the screen that collected it rather than being indistinguishable
        // from a signup.
        attested_via: "email_link_interstitial",
        ...(meta.role ? {} : { role: "customer" }),
      },
    });
    if (error) {
      console.error("[attestation] REFUSED: could not record the representations", error.message);
      return "failed";
    }
    return "recorded";
  } catch (error) {
    console.error("[attestation] could not record the representations", error);
    return "failed";
  }
}
