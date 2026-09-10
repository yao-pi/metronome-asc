# Tap Tempo

A tap-tempo metronome. Tap the button in time with the music; the app reads
back the tempo in BPM.

Three static files, no build step, no dependencies beyond the Google Fonts
stylesheet.

| | |
|---|---|
| `index.html` | markup |
| `styles.css` | Material Design 3 tokens: colour, type scale, shape, elevation, motion, state layers |
| `app.js` | tap capture and BPM calculation |

## Run it

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` from the filesystem
works too — nothing here needs a server.

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

## Design

Material Design 3 baseline, implemented directly in CSS custom properties —
`--md-sys-color-*`, `--md-sys-shape-*`, `--md-sys-elevation-*`,
`--md-sys-motion-*`. The default M3 purple scheme, in both light and dark, is
chosen by `prefers-color-scheme`. No Material component library is pulled in:
the surfaces here are a top app bar, a card, a filled tonal circle, and a text
button, all of which are a few rules each against the tokens.
