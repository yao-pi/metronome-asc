"use strict";

/* ==========================================================================
   Pi Network payments — U2A, one product: a voluntary developer tip.

   Flow:
     1. await Pi.init(...)                    — via auth.js, shared, awaited once
     2. ensure a session (sign in if needed)  — payments need the payments scope
     3. Pi.createPayment({ amount, memo, metadata }, callbacks)
        ├─ onReadyForServerApproval(paymentId)      -> POST /payments/approve
        ├─ onReadyForServerCompletion(paymentId,tx) -> POST /payments/complete
        ├─ onCancel
        └─ onError

   Approve and complete are server-to-server calls authorised with the Pi
   Server API Key, which is why they cannot happen here. The browser only ever
   relays the paymentId and txid; the Worker re-reads the payment from Pi and
   decides for itself whether it is really this product, really this user, and
   really the right amount.
   ========================================================================== */

(function () {

const CONFIG = window.APP_CONFIG;
const PRODUCT = CONFIG.PRODUCT;

// auth.js owns the Pi handshake and the session; reuse both rather than
// running a second init or minting a second session.
const Auth = window.PiAuth;

const el = {
  tipButton: document.getElementById("tip-button"),
  tipLabel: document.getElementById("tip-label"),
  tipStatus: document.getElementById("tip-status"),
};

let busy = false;

function setBusy(value) {
  busy = value;
  el.tipButton.disabled = value;
  el.tipButton.classList.toggle("is-busy", value);
  el.tipLabel.textContent = value ? "Working…" : PRODUCT.label;
}

function setStatus(message, kind = "") {
  el.tipStatus.textContent = message;
  el.tipStatus.className = `tip__status${kind ? ` is-${kind}` : ""}`;
}

/* --------------------------------------------------------------------------
   Backend
   -------------------------------------------------------------------------- */

/**
 * Every payment call is authenticated with our own session token, not with the
 * Pi access token. The Worker minted that session only after Pi vouched for the
 * user, so it already proves the uid — and it means the access token never has
 * to be kept around in the browser after sign-in.
 */
async function postPayment(path, body) {
  const token = await Auth.requireSession();
  return Auth.callBackend(path, { body, token });
}

/* --------------------------------------------------------------------------
   Incomplete payments
   -------------------------------------------------------------------------- */

/**
 * Settle a payment that reached the blockchain but was never completed by us.
 *
 * Pi blocks any new payment until this is cleared, so failing quietly here
 * would leave tipping permanently broken with no visible cause. Called from
 * auth.js's onIncompletePaymentFound, which fires *during* authenticate() —
 * requireSession() therefore waits for the sign-in happening around it rather
 * than starting another.
 */
async function completeIncomplete(payment) {
  const paymentId = payment?.identifier;
  const txid = payment?.transaction?.txid;

  if (!paymentId || !txid) {
    // No txid means it never reached the chain, so there is nothing to
    // complete; Pi will not hold a new payment against it either.
    console.warn("Incomplete payment has no txid; nothing to complete.", payment);
    return;
  }

  try {
    await postPayment("/payments/complete", { paymentId, txid });
    Auth.snackbar("Finished a previous tip that was left pending.");
  } catch (error) {
    console.error("Could not complete the pending payment", error);
    setStatus("A previous tip is still pending. Try again in a moment.", "error");
    Auth.snackbar("A previous tip could not be finished.", 6000);
  }
}

/* --------------------------------------------------------------------------
   Buying
   -------------------------------------------------------------------------- */

function createPayment() {
  return new Promise((resolve, reject) => {
    /*
     * The SDK may keep invoking callbacks after the payment has already failed
     * — completion can follow a rejected approval. Settling once is not enough
     * on its own, because a late callback still runs its side effects: an
     * approval error would be overwritten by "Confirming on the blockchain…"
     * and the status line would sit there claiming progress that never happens.
     * So late callbacks are made inert, not merely ignored.
     */
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const succeed = settle(resolve);
    const fail = settle(reject);

    window.Pi.createPayment(
      {
        amount: PRODUCT.amount,
        memo: PRODUCT.memo,
        // Mirrored by the Worker, which rejects a payment whose metadata does
        // not name this product — it is what distinguishes a tip from any
        // other payment the app might create later.
        metadata: { product: PRODUCT.id, app: "tap-tempo" },
      },
      {
        onReadyForServerApproval: async (paymentId) => {
          if (settled) return;
          setStatus("Approving…");
          try {
            await postPayment("/payments/approve", { paymentId });
          } catch (error) {
            fail(error);
          }
        },

        onReadyForServerCompletion: async (paymentId, txid) => {
          if (settled) return;
          setStatus("Confirming on the blockchain…");
          try {
            await postPayment("/payments/complete", { paymentId, txid });
            succeed({ paymentId, txid });
          } catch (error) {
            fail(error);
          }
        },

        onCancel: () => fail(Object.assign(new Error("Tip cancelled."), { cancelled: true })),

        onError: (error) => fail(error instanceof Error ? error : new Error(String(error))),
      },
    );
  });
}

async function tip() {
  if (busy) return;

  if (typeof window.Pi === "undefined") {
    setStatus("Open this app in the Pi Browser to tip.", "error");
    Auth.snackbar("Tipping needs the Pi Browser.", 6000);
    return;
  }

  setBusy(true);
  setStatus("Opening Pi Wallet…");

  try {
    // init is awaited to completion before any createPayment call, exactly as
    // it is before authenticate. Shared promise, so this is a no-op once done.
    await Auth.initialisePi();

    // requirePiAuth, not requireSession: createPayment needs the *SDK* to be
    // authenticated with the payments scope in this page load. Merely holding
    // one of our session tokens is not that, and a session restored from
    // storage never authenticated the SDK at all.
    await Auth.requirePiAuth();

    await createPayment();

    setStatus(`Thank you! ${PRODUCT.amount} π received.`, "success");
    Auth.snackbar("Tip sent — thank you!");
  } catch (error) {
    if (error?.cancelled) {
      setStatus("");
      Auth.snackbar("Tip cancelled.");
    } else {
      console.error("Tip failed", error);
      setStatus(error?.message || "Tip failed. Please try again.", "error");
      Auth.snackbar("Tip failed.", 6000);
    }
  } finally {
    setBusy(false);
  }
}

/* --------------------------------------------------------------------------
   Wiring
   -------------------------------------------------------------------------- */

el.tipLabel.textContent = PRODUCT.label;
el.tipButton.addEventListener("click", tip);

window.PiPayments = { tip, completeIncomplete, product: PRODUCT };

})();
