// Soundtrack for the promo film: an original score and sound design, synthesised
// from scratch (no samples, no licensing questions) and muxed onto the video.
//
//  - Music: a D-major pentatonic (ngũ cung) piece for đàn tranh (plucked zither,
//    Karplus-Strong), sáo trúc (bamboo flute), pads, bass and drums. At 114.3 BPM
//    with a 0.4 s pickup, every shot cut lands on a bar line (one shot = two bars).
//  - Engines: each of the four aircraft gets its own voice (paper-jet turbine,
//    seaplane propeller, Ahamove helicopter rotor) whose loudness, stereo position
//    and Doppler shift follow the real distance to the camera, frame by frame,
//    computed from the same flight paths and cameras tools/film.js used.
//  - Ambience and effects: surf at Mỹ Khê, a pagoda bell at Linh Ứng, mountain
//    wind at Bà Nà, birds at Ngũ Hành Sơn, the evening city at the Dragon Bridge,
//    water at Hội An, paper whooshes on every cut, and the boss fight's guns,
//    missile-lock tones and explosions on the frames where they happen.
//
// Usage: node tools/soundtrack.js --video promo.mp4 --out promo-sound.mp4 [--wav track.wav]

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SHOTS, SLOTS, FPS, poseOf, slotPose } from './film.js';

const SR = 48000;

/* ------------------------------------------------------------------ timeline */

// Shot start times in the edited film (warm-up frames are not recorded).
const TIMELINE = [];
{
	let f = 0;
	for (const S of SHOTS) { const n = Math.round(S.dur * FPS); TIMELINE.push({ S, start: f / FPS, frames: n }); f += n; }
}
const LENGTH = TIMELINE.reduce((s, x) => s + x.frames, 0) / FPS;
const at = (name) => TIMELINE.find((x) => x.S.name === name).start;
const BEAT = 60 / (8 / 4.2 * 60) , PICKUP = 0.4; // 8 beats per 4.2 s shot → 114.29 BPM
const beat = (n) => PICKUP + n * BEAT;
const BOSS = at('boss'); // boss shot: beats from tools/film.js (pods at +1.0/+1.7/+2.3, kill at +2.95)

/* ------------------------------------------------------------------ DSP kit */

let seed = 20261018;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const noise = () => rnd() * 2 - 1;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class Bus {
	constructor(n) { this.L = new Float32Array(n); this.R = new Float32Array(n); }
	add(i, v, pan = 0) {
		if (i < 0 || i >= this.L.length) return;
		const a = (clamp(pan, -1, 1) + 1) * Math.PI / 4;
		this.L[i] += v * Math.cos(a);
		this.R[i] += v * Math.sin(a);
	}
}

// RBJ biquad
class Biquad {
	constructor() { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set('lp', 1000, 0.7); }
	set(type, f, q) {
		const w = 2 * Math.PI * clamp(f, 10, SR * 0.45) / SR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
		let b0, b1, b2;
		if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
		else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
		else { b0 = al; b1 = 0; b2 = -al; } // band-pass, 0 dB peak
		const a0 = 1 + al;
		this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * cs / a0; this.a2 = (1 - al) / a0;
		return this;
	}
	run(x) {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
		return y;
	}
}

// Small Schroeder/Freeverb-style room for the music and the bells.
function reverb(bus, wet = 0.22, size = 0.84) {
	const combs = [1557, 1617, 1491, 1422, 1277, 1356], aps = [556, 441];
	for (const [ch, spread] of [[bus.L, 0], [bus.R, 23]]) {
		const n = ch.length, out = new Float32Array(n);
		for (const len0 of combs) {
			const len = len0 + spread, buf = new Float32Array(len);
			let idx = 0, lp = 0;
			for (let i = 0; i < n; i++) {
				const y = buf[idx];
				lp = y * 0.75 + lp * 0.25;
				buf[idx] = ch[i] * 0.015 + lp * size;
				out[i] += y;
				if (++idx >= len) idx = 0;
			}
		}
		for (const len0 of aps) {
			const len = len0 + spread, buf = new Float32Array(len);
			let idx = 0;
			for (let i = 0; i < n; i++) {
				const b = buf[idx], y = -out[i] + b;
				buf[idx] = out[i] + b * 0.5;
				out[i] = y;
				if (++idx >= len) idx = 0;
			}
		}
		for (let i = 0; i < n; i++) ch[i] += out[i] * wet;
	}
}

