/**
 * Easing.ts — Centralized animation curve library.
 *
 * Every function maps [0,1] → [0,1] unless noted. All pure, no state.
 * Organized by feel, not math family. Import what you need:
 *
 *   import { spring, expEase, hunt } from './Easing';
 *
 * Each function has a matching GLSL version in Shaders/easing-lib.js
 * for Code Node usage.
 */

// =====================================================================
// SMOOTH — deceleration curves, things coming to rest
// =====================================================================

/** Hermite smoothstep. The default "soft" curve. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Quintic smoothstep — smoother acceleration/deceleration than Hermite.
 *  Zero 1st AND 2nd derivative at endpoints. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Quadratic ease out. Gentle deceleration. */
export function outQuad(t: number): number {
  return t * (2 - t);
}

/** Cubic ease out. Medium deceleration. */
export function outCubic(t: number): number {
  var u = 1 - t;
  return 1 - u * u * u;
}

/** Quartic ease out. Strong deceleration — lingers at end. */
export function outQuart(t: number): number {
  var u = 1 - t;
  return 1 - u * u * u * u;
}

/** Sine ease in-out. Gentle S-curve, good for rotation/turntable. */
export function inOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) * 0.5;
}

/** Cubic ease in-out. Sharper S than sine. */
export function inOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) * 0.5;
}

// =====================================================================
// SNAPPY — exponential family, tunable sharpness
// =====================================================================

/** Exponential ease out. k controls snap: 3=gentle, 6=snappy, 10=very snappy.
 *  This is the CuboidMaterialize pattern: (1-exp(-tk))/(1-exp(-k)). */
export function expEase(t: number, k: number): number {
  if (k < 0.01) return t; // degenerate → linear
  return (1 - Math.exp(-t * k)) / (1 - Math.exp(-k));
}

/** Classic exponential out: 1 - 2^(-10t). Fixed sharpness. */
export function outExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/** Quadratic ease in. Slow start, accelerating. */
export function inQuad(t: number): number {
  return t * t;
}

/** Cubic ease in. Slow start, strong acceleration. */
export function inCubic(t: number): number {
  return t * t * t;
}

// =====================================================================
// BOUNCY — overshoot, elastic, spring
// =====================================================================

/** Back ease out — slight overshoot then settle.
 *  overshoot=1.70158 (default) gives ~10% overshoot. */
export function outBack(t: number, overshoot?: number): number {
  var c = overshoot !== undefined ? overshoot : 1.70158;
  var u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/** Elastic ease out — springy bounce past target.
 *  amplitude controls peak overshoot, period controls oscillation speed. */
export function outElastic(t: number, amplitude?: number, period?: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  var a = amplitude !== undefined ? amplitude : 1;
  var p = period !== undefined ? period : 0.3;
  var s = p / (2 * Math.PI) * Math.asin(1 / a);
  return a * Math.pow(2, -10 * t) * Math.sin((t - s) * (2 * Math.PI) / p) + 1;
}

/** Critically damped spring. The gold standard for natural motion.
 *  response = speed of approach (higher = faster).
 *  damping = how quickly oscillation dies (1 = critical, <1 = underdamped/bouncy). */
export function spring(t: number, response: number, damping: number): number {
  if (damping >= 1) {
    // Critically damped or overdamped — no oscillation
    return 1 - Math.exp(-t * response) * (1 + t * response * (1 - damping));
  }
  // Underdamped — oscillates then settles
  var omega = response * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-t * response * damping) * Math.cos(omega * t);
}

// =====================================================================
// TWITCHY — jitter, hunt, mechanical vibration
// =====================================================================

/** Dual-sine hunt oscillation. Returns ±amplitude centered on 0.
 *  Two incommensurate frequencies create organic-feeling vibration.
 *  freq1/freq2 in Hz-like units, seed offsets phase per-instance. */
export function hunt(t: number, freq1: number, freq2: number, amp1: number, amp2: number, seed: number): number {
  return Math.sin(t * freq1 + seed * 2.3) * amp1
       + Math.sin(t * freq2 + seed * 5.1) * amp2;
}

