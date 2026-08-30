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
import crypto, { createHmac, randomUUID } from "node:crypto";

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

// GoTrue revokes a session server-side on admin.signOut, so a token captured
// before logout stops working immediately. Held in memory: the harness process
// is the whole auth backend and lives only for the run.
const revokedTokens = new Set();

// Real GoTrue verifies the HS256 signature and the `exp` claim before it will
// answer /user. A stand-in that merely base64-decodes the payload accepts a
// forged or long-expired token, so every "does an expired session still get in"
// test passes vacuously against it — the rig reports safe because it cannot
// tell unsafe from safe. Same failure mode as the shim that silently widened
// queries: verify here, or the test proves nothing.
function readToken(req) {
  const raw = String(req.headers.authorization ?? "");
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const expected = crypto.createHmac("sha256", DEV_JWT_SECRET)
    .update(`${parts[0]}.${parts[1]}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const given = Buffer.from(parts[2]);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  } catch {
    return null;
  }

  if (typeof claims?.exp === "number" && claims.exp <= Math.floor(Date.now() / 1000)) return null;
  if (revokedTokens.has(token)) return null;
  return claims;
}

/** The user shape GoTrue returns; the app reads role off app_metadata first. */
const toUser = (row) => ({
  id: row.id,
  aud: "authenticated",
  role: "authenticated",
  email: row.email,
  // REAL, not assumed. This used to report row.created_at unconditionally, so
  // every harness user looked confirmed and no test could exercise the
  // unconfirmed paths — which are exactly the ones that stranded four accounts
  // on 2026-08-29 (resend confirmation, the locked-out-ambassador sweep).
  email_confirmed_at: row.email_confirmed_at ?? null,
  confirmed_at: row.email_confirmed_at ?? null,
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
/**
 * Tokens already spent in this process.
 *
 * Real GoTrue consumes a verification token on first use. Modelling that is
 * what makes "clicking the link twice is safe" and "a reused reset link is
 * refused" testable at all — and it is the exact behaviour behind the
 * 2026-08-29 applicant whose token a mailbox scanner burned before they
 * clicked. In-memory, so a shim restart is a clean slate.
 */
const spentTokens = new Set();

/**
 * Per-user sign-outs the shim was asked to perform, so a test can assert that
 * the app actually asked. Recorded rather than simulated: this shim keeps no
 * session table, and pretending to revoke sessions it never tracked would be a
 * harness reporting work it did not do.
 */
const signedOutUsers = new Map();

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

  // ---- password recovery -------------------------------------------------
  // Real GoTrue emails a magic link carrying a recovery token in the URL hash.
  // There is no mail service here, so this returns the same unconditional 200
  // GoTrue does (never confirming whether the address exists) and, for a known
  // address, hands the caller the link the email WOULD have contained under
  // `harness_recovery_url`. Production never returns that field, and the app
  // never reads it — it exists so the browser test can follow the link a real
  // shopper would click. Everything after the click is the real product code.
  if (path === "/recover" && req.method === "POST") {
    const body = (await readBody(req)) ?? {};
    const email = String(body.email ?? "").trim().toLowerCase();
    const found = await q("select * from auth.users where lower(email) = $1", [email]);
    const payload = { };
    if (found.rows.length) {
      const token = mintAccessToken(toUser(found.rows[0]));
      const redirect = String(body.redirect_to ?? body.gotrue_meta_security?.redirect_to ?? "");
      payload.harness_recovery_url = `${redirect}#access_token=${token}&type=recovery&expires_in=${TOKEN_TTL_SECONDS}&refresh_token=harness-refresh-${found.rows[0].id}&token_type=bearer`;
    }
    return send(res, 200, payload), true;
  }

  // Harness-only introspection: which users the app asked to sign out, and
  // with what scope. Development tooling; there is no equivalent in GoTrue.
  if (path === "/__harness/signouts" && req.method === "GET") {
    return send(res, 200, Object.fromEntries(signedOutUsers)), true;
  }

  // POST /logout?scope=global|local|others — the REAL path, and the one
  // admin.signOut(jwt, scope) uses. /api/account/change-password calls it with
  // scope "others" so a customer changing their password because they think
  // somebody else is in the account actually removes them.
  if (path === "/logout" && req.method === "POST") {
    const raw = String(req.headers.authorization ?? "");
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    const scope = url.searchParams.get("scope") ?? "global";

    // Whose token is it? Recorded so a test can assert the app asked for the
    // right person and the right scope. The shim keeps no session table, so it
    // records the request rather than pretending to revoke sessions it never
    // tracked — claiming work it did not do is the failure this harness exists
    // to avoid.
    let subject = null;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      subject = claims?.sub ?? null;
    } catch {
      subject = null;
    }
    if (subject) signedOutUsers.set(subject, { scope, at: new Date().toISOString() });

    // "others" deliberately leaves the CALLING token usable — the customer must
    // not be signed out of the page they are standing on.
    if (token && scope !== "others") revokedTokens.add(token);
    return send(res, 204), true;
  }

  // ---- admin API ---------------------------------------------------------
  if (path.startsWith("/admin/users")) {
    const rest = path.slice("/admin/users".length).replace(/^\//, "");

    // admin.updateUserById — PUT /admin/users/<id>.
    if (rest && (req.method === "PUT" || req.method === "PATCH")) {
      const body = (await readBody(req)) ?? {};
      const found = await q("select * from auth.users where id = $1", [rest]);
      if (!found.rows.length) return send(res, 404, { error: "user_not_found" }), true;
      if (body.password !== undefined) {
        await q("update auth.users set encrypted_password = $2 where id = $1", [rest, String(body.password)]);
      }
      if (body.email !== undefined) {
        await q("update auth.users set email = $2 where id = $1", [rest, String(body.email).toLowerCase()]);
      }
      if (body.email_confirm === true) {
        await q("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [rest]);
      }
      if (body.user_metadata) {
        await q(
          "update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || $2::jsonb where id = $1",
          [rest, JSON.stringify(body.user_metadata)],
        );
      }
      if (body.app_metadata) {
        await q(
          "update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || $2::jsonb where id = $1",
          [rest, JSON.stringify(body.app_metadata)],
        );
      }
      const fresh = await q("select * from auth.users where id = $1", [rest]);
      return send(res, 200, toUser(fresh.rows[0])), true;
    }

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

  // ---- verify -------------------------------------------------------------
  // The hop every auth email now lands on. /auth/confirm on the app's own host
  // rebuilds this URL and redirects here, so the customer only ever sees
  // vantalabsresearch.com — a link whose domain matches the sender, which is
  // the phishing signal that outlived the 2026-08-29 branding fix.
  //
  // Real GoTrue verifies the token, CONFIRMS the address, and 303s to
  // redirect_to with a session in the fragment. Modelled here so the full chain
  // is testable; without it the browser test stops at a 501 and proves nothing.
  if (path === "/verify" && req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const type = url.searchParams.get("type") ?? "";
    const redirect = url.searchParams.get("redirect_to") ?? "http://127.0.0.1:3000";

    // ERRORS GO IN THE FRAGMENT, exactly as GoTrue sends them.
    //
    // A spent or expired link comes back as
    // `#error=access_denied&error_code=otp_expired&error_description=...`, and
    // account-auth-form reads that fragment to explain what happened. Putting
    // the error in the QUERY instead — which this shim used to do — meant the
    // app's dead-link handling was never exercised: the page said nothing and
    // the harness recorded a pass.
    const deadLink = (code) => {
      res.writeHead(303, {
        Location: `${redirect}#error=access_denied&error_code=${code}`
          + `&error_description=${encodeURIComponent("Email link is invalid or has expired")}`,
      });
      res.end();
      return true;
    };

    // Harness tokens are minted as `harness-hashed-<user id>` by generate_link.
    const id = token.startsWith("harness-hashed-") ? token.slice("harness-hashed-".length) : "";
    const found = id ? await q("select * from auth.users where id = $1", [id]) : { rows: [] };
    if (!found.rows.length) {
      return deadLink("otp_expired");
    }

    // SINGLE USE, because that is the property the 2026-08-29 incident turned
    // on: a mailbox security scanner pre-fetched the link and burned the token
    // before the human ever clicked it. A shim that verifies the same token
    // forever cannot reproduce that, so the app's handling of it goes untested.
    const spentKey = `${token}:${type}`;
    if (spentTokens.has(spentKey)) {
      return deadLink("access_denied");
    }
    spentTokens.add(spentKey);

    // Verifying an email link is what confirms the address — the whole point.
    await q("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [id]);

    // An email_change link MOVES the account to the pending address and clears
    // it, so the old address stops signing in from this moment.
    if (type === "email_change" && found.rows[0].email_change) {
      await q(
        "update auth.users set email = email_change, email_change = null, email_confirmed_at = now() where id = $1",
        [id],
      );
    }
    const fresh = await q("select * from auth.users where id = $1", [id]);
    const user = toUser(fresh.rows[0]);
    const fragment =
      `#access_token=${mintAccessToken(user)}&type=${type}&expires_in=${TOKEN_TTL_SECONDS}`
      + `&refresh_token=harness-refresh-${id}&token_type=bearer`;

    res.writeHead(303, { Location: `${redirect}${fragment}` });
    res.end();
    return true;
  }

  // ---- admin generate_link ------------------------------------------------
  // Real GoTrue mints a verification link and returns it WITHOUT sending any
  // email, which is what /api/auth/password-reset and /api/auth/signup rely on
  // to send branded mail through Resend instead of Supabase's own template.
  //
  // Implemented here because those two routes are the ONLY way a customer gets
  // into an account, and without this the harness answers 501 and every browser
  // test of signup exercises the fallback path rather than the real one. That
  // is precisely the gap that let a broken confirmation email reach production
  // on 2026-08-29.
  //
  // Harness-only, and not a security boundary: the token is the same
  // mintAccessToken() the rest of this file uses, and passwords are stored in
  // clear text here exactly as the header of this file already warns.
  if (path === "/admin/generate_link" && req.method === "POST") {
    const body = (await readBody(req)) ?? {};
    const type = String(body.type ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();
    const redirect = String(body.redirect_to ?? "");

    if (!email) return send(res, 400, { error: "validation_failed" }), true;

    const existing = await q("select * from auth.users where lower(email) = $1", [email]);

    let row;
    if (type === "signup") {
      // Real GoTrue REFUSES to mint a signup link for an address that already
      // has an account. The app depends on that refusal — it is the branch that
      // sends an unconfirmed user a magic link instead — so model it.
      if (existing.rows.length) {
        return send(res, 422, {
          error: "user_already_exists",
          error_description: "User already registered",
        }), true;
      }
      // email_confirmed_at stays NULL: a freshly signed-up user is unconfirmed
      // until they follow the link, which is the state the whole confirmation
      // path exists to move them out of.
      const created = await q(
        `insert into auth.users (email, encrypted_password, raw_user_meta_data, created_at)
         values ($1, $2, $3, now()) returning *`,
        [email, String(body.password ?? ""), JSON.stringify(body.data ?? {})],
      );
      row = created.rows[0];
    } else if (type === "magiclink" || type === "recovery" || type === "invite") {
      if (!existing.rows.length) {
        return send(res, 404, { error: "user_not_found" }), true;
      }
      row = existing.rows[0];
    } else if (type === "email_change_current" || type === "email_change_new") {
      // A change of address. `email` is the CURRENT address and must exist;
      // `new_email` is the one being adopted and must not already belong to
      // somebody else — real GoTrue refuses that, and /api/account/email-change
      // reports the refusal rather than promising an email nobody will send.
      if (!existing.rows.length) {
        return send(res, 404, { error: "user_not_found" }), true;
      }
      const newEmail = String(body.new_email ?? "").trim().toLowerCase();
      if (!newEmail) return send(res, 400, { error: "validation_failed" }), true;
      const taken = await q("select 1 from auth.users where lower(email) = $1", [newEmail]);
      if (taken.rows.length) {
        return send(res, 422, {
          error: "email_exists",
          error_description: "A user with this email address has already been registered",
        }), true;
      }
      // Record the pending address the way real GoTrue does, so /verify can
      // actually MOVE the account when the link is followed. Without this the
      // change-of-address chain stops at "an email was sent" and the half that
      // matters — does the account end up on the new address, and does the old
      // one stop working — cannot be tested at all.
      await q("update auth.users set email_change = $2 where id = $1", [existing.rows[0].id, newEmail]);
      row = existing.rows[0];
    } else {
      return send(res, 501, {
        error: "not_implemented",
        error_description: `gotrue-shim does not implement generate_link type "${type}".`,
      }), true;
    }

    const user = toUser(row);
    const token = mintAccessToken(user);
    const fragment =
      `#access_token=${token}&type=${type}&expires_in=${TOKEN_TTL_SECONDS}`
      + `&refresh_token=harness-refresh-${row.id}&token_type=bearer`;

    // FLAT, exactly as GoTrue answers: supabase-js splits action_link and its
    // siblings into `properties` and leaves the rest as `user`. Nesting them
    // here would make data.properties.action_link undefined and every caller
    // would take its failure branch while this shim reported 200.
    return send(res, 200, {
      ...user,
      action_link: `${redirect || "http://127.0.0.1:3000"}${fragment}`,
      email_otp: "000000",
      hashed_token: `harness-hashed-${row.id}`,
      verification_type: type,
      redirect_to: redirect,
    }), true;
  }

  // Anything else auth-shaped is explicitly NOT implemented — fail loudly
  // rather than silently returning a shape that looks like success.
  return send(res, 501, {
    error: "not_implemented",
    error_description: `gotrue-shim does not implement ${req.method} ${path}. See scripts/gotrue-shim.mjs.`,
  }), true;
}