/* ------------------------------------------------------------------ instruments */

// đàn tranh: Karplus-Strong string, bright and long
function tranh(bus, t0, midi, dur, gain, pan = 0) {
	const f = mtof(midi), N = Math.max(2, Math.round(SR / f)), buf = new Float32Array(N);
	let prev = 0;
	for (let i = 0; i < N; i++) { const x = noise(); buf[i] = x * 0.7 + prev * 0.3; prev = buf[i]; }
	const i0 = Math.round(t0 * SR), len = Math.round((dur + 1.4) * SR);
	let idx = 0;
	const damp = 0.996 - 0.0006 * (midi - 60) / 12;
	for (let k = 0; k < len; k++) {
		const nxt = (idx + 1) % N, y = buf[idx];
		buf[idx] = (y + buf[nxt]) * 0.5 * damp;
		idx = nxt;
		const rel = k > dur * SR ? Math.exp(-(k - dur * SR) / (0.25 * SR)) : 1;
		bus.add(i0 + k, y * gain * rel, pan);
	}
}

// sáo trúc: breathy sine with growing vibrato
function sao(bus, t0, midi, dur, gain, pan = 0) {
	const f = mtof(midi), i0 = Math.round(t0 * SR), len = Math.round((dur + 0.25) * SR);
	const bp = new Biquad().set('bp', f * 2, 2.5);
	let ph = 0;
	for (let k = 0; k < len; k++) {
		const t = k / SR, vib = 1 + 0.006 * Math.min(1, Math.max(0, (t - 0.18) / 0.4)) * Math.sin(2 * Math.PI * 5.4 * t);
		ph += 2 * Math.PI * f * vib / SR;
		const env = Math.min(1, t / 0.07) * (t > dur ? Math.exp(-(t - dur) / 0.08) : 1) * (1 - 0.15 * Math.min(1, t / dur));
		const tone = Math.sin(ph) + 0.22 * Math.sin(2 * ph) + 0.07 * Math.sin(3 * ph);
		bus.add(i0 + k, (tone * 0.85 + bp.run(noise()) * 0.5) * env * gain, pan);
	}
}

// warm pad: detuned saws through a low-pass
function pad(bus, t0, midis, dur, gain) {
	const i0 = Math.round(t0 * SR), len = Math.round((dur + 1.2) * SR);
	midis.forEach((m, j) => {
		const pan = (j / Math.max(1, midis.length - 1)) * 1.2 - 0.6;
		for (const det of [-0.004, 0.004]) {
			const f = mtof(m) * (1 + det), lp = new Biquad().set('lp', 1100, 0.6);
			let ph = rnd();
			for (let k = 0; k < len; k++) {
				const t = k / SR;
				ph += f / SR; if (ph >= 1) ph -= 1;
				const env = Math.min(1, t / 0.7) * (t > dur ? Math.exp(-(t - dur) / 0.45) : 1);
				bus.add(i0 + k, lp.run(ph * 2 - 1) * env * gain, pan);
			}
		}
	});
}

function bass(bus, t0, midi, dur, gain) {
	const f = mtof(midi), i0 = Math.round(t0 * SR), len = Math.round((dur + 0.1) * SR);
	let ph = 0;
	for (let k = 0; k < len; k++) {
		const t = k / SR;
		ph += 2 * Math.PI * f / SR;
		const env = Math.min(1, t / 0.008) * Math.exp(-t / (dur * 0.9 + 0.05)) * (t > dur ? Math.exp(-(t - dur) / 0.03) : 1);
		bus.add(i0 + k, Math.tanh((Math.sin(ph) + 0.35 * Math.sin(2 * ph)) * 1.4) * env * gain, 0);
	}
}

