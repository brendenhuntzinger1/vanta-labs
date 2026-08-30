/**
 * The one password rule this product states, in one place.
 *
 * It was written twice: as a literal 8 in change-password/route.ts, and as a
 * separate literal 8 in account-reset-password-form.tsx. Two copies of a policy
 * are two things that can drift, and these two already differ in a way that
 * matters — see below.
 *
 * WHERE IT IS ACTUALLY ENFORCED, AND WHERE IT IS NOT.
 *
 *   /account/settings  -> POST /api/account/change-password. The length is
 *                         checked SERVER-side, before anything is written, by a
 *                         caller that cannot reach around it.
 *
 *   /account/reset-password -> supabase.auth.updateUser({ password }) from the
 *                         BROWSER. There is no server route on this path — the
 *                         password reset route only sends the link — so this
 *                         constant is advisory there. The real floor is
 *                         whatever the Supabase project's own minimum password
 *                         length is set to (GoTrue's default is 6).
 *
 * Closing that gap is a project setting, not code: Supabase dashboard ->
 * Authentication -> Sign In / Providers -> Minimum password length = 8, and
 * "Secure password change" ON so GoTrue itself requires re-authentication for a
 * password update. A server route on the reset path could not do it safely,
 * because it would have to accept an access token, and an ordinary signed-in
 * session's token is indistinguishable from a recovery one without claims the
 * client cannot be trusted to assert — which would hand any live session a
 * no-current-password change, the exact hole change-password/route.ts closed.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** The sentence the customer sees, so both forms say the same thing. */
export const MIN_PASSWORD_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
