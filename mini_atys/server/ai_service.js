// AI Service: fauna spawn groups and their behaviour.
// Ryzom equivalent: ryzom/server/src/ai_service (CGrpFauna / CSpawnBotFauna
// in ai_bot_fauna.h, aggro lists in ai_aggro.h). A group wanders around its
// spawn point, aggressive species pull players that come close, the aggro
// list decides the target, and a creature dragged too far "leashes" home
// (evading, healing to full) like Ryzom fauna do.

'use strict';

const Rules = require('../shared/rules');
const { CREATURES } = require('./sheets');
const { mulberry32 } = require('./world');

const LEASH = 22;
const ACTIVE_RADIUS = 45;
const DROP_AGGRO = 30;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

class AIService {
	constructor(world, egs, opts = {}) {
		this.world = world;
		this.egs = egs;
		this.rnd = mulberry32((opts.seed || world.seed) + 99);
		this.groups = [];
		this._tick = 0;
		egs.ai = this;
		this._populate();
	}

	_populate() {
		const { world } = this;
		const step = 12;
		for (let gy = step / 2; gy < world.h; gy += step) {
			for (let gx = step / 2; gx < world.w; gx += step) {
				const jx = gx + (this.rnd() - 0.5) * step * 0.6, jy = gy + (this.rnd() - 0.5) * step * 0.6;
				const d = world.distFromCenter(jx, jy);
				if (d < Rules.TOWN_RADIUS + 7) continue;
				const pos = world.randomWalkableNear(jx, jy, 3, this.rnd);
				if (!pos) continue;
				const region = world.regionAt(pos[0], pos[1]);
				const level = Math.round(Math.min(28, Math.max(1, 1 + (d - 16) / 4.2 + (this.rnd() - 0.5) * 2)));
				const choices = Object.keys(CREATURES).filter((k) => {
					const s = CREATURES[k];
					return !s.boss && s.regions.includes(region) && level >= s.minLevel && level <= s.maxLevel;
				});
				if (!choices.length) continue;
				const sheet = choices[Math.floor(this.rnd() * choices.length)];
				this._addGroup(sheet, pos[0], pos[1], level, 2 + Math.floor(this.rnd() * 3), 5);
			}
		}
		// The boss lives at the far end of the Zorai jungle.
		const boss = world.randomWalkableNear(world.w - 26, world.h - 26, 8, this.rnd);
		if (boss) this._addGroup('kirosta', boss[0], boss[1], 30, 1, 2, 120000);
	}

	_addGroup(sheet, x, y, level, count, radius, respawnMs) {
		const g = { sheet, x, y, level, count, radius, respawnMs: respawnMs || 20000, members: new Set(), queue: [], active: true };
		this.groups.push(g);
		for (let i = 0; i < count; i++) this._spawnMember(g);
	}

	_spawnMember(g) {
		const pos = this.world.randomWalkableNear(g.x, g.y, g.radius, this.rnd) || [g.x, g.y];
		const level = Math.max(1, g.level + Math.floor(this.rnd() * 3) - 1);
		const c = this.spawnCreature(g.sheet, level, pos[0], pos[1]);
		c.group = g;
		g.members.add(c);
		return c;
	}

	spawnCreature(sheetId, level, x, y) {
		const s = CREATURES[sheetId];
		const maxHp = Math.round(s.hp[0] + s.hp[1] * level);
		return this.egs.addEntity({
			kind: 'creature', sheet: sheetId, name: s.name, level,
			x, y, homeX: x, homeY: y, dir: this.rnd() * Math.PI * 2,
			hp: maxHp, maxHp, alive: true, color: s.color, size: s.size, boss: !!s.boss,
			aggro: new Map(), damageBy: new Map(), state: 'idle',
			nextThink: 0, nextAttack: 0, nextScan: 0, wanderTo: null, evading: false, lastCombat: 0,
			group: null,
		});
	}

	// ------------------------------------------------------------ callbacks

	onAttacked(c, src, amount) {
		if (src.kind !== 'player' || c.state === 'return') return;
		c.aggro.set(src.id, (c.aggro.get(src.id) || 0) + amount);
		c.state = 'combat';
	}

	onHeal(healer, target, amount) {
		this.egs.matrix.forEachInRadius(target.x, target.y, 25, (c) => {
			if (c.kind === 'creature' && c.alive && c.aggro.has(target.id)) {
				c.aggro.set(healer.id, (c.aggro.get(healer.id) || 0) + amount * 0.5);
			}
		});
	}

