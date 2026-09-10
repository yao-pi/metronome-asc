/**
 * Tests for the Pi authentication Worker, against a stubbed Pi API.
 *
 * Nothing here touches the network: global fetch is replaced, which also lets
 * each test assert on the request the Worker *made* to Pi — the Bearer header
 * and the absence of any API key are the points of the whole exercise.
 *
 *   node test/index.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const ORIGIN = "https://yao-pi.github.io";

const ENV = {
  SESSION_SECRET: "test-secret-do-not-use-in-production",
  ALLOWED_ORIGINS: "https://yao-pi.github.io,http://localhost:8000",
  SESSION_TTL: "43200",
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** Replace global fetch for one call, capturing what the Worker sent to Pi. */
function withPi(handler, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return run(calls).finally(() => { globalThis.fetch = original; });
}

function piOk(body, status = 200) {
  return () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function request(path, { method = "GET", body, origin = ORIGIN, token, raw } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body || raw) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://worker.test${path}`, {
    method,
    headers,
    ...(raw !== undefined ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
}

const call = (path, options, env = ENV) => worker.fetch(request(path, options), env);

/** Sign in with a stubbed Pi and return the parsed body. */
function signIn(piUser = { uid: "uid-123", username: "pioneer" }, env = ENV) {
  return withPi(piOk(piUser), async () => {
    const response = await call("/auth", { method: "POST", body: { accessToken: "tok" } }, env);
    return { status: response.status, body: await response.json() };
  });
}

/* -------------------------------------------------------------------------- */
/* Health and CORS                                                             */
/* -------------------------------------------------------------------------- */

test("health reports configured when the signing secret is bound", async () => {
  const response = await call("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true });
});

test("health reports unconfigured when the signing secret is missing", async () => {
  const response = await call("/health", {}, { ...ENV, SESSION_SECRET: undefined });
  assert.equal((await response.json()).configured, false);
});

test("preflight is answered with the allowed origin echoed back", async () => {
  const response = await call("/auth", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal(response.headers.get("Vary"), "Origin");
});

test("an origin outside the allow-list is refused", async () => {
  const response = await call("/auth", { method: "POST", origin: "https://evil.example" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("a request with no Origin at all is allowed through", async () => {
  // curl and the tests themselves send none; CORS guards browser credentials,
  // it is not general access control.
  const response = await call("/health", { origin: null });
  assert.equal(response.status, 200);
});

test("a missing signing secret fails closed rather than issuing unsigned sessions", async () => {
  const response = await call("/auth", { method: "POST", body: { accessToken: "tok" } },
    { ...ENV, SESSION_SECRET: undefined });
  assert.equal(response.status, 500);
});

/* -------------------------------------------------------------------------- */
/* POST /auth                                                                  */
/* -------------------------------------------------------------------------- */

test("the access token is validated against Pi with a Bearer header", async () => {
  await withPi(piOk({ uid: "uid-123", username: "pioneer" }), async (calls) => {
    await call("/auth", { method: "POST", body: { accessToken: "access-token-abc" } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.minepi.com/v2/me");
    assert.equal(calls[0].init.headers.Authorization, "Bearer access-token-abc");
  });
});

test("no Pi Server API Key is sent anywhere in this flow", async () => {
  await withPi(piOk({ uid: "uid-123", username: "pioneer" }), async (calls) => {
    await call("/auth", { method: "POST", body: { accessToken: "tok" } });

    const sent = JSON.stringify(calls[0].init.headers);
    assert.doesNotMatch(sent, /^.*"Key /, "must not authenticate with a Server API Key");
    assert.equal(calls[0].init.headers["Content-Type"], undefined);
  });
});

test("a valid token yields the Pi identity and a session token", async () => {
  const { status, body } = await signIn();
  assert.equal(status, 200);
  assert.deepEqual(body.user, { uid: "uid-123", username: "pioneer" });
  assert.equal(typeof body.sessionToken, "string");
  assert.match(body.sessionToken, /^[\w-]+\.[\w-]+$/);
  assert.equal(typeof body.expiresAt, "number");
});

test("the identity comes from Pi, never from the client", async () => {
  const { body } = await withPi(piOk({ uid: "real-uid", username: "real-user" }), async () => {
    const response = await call("/auth", {
      method: "POST",
      // A tampered client claiming to be somebody else.
      body: { accessToken: "tok", uid: "attacker-uid", username: "admin" },
    });
    return { body: await response.json() };
  });
  assert.deepEqual(body.user, { uid: "real-uid", username: "real-user" });
});

test("the Pi access token is not echoed back to the client", async () => {
  const { body } = await signIn();
  assert.doesNotMatch(JSON.stringify(body), /tok/);
});

test("a token Pi rejects is a 401", async () => {
  const { status, body } = await withPi(piOk({ error: "invalid_token" }, 401), async () => {
    const response = await call("/auth", { method: "POST", body: { accessToken: "bad" } });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(status, 401);
  assert.match(body.error, /rejected the access token/);
});

test("Pi being unreachable is a 502, not a rejected sign-in", async () => {
  const handler = () => { throw new Error("network down"); };
  const { status } = await withPi(handler, async () => {
    const response = await call("/auth", { method: "POST", body: { accessToken: "tok" } });
    return { status: response.status };
  });
  assert.equal(status, 502);
});

test("a 200 from Pi carrying no uid is refused", async () => {
  const { status } = await withPi(piOk({ username: "ghost" }), async () => {
    const response = await call("/auth", { method: "POST", body: { accessToken: "tok" } });
    return { status: response.status };
  });
  assert.equal(status, 502);
});

test("a missing accessToken is a 400", async () => {
  const response = await call("/auth", { method: "POST", body: {} });
  assert.equal(response.status, 400);
});

test("a malformed JSON body is a 400", async () => {
  const response = await call("/auth", { method: "POST", raw: "{not json" });
  assert.equal(response.status, 400);
});

/* -------------------------------------------------------------------------- */
/* GET /session                                                                */
/* -------------------------------------------------------------------------- */

test("a freshly issued session token resolves to the same user", async () => {
  const { body } = await signIn();
  const response = await call("/session", { token: body.sessionToken });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).user, { uid: "uid-123", username: "pioneer" });
});

test("verifying a session makes no call to Pi", async () => {
  const { body } = await signIn();
  await withPi(() => { throw new Error("Pi must not be called"); }, async (calls) => {
    const response = await call("/session", { token: body.sessionToken });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
  });
});

test("a request with no session token is a 401", async () => {
  assert.equal((await call("/session")).status, 401);
});

test("a tampered payload is rejected", async () => {
  const { body } = await signIn();
  const [, signature] = body.sessionToken.split(".");
  const forgedClaims = Buffer.from(JSON.stringify({
    uid: "attacker", username: "admin", iat: 0, exp: 9999999999,
  })).toString("base64url");

  const response = await call("/session", { token: `${forgedClaims}.${signature}` });
  assert.equal(response.status, 401);
});

test("a token signed with a different secret is rejected", async () => {
  const { body } = await signIn({ uid: "uid-123", username: "pioneer" },
    { ...ENV, SESSION_SECRET: "some-other-secret" });
  const response = await call("/session", { token: body.sessionToken });
  assert.equal(response.status, 401);
});

test("an expired session is rejected", async () => {
  // A negative TTL puts exp in the past at the moment of issue.
  const { body } = await signIn({ uid: "uid-123", username: "pioneer" },
    { ...ENV, SESSION_TTL: "-10" });
  const response = await call("/session", { token: body.sessionToken });
  assert.equal(response.status, 401);
});

test("garbage in the Authorization header is rejected, not crashed on", async () => {
  for (const token of ["nonsense", "a.b", "....", "!!!.???"]) {
    const response = await call("/session", { token });
    assert.equal(response.status, 401, `expected 401 for ${token}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

test("an unknown path is a 404", async () => {
  assert.equal((await call("/nope", { method: "POST", body: {} })).status, 404);
});

test("POST /session and GET /auth are not routed", async () => {
  assert.equal((await call("/session", { method: "POST", body: {} })).status, 404);
  assert.equal((await call("/auth")).status, 404);
});
