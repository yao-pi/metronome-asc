/**
 * Tap Tempo — Pi authentication backend.
 *
 * The browser cannot establish its own session. An access token from the Pi
 * SDK is just an opaque string until somebody asks Pi who it belongs to, and a
 * tampered client can send any string it likes. So the token is validated here,
 * against Pi's own /me endpoint, and only then is a session issued.
 *
 * This flow needs **no Pi Server API Key**. GET /v2/me authenticates with the
 * user's own access token as a Bearer credential, so there is no secret to
 * protect beyond the session-signing key. (A payments backend is a different
 * story: approve/complete are authorised with `Key <SERVER_API_KEY>`.)
 *
 * Payments are the exception to the no-API-key rule above. Approving and
 * completing a U2A payment are server-to-server calls authorised with
 * `Key <PI_NETWORK_API_KEY>`, and that key must never reach a browser — which
 * is the whole reason this Worker has payment endpoints at all.
 *
 * Endpoints:
 *   POST /auth              { accessToken }            -> { user, sessionToken }
 *   GET  /session           Authorization: Bearer <st> -> { user, expiresAt }
 *   POST /payments/approve  { paymentId }              Authorization: Bearer <st>
 *   POST /payments/complete { paymentId, txid }        Authorization: Bearer <st>
 *   GET  /health
 *
 * Bindings:
 *   SESSION_SECRET       (secret)  HMAC key for session tokens
 *   PI_NETWORK_API_KEY   (secret)  Server API Key from the Pi Developer Portal
 *   ALLOWED_ORIGINS      (var)     comma-separated list of allowed browser origins
 *   SESSION_TTL          (var)     session lifetime in seconds
 *   PRODUCT_ID           (var)     the only product this app sells
 *   PRODUCT_AMOUNT       (var)     its price in Pi, as a string
 */

const PI_API_BASE = "https://api.minepi.com/v2";

const DEFAULT_SESSION_TTL = 60 * 60 * 12; // 12 hours

const encoder = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* CORS                                                                        */
/* -------------------------------------------------------------------------- */

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Authorization is needed for GET /session, which carries the session token.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowedOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
  });
}

/* -------------------------------------------------------------------------- */
/* Session tokens                                                              */
/* -------------------------------------------------------------------------- */

/*
 * A session token is `base64url(claims).base64url(HMAC-SHA256(claims))`.
 *
 * Signed rather than random-and-stored so the Worker stays stateless — there
 * is no KV or D1 binding here to look a session up in. The trade-off is that a
 * session cannot be revoked before it expires; rotating SESSION_SECRET
 * invalidates all of them at once, which is the blunt instrument available.
 */

