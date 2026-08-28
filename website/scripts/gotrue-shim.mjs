/**
 * A MINIMAL GoTrue (Supabase Auth) STAND-IN, FOR THE LOCAL HARNESS ONLY.
 *
 * WHY THIS EXISTS
 *
 * pgrst-shim.mjs says, correctly, that it does not reproduce GoTrue auth, and
 * that anything requiring a signed-in user is therefore NOT covered. That single
 * gap is why the most valuable customer journeys had never been browser-proven:
 * account signup and login, the account dashboard, MEMBER PRICING and member
 * perks at checkout, points and store-credit redemption, and the ambassador
 * portal. All of those are revenue paths, and all of them were dark.
 *
 * WHAT IT IS
 *
 * Enough of the GoTrue wire protocol for supabase-js to sign a user up, sign
 * them in, hold a session, and for the server to read users back through the
 * admin API. It is backed by the harness's real `auth.users` table, so a user
 * created here is the same row the application's foreign keys point at.
 *
 * WHAT IT IS NOT
 *
 * Not a security boundary and not a GoTrue replacement. Passwords are stored in
 * clear text; tokens are signed with a fixed dev secret; nothing is rate
 * limited; email confirmation, OTP and password reset are not implemented.
 * Evidence from this shim proves APPLICATION behaviour for a signed-in user —
 * that member pricing applies, that the dashboard renders the right numbers. It
 * proves NOTHING about GoTrue's own security behaviour, and RLS is still not
 * exercised (the shim connects as superuser). Do not launder one into the other.
 *
 * Development-only. Never imported by the Next.js app.
 */
import { createHmac, randomUUID } from "node:crypto";

const DEV_JWT_SECRET = "harness-only-not-a-real-jwt-secret";
const TOKEN_TTL_SECONDS = 60 * 60;

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A real HS256 JWT — supabase-js decodes the payload client-side for getSession(). */
function mintAccessToken(user) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub: user.id,
    email: user.email,
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    app_metadata: user.app_metadata ?? {},
    user_metadata: user.user_metadata ?? {},
  }));
  const signature = createHmac("sha256", DEV_JWT_SECRET)
    .update(`${header}.${payload}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${payload}.${signature}`;
}

function readToken(req) {
  const raw = String(req.headers.authorization ?? "");
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  } catch {
    return null;
  }
}

/** The user shape GoTrue returns; the app reads role off app_metadata first. */
const toUser = (row) => ({
  id: row.id,
  aud: "authenticated",
  role: "authenticated",
  email: row.email,
  email_confirmed_at: row.created_at,
  confirmed_at: row.created_at,
  phone: row.phone ?? "",
  created_at: row.created_at,
  updated_at: row.created_at,
  app_metadata: row.raw_app_meta_data ?? {},
  user_metadata: row.raw_user_meta_data ?? {},
  identities: [],
});

const session = (user) => ({
  access_token: mintAccessToken(user),
  token_type: "bearer",
  expires_in: TOKEN_TTL_SECONDS,
  expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  refresh_token: `harness-refresh-${user.id}`,
  user,
});

/**
 * Handle a GoTrue request. Returns true when it took the request.
 * `pool` is the pg pool the REST shim already owns.
 */
export async function handleAuth(req, res, url, pool, send, readBody) {
  const path = url.pathname.replace(/^\/auth\/v1/, "");
  if (!url.pathname.startsWith("/auth/v1")) return false;

  const q = (text, values) => pool.query(text, values);

  // ---- sign up -----------------------------------------------------------
  if (path === "/signup" && req.method === "POST") {
    const body = (await readBody(req)) ?? {};
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password) return send(res, 400, { error: "invalid_request", error_description: "email and password required" }), true;

    const existing = await q("select id from auth.users where lower(email) = $1", [email]);
    if (existing.rows.length) {
      return send(res, 422, { code: 422, error_code: "user_already_exists", msg: "User already registered" }), true;
    }
    const id = randomUUID();
    // Every account created through the storefront is a CUSTOMER; the app reads
    // this to separate shoppers from staff and ambassadors.
    const meta = { role: "customer", ...(body.data ?? {}) };
    await q(
      `insert into auth.users (id, email, encrypted_password, raw_user_meta_data, raw_app_meta_data, created_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, now())`,
      [id, email, password, JSON.stringify(meta), JSON.stringify({ role: meta.role, provider: "email" })],
    );
    const row = (await q("select * from auth.users where id = $1", [id])).rows[0];
    const user = toUser(row);
    return send(res, 200, { ...session(user), user }), true;
  }

  // ---- sign in / refresh -------------------------------------------------
  if (path === "/token" && req.method === "POST") {
    const grant = url.searchParams.get("grant_type");
    const body = (await readBody(req)) ?? {};

    if (grant === "refresh_token") {
      const id = String(body.refresh_token ?? "").replace("harness-refresh-", "");
      const found = await q("select * from auth.users where id = $1", [id]);
      if (!found.rows.length) return send(res, 401, { error: "invalid_grant" }), true;
      const user = toUser(found.rows[0]);
      return send(res, 200, { ...session(user), user }), true;
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    const found = await q("select * from auth.users where lower(email) = $1", [email]);
    if (!found.rows.length || found.rows[0].encrypted_password !== String(body.password ?? "")) {
      return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" }), true;
    }
    const user = toUser(found.rows[0]);
    return send(res, 200, { ...session(user), user }), true;
  }

  // ---- current user ------------------------------------------------------
  if (path === "/user" && (req.method === "GET" || req.method === "PUT")) {
    const claims = readToken(req);
    if (!claims?.sub) return send(res, 401, { error: "invalid_token" }), true;

    if (req.method === "PUT") {
      const body = (await readBody(req)) ?? {};
      if (body.password) await q("update auth.users set encrypted_password = $2 where id = $1", [claims.sub, String(body.password)]);
      if (body.email) await q("update auth.users set email = $2 where id = $1", [claims.sub, String(body.email).toLowerCase()]);
      if (body.data) {
        await q("update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || $2::jsonb where id = $1",
          [claims.sub, JSON.stringify(body.data)]);
      }
    }
    const found = await q("select * from auth.users where id = $1", [claims.sub]);
    if (!found.rows.length) return send(res, 401, { error: "invalid_token" }), true;
    return send(res, 200, toUser(found.rows[0])), true;
  }

  if (path === "/logout" && req.method === "POST") return send(res, 204), true;

  // ---- admin API ---------------------------------------------------------
  if (path.startsWith("/admin/users")) {
    const rest = path.slice("/admin/users".length).replace(/^\//, "");
    if (rest) {
      const found = await q("select * from auth.users where id = $1", [rest]);
      if (!found.rows.length) return send(res, 404, { error: "user_not_found" }), true;
      return send(res, 200, toUser(found.rows[0])), true;
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const perPage = Number(url.searchParams.get("per_page") ?? 50);
    const rows = await q(
      "select * from auth.users order by created_at nulls first, id limit $1 offset $2",
      [perPage, Math.max(0, (page - 1) * perPage)],
    );
    return send(res, 200, { users: rows.rows.map(toUser), aud: "authenticated" }), true;
  }

  // Anything else auth-shaped is explicitly NOT implemented — fail loudly
  // rather than silently returning a shape that looks like success.
  return send(res, 501, {
    error: "not_implemented",
    error_description: `gotrue-shim does not implement ${req.method} ${path}. See scripts/gotrue-shim.mjs.`,
  }), true;
}
