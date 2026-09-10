"use strict";

/* ==========================================================================
   Tap Tempo — tap a button in time, read the BPM.
   ========================================================================== */

const el = {
  bpmValue: document.getElementById("bpm-value"),
  marking: document.getElementById("tempo-marking"),
  beatDots: Array.from(document.querySelectorAll(".beat-dot")),
  tapButton: document.getElementById("tap-button"),
  resetButton: document.getElementById("reset-button"),
};

/**
 * Taps further apart than this start a new measurement rather than dragging
 * the average down — it means the user stopped and is timing something else.
 */
const RESET_AFTER_MS = 2000;

/** Rolling window. Long enough to be stable, short enough to follow a drift. */
const WINDOW_SIZE = 8;

const MIN_BPM = 20;
const MAX_BPM = 400;

/** @type {number[]} timestamps, most recent last */
let taps = [];
let beatIndex = 0;
let currentBpm = null;

/** Italian tempo markings, by BPM ceiling. */
const TEMPO_MARKINGS = [
  [24, "Larghissimo"],
  [40, "Grave"],
  [60, "Largo"],
  [66, "Larghetto"],
  [76, "Adagio"],
  [108, "Andante"],
  [120, "Moderato"],
  [156, "Allegro"],
  [176, "Vivace"],
  [200, "Presto"],
  [Infinity, "Prestissimo"],
];

function markingFor(bpm) {
  return TEMPO_MARKINGS.find(([ceiling]) => bpm < ceiling)[1];
}

/** Show the "no reading yet" state without discarding the taps collected. */
function showPending() {
  currentBpm = null;
  el.bpmValue.textContent = "--";
  el.marking.textContent = "Keep tapping…";
}

function registerTap() {
  const now = performance.now();

  if (taps.length && now - taps[taps.length - 1] > RESET_AFTER_MS) {
    taps = [];
  }

  taps.push(now);
  if (taps.length > WINDOW_SIZE) taps.shift();

  pulse();

  // A single tap establishes only a starting point, not yet an interval.
  if (taps.length < 2) {
    showPending();
    return;
  }

  // Mean interval across the window. Using first-to-last over the number of
  // gaps is equivalent to averaging every gap, and needs no intermediate array.
  const spanMs = taps[taps.length - 1] - taps[0];
  const bpm = (60000 * (taps.length - 1)) / spanMs;

  if (bpm < MIN_BPM || bpm > MAX_BPM) {
    // Out-of-range reading: treat this tap as the start of a fresh count.
    taps = [now];
    showPending();
    return;
  }

  currentBpm = Math.round(bpm);
  el.bpmValue.textContent = String(currentBpm);
  el.marking.textContent = `${markingFor(currentBpm)} · ${taps.length} taps`;
}

function pulse() {
  el.beatDots.forEach((dot, i) => dot.classList.toggle("is-active", i === beatIndex));
  beatIndex = (beatIndex + 1) % el.beatDots.length;

  el.tapButton.classList.remove("is-pulsing");
  void el.tapButton.offsetWidth; // restart the CSS animation
  el.tapButton.classList.add("is-pulsing");
}

function resetTempo() {
  taps = [];
  beatIndex = 0;
  currentBpm = null;
  el.bpmValue.textContent = "--";
  el.marking.textContent = "Tap the button to begin";
  el.beatDots.forEach((dot) => dot.classList.remove("is-active"));
}

/* --- Ripple ---------------------------------------------------------------- */

function ripple(event, target) {
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2;
  const x = (event.clientX ?? rect.left + rect.width / 2) - rect.left;
  const y = (event.clientY ?? rect.top + rect.height / 2) - rect.top;

  const span = document.createElement("span");
  span.className = "ripple";
  span.style.width = span.style.height = `${size}px`;
  span.style.left = `${x - size / 2}px`;
  span.style.top = `${y - size / 2}px`;
  target.appendChild(span);
  span.addEventListener("animationend", () => span.remove());
}

/* --- Input ----------------------------------------------------------------- */

/**
 * Tap timing is taken from pointerdown, not click: click fires on release,
 * which adds the user's own press duration as jitter to every interval.
 */
el.tapButton.addEventListener("pointerdown", (event) => {
  ripple(event, el.tapButton);
  registerTap();
});

// pointerdown does not fire for keyboard activation, so handle keys separately
// and suppress the synthetic click they would otherwise produce.
el.tapButton.addEventListener("keydown", (event) => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  if (event.repeat) return;
  ripple(event, el.tapButton);
  registerTap();
});

el.tapButton.addEventListener("click", (event) => event.preventDefault());

el.resetButton.addEventListener("click", (event) => {
  ripple(event, el.resetButton);
  resetTempo();
});

// Space anywhere on the page is a natural tap key; don't steal it from buttons.
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  if (event.target.closest("button")) return;
  event.preventDefault();
  registerTap();
});