/** Snap settle — high-frequency damped oscillation for lock-in moments.
 *  Returns ±amplitude decaying to 0. */
export function snap(t: number, amplitude: number): number {
  if (t >= 1) return 0;
  return Math.sin(t * Math.PI * 2) * amplitude * (1 - t);
}

/** Deterministic 1D noise from time. Cheap, no state. Returns [0,1].
 *  Use for subtle per-frame variation ("alive idle"). */
export function noise1D(t: number): number {
  var x = Math.sin(t * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Integer hash → [0,1]. Deterministic pseudo-random from integer seed.
 *  Use for per-cell or per-instance variation. */
export function hashSeg(n: number): number {
  n = Math.floor(n);
  n = ((n >> 16) ^ n) * 0x45d9f3b | 0;
  n = ((n >> 16) ^ n) * 0x45d9f3b | 0;
  n = (n >> 16) ^ n;
  return (n & 0x7fffffff) / 0x7fffffff;
}

// =====================================================================
// IMPULSE — sharp onset, natural decay (IQ-style)
// =====================================================================

/** Exponential impulse: sharp rise, smooth fall. k controls sharpness.
 *  Peaks at t=1/k. Great for impacts, flashes, activation bursts. */
export function impulse(t: number, k: number): number {
  var h = k * t;
  return h * Math.exp(1 - h);
}

/** Cubic pulse — fast on, fast off, flat top centered at c with width w.
 *  Returns 0 outside [c-w, c+w]. */
export function cubicPulse(t: number, c: number, w: number): number {
  var x = Math.abs(t - c);
  if (x > w) return 0;
  x = x / w;
  return 1 - x * x * (3 - 2 * x);
}

/** Power curve — asymmetric bell shape. a controls rise, b controls fall.
 *  Normalized to peak at 1. Use for skewed envelopes. */
export function pcurve(t: number, a: number, b: number): number {
  var k = Math.pow(a + b, a + b) / (Math.pow(a, a) * Math.pow(b, b));
  return k * Math.pow(t, a) * Math.pow(1 - t, b);
}

/** Gain — S-curve with adjustable steepness. k<0.5 = flat, k>0.5 = steep.
 *  k=0.5 is identity. Good for making things punchier. */
export function gain(t: number, k: number): number {
  if (t < 0.5) {
    return 0.5 * Math.pow(2 * t, 2 * Math.log(1 - k) / Math.log(0.5));
  }
  return 1 - 0.5 * Math.pow(2 - 2 * t, 2 * Math.log(1 - k) / Math.log(0.5));
}

/** Parabolic bell: pow(4t(1-t), k). k=1 is parabola, k>1 narrows. */
export function parabola(t: number, k: number): number {
  return Math.pow(4 * t * (1 - t), k);
}

// =====================================================================
// ENVELOPES — composite shapes for phase transitions
// =====================================================================

/** Rise-fade: 0→1→0 using smoothstep. Standard phase appearance. */
export function riseFade(t: number, start: number, end: number, fadeStart: number, fadeEnd: number): number {
  return smoothstep(start, end, t) * (1 - smoothstep(fadeStart, fadeEnd, t));
}

/** Bell envelope: decoupled rise and fall speeds. */
export function bell(t: number, start: number, peak: number, fallStart: number, end: number): number {
  return smoothstep(start, peak, t) * (1 - smoothstep(fallStart, end, t));
}

/** Activation pulse: hot flash 1→0 in `width` seconds. */
export function pulse(t: number, width?: number): number {
  var w = width !== undefined ? width : 0.2;
  return Math.max(0, 1 - t / w);
}

/** Trapezoid: flat top between riseEnd and fallStart. Good for sustained effects. */
export function trapezoid(t: number, riseStart: number, riseEnd: number, fallStart: number, fallEnd: number): number {
  return smoothstep(riseStart, riseEnd, t) * (1 - smoothstep(fallStart, fallEnd, t));
}