function kick(bus, t0, gain) {
	const i0 = Math.round(t0 * SR);
	let ph = 0;
	for (let k = 0; k < 0.45 * SR; k++) {
		const t = k / SR, f = 48 + 110 * Math.exp(-t / 0.035);
		ph += 2 * Math.PI * f / SR;
		bus.add(i0 + k, Math.sin(ph) * Math.exp(-t / 0.16) * gain, 0);
	}
}
function tom(bus, t0, f0, gain, pan = 0) {
	const i0 = Math.round(t0 * SR);
	let ph = 0;
	for (let k = 0; k < 0.6 * SR; k++) {
		const t = k / SR, f = f0 * (1 + 0.5 * Math.exp(-t / 0.05));
		ph += 2 * Math.PI * f / SR;
		bus.add(i0 + k, (Math.sin(ph) + noise() * 0.15 * Math.exp(-t / 0.02)) * Math.exp(-t / 0.22) * gain, pan);
	}
}
function snare(bus, t0, gain, pan = 0) {
	const i0 = Math.round(t0 * SR), hp = new Biquad().set('hp', 1200, 0.7);
	let ph = 0;
	for (let k = 0; k < 0.3 * SR; k++) {
		const t = k / SR;
		ph += 2 * Math.PI * 190 / SR;
		bus.add(i0 + k, (hp.run(noise()) * Math.exp(-t / 0.07) + Math.sin(ph) * 0.5 * Math.exp(-t / 0.04)) * gain, pan);
	}
}
function shaker(bus, t0, gain, pan) {
	const i0 = Math.round(t0 * SR), bp = new Biquad().set('bp', 7500, 1.2);
	for (let k = 0; k < 0.07 * SR; k++) { const t = k / SR; bus.add(i0 + k, bp.run(noise()) * Math.min(1, t / 0.008) * Math.exp(-t / 0.025) * gain, pan); }
}
function cymbal(bus, t0, gain, dur = 2.4) {
	const i0 = Math.round(t0 * SR), hp = new Biquad().set('hp', 4200, 0.6);
	for (let k = 0; k < dur * SR; k++) { const t = k / SR; const v = hp.run(noise()) * Math.exp(-t / (dur * 0.35)) * gain; bus.add(i0 + k, v, k % 2 ? 0.3 : -0.3); }
}
// FM bell: pagoda bell (low, ratio 1.4) or chime (high, ratio 3.5)
function bell(bus, t0, f, dur, gain, ratio = 1.4, index = 3, pan = 0) {
	const i0 = Math.round(t0 * SR);
	let pc = 0, pm = 0;
	for (let k = 0; k < dur * SR; k++) {
		const t = k / SR;
		pm += 2 * Math.PI * f * ratio / SR;
		pc += 2 * Math.PI * f / SR + index * Math.exp(-t / (dur * 0.25)) * Math.sin(pm) * 2 * Math.PI * f * ratio / SR * 0.15;
		bus.add(i0 + k, Math.sin(pc) * Math.min(1, t / 0.004) * Math.exp(-t / (dur * 0.33)) * gain, pan);
	}
}
// rising noise sweep
function riser(bus, t0, dur, gain) {
	const i0 = Math.round(t0 * SR), bp = new Biquad();
	for (let k = 0; k < dur * SR; k++) {
		const u = k / (dur * SR);
		if (k % 64 === 0) bp.set('bp', 300 + 5000 * u * u, 1.6);
		bus.add(i0 + k, bp.run(noise()) * u * u * gain, Math.sin(u * 9) * 0.4);
	}
}

/* ------------------------------------------------------------------ the score */

