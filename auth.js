"use strict";

/* ==========================================================================
   Pi Network authentication.

   Flow:
     1. await Pi.init(...)                        — fully settled before step 2
     2. Pi.authenticate(["username"], onIncomplete)
     3. POST the access token to our backend, which validates it against
        GET https://api.minepi.com/v2/me before issuing a session

   The browser's word about who the user is cannot be trusted, so the access
   token is never treated as proof on its own. The session this module holds is
   the one the backend minted after checking that token with Pi.

   Runs on load, and again on demand from the sign-in button. The metronome
   itself never depends on any of this — it works signed out, and in browsers
   where window.Pi does not exist at all.

   Wrapped in an IIFE because these are classic scripts sharing one global
   scope: app.js already binds `el` at top level, and a second top-level `el`
   here is a SyntaxError that takes the whole file down with it.
   ========================================================================== */

(function () {

const CONFIG = window.APP_CONFIG;

/** Where the backend session is kept. Per-tab: closing it signs you out. */
const SESSION_KEY = "tap-tempo.session";

/**
 * How long to wait for the Pi SDK before giving up.
 *
 * Loading sdk.minepi.com defines window.Pi in *any* browser, so its presence
 * proves nothing about whether we are in the Pi Browser. Outside it there is no
 * host frame to answer, and authenticate() simply never settles — no error, no
 * rejection. Without this the button sits disabled on "Signing in…" forever,
 * which is what every visitor to the public URL would see.
 */
const AUTH_TIMEOUT_MS = 12000;

const el = {
  signInButton: document.getElementById("sign-in-button"),
  signInText: document.getElementById("sign-in-text"),
  account: document.getElementById("account"),
  accountName: document.getElementById("account-name"),
  snackbar: document.getElementById("snackbar"),
  snackbarText: document.getElementById("snackbar-text"),
};

/* --------------------------------------------------------------------------
   Snackbar
   -------------------------------------------------------------------------- */

let snackbarTimer = null;

function snackbar(message, duration = 4000) {
  el.snackbarText.textContent = message;
  el.snackbar.classList.add("is-open");
  clearTimeout(snackbarTimer);
  snackbarTimer = setTimeout(() => el.snackbar.classList.remove("is-open"), duration);
}

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

/** @type {"unavailable"|"signed-out"|"signing-in"|"signed-in"} */
let status = "signed-out";
let user = null;          // { uid, username }
let sessionToken = null;  // signed by our backend, not by Pi

/** The attempt currently running, so a click can join it instead of starting a second. */
let inFlight = null;

/**
 * Whether to *show* the busy state — deliberately not the same as being busy.
 *
 * The automatic attempt runs silently: it can take the full timeout to fail,
 * and a button greyed out on "Signing in…" for twelve seconds after every page
 * load reads as a broken control rather than a pending one. Only a sign-in the
 * user actually asked for reports progress.
 */
let showBusy = false;

const PI_AVAILABLE = typeof window.Pi !== "undefined";

function render() {
  const signedIn = status === "signed-in";

  el.account.hidden = !signedIn;
  if (signedIn && user) {
    el.accountName.textContent = user.username || user.uid;
  }

  // Shown whenever nobody is signed in — including when the SDK is missing.
  // Hiding it there left browsers that block sdk.minepi.com with no sign-in
  // control at all and no explanation; clicking now says why it cannot work.
  el.signInButton.hidden = signedIn;
  el.signInButton.disabled = showBusy;
  el.signInButton.classList.toggle("is-busy", showBusy);
  el.signInText.textContent = showBusy ? "Signing in…" : "Sign in with Pi";
}

/* --------------------------------------------------------------------------
   Stored session
   -------------------------------------------------------------------------- */

function storeSession(token, who) {
  sessionToken = token;
  user = who;
  status = "signed-in";
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, user: who }));
  } catch {
    // Private mode or blocked storage: the session still works for this page
    // view, it just will not survive a reload. Not worth failing sign-in over.
  }
  render();
}

function clearSession() {
  sessionToken = null;
  user = null;
  status = PI_AVAILABLE ? "signed-out" : "unavailable";
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch { /* see storeSession */ }
  render();
}

function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
   Backend
   -------------------------------------------------------------------------- */

async function callBackend(path, { method = "POST", body, token } = {}) {
  const response = await fetch(`${CONFIG.BACKEND_URL}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${path} failed (HTTP ${response.status})`);
  }
  return payload;
}

/**
 * Resume a session from a previous page view.
 *
 * The stored token is re-checked against the backend rather than trusted: it
 * is signed, but it also expires, and only the backend can say whether it
 * still holds.
 */
