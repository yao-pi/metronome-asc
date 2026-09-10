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

  /** Scopes requested at sign-in. Username only: this app identifies, nothing more. */
  SCOPES: ["username"],

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