// D pentatonic (ngũ cung): D E F# A B
const N = { D3: 50, A3: 57, B3: 59, D4: 62, E4: 64, Fs4: 66, A4: 69, B4: 71, D5: 74, E5: 76, Fs5: 78, A5: 81, B5: 83, D6: 86 };
const CH = { D: [50, 57, 62, 66], Bm: [47, 54, 59, 62], G: [43, 50, 55, 59], A: [45, 52, 57, 61] };
const ROOT = { D: 38, Bm: 35, G: 31, A: 33 };
// one chord per bar, 14 bars (two per shot)
const BARS = ['D', 'D', 'D', 'Bm', 'G', 'A', 'Bm', 'A', 'G', 'A', 'Bm', 'G', 'D', 'A'];
const ARP = { D: [N.D4, N.A4, N.D5, N.E5, N.Fs5, N.E5, N.D5, N.A4], Bm: [N.B3, N.Fs4, N.B4, N.D5, N.Fs5, N.D5, N.B4, N.Fs4], G: [N.D4, N.B4, N.D5, N.E5, N.B4, N.D5, N.E5, N.D5], A: [N.E4, N.A4, N.B4, N.E5, N.A4, N.E5, N.B4, N.A4] };
// sáo melody: [beat, length, note], beats counted from the first bar line
const FLUTE = [
	[8, 1, N.A4], [9, 0.5, N.B4], [9.5, 0.5, N.A4], [10, 1, N.Fs4], [11, 1, N.E4],
	[12, 1.5, N.D4], [13.5, 0.5, N.E4], [14, 2, N.Fs4],
	[16, 1, N.B4], [17, 1, N.D5], [18, 0.5, N.B4], [18.5, 0.5, N.A4], [19, 1, N.Fs4],
	[20, 3, N.A4],
	[24, 1, N.D5], [25, 0.5, N.E5], [25.5, 0.5, N.D5], [26, 1, N.B4], [27, 1, N.A4],
	[28, 1, N.Fs4], [29, 1, N.A4], [30, 2, N.B4],
	[32, 1, N.Fs5], [33, 0.5, N.E5], [33.5, 0.5, N.D5], [34, 2, N.E5],
	[36, 1.5, N.D5], [37.5, 0.5, N.B4], [38, 2, N.A4],
	[48, 0.5, N.A4], [48.5, 0.5, N.B4], [49, 1, N.D5], [50, 1, N.E5], [51, 1, N.Fs5],
	[52, 1.5, N.A5],
];
// đàn tranh lead over Hội An (with tremolo on long notes)
const TRANH = [[40, 1, N.Fs5], [41, 1, N.E5], [42, 1, N.D5], [43, 1, N.B4], [44, 1, N.A4], [45, 1, N.B4], [46, 2, N.D5]];

function score() {
	const n = Math.ceil(LENGTH * SR) + SR;
	const mus = new Bus(n), dry = new Bus(n);
	const FINAL = BOSS + 3.0; // the end card fades in here: last chord
	// pickup: a quick đàn tranh glissando into the first bar line
	[N.D4, N.E4, N.Fs4, N.A4, N.B4, N.D5].forEach((m, i) => tranh(mus, 0.04 + i * 0.055, m, 0.6, 0.16, -0.3 + i * 0.12));
	for (let b = 0; b < BARS.length; b++) {
		const c = BARS[b], t = beat(b * 4), last = b === BARS.length - 1;
		const dur = last ? FINAL - t : 4 * BEAT;
		pad(mus, t, CH[c], dur, b < 2 ? 0.05 : b >= 12 ? 0.05 : 0.04);
		// arpeggio: bars 1-2 and 5-6 lead it, quieter elsewhere, rests in the finale
		if (b < 12) {
			const g = b < 2 ? 0.19 : b >= 4 && b < 6 ? 0.15 : b >= 10 ? 0.07 : 0.09;
			ARP[c].forEach((m, i) => tranh(mus, t + i * BEAT / 2, m, BEAT / 2, g, ((i % 4) - 1.5) * 0.25));
		}
		// bass: a held drone under the opening, half notes from bar 3, driving eighths in the finale
		if (b < 2) bass(mus, t, ROOT[c], 4 * BEAT, 0.2);
		if (b >= 2 && b < 12) { bass(mus, t, ROOT[c], 2 * BEAT, 0.26); bass(mus, t + 2 * BEAT, ROOT[c] + (b % 2 ? 7 : 0), 2 * BEAT, 0.22); }
		if (b >= 12) for (let i = 0; i < 8; i++) { const tt = t + i * BEAT / 2; if (tt < FINAL - 0.05) bass(mus, tt, ROOT[c] + (i % 4 === 3 ? 12 : 0), BEAT / 2, 0.3); }
		// percussion
		for (let i = 0; i < 16 && b >= 2 && b < 12; i++) shaker(dry, t + i * BEAT / 4, i % 2 ? 0.05 : 0.025, i % 2 ? 0.4 : -0.4);
		if (b >= 6 && b < 12) { kick(dry, t, 0.45); kick(dry, t + 2 * BEAT, 0.4); }
		if (b >= 8 && b < 12) { snare(dry, t + BEAT, 0.12, 0.1); snare(dry, t + 3 * BEAT, 0.12, 0.1); }
		if (b >= 12) for (let i = 0; i < 4; i++) { const tt = t + i * BEAT; if (tt < FINAL - 0.05) { kick(dry, tt, 0.7); if (i % 2) snare(dry, tt, 0.3, 0.1); } }
	}
	// build-up into the boss fight: snare roll + riser over the last beats of bar 12
	for (let i = 0; i < 16; i++) snare(dry, beat(46) + i * BEAT / 8, 0.05 + i * 0.012, 0.1);
	riser(dry, beat(44), 4 * BEAT, 0.25);
	tom(dry, BOSS, 70, 0.6, -0.2); tom(dry, BOSS + 0.08, 92, 0.5, 0.2);
	cymbal(dry, BOSS, 0.18);
	// melody
	for (const [b0, len, m] of FLUTE) sao(mus, beat(b0), m, len * BEAT * 0.95, 0.16, 0.1);
	for (const [b0, len, m] of TRANH) {
		if (len > 1) for (let i = 0; i < len * 6; i++) tranh(mus, beat(b0) + i * BEAT / 6, m, BEAT / 6, 0.1, 0.2);
		else tranh(mus, beat(b0), m, len * BEAT, 0.2, 0.2);
	}
	// the last chord with the end card: full pad, a ringing tranh chord, a big hit and chimes
	pad(mus, FINAL, [...CH.D, 69, 74], LENGTH - FINAL, 0.06);
	[N.D4, N.A4, N.D5, N.Fs5, N.A5, N.D6].forEach((m, i) => tranh(mus, FINAL + i * 0.03, m, 1.6, 0.18, -0.4 + i * 0.16));
	sao(mus, FINAL, N.A5, LENGTH - FINAL - 0.3, 0.13, 0.1);
	kick(dry, FINAL, 0.9); tom(dry, FINAL, 60, 0.7); cymbal(dry, FINAL, 0.3, 2.8);
	[N.D6, N.A5, N.Fs5, N.D6 + 7].forEach((m, i) => bell(mus, FINAL + 0.25 + i * 0.18, mtof(m), 1.8, 0.05, 3.5, 2, -0.5 + i * 0.33));
	reverb(mus, 0.3, 0.86);
	for (let i = 0; i < n; i++) { mus.L[i] += dry.L[i]; mus.R[i] += dry.R[i]; }
	return mus;
}

