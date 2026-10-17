// Rules shared by the server and the browser client (UMD).
// Collision must be identical on both sides: the client moves its own
// character (client-authoritative, like the Ryzom client) and the server
// re-checks every move, as GPMS does in ryzom/server/src/gpm_service/move_checker.cpp.

(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.Rules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	const TILE = {
		GRASS: 0, SAND: 1, WATER: 2, TREE: 3, ROCK: 4,
		DIRT: 5, STONE: 6, FOREST: 7, JUNGLE: 8, SHALLOW: 9,
	};
	const BLOCKING = [false, false, true, true, true, false, false, false, false, false];

	const ENTITY_RADIUS = 0.3;
	const PLAYER_SPEED = 4.5; // tiles per second
	const TICK_MS = 100; // Ryzom game cycle is 100 ms (TickTimeStep)
	const VIEW_RADIUS = 24; // tiles
	const TOWN_RADIUS = 11;

	// Player actions, the equivalent of Ryzom "sabrina" phrases reduced to one brick each.
	const ACTIONS = {
		attack: { name: 'Attack', key: '1', range: 1.8, cooldown: 1.3, sta: 6, sap: 0, needsTarget: true },
		fire: { name: 'Fire Bolt', key: '2', range: 7, cooldown: 2.5, sta: 0, sap: 14, needsTarget: true },
		heal: { name: 'Heal', key: '3', range: 7, cooldown: 4, sta: 0, sap: 20, needsTarget: false },
		potion: { name: 'Potion', key: '4', range: 0, cooldown: 8, sta: 0, sap: 0, needsTarget: false, item: 'potion' },
		crystal: { name: 'Sap Crystal', key: '5', range: 0, cooldown: 8, sta: 0, sap: 0, needsTarget: false, item: 'crystal' },
	};

	function tileAt(map, x, y) {
		const tx = Math.floor(x), ty = Math.floor(y);
		if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return TILE.ROCK;
		return map.tiles[ty * map.w + tx];
	}

	function isWalkable(map, x, y, r) {
		if (r === undefined) r = ENTITY_RADIUS;
		return !BLOCKING[tileAt(map, x - r, y - r)] && !BLOCKING[tileAt(map, x + r, y - r)] &&
			!BLOCKING[tileAt(map, x - r, y + r)] && !BLOCKING[tileAt(map, x + r, y + r)];
	}

	// Every sample point along the segment must be walkable (no wall-hopping).
	function segmentWalkable(map, x0, y0, x1, y1, r) {
		const d = Math.hypot(x1 - x0, y1 - y0);
		const steps = Math.max(1, Math.ceil(d / 0.2));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			if (!isWalkable(map, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) return false;
		}
		return true;
	}

	// Move by (dx,dy), sliding along obstacles axis by axis.
	function moveWithSlide(map, x, y, dx, dy) {
		if (isWalkable(map, x + dx, y + dy)) return [x + dx, y + dy];
		if (dx && isWalkable(map, x + dx, y)) return [x + dx, y];
		if (dy && isWalkable(map, x, y + dy)) return [x, y + dy];
		return [x, y];
	}

	// Steer toward (tx,ty): try the direct heading, then rotate up to +-90 degrees.
	function steer(map, x, y, tx, ty, step) {
		const dist = Math.hypot(tx - x, ty - y);
		if (dist < 1e-6) return [x, y];
		const s = Math.min(step, dist);
		const a0 = Math.atan2(ty - y, tx - x);
		const offsets = [0, 0.6, -0.6, 1.2, -1.2, 1.57, -1.57];
		for (const o of offsets) {
			const nx = x + Math.cos(a0 + o) * s, ny = y + Math.sin(a0 + o) * s;
			if (isWalkable(map, nx, ny)) return [nx, ny];
		}
		return [x, y];
	}

	function xpForLevel(level) {
		return Math.round(100 * Math.pow(level, 1.5));
	}

	function playerStats(level) {
		return {
			maxHp: 80 + 20 * level,
			maxSap: 40 + 10 * level,
			maxSta: 60 + 10 * level,
		};
	}

	return {
		TILE, BLOCKING, ENTITY_RADIUS, PLAYER_SPEED, TICK_MS, VIEW_RADIUS, TOWN_RADIUS, ACTIONS,
		MAX_LEVEL: 30,
		tileAt, isWalkable, segmentWalkable, moveWithSlide, steer, xpForLevel, playerStats,
	};
}));
