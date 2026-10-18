// Shared state of the shard: every module (players, enemies, combat, events,
// frontend) works on one World. Mirrors the role of the Ryzom mirror service:
// a single place where entity state lives and is read by the other services.

import { buildHeights, gridH, SEA_Y } from '../shared/geo.js';

export class World {
	constructor(opts = {}) {
		this.opts = opts;
		this.now = Date.now();
		this.t = 0; // seconds since start
		this.nextId = 1;
		this.players = new Map();
		this.enemies = new Map();
		this.crates = new Map();
		this.bullets = []; // enemy bullets, ink blobs and bombs
		this.missiles = new Map(); // enemy missiles (the squid's)
		this.events = []; // { x, z, ev } flushed to nearby clients every cycle
		this.feed = []; // kill feed lines for everyone
		this.rnd = opts.random || Math.random;
		this.notify = () => {}; // (player, msg) wired by the frontend
		this.broadcast = () => {};
		if (!opts.skipTerrain) buildHeights();
	}

	id() {
		return this.nextId++;
	}

	rr(a, b) {
		return a + (b - a) * this.rnd();
	}

	pick(arr) {
		return arr[Math.floor(this.rnd() * arr.length)];
	}

	ground(x, z) {
		return Math.max(gridH(x, z), SEA_Y);
	}

	emit(x, z, ev) {
		this.events.push({ x, z, ev });
	}

	say(text) {
		this.feed.push(text);
	}
}