/* ------------------------------------------------------------------ engines */

// Per frame and per aircraft: gain, pan and Doppler factor relative to the camera.
function engineTracks() {
	const total = Math.round(LENGTH * FPS) + 2, tracks = SLOTS.map(() => ({ g: new Float32Array(total), pan: new Float32Array(total), dop: new Float32Array(total).fill(1) }));
	for (const { S, start, frames } of TIMELINE) {
		const f0 = Math.round(start * FPS);
		for (let f = 0; f < frames; f++) {
			const t = f / FPS;
			if (!S.path) {
				// boss fight: the game's chase camera rides just behind the flight
				const near = [[30, 0], [26, -0.6], [22, 0.65], [38, 0.05]];
				tracks.forEach((tr, i) => { tr.g[f0 + f] = Math.pow(18 / near[i][0], 1.1); tr.pan[f0 + f] = near[i][1]; });
				continue;
			}
			const dists = (tt) => {
				const L = poseOf(S.path, tt), cam = S.cam(tt, L);
				const lx = cam[3] - cam[0], lz = cam[5] - cam[2], ll = Math.hypot(lx, lz) || 1;
				return SLOTS.map((s) => {
					const p = slotPose(L, s), dx = p[0] - cam[0], dy = p[1] - cam[1], dz = p[2] - cam[2], d = Math.hypot(dx, dy, dz);
					return [d, (-lz / ll * dx + lx / ll * dz) / Math.max(1, Math.hypot(dx, dz))];
				});
			};
			const a = dists(t - 1 / 60), b = dists(t + 1 / 60), c = dists(t);
			tracks.forEach((tr, i) => {
				const [d, side] = c[i], vr = (b[i][0] - a[i][0]) * 30; // m/s, positive when receding
				tr.g[f0 + f] = Math.min(1.6, Math.pow(20 / Math.max(d, 8), 1.25));
				tr.pan[f0 + f] = clamp(side, -1, 1) * 0.85;
				tr.dop[f0 + f] = 343 / (343 + clamp(vr, -120, 120));
			});
		}
	}
	return tracks;
}