function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function signingKey(env) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function issueSession(env, claims) {
  const payload = base64urlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await signingKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** @returns claims, or null if the token is malformed, forged or expired. */
async function readSession(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;

  let claims;
  try {
    const key = await signingKey(env);
    // subtle.verify compares in constant time, so a forged signature cannot be
    // discovered byte by byte from response timing.
    const valid = await crypto.subtle.verify(
      "HMAC", key, base64urlDecode(signature), encoder.encode(payload),
    );
    if (!valid) return null;
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
  } catch {
    // Malformed base64 or JSON: indistinguishable from a forgery, treat it as one.
    return null;
  }

  if (!claims?.uid) return null;
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return claims;
}

/* -------------------------------------------------------------------------- */
/* Pi                                                                          */
/* -------------------------------------------------------------------------- */

function piError(body) {
  if (!body || typeof body !== "object") return "";
  return body.error_message || body.message || body.error || "";
}

/**
 * Ask Pi who this access token belongs to.
 *
 * This single call is the entire trust anchor of the flow: whatever uid comes
 * back is the user, and anything the client claimed is ignored.
 */
async function fetchPiUser(accessToken) {
  let response;
  try {
    response = await fetch(`${PI_API_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    // Pi unreachable is not the caller's fault; distinguish it from a bad token
    // so the client does not tell the user their sign-in was rejected.
    return { error: `Could not reach Pi: ${error?.message || error}`, status: 502 };
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      error: `Pi rejected the access token (HTTP ${response.status}). ${piError(body)}`.trim(),
      status: 401,
    };
  }
  if (!body?.uid) {
    return { error: "Pi returned no uid for this token.", status: 502 };
  }

  return { uid: body.uid, username: body.username };
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Call the Pi Platform API with the Server API Key.
 *
 * `Key <api key>`, not `Bearer` — Bearer is the user's access token, and the
 * two are not interchangeable. The payment endpoints reject the wrong one.
 */
async function piServerFetch(env, path, init = {}) {
  const response = await fetch(`${PI_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Key ${env.PI_NETWORK_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Pi returned HTML or a bare string; keep it so the cause stays visible
    // rather than collapsing to an empty object.
    body = { raw: text.slice(0, 300) };
  }
  console.log(`pi ${init.method || "GET"} ${path} -> ${response.status}`,
    JSON.stringify(body).slice(0, 400));
  return { ok: response.ok, status: response.status, body };
}

/**
 * Read the payment back from Pi and decide whether it is really ours.
 *
 * Nothing the browser said is trusted here. The client sends only a paymentId;
 * the amount, the owner and the product all come from Pi's own record, because
 * a tampered client would otherwise be free to have a 0.0001 π payment approved
 * as a 0.01 π tip, or to complete somebody else's payment.
 */
async function loadVerifiedPayment(env, paymentId, uid) {
  const { ok, status, body } = await piServerFetch(env, `/payments/${paymentId}`);

  if (!ok) {
    // A 404 here is usually a project mismatch rather than a missing payment:
    // the payment exists, but under an app this API key cannot see. Testnet and
    // Mainnet are separate Portal projects with separate keys.
    const hint = status === 404
      ? " If the payment does exist, PI_NETWORK_API_KEY belongs to a different Portal project."
      : "";
    return { error: `Could not read the payment (HTTP ${status}). ${piError(body)}${hint}`.trim(), status: 502 };
  }

  const expected = Number(env.PRODUCT_AMOUNT);
  if (!Number.isFinite(expected)) {
    return { error: "Server is missing a valid PRODUCT_AMOUNT.", status: 500 };
  }
  if (Number(body.amount) !== expected) {
    return { error: `Unexpected amount: got ${body.amount}, expected ${expected}.`, status: 400 };
  }
  if (body.user_uid !== uid) {
    return { error: "This payment belongs to a different user.", status: 403 };
  }
  if (body.metadata?.product !== env.PRODUCT_ID) {
    return {
      error: `Unexpected product: got ${body.metadata?.product ?? "(none)"}, expected ${env.PRODUCT_ID}.`,
      status: 400,
    };
  }
  if (body.status?.cancelled || body.status?.user_cancelled) {
    return { error: "This payment was cancelled.", status: 409 };
  }

  return { payment: body };
}

async function handleApprove(request, env, claims, payload) {
  const { paymentId } = payload;
  if (!paymentId) return json({ error: "paymentId is required." }, 400, request, env);

  const verified = await loadVerifiedPayment(env, paymentId, claims.uid);
  if (verified.error) return json({ error: verified.error }, verified.status, request, env);

  // Approving twice is not worth surfacing as a failure: the desired end state
  // is already reached, and the SDK may legitimately retry the callback.
  if (verified.payment.status?.developer_approved) {
    return json({ ok: true, alreadyApproved: true }, 200, request, env);
  }

  const { ok, status, body } = await piServerFetch(env, `/payments/${paymentId}/approve`, {
    method: "POST",
  });
  if (!ok) {
    console.error("approve failed", status, JSON.stringify(body));
    return json({ error: `Pi rejected the approval (HTTP ${status}). ${piError(body)}`.trim() },
      502, request, env);
  }

  return json({ ok: true, payment: body }, 200, request, env);
}

async function handleComplete(request, env, claims, payload) {
  const { paymentId, txid } = payload;
  if (!paymentId || !txid) {
    return json({ error: "paymentId and txid are required." }, 400, request, env);
  }

  const verified = await loadVerifiedPayment(env, paymentId, claims.uid);
  if (verified.error) return json({ error: verified.error }, verified.status, request, env);

  if (verified.payment.status?.developer_completed) {
    return json({ ok: true, alreadyCompleted: true }, 200, request, env);
  }

  const { ok, status, body } = await piServerFetch(env, `/payments/${paymentId}/complete`, {
    method: "POST",
    body: JSON.stringify({ txid }),
  });

  // A non-200 means Pi could not confirm the transaction. The caller may be
  // running a tampered client claiming a payment it never made, so this must
  // not be reported as a completed tip.
  if (!ok) {
    console.error("complete failed", status, JSON.stringify(body));
    return json({ error: `Pi rejected the completion (HTTP ${status}). ${piError(body)}`.trim() },
      502, request, env);
  }

  return json({ ok: true, payment: body }, 200, request, env);
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

async function handleAuth(request, env, payload) {
  const accessToken = payload?.accessToken;
  if (!accessToken || typeof accessToken !== "string") {
    return json({ error: "accessToken is required." }, 400, request, env);
  }

  const piUser = await fetchPiUser(accessToken);
  if (piUser.error) {
    return json({ error: piUser.error }, piUser.status, request, env);
  }

  const ttl = Number(env.SESSION_TTL) || DEFAULT_SESSION_TTL;
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    uid: piUser.uid,
    username: piUser.username,
    iat: issuedAt,
    exp: issuedAt + ttl,
  };

  const sessionToken = await issueSession(env, claims);

  // The Pi access token is deliberately not stored or echoed back. It has done
  // its job, and keeping it would widen the blast radius of any later bug.
  return json({
    ok: true,
    user: { uid: claims.uid, username: claims.username },
    sessionToken,
    expiresAt: claims.exp,
  }, 200, request, env);
}

/** Claims for the caller's session token, or null. */
function bearerClaims(request, env) {
  const header = request.headers.get("Authorization") || "";
  return readSession(env, header.startsWith("Bearer ") ? header.slice(7) : "");
}

async function handleSession(request, env) {
  const claims = await bearerClaims(request, env);
  if (!claims) {
    return json({ error: "Session is invalid or has expired." }, 401, request, env);
  }

  return json({
    ok: true,
    user: { uid: claims.uid, username: claims.username },
    expiresAt: claims.exp,
  }, 200, request, env);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (pathname === "/health") {
      return json({
        ok: true,
        configured: Boolean(env.SESSION_SECRET),
        payments: Boolean(env.PI_NETWORK_API_KEY),
        product: env.PRODUCT_ID,
        amount: env.PRODUCT_AMOUNT,
      }, 200, request, env);
    }

    // A browser request always carries Origin. A non-browser caller (curl, a
    // test) carries none, and there is nothing to check in that case — CORS
    // protects browser credentials, it is not a general access control.
    const origin = request.headers.get("Origin") || "";
    if (origin && !allowedOrigins(env).includes(origin)) {
      return json({ error: "Origin not allowed." }, 403, request, env);
    }

    if (!env.SESSION_SECRET) {
      return json({ error: "Server is missing SESSION_SECRET." }, 500, request, env);
    }

    if (pathname === "/session" && request.method === "GET") {
      return handleSession(request, env);
    }

    const isPayment = pathname === "/payments/approve" || pathname === "/payments/complete";

    if (request.method === "POST" && (pathname === "/auth" || isPayment)) {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Invalid JSON body." }, 400, request, env);
      }

      if (pathname === "/auth") return handleAuth(request, env, payload);

      // Payments only: the Server API Key is what authorises approve and
      // complete against Pi, so without it there is nothing this can do.
      if (!env.PI_NETWORK_API_KEY) {
        return json({ error: "Server is missing PI_NETWORK_API_KEY." }, 500, request, env);
      }

      const claims = await bearerClaims(request, env);
      if (!claims) {
        return json({ error: "Sign in with Pi to continue." }, 401, request, env);
      }

      return pathname === "/payments/approve"
        ? handleApprove(request, env, claims, payload)
        : handleComplete(request, env, claims, payload);
    }

    return json({ error: "Not found." }, 404, request, env);
  },
};
