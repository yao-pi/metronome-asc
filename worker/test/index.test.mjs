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
  PI_NETWORK_API_KEY: "test-server-api-key",
  ALLOWED_ORIGINS: "https://yao-pi.github.io,http://localhost:8000",
  SESSION_TTL: "43200",
  PRODUCT_ID: "developer-tip",
  PRODUCT_AMOUNT: "0.01",
};

/** A payment as Pi would report it: ours, right price, right product. */
const GOOD_PAYMENT = {
  identifier: "pay-1",
  amount: 0.01,
  user_uid: "uid-123",
  metadata: { product: "developer-tip", app: "tap-tempo" },
  status: { developer_approved: false, developer_completed: false, cancelled: false },
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
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
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
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

/** Route stubbed Pi responses by path, so approve/complete can be asserted separately. */
function piRoutes({ payment = GOOD_PAYMENT, approve, complete } = {}) {
  return (url, init) => {
    if (url.endsWith("/approve")) {
      return approve ?? new Response(JSON.stringify({ ...payment, status: { ...payment.status, developer_approved: true } }), { status: 200 });
    }
    if (url.endsWith("/complete")) {
      return complete ?? new Response(JSON.stringify({ ...payment, status: { ...payment.status, developer_completed: true } }), { status: 200 });
    }
    if (url.includes("/payments/")) {
      return payment instanceof Response ? payment : new Response(JSON.stringify(payment), { status: 200 });
    }
    return new Response(JSON.stringify({ uid: "uid-123", username: "pioneer" }), { status: 200 });
  };
}

/** Sign in, then call a payment endpoint with the resulting session. */
async function pay(path, body, { routes = piRoutes(), env = ENV, token } = {}) {
  const session = token ?? (await signIn({ uid: "uid-123", username: "pioneer" }, env)).body.sessionToken;
  return withPi(routes, async (calls) => {
    const response = await worker.fetch(
      new Request(`https://worker.test${path}`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${session}` },
        body: JSON.stringify(body),
      }), env);
    return { status: response.status, body: await response.json(), calls };
  });
}

test("approve authorises to Pi with the Server API Key, not a Bearer token", async () => {
  const { status, calls } = await pay("/payments/approve", { paymentId: "pay-1" });
  assert.equal(status, 200);

  const approveCall = calls.find((c) => c.url.endsWith("/approve"));
  assert.equal(approveCall.url, "https://api.minepi.com/v2/payments/pay-1/approve");
  assert.equal(approveCall.init.method, "POST");
  assert.equal(approveCall.init.headers.Authorization, "Key test-server-api-key");
});

test("complete sends the txid and the Server API Key", async () => {
  const { status, calls } = await pay("/payments/complete", { paymentId: "pay-1", txid: "tx-9" });
  assert.equal(status, 200);

  const completeCall = calls.find((c) => c.url.endsWith("/complete"));
  assert.equal(completeCall.url, "https://api.minepi.com/v2/payments/pay-1/complete");
  assert.equal(completeCall.init.headers.Authorization, "Key test-server-api-key");
  assert.deepEqual(JSON.parse(completeCall.init.body), { txid: "tx-9" });
});

test("the payment is read back from Pi before it is approved", async () => {
  const { calls } = await pay("/payments/approve", { paymentId: "pay-1" });
  const lookup = calls.find((c) => c.url === "https://api.minepi.com/v2/payments/pay-1");
  assert.ok(lookup, "expected a GET of the payment before approving");
});

test("a payment for the wrong amount is refused", async () => {
  const { status, body, calls } = await pay("/payments/approve", { paymentId: "pay-1" },
    { routes: piRoutes({ payment: { ...GOOD_PAYMENT, amount: 0.0001 } }) });
  assert.equal(status, 400);
  assert.match(body.error, /Unexpected amount/);
  assert.equal(calls.filter((c) => c.url.endsWith("/approve")).length, 0, "must not approve");
});

test("a payment belonging to another user is refused", async () => {
  const { status, body, calls } = await pay("/payments/approve", { paymentId: "pay-1" },
    { routes: piRoutes({ payment: { ...GOOD_PAYMENT, user_uid: "someone-else" } }) });
  assert.equal(status, 403);
  assert.match(body.error, /different user/);
  assert.equal(calls.filter((c) => c.url.endsWith("/approve")).length, 0);
});

test("a payment for a different product is refused", async () => {
  const { status, body } = await pay("/payments/approve", { paymentId: "pay-1" },
    { routes: piRoutes({ payment: { ...GOOD_PAYMENT, metadata: { product: "something-else" } } }) });
  assert.equal(status, 400);
  assert.match(body.error, /Unexpected product/);
});

test("a cancelled payment is refused", async () => {
  const { status, body } = await pay("/payments/approve", { paymentId: "pay-1" },
    { routes: piRoutes({ payment: { ...GOOD_PAYMENT, status: { cancelled: true } } }) });
  assert.equal(status, 409);
  assert.match(body.error, /cancelled/);
});

test("re-approving an approved payment is a success, not an error", async () => {
  const { status, body, calls } = await pay("/payments/approve", { paymentId: "pay-1" },
    { routes: piRoutes({ payment: { ...GOOD_PAYMENT, status: { developer_approved: true } } }) });
  assert.equal(status, 200);
  assert.equal(body.alreadyApproved, true);
  assert.equal(calls.filter((c) => c.url.endsWith("/approve")).length, 0, "no second approve");
});

test("re-completing a completed payment is a success, not an error", async () => {
  const { status, body } = await pay("/payments/complete", { paymentId: "pay-1", txid: "tx-9" },
    { routes: piRoutes({ payment: { ...GOOD_PAYMENT, status: { developer_completed: true } } }) });
  assert.equal(status, 200);
  assert.equal(body.alreadyCompleted, true);
});

test("a completion Pi rejects is not reported as a completed tip", async () => {
  const { status, body } = await pay("/payments/complete", { paymentId: "pay-1", txid: "tx-9" },
    { routes: piRoutes({ complete: new Response(JSON.stringify({ error_message: "bad txid" }), { status: 400 }) }) });
  assert.equal(status, 502);
  assert.match(body.error, /rejected the completion/);
  assert.match(body.error, /bad txid/);
});

test("payments require a session", async () => {
  const response = await worker.fetch(new Request("https://worker.test/payments/approve", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ paymentId: "pay-1" }),
  }), ENV);
  assert.equal(response.status, 401);
});

test("payments fail closed when the Server API Key is missing", async () => {
  const { status, body } = await pay("/payments/approve", { paymentId: "pay-1" },
    { env: { ...ENV, PI_NETWORK_API_KEY: undefined } });
  assert.equal(status, 500);
  assert.match(body.error, /PI_NETWORK_API_KEY/);
});

test("complete requires a txid", async () => {
  const { status } = await pay("/payments/complete", { paymentId: "pay-1" });
  assert.equal(status, 400);
});

test("health reports whether payments are configured", async () => {
  const configured = await (await call("/health")).json();
  assert.equal(configured.payments, true);
  assert.equal(configured.product, "developer-tip");
  assert.equal(configured.amount, "0.01");

  const without = await (await call("/health", {}, { ...ENV, PI_NETWORK_API_KEY: undefined })).json();
  assert.equal(without.payments, false);
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