function engines(bus) {
	const tracks = engineTracks(), n = bus.L.length;
	const kinds = ['jet', 'seaplane', 'heli', 'jet'];
	tracks.forEach((tr, i) => {
		const kind = kinds[i], bp = new Biquad(), lp = new Biquad(), lp2 = new Biquad().set('lp', 420, 0.7);
		let ph = rnd(), ph2 = rnd(), rot = rnd();
		for (let k = 0; k < n; k++) {
			const fr = k / SR * FPS, f = Math.min(tr.g.length - 2, Math.floor(fr)), u = fr - f;
			const g = tr.g[f] + (tr.g[f + 1] - tr.g[f]) * u;
			if (g < 1e-4) continue;
			const pan = tr.pan[f] + (tr.pan[f + 1] - tr.pan[f]) * u, dop = tr.dop[f] + (tr.dop[f + 1] - tr.dop[f]) * u;
			let v;
			if (kind === 'jet') {
				if (k % 32 === 0) bp.set('bp', 950 * dop, 0.9);
				ph += 2 * Math.PI * 2100 * dop / SR;
				v = bp.run(noise()) * 0.9 + Math.sin(ph) * 0.05;
			} else if (kind === 'seaplane') {
				ph += 96 * dop / SR; if (ph >= 1) ph -= 1;
				if (k % 32 === 0) lp.set('lp', 900 * dop, 0.8);
				v = lp.run((ph * 2 - 1) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 24 * k / SR))) * 0.6;
			} else {
				rot += 10.5 / SR; if (rot >= 1) rot -= 1;
				ph2 += 2 * Math.PI * 1600 * dop / SR;
				const thwop = Math.pow(Math.abs(Math.sin(Math.PI * rot)), 6);
				v = lp2.run(noise()) * (0.25 + 1.6 * thwop) + Math.sin(ph2) * 0.03;
			}
			bus.add(k, v * g * 0.16, pan);
		}
	});
}

/* ------------------------------------------------------------------ ambience + effects */

function noiseBed(bus, t0, t1, gainFn, filt, pan = 0) {
	const i0 = Math.round(t0 * SR), i1 = Math.round(t1 * SR), [type, f, q] = filt, b = new Biquad().set(type, f, q);
	for (let k = i0; k < i1; k++) {
		const t = (k - i0) / SR, fade = Math.min(1, t / 0.3, (i1 - k) / SR / 0.3);
		bus.add(k, b.run(noise()) * gainFn(t) * fade, pan);
	}
}
// paper whoosh on each cut: a band sweep peaking on the cut, plus paper crinkle
function whoosh(bus, tc, gain) {
	const t0 = tc - 0.45, i0 = Math.round(t0 * SR), len = Math.round(0.75 * SR), b = new Biquad();
	for (let k = 0; k < len; k++) {
		const t = k / SR, u = t / 0.75;
		if (k % 64 === 0) b.set('bp', 250 + 2600 * Math.sin(Math.PI * Math.min(1, u * 1.1)), 1.1);
		const env = Math.sin(Math.PI * u) ** 2;
		const crinkle = rnd() < 0.004 * env ? noise() * 2 : 0;
		bus.add(i0 + k, (b.run(noise()) * env + crinkle * 0.3) * gain, -0.6 + 1.2 * u);
	}
}
function chirp(bus, t0, f0, f1, dur, gain, pan) {
	const i0 = Math.round(t0 * SR);
	let ph = 0;
	for (let k = 0; k < dur * SR; k++) { const u = k / (dur * SR); ph += 2 * Math.PI * (f0 + (f1 - f0) * u) / SR; bus.add(i0 + k, Math.sin(ph) * Math.sin(Math.PI * u) * gain, pan); }
}
function gunBurst(bus, t0, t1, rate, gain, pan) {
	const hp = new Biquad().set('hp', 900, 0.7);
	for (let t = t0; t < t1; t += 1 / rate) {
		const i0 = Math.round((t + rnd() * 0.01) * SR);
		for (let k = 0; k < 0.05 * SR; k++) { const tt = k / SR; bus.add(i0 + k, (hp.run(noise()) * Math.exp(-tt / 0.012) + Math.sin(2 * Math.PI * 140 * tt) * Math.exp(-tt / 0.02) * 0.6) * gain, pan); }
	}
}
function explosion(bus, t0, size, pan = 0) {
	const i0 = Math.round(t0 * SR), len = Math.round((0.9 + size * 1.6) * SR), lp = new Biquad().set('lp', 900 + 600 * size, 0.6), sub = new Biquad().set('lp', 120, 0.7);
	let ph = 0;
	for (let k = 0; k < len; k++) {
		const t = k / SR;
		ph += 2 * Math.PI * (55 * Math.exp(-t / 0.4) + 32) / SR;
		const v = lp.run(noise()) * Math.exp(-t / (0.18 + 0.35 * size)) * 1.4 + sub.run(noise()) * Math.exp(-t / (0.5 + size)) * 2.5 + Math.sin(ph) * Math.exp(-t / 0.3) * 0.9 * size;
		bus.add(i0 + k, v * (0.35 + 0.4 * size) * Math.min(1, t / 0.003), pan);
	}
}
function beeps(bus, t0, t1, period, f, gain) {
	for (let t = t0; t < t1; t += period) {
		const i0 = Math.round(t * SR);
		for (let k = 0; k < 0.05 * SR; k++) bus.add(i0 + k, Math.sin(2 * Math.PI * f * k / SR) * Math.min(1, k / 100, (0.05 * SR - k) / 100) * gain, 0.15);
	}
}