	onCorpseRemoved(c) {
		if (!c.group) return;
		c.group.members.delete(c);
		const jitter = c.boss ? 0 : (this.rnd() - 0.5) * 8000;
		c.group.queue.push(this.egs.now + c.group.respawnMs + jitter);
		c.group.queue.sort((a, b) => a - b);
	}

	// ------------------------------------------------------------------ tick

	update(dt) {
		const now = this.egs.now;
		this._tick++;
		// Groups far from every player are frozen (cheap level-of-detail).
		if (this._tick % 10 === 1) {
			for (const g of this.groups) {
				let active = false;
				for (const p of this.egs.players.values()) {
					if (Math.abs(p.x - g.x) < ACTIVE_RADIUS && Math.abs(p.y - g.y) < ACTIVE_RADIUS) { active = true; break; }
				}
				g.active = active;
			}
		}
		for (const g of this.groups) {
			while (g.queue.length && g.queue[0] <= now) {
				g.queue.shift();
				this._spawnMember(g);
			}
			let busy = false;
			for (const c of g.members) if (c.state !== 'idle') busy = true;
			if (!g.active && !busy) continue;
			for (const c of g.members) if (c.alive) this._think(c, dt, now);
		}
		// Creatures spawned by GM commands have no group.
		for (const e of this.egs.entities.values()) {
			if (e.kind === 'creature' && !e.group && e.alive) this._think(e, dt, now);
		}
	}

	_think(c, dt, now) {
		const s = CREATURES[c.sheet];
		if (c.state === 'return') {
			this._moveToward(c, c.homeX, c.homeY, s.speed * 1.3 * dt);
			if (Math.hypot(c.x - c.homeX, c.y - c.homeY) < 0.6) {
				c.state = 'idle';
				c.evading = false;
				c.hp = c.maxHp;
			}
			return;
		}

		if (s.aggressive && c.aggro.size === 0 && now >= c.nextScan) {
			c.nextScan = now + 400;
			let best = null, bestD = s.aggroRadius;
			this.egs.matrix.forEachInRadius(c.x, c.y, s.aggroRadius, (p, d) => {
				if (p.kind !== 'player' || !p.alive || d > bestD) return;
				if (this.world.isSafe(p.x, p.y) || p.level >= c.level + 8) return;
				best = p;
				bestD = d;
			});
			if (best) { c.aggro.set(best.id, 1); c.state = 'combat'; }
		}

		if (c.aggro.size) this._combat(c, s, dt, now);
		else this._wander(c, s, dt, now);
	}

	_combat(c, s, dt, now) {
		let target = null, top = -1;
		for (const [pid, threat] of c.aggro) {
			const p = this.egs.players.get(pid);
			if (!p || !p.alive || dist(p, c) > DROP_AGGRO || this.world.isSafe(p.x, p.y)) { c.aggro.delete(pid); continue; }
			if (threat > top) { top = threat; target = p; }
		}
		const fromHome = Math.hypot(c.x - c.homeX, c.y - c.homeY);
		if (!target || fromHome > LEASH) {
			c.aggro.clear();
			c.damageBy.clear();
			c.state = 'return';
			c.evading = true;
			return;
		}
		const d = dist(c, target);
		if (d > s.range) {
			this._moveToward(c, target.x, target.y, Math.min(s.speed * dt, d - s.range + 0.15));
		} else {
			c.dir = Math.atan2(target.y - c.y, target.x - c.x);
			if (now >= c.nextAttack) {
				c.nextAttack = now + s.attackSpeed * 1000;
				this.egs._resolveHit(c, target, s.dmg[0] + s.dmg[1] * c.level, 'melee');
			}
		}
	}

	_wander(c, s, dt, now) {
		c.state = 'idle';
		if (c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + c.maxHp * 0.05 * dt);
		if (now >= c.nextThink) {
			c.nextThink = now + 3000 + this.rnd() * 5000;
			const g = c.group;
			c.wanderTo = this.rnd() < 0.6
				? this.world.randomWalkableNear(g ? g.x : c.homeX, g ? g.y : c.homeY, g ? g.radius : 4, this.rnd)
				: null;
		}
		if (c.wanderTo) {
			this._moveToward(c, c.wanderTo[0], c.wanderTo[1], s.speed * 0.35 * dt);
			if (Math.hypot(c.x - c.wanderTo[0], c.y - c.wanderTo[1]) < 0.3) c.wanderTo = null;
		}
	}

	_moveToward(c, tx, ty, step) {
		if (step <= 0) return;
		const [nx, ny] = Rules.steer(this.world, c.x, c.y, tx, ty, step);
		if (this.world.isSafe(nx, ny)) return; // fauna never enters the village
		this.egs.setPosition(c, nx, ny);
	}
}

module.exports = { AIService };