async function restoreSession() {
  const stored = readStoredSession();
  if (!stored?.token) return false;

  try {
    const result = await callBackend("/session", { method: "GET", token: stored.token });
    storeSession(stored.token, result.user);
    return true;
  } catch {
    clearSession();
    return false;
  }
}

/* --------------------------------------------------------------------------
   Pi SDK
   -------------------------------------------------------------------------- */

/**
 * Pi.init(), awaited to completion, exactly once.
 *
 * Promise.resolve() wraps it because init has been synchronous in some SDK
 * builds and Promise-returning in others. Wrapping makes `await` correct in
 * both: a returned promise is adopted and settled fully, while a plain
 * undefined still yields before authenticate() is allowed to run. Calling
 * authenticate() against a half-initialised SDK is the failure this guards
 * against, and caching the promise means concurrent callers share one init
 * rather than racing two.
 */
let initPromise = null;

function initialisePi() {
  if (!initPromise) {
    initPromise = Promise.resolve(
      window.Pi.init({ version: "2.0", sandbox: CONFIG.SANDBOX }),
    ).catch((error) => {
      // Do not cache a failure: the retry button would then replay this same
      // rejection forever without ever calling init() again.
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

/**
 * Required argument to authenticate(). This app takes no payments, so there is
 * nothing to settle — but the SDK calls it, and omitting the argument makes
 * authenticate() itself fail.
 */
function onIncompletePaymentFound(payment) {
  console.warn("Incomplete Pi payment found; this app has no payment flow.", payment);
}

/** Reject if `promise` has not settled in time. See AUTH_TIMEOUT_MS. */
function withTimeout(promise, ms, message) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { timedOut: true })), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/* --------------------------------------------------------------------------
   Sign in
   -------------------------------------------------------------------------- */

/**
 * @param {{ automatic?: boolean }} options
 *   automatic — triggered by page load rather than by the user. Failures are
 *   logged and reflected in the button, but not announced: an attempt the user
 *   never asked for should not open the app with an error.
 */
async function signIn({ automatic = false } = {}) {
  if (status === "signed-in") return;

  // A click landing on top of the silent automatic attempt joins it rather than
  // racing a second one — and promotes the UI to busy, since now somebody is
  // actually waiting on it.
  if (inFlight) {
    if (!automatic) { showBusy = true; render(); }
    return inFlight;
  }

  if (!PI_AVAILABLE) {
    status = "unavailable";
    render();
    if (!automatic) snackbar("Open this app in the Pi Browser to sign in.", 6000);
    return;
  }

  status = "signing-in";
  showBusy = !automatic;
  render();

  inFlight = (async () => {
    try {
      // Steps 1 and 2 share one deadline: outside the Pi Browser either can
      // hang indefinitely, and the user cannot tell which one stalled anyway.
      const auth = await withTimeout(
        (async () => {
          // Step 1 — initialise, and wait for it to finish completely.
          await initialisePi();
          // Step 2 — ask Pi for an access token.
          return window.Pi.authenticate(CONFIG.SCOPES, onIncompletePaymentFound);
        })(),
        AUTH_TIMEOUT_MS,
        "Pi did not respond. Open this app in the Pi Browser to sign in.",
      );

      if (!auth?.accessToken) throw new Error("Pi returned no access token.");

      // Step 3 — the backend validates that token against /v2/me and mints the
      // session. Until it answers, the user is not signed in.
      const result = await callBackend("/auth", { body: { accessToken: auth.accessToken } });

      storeSession(result.sessionToken, result.user);
      snackbar(`Signed in as ${result.user.username || result.user.uid}.`);
    } catch (error) {
      status = "signed-out";
      console.error("Pi sign-in failed", error);
      // Report only what the user asked for. showBusy is the test rather than
      // `automatic`, so an automatic attempt that a click has since joined
      // still explains itself.
      if (showBusy) snackbar(error?.message || "Sign-in failed. Please try again.", 6000);
    } finally {
      inFlight = null;
      showBusy = false;
      render();
    }
  })();

  return inFlight;
}

/* --------------------------------------------------------------------------
   Wiring
   -------------------------------------------------------------------------- */

el.signInButton.addEventListener("click", () => signIn({ automatic: false }));

// Automatic sign-in on load. Deliberately not awaited by anything: the
// metronome must be usable immediately, whether or not Pi is present.
const ready = (async function start() {
  status = PI_AVAILABLE ? "signed-out" : "unavailable";
  render();

  if (await restoreSession()) return;
  await signIn({ automatic: true });
})();

// Exposed for debugging, and for tests driving the page directly.
window.PiAuth = {
  signIn,
  signOut: clearSession,
  ready,
  get state() {
    return { status, user, hasSession: Boolean(sessionToken) };
  },
};

})();
