# Tap Tempo

A tap-tempo metronome. Tap the button in time with the music; the app reads
back the tempo in BPM.

Signing in with Pi Network is optional; the metronome works signed out.

| | |
|---|---|
| `index.html` | markup |
| `styles.css` | Material Design 3 tokens: colour, type scale, shape, elevation, motion, state layers |
| `app.js` | tap capture and BPM calculation |
| `config.js` | `BACKEND_URL`, scopes, sandbox detection |
| `auth.js` | Pi sign-in |
| `worker/` | Cloudflare Worker that validates Pi access tokens and issues sessions |

The front end is static and needs no build step. The Worker is separate because
GitHub Pages serves files only, and the access token has to be validated
somewhere the client cannot forge.

## Run it

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. The metronome needs nothing else; sign-in
additionally needs the Worker (below) and the Pi Browser.

```bash
cd worker && npm install && npm test
```

## How the BPM is measured

Timestamps come from `pointerdown` rather than `click`. Click fires on release,
so the user's own press duration lands in every interval as jitter.

Each tap is pushed onto a rolling window of the last **8** taps. The reading is
the mean interval across that window — first-to-last elapsed time divided by
the number of gaps, which is arithmetically the same as averaging every gap:

```
bpm = 60000 × (taps − 1) / (last − first)
```

The window keeps the number steady while still following a real drift in tempo.
Two guards keep a stray tap from poisoning it:

- **A pause over 2 seconds** clears the window. A gap that long means the user
  stopped, not that they are playing a very slow piece.
- **A reading outside 20–400 BPM** is discarded and that tap becomes the start
  of a fresh count, rather than being averaged in.

Below two taps there is no interval to measure, so the readout shows `--`.

## Interaction

- **Tap** the big button, or press **Space** anywhere on the page.
- **Space** / **Enter** also work when the button itself has keyboard focus.
- **Reset** clears the reading.

The button carries an M3 state layer, a ripple, and a pulse ring on each
captured beat; four dots below the readout cycle to mark the beat. Every
animation is suppressed under `prefers-reduced-motion`.

## Pi Network sign-in

Sign-in runs automatically on load, and again from the **Sign in with Pi**
button in the app bar. It requests the `username` scope only.

```
Browser                          Worker                    Pi
   │                                │                       │
   │ await Pi.init({version:"2.0"}) │                       │
   │ Pi.authenticate(["username"])  │                       │
   │◀──────── accessToken ──────────┼───────────────────────│
   │                                │                       │
   ├── POST /auth {accessToken} ───▶│                       │
   │                                ├─ GET /v2/me ─────────▶│
   │                                │  Authorization:       │
   │                                │  Bearer <accessToken> │
   │                                │◀──── {uid, username} ─│
   │◀─── {user, sessionToken} ──────│                       │
```

Three things about this are deliberate.

**`Pi.init()` is awaited to completion before `authenticate()` is called.** It
has been synchronous in some SDK builds and Promise-returning in others, so it
is wrapped in `Promise.resolve()`: a returned promise is adopted and settled
fully, and a plain `undefined` still yields. Calling `authenticate()` against a
half-initialised SDK is the failure this avoids.

**The access token is never trusted in the browser.** It is an opaque string,
and a tampered client can send anything. The Worker resolves it against Pi's
`/v2/me` and uses *that* uid — anything the client claims about its own
identity is ignored.

**No Pi Server API Key is involved.** `/v2/me` authenticates with the user's own
access token as a Bearer credential. This is the difference from a payments
backend, where `approve` and `complete` are authorised with `Key <API_KEY>` and
that key must never reach a browser. Here the only secret is `SESSION_SECRET`,
which is ours, not Pi's.

Sessions are stateless: `base64url(claims).base64url(HMAC-SHA256(claims))`,
signed with `SESSION_SECRET`. There is no KV binding to look a session up in,
which also means a session cannot be revoked before it expires — rotating
`SESSION_SECRET` invalidates all of them at once, and that is the only lever.

### Deploying the Worker

Wrangler needs Node ≥22; if your default is older, select a newer one first.

```bash
cd worker
npm install
npx wrangler secret put SESSION_SECRET    # any long random string
npx wrangler deploy
```

Check it came up, then point `BACKEND_URL` in `config.js` at the deployed URL:

```bash
curl https://metronome-asc-auth.<your-subdomain>.workers.dev/health
```

`{"ok":true,"configured":true}` means the signing secret is bound;
`"configured":false` means it is missing. `ALLOWED_ORIGINS` in
`worker/wrangler.toml` must list the origin the app is served from — an origin
has no path, so `https://yao-pi.github.io` covers the `/metronome-asc/` subpath.

### Environments

`SANDBOX` is derived from the hostname in `config.js`, never hardcoded. It has
to match how the app was actually reached, because sandbox mode hands the
request to a sandbox host frame:

| Reached via | `location.hostname` | `SANDBOX` |
|---|---|---|
| Pi Sandbox → your dev server | `localhost` | `true` |
| Pi Browser → the production URL | `yao-pi.github.io` | `false` |

### Outside the Pi Browser

Loading `sdk.minepi.com/pi-sdk.js` defines `window.Pi` in *any* browser, so its
presence proves nothing. Outside the Pi Browser there is no host frame to
answer and `authenticate()` never settles — no error, no rejection. Sign-in is
therefore raced against a 12-second timeout.

That timeout is why the automatic attempt is **silent**. Being busy and *showing*
busy are tracked separately: the automatic attempt leaves the button reading
"Sign in with Pi" and clickable, because a control greyed out on "Signing in…"
for twelve seconds after every page load reads as broken rather than pending.
Only a sign-in the user asked for reports progress. A click landing on top of a
silent attempt joins it rather than starting a second, and promotes the button
to the busy state, since by then somebody is waiting on it.

The button is shown whenever nobody is signed in — including when the SDK is
missing entirely, as it is in any browser blocking `sdk.minepi.com`. Hiding it
there left those users with no sign-in control and no explanation; clicking it
now says why it cannot work.

The metronome never waits on any of this.

## Design

Material Design 3 baseline, implemented directly in CSS custom properties —
`--md-sys-color-*`, `--md-sys-shape-*`, `--md-sys-elevation-*`,
`--md-sys-motion-*`. The default M3 purple scheme, in both light and dark, is
chosen by `prefers-color-scheme`. No Material component library is pulled in:
the surfaces here are a top app bar, a card, a filled tonal circle, and a text
button, all of which are a few rules each against the tokens.