function design(bus) {
	const T = Object.fromEntries(TIMELINE.map(({ S, start, frames }) => [S.name, [start, start + frames / FPS]]));
	// Mỹ Khê: surf with slow swells
	noiseBed(bus, T.mykhe[0], T.mykhe[1] + 0.3, (t) => 0.06 + 0.07 * Math.max(0, Math.sin(2 * Math.PI * t / 3.6)), ['lp', 700, 0.5], 0.3);
	noiseBed(bus, T.mykhe[0], T.mykhe[1] + 0.3, (t) => 0.025 * Math.max(0, Math.sin(2 * Math.PI * (t + 0.4) / 3.6)) ** 2, ['bp', 3500, 0.8], -0.3);
	// Linh Ứng: mountain breeze and the pagoda bell
	noiseBed(bus, T.sontra[0], T.sontra[1], (t) => 0.03 + 0.02 * Math.sin(t * 1.3), ['bp', 500, 0.6]);
	bell(bus, T.sontra[0] + 0.35, 98, 4.5, 0.11, 1.4, 4, -0.2);
	bell(bus, T.sontra[0] + 0.35, 196.5, 3.2, 0.04, 2.76, 2, 0.2);
	// Bà Nà: high wind
	noiseBed(bus, T.bana[0], T.bana[1], (t) => 0.045 + 0.03 * Math.sin(t * 2.1) ** 2, ['bp', 900, 0.5], -0.2);
	// Ngũ Hành Sơn: birds
	for (const [dt, f, p] of [[0.5, 3900, -0.6], [0.62, 4300, -0.6], [1.8, 3600, 0.5], [1.92, 4100, 0.5], [3.1, 4400, -0.2], [3.2, 3800, -0.2]]) chirp(bus, T.nguhanh[0] + dt, f, f * 1.25, 0.08, 0.03, p);
	noiseBed(bus, T.nguhanh[0], T.nguhanh[1], () => 0.02, ['bp', 600, 0.6]);
	// Cầu Rồng: the evening city, low and wide
	noiseBed(bus, T.dragon[0], T.dragon[1], (t) => 0.045 + 0.01 * Math.sin(t * 0.7), ['lp', 380, 0.6]);
	// Hội An: water lapping by the lanterns
	noiseBed(bus, T.hoian[0], T.hoian[1], (t) => 0.03 + 0.03 * Math.max(0, Math.sin(2 * Math.PI * t / 1.7)) ** 3, ['bp', 1300, 1.4], 0.2);
	// paper whooshes on every cut
	for (const { start } of TIMELINE.slice(1)) whoosh(bus, start, 0.2);
	// boss fight (times from tools/film.js: guns until +3.4, pods +1.0/+1.7/+2.3, kill +2.95)
	const B = T.boss[0];
	noiseBed(bus, B, T.boss[1], () => 0.05, ['bp', 700, 0.5]);
	beeps(bus, B + 0.1, B + 0.7, 0.24, 1000, 0.035);
	beeps(bus, B + 0.7, B + 1.6, 0.09, 1600, 0.03);
	[[-0.55, 14], [-0.2, 16], [0.25, 11], [0.6, 14]].forEach(([p, r], i) => gunBurst(bus, B + 0.05 * i, B + 3.4, r, 0.05, p));
	explosion(bus, B + 1.0, 0.6, -0.15);
	explosion(bus, B + 1.7, 0.6, 0.2);
	explosion(bus, B + 2.3, 0.75, -0.05);
	explosion(bus, B + 2.95, 1.4, 0);
	for (let t = B + 3.2; t < T.boss[1] - 0.2; t += 0.22 + rnd() * 0.15) explosion(bus, t, 0.25 + rnd() * 0.2, rnd() * 0.8 - 0.4);
}

