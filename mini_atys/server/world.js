// Procedural continent: a tiny "Atys" with the starting village of Silan in
// the middle and one ecosystem per quadrant (Matis forest, Fyros desert,
// Tryker lakes, Zorai jungle). In Ryzom the continents are static data
// (egs_static_continent.cpp, .primitive files); here they are generated
// from a seed so the server needs no asset pipeline.

'use strict';

const { TILE, BLOCKING, TOWN_RADIUS } = require('../shared/rules');

function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeNoise(seed, size) {
	const rnd = mulberry32(seed);
	const grid = new Float32Array(size * size);
	for (let i = 0; i < grid.length; i++) grid[i] = rnd();
	const at = (x, y) => grid[((y % size + size) % size) * size + ((x % size + size) % size)];
	const smooth = (t) => t * t * (3 - 2 * t);
	function value(x, y) {
		const x0 = Math.floor(x), y0 = Math.floor(y);
		const fx = smooth(x - x0), fy = smooth(y - y0);
		const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
		return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
	}
	return function fbm(x, y) {
		let v = 0, amp = 0.5, freq = 1, norm = 0;
		for (let o = 0; o < 4; o++) {
			v += value(x * freq, y * freq) * amp;
			norm += amp;
			amp *= 0.5;
			freq *= 2;
		}
		return v / norm;
	};
}

const REGIONS = {
	silan: { name: 'Silan Village', safe: true },
	matis: { name: 'Matis Forest' },
	fyros: { name: 'Fyros Desert' },
	tryker: { name: 'Tryker Lakes' },
	zorai: { name: 'Zorai Jungle' },
};

class World {
	constructor(seed = 1337, size = 192) {
		this.seed = seed;
		this.w = size;
		this.h = size;
		this.cx = size / 2;
		this.cy = size / 2;
		this.tiles = new Uint8Array(size * size);
		this._generate();
	}

	regionAt(x, y) {
		const dx = x - this.cx, dy = y - this.cy;
		if (dx * dx + dy * dy <= TOWN_RADIUS * TOWN_RADIUS) return 'silan';
		if (dy < 0) return dx < 0 ? 'matis' : 'fyros';
		return dx < 0 ? 'tryker' : 'zorai';
	}

	isSafe(x, y) {
		return this.regionAt(x, y) === 'silan';
	}

	distFromCenter(x, y) {
		return Math.hypot(x - this.cx, y - this.cy);
	}

	set(x, y, t) {
		if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.tiles[y * this.w + x] = t;
	}

	get(x, y) {
		if (x < 0 || y < 0 || x >= this.w || y >= this.h) return TILE.ROCK;
		return this.tiles[y * this.w + x];
	}

	walkableTile(x, y) {
		return !BLOCKING[this.get(x, y)];
	}

	_generate() {
		const n1 = makeNoise(this.seed, 64);
		const n2 = makeNoise(this.seed + 1, 64);
		const { w, h, cx, cy } = this;

		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const region = this.regionAt(x + 0.5, y + 0.5);
				const a = n1(x / 9, y / 9);
				const b = n2(x / 4, y / 4);
				let t = TILE.GRASS;
				switch (region) {
				case 'matis':
					t = TILE.FOREST;
					if (a > 0.58 && b > 0.45) t = TILE.TREE;
					else if (b > 0.78) t = TILE.TREE;
					break;
				case 'fyros':
					t = TILE.SAND;
					if (a > 0.66) t = TILE.ROCK;
					else if (b > 0.83) t = TILE.ROCK;
					else if (a < 0.3) t = TILE.DIRT;
					break;
				case 'tryker':
					t = TILE.GRASS;
					if (a < 0.33) t = TILE.WATER;
					else if (a < 0.37) t = TILE.SHALLOW;
					else if (b > 0.85) t = TILE.TREE;
					break;
				case 'zorai':
					t = TILE.JUNGLE;
					if (a > 0.62 && b > 0.4) t = TILE.TREE;
					else if (a < 0.27) t = TILE.WATER;
					else if (b > 0.8) t = TILE.TREE;
					break;
				default:
					t = TILE.STONE;
				}
				// Impassable rim around the continent
				const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
				if (edge < 2 || (edge < 5 && b > 0.5)) t = region === 'tryker' || region === 'zorai' ? TILE.WATER : TILE.ROCK;
				this.tiles[y * w + x] = t;
			}
		}

		// Silan village: paved square with a ring of trees as a hedge
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
				if (d <= TOWN_RADIUS) this.tiles[y * w + x] = TILE.STONE;
				else if (d <= TOWN_RADIUS + 1.2) this.tiles[y * w + x] = TILE.TREE;
			}
		}

		// Roads from the village toward each region (diagonals and cardinals)
		const roads = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
		for (const [rx, ry] of roads) {
			const len = rx && ry ? 70 : 85;
			const n = Math.hypot(rx, ry);
			for (let s = 0; s < len; s += 0.5) {
				const wobble = (n1(s / 6, rx * 7 + ry * 13) - 0.5) * 6;
				const px = cx + (rx / n) * s + (-ry / n) * wobble;
				const py = cy + (ry / n) * s + (rx / n) * wobble;
				for (let oy = -1; oy <= 1; oy++) {
					for (let ox = -1; ox <= 1; ox++) {
						const tx = Math.floor(px + ox * 0.7), ty = Math.floor(py + oy * 0.7);
						const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
						const edge = Math.min(tx, ty, w - 1 - tx, h - 1 - ty);
						if (edge < 6) continue;
						if (d > TOWN_RADIUS) this.set(tx, ty, TILE.DIRT);
					}
				}
			}
		}

		// Anything not reachable from the village becomes blocked so that
		// nothing can spawn in an enclosed pocket.
		const seen = new Uint8Array(w * h);
		const stack = [Math.floor(cy) * w + Math.floor(cx)];
		seen[stack[0]] = 1;
		while (stack.length) {
			const i = stack.pop();
			const x = i % w, y = (i / w) | 0;
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
				const j = ny * w + nx;
				if (!seen[j] && !BLOCKING[this.tiles[j]]) { seen[j] = 1; stack.push(j); }
			}
		}
		for (let i = 0; i < w * h; i++) {
			if (!seen[i] && !BLOCKING[this.tiles[i]]) {
				const r = this.regionAt((i % w) + 0.5, ((i / w) | 0) + 0.5);
				this.tiles[i] = r === 'tryker' || r === 'zorai' ? TILE.WATER : r === 'fyros' ? TILE.ROCK : TILE.TREE;
			}
		}
	}

	// Find a walkable tile center near (x,y) using the given RNG.
	randomWalkableNear(x, y, radius, rnd) {
		for (let tries = 0; tries < 40; tries++) {
			const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius;
			const tx = Math.floor(x + Math.cos(a) * r), ty = Math.floor(y + Math.sin(a) * r);
			if (this.walkableTile(tx, ty) && this.walkableTile(tx + 1, ty) && this.walkableTile(tx - 1, ty) &&
				this.walkableTile(tx, ty + 1) && this.walkableTile(tx, ty - 1)) return [tx + 0.5, ty + 0.5];
		}
		return null;
	}

	spawnPoint() {
		return [this.cx + 0.5, this.cy + 2.5];
	}

	serialize() {
		return { w: this.w, h: this.h, tiles: Buffer.from(this.tiles).toString('base64') };
	}
}

module.exports = { World, REGIONS, mulberry32 };
