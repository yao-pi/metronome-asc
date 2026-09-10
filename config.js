/**
 * Runtime configuration.
 *
 * BACKEND_URL must point at the deployed Worker in ../worker. Sign-in cannot
 * complete without it: the access token returned by Pi is only meaningful once
 * a server has validated it against Pi's /v2/me, and GitHub Pages serves static
 * files only, so that check cannot happen here.
 *
 * Note this flow needs no Pi Server API Key anywhere — /v2/me authenticates
 * with the *user's own* access token. Nothing secret is involved, which is why
 * this backend is far smaller than a payments backend would be.
 */
window.APP_CONFIG = {
  // No trailing slash — paths are appended directly, so one would give "//auth".
  BACKEND_URL: "https://metronome-asc-auth.yao-pi.workers.dev",

  /**
   * Scopes requested at sign-in.
   *
   * `payments` is required before createPayment() will work at all — the SDK
   * rejects a payment from a session that never asked for it, so it has to be
   * granted at authenticate() time rather than at the moment of purchase.
   */
  SCOPES: ["username", "payments"],

  /**
   * The one thing this app sells: a voluntary tip, U2A.
   *
   * Every field here is also enforced by the Worker. The amount in particular
   * is checked against the payment Pi reports, not against anything the client
   * sends — a tampered client could otherwise create a 0.0001 π payment and
   * have it approved as a tip.
   */
  PRODUCT: {
    id: "developer-tip",
    label: "Tip 0.01 π",
    amount: 0.01,
    memo: "Tip for Tap Tempo",
  },

  /**
   * The sandbox flag must match how the app was actually reached, or the SDK
   * has nothing to talk to:
   *
   *   Pi Sandbox → frames http://localhost:8000                  → sandbox: true
   *   Pi Browser → https://yao-pi.github.io/metronome-asc/        → sandbox: false
   *
   * Derived rather than hardcoded: forcing it true breaks the Pi Browser, since
   * sandbox mode expects a sandbox host frame that a production URL does not have.
   */
  get SANDBOX() {
    const h = location.hostname;
    return h === "localhost"
      || h === "127.0.0.1"
      || h === "sandbox.minepi.com"
      || h.endsWith(".sandbox.minepi.com");
  },
};