/* ------------------------------------------------------------------ mixdown */

export function render() {
	const music = score();
	const sfx = new Bus(music.L.length);
	engines(sfx);
	design(sfx);
	const n = Math.round(LENGTH * SR), L = new Float32Array(n), R = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		// let the music breathe under the boss fight's sound effects, then lift it for the end card
		const mg = t > BOSS && t < BOSS + 3.0 ? 0.78 : 1;
		L[i] = music.L[i] * 0.9 * mg + sfx.L[i];
		R[i] = music.R[i] * 0.9 * mg + sfx.R[i];
	}
	// fade in/out, normalise, then master: make-up gain into a look-ahead limiter so the
	// explosions don't set the level of the whole mix (lands near -14 LUFS for social platforms)
	let peak = 0;
	for (let i = 0; i < n; i++) {
		const t = i / SR, f = Math.min(1, t / 0.05, (LENGTH - t) / 0.6);
		L[i] *= f; R[i] *= f;
		peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
	}
	limit(L, R, MAKEUP / peak, CEILING);
	return { L, R };
}

const MAKEUP = 10 ** (10 / 20), CEILING = 10 ** (-2.5 / 20);

// Gain envelope = the gain each sample needs to stay under the ceiling, spread backwards over
// 5 ms (attack, so the gain is already down when the peak arrives) and forwards over 120 ms (release).
function limit(L, R, gain, ceiling) {
	const n = L.length, g = new Float32Array(n);
	for (let i = 0; i < n; i++) g[i] = Math.min(1, ceiling / (Math.max(Math.abs(L[i]), Math.abs(R[i])) * gain + 1e-9));
	const rel = Math.exp(-1 / (0.12 * SR)), atk = Math.exp(-1 / (0.005 * SR));
	for (let i = 1; i < n; i++) g[i] = Math.min(g[i], 1 - (1 - g[i - 1]) * rel);
	for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], 1 - (1 - g[i + 1]) * atk);
	for (let i = 0; i < n; i++) { L[i] *= gain * g[i]; R[i] *= gain * g[i]; }
}

export function writeWav(file, { L, R }) {
	const n = L.length, buf = Buffer.alloc(44 + n * 4);
	buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
	buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
	for (let i = 0; i < n; i++) {
		buf.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4);
		buf.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 46 + i * 4);
	}
	fs.writeFileSync(file, buf);
}

// Mux the soundtrack onto a video (video stream copied, AAC audio at -14 LUFS for social platforms).
export function addSoundtrack(video, out, wav) {
	const tmp = wav || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phidoi-audio-')), 'soundtrack.wav');
	writeWav(tmp, render());
	// two-pass loudnorm: measure first, then apply one linear gain so the mix keeps its dynamics
	const ln = 'loudnorm=I=-14:TP=-1.5:LRA=11';
	const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', tmp, '-af', ln + ':print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
	const m = JSON.parse(probe.slice(probe.lastIndexOf('{'), probe.lastIndexOf('}') + 1));
	const af = `${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', tmp, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
		'-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', out]);
	return tmp;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i < 0 ? null : a[i + 1]; };
	const t0 = Date.now();
	if (opt('--video')) {
		const out = opt('--out') || opt('--video').replace(/\.mp4$/, '-sound.mp4');
		addSoundtrack(opt('--video'), out, opt('--wav'));
		console.log('[soundtrack] ' + out + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
	} else {
		const wav = opt('--wav') || 'soundtrack.wav';
		writeWav(wav, render());
		console.log('[soundtrack] ' + wav + ' (' + LENGTH.toFixed(2) + ' s) in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
	}
}
