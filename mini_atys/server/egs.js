// Entities Game Service: owns every entity and all gameplay rules
// (characters, stats, combat, experience, inventory, trade, death).
// Ryzom equivalent: ryzom/server/src/entities_game_service, with the
// combat part of ryzom/server/src/entities_game_service/phrase_manager.

'use strict';

const Rules = require('../shared/rules');
const { EntityMatrix } = require('./entity_matrix');
const { CREATURES, ITEMS, GEAR, SHOP } = require('./sheets');

const { ACTIONS } = Rules;
const COMBAT_TIMEOUT = 6000;
const CORPSE_TIME = 2500;
const START_BUDGET = Rules.PLAYER_SPEED * 0.25;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function gearOf(slot, id) {
	return GEAR[slot].find((g) => g.id === id) || GEAR[slot][0];
}

class EntitiesGameService {
	constructor(world, opts = {}) {
		this.world = world;
		this.matrix = new EntityMatrix(world.w, world.h);
		this.entities = new Map();
		this.players = new Map();
		this.nextId = 1;
		this.events = []; // positional events flushed by the frontend each tick
		this.now = Date.now();
		this.rnd = opts.random || Math.random;
		this.notify = () => {}; // (player, msg) -> void, wired by the frontend
		this.ai = null;
		this._spawnNpcs();
	}

	// ---------------------------------------------------------------- entities

	addEntity(e) {
		e.id = this.nextId++;
		this.entities.set(e.id, e);
		this.matrix.insert(e);
		if (e.kind === 'player') this.players.set(e.id, e);
		return e;
	}

	removeEntity(e) {
		this.matrix.remove(e);
		this.entities.delete(e.id);
		this.players.delete(e.id);
		e.removed = true;
	}

	setPosition(e, x, y) {
		if (x !== e.x || y !== e.y) e.dir = Math.atan2(y - e.y, x - e.x);
		e.x = x;
		e.y = y;
		this.matrix.update(e);
	}

	emit(x, y, ev) {
		this.events.push({ x, y, ev });
	}

	_spawnNpcs() {
		const { cx, cy } = this.world;
		const npcs = [
			{ name: 'Merchant Lyna', role: 'merchant', x: cx - 4.5, y: cy - 3.5, color: '#3fb6a8' },
			{ name: 'Elder Zachary', role: 'guide', x: cx + 4.5, y: cy - 3.5, color: '#c9a0ff' },
		];
		for (const n of npcs) {
			this.addEntity({
				kind: 'npc', name: n.name, role: n.role, x: n.x, y: n.y, dir: Math.PI / 2,
				level: 99, hp: 1, maxHp: 1, alive: true, color: n.color, size: 0.4,
			});
		}
	}

	nearNpc(p, role, range = 4) {
		for (const e of this.entities.values()) {
			if (e.kind === 'npc' && e.role === role && dist(e, p) <= range) return e;
		}
		return null;
	}

	// ----------------------------------------------------------------- players

	createPlayer(save) {
		const [sx, sy] = this.world.spawnPoint();
		let x = save.x, y = save.y;
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Rules.isWalkable(this.world, x, y)) [x, y] = [sx, sy];
		const p = {
			kind: 'player',
			name: save.name,
			x, y, dir: Math.PI / 2,
			level: save.level || 1,
			xp: save.xp || 0,
			dappers: save.dappers || 0,
			inventory: Object.assign({}, save.inventory || { potion: 3 }),
			equip: Object.assign({ weapon: 'dagger', amp: 'none', armor: 'cloth' }, save.equip || {}),
			kills: save.kills || 0,
			deaths: save.deaths || 0,
			alive: true,
			cooldowns: {},
			autoTarget: 0,
			lastCombat: 0,
			lastMoveAt: this.now,
			moveBudget: START_BUDGET,
			region: null,
			dirty: true,
		};
		this._recalcStats(p);
		p.hp = clamp(save.hp || p.maxHp, 1, p.maxHp);
		p.sap = clamp(save.sap === undefined ? p.maxSap : save.sap, 0, p.maxSap);
		p.sta = clamp(save.sta === undefined ? p.maxSta : save.sta, 0, p.maxSta);
		return this.addEntity(p);
	}

	saveData(p) {
		return {
			level: p.level, xp: Math.floor(p.xp), dappers: p.dappers,
			inventory: p.inventory, equip: p.equip, kills: p.kills, deaths: p.deaths,
			x: +p.x.toFixed(2), y: +p.y.toFixed(2),
			hp: Math.ceil(p.hp), sap: Math.floor(p.sap), sta: Math.floor(p.sta),
		};
	}

	_recalcStats(p) {
		const s = Rules.playerStats(p.level);
		p.maxHp = s.maxHp;
		p.maxSap = s.maxSap;
		p.maxSta = s.maxSta;
	}

	// Client-reported position, validated like GPMS move_checker: bounded
	// speed and a walkable straight path. Returns false if a correction
	// must be sent back.
	clientMove(p, x, y) {
		if (!p.alive) return false;
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
		const elapsed = clamp((this.now - p.lastMoveAt) / 1000, 0, 1.0);
		p.lastMoveAt = this.now;
		// A small budget absorbs network jitter (messages bunching up) but
		// cannot be banked for more than ~0.6 s of movement.
		p.moveBudget = Math.min(p.moveBudget + Rules.PLAYER_SPEED * elapsed * 1.15, Rules.PLAYER_SPEED * 0.6);
		const d = Math.hypot(x - p.x, y - p.y);
		if (d > p.moveBudget + 0.05) return false;
		// The client checks collision with the full radius every frame but
		// reports a polyline every 50 ms; the chord between two reports may
		// cut a corner, so the server only demands that the center never
		// crosses a blocking tile.
		if (!Rules.segmentWalkable(this.world, p.x, p.y, x, y, 0.1)) return false;
		p.moveBudget -= d;
		this.setPosition(p, x, y);
		const region = this.world.regionAt(x, y);
		if (region !== p.region) { p.region = region; p.dirty = true; }
		return true;
	}

	teleport(p, x, y) {
		this.setPosition(p, x, y);
		p.autoTarget = 0;
		p.moveBudget = START_BUDGET;
		p.lastMoveAt = this.now;
		p.region = this.world.regionAt(x, y);
		p.dirty = true;
		this.notify(p, { t: 'teleport', x, y });
	}

	respawn(p) {
		if (p.alive) return;
		const [x, y] = this.world.spawnPoint();
		p.alive = true;
		p.hp = Math.ceil(p.maxHp * 0.5);
		p.sap = Math.ceil(p.maxSap * 0.5);
		p.sta = Math.ceil(p.maxSta * 0.5);
		this.teleport(p, x, y);
		this.emit(p.x, p.y, { e: 'respawn', id: p.id });
	}

	// ----------------------------------------------------------------- actions

	doAction(p, actionId, targetId) {
		if (!Object.hasOwn(ACTIONS, actionId) || !p.alive) return;
		const a = ACTIONS[actionId];
		if (actionId === 'attack') {
			const t = this.entities.get(targetId);
			if (!t || t.kind !== 'creature' || !t.alive) return this._error(p, 'Invalid target');
			p.autoTarget = t.id;
			p.dirty = true;
			return;
		}
		const ready = p.cooldowns[actionId] || 0;
		if (this.now < ready) return this._error(p, a.name + ' is not ready');
		if (p.sap < a.sap) return this._error(p, 'Not enough Sap');
		if (p.sta < a.sta) return this._error(p, 'Not enough Stamina');

		if (actionId === 'fire') {
			const t = this.entities.get(targetId);
			if (!t || t.kind !== 'creature' || !t.alive) return this._error(p, 'Invalid target');
			if (dist(p, t) > a.range + 0.6) return this._error(p, 'Target is too far');
			p.sap -= a.sap;
			this._startCooldown(p, actionId, a);
			const base = (10 + 4 * p.level) * (1 + gearOf('amp', p.equip.amp).bonus);
			this._resolveHit(p, t, base, 'fire');
		} else if (actionId === 'heal') {
			let t = this.entities.get(targetId);
			if (!t || t.kind !== 'player' || !t.alive) t = p;
			if (dist(p, t) > a.range + 0.6) return this._error(p, 'Target is too far');
			p.sap -= a.sap;
			this._startCooldown(p, actionId, a);
			const amount = Math.round((20 + 6 * p.level) * (1 + gearOf('amp', p.equip.amp).bonus) * (0.9 + this.rnd() * 0.2));
			this.heal(p, t, amount);
		} else if (a.item) {
			if (!(p.inventory[a.item] > 0)) return this._error(p, 'No ' + ITEMS[a.item].name + ' left');
			this._consume(p, a.item, 1);
			this._startCooldown(p, actionId, a);
			if (a.item === 'potion') this.heal(p, p, Math.round(p.maxHp * 0.5));
			else { p.sap = Math.min(p.maxSap, p.sap + p.maxSap * 0.6); this.emit(p.x, p.y, { e: 'sap', id: p.id }); }
		}
		p.dirty = true;
	}

	stopAttack(p) {
		if (p.autoTarget) { p.autoTarget = 0; p.dirty = true; }
	}

	_startCooldown(p, id, a) {
		p.cooldowns[id] = this.now + a.cooldown * 1000;
	}

	_error(p, text) {
		this.notify(p, { t: 'err', text });
	}

	_resolveHit(src, tgt, base, kind) {
		const diff = src.level - tgt.level;
		const hitChance = clamp(0.9 + 0.04 * diff, 0.35, 0.98);
		this._enterCombat(src);
		this._enterCombat(tgt);
		if (this.rnd() > hitChance) {
			this.emit(tgt.x, tgt.y, { e: 'dmg', s: src.id, t: tgt.id, v: 0, k: 'miss' });
			if (tgt.kind === 'creature' && this.ai) this.ai.onAttacked(tgt, src, 1);
			return;
		}
		let amount = base * clamp(1 + 0.08 * diff, 0.4, 1.6) * (0.85 + this.rnd() * 0.3);
		let k = kind;
		if (this.rnd() < 0.1) { amount *= 1.6; k = 'crit'; }
		if (tgt.kind === 'player') amount *= 1 - gearOf('armor', tgt.equip.armor).bonus;
		this.damage(src, tgt, Math.max(1, Math.round(amount)), k);
	}

	damage(src, tgt, amount, kind) {
		if (!tgt.alive) return;
		if (tgt.evading) {
			this.emit(tgt.x, tgt.y, { e: 'dmg', s: src.id, t: tgt.id, v: 0, k: 'evade' });
			return;
		}
		tgt.hp = Math.max(0, tgt.hp - amount);
		if (tgt.kind === 'player') tgt.dirty = true;
		this.emit(tgt.x, tgt.y, { e: 'dmg', s: src.id, t: tgt.id, v: amount, k: kind });
		if (tgt.kind === 'creature') {
			if (src.kind === 'player') tgt.damageBy.set(src.id, (tgt.damageBy.get(src.id) || 0) + amount);
			if (this.ai) this.ai.onAttacked(tgt, src, amount);
		}
		if (tgt.hp <= 0) this._kill(tgt, src);
	}

	heal(src, tgt, amount) {
		const before = tgt.hp;
		tgt.hp = Math.min(tgt.maxHp, tgt.hp + amount);
		tgt.dirty = true;
		this.emit(tgt.x, tgt.y, { e: 'dmg', s: src.id, t: tgt.id, v: Math.round(tgt.hp - before), k: 'heal' });
		// Healing someone in combat draws the attention of their attackers (healing aggro).
		if (src !== tgt && this.ai) this.ai.onHeal(src, tgt, amount);
	}

	_enterCombat(e) {
		e.lastCombat = this.now;
	}

	_kill(victim, killer) {
		victim.alive = false;
		victim.hp = 0;
		victim.deadAt = this.now;
		this.emit(victim.x, victim.y, { e: 'death', id: victim.id, by: killer.id });
		if (victim.kind === 'player') {
			victim.autoTarget = 0;
			victim.deaths++;
			// Death penalty: lose 10% of the current level's requirement (never de-level).
			const loss = Math.floor(Rules.xpForLevel(victim.level) * 0.1);
			victim.xp = Math.max(0, victim.xp - loss);
			victim.dirty = true;
			this.notify(victim, { t: 'chat', ch: 'sys', text: 'You were killed by ' + killer.name + '. Lost ' + loss + ' XP.' });
		} else if (victim.kind === 'creature') {
			this._rewardKill(victim);
		}
	}

	_rewardKill(c) {
		const sheet = CREATURES[c.sheet];
		let top = null, topDmg = -1;
		for (const [pid, dmg] of c.damageBy) {
			const p = this.players.get(pid);
			if (!p || dist(p, c) > 40) continue;
			const diff = c.level - p.level;
			const factor = diff <= -6 ? 0 : clamp(1 + 0.15 * diff, 0.2, 2);
			const xp = Math.round((20 + 12 * c.level) * factor * (sheet.boss ? 20 : 1));
			if (xp > 0) this.gainXp(p, xp);
			else this.notify(p, { t: 'chat', ch: 'sys', text: c.name + ' is too weak to teach you anything.' });
			p.kills++;
			if (p.autoTarget === c.id) p.autoTarget = 0;
			p.dirty = true;
			if (dmg > topDmg) { top = p; topDmg = dmg; }
		}
		if (!top) return;
		// Auto-loot goes to whoever did the most damage.
		const dappers = Math.round(c.level * (2 + this.rnd() * 2)) * (sheet.boss ? 50 : 1);
		top.dappers += dappers;
		let lootText = dappers + ' dappers';
		if (sheet.loot && (sheet.boss || this.rnd() < 0.65)) {
			this._give(top, sheet.loot, 1);
			lootText += ', ' + ITEMS[sheet.loot].name;
		}
		if (this.rnd() < 0.08) {
			this._give(top, 'potion', 1);
			lootText += ', Health Potion';
		}
		this.notify(top, { t: 'loot', text: 'Looted ' + lootText });
	}

	gainXp(p, amount) {
		if (p.level >= Rules.MAX_LEVEL) return;
		p.xp += amount;
		this.notify(p, { t: 'xp', v: amount });
		while (p.level < Rules.MAX_LEVEL && p.xp >= Rules.xpForLevel(p.level)) {
			p.xp -= Rules.xpForLevel(p.level);
			p.level++;
			this._recalcStats(p);
			p.hp = p.maxHp;
			p.sap = p.maxSap;
			p.sta = p.maxSta;
			this.emit(p.x, p.y, { e: 'levelup', id: p.id, l: p.level });
			if (this.onLevelUp) this.onLevelUp(p);
		}
		if (p.level >= Rules.MAX_LEVEL) p.xp = 0;
		p.dirty = true;
	}

	// --------------------------------------------------------------- inventory

	_give(p, item, n) {
		p.inventory[item] = (p.inventory[item] || 0) + n;
		p.dirty = true;
	}

	_consume(p, item, n) {
		p.inventory[item] -= n;
		if (p.inventory[item] <= 0) delete p.inventory[item];
		p.dirty = true;
	}

	buy(p, what) {
		if (!this.nearNpc(p, 'merchant')) return this._error(p, 'You must stand next to the merchant');
		if (SHOP.includes(what)) {
			const it = ITEMS[what];
			if (p.dappers < it.price) return this._error(p, 'Not enough dappers');
			p.dappers -= it.price;
			this._give(p, what, 1);
			return this.notify(p, { t: 'chat', ch: 'sys', text: 'Bought ' + it.name + ' for ' + it.price + ' dappers.' });
		}
		for (const slot of Object.keys(GEAR)) {
			const idx = GEAR[slot].findIndex((g) => g.id === what);
			if (idx < 0) continue;
			const cur = GEAR[slot].findIndex((g) => g.id === p.equip[slot]);
			if (idx <= cur) return this._error(p, 'You already own better gear');
			const g = GEAR[slot][idx];
			if (p.dappers < g.price) return this._error(p, 'Not enough dappers');
			p.dappers -= g.price;
			p.equip[slot] = g.id;
			p.dirty = true;
			return this.notify(p, { t: 'chat', ch: 'sys', text: 'Equipped ' + g.name + '.' });
		}
		this._error(p, 'Unknown item');
	}

	sellAll(p) {
		if (!this.nearNpc(p, 'merchant')) return this._error(p, 'You must stand next to the merchant');
		let total = 0;
		for (const [id, n] of Object.entries(p.inventory)) {
			if (SHOP.includes(id)) continue; // keep consumables
			total += (ITEMS[id] ? ITEMS[id].sell : 0) * n;
			delete p.inventory[id];
		}
		p.dappers += total;
		p.dirty = true;
		this.notify(p, { t: 'chat', ch: 'sys', text: total ? 'Sold materials for ' + total + ' dappers.' : 'Nothing to sell.' });
	}

	// ------------------------------------------------------------------- tick

	update(dt) {
		this.now = Date.now();
		for (const p of this.players.values()) this._updatePlayer(p, dt);
		for (const e of this.entities.values()) {
			if (e.kind === 'creature' && !e.alive && !e.corpseGone && this.now - e.deadAt > CORPSE_TIME) {
				e.corpseGone = true;
				this.matrix.remove(e);
				this.entities.delete(e.id);
				if (this.ai) this.ai.onCorpseRemoved(e);
			}
		}
	}

	_updatePlayer(p, dt) {
		if (!p.alive) return;
		// Regeneration (characteristics metabolism/wisdom/well_balanced in Ryzom)
		const inCombat = this.now - p.lastCombat < COMBAT_TIMEOUT;
		const safe = this.world.isSafe(p.x, p.y);
		const hpRate = inCombat ? 0.005 : safe ? 0.1 : 0.03;
		const sapRate = inCombat ? 0.01 : safe ? 0.1 : 0.03;
		const old = [p.hp, p.sap, p.sta].map(Math.floor);
		p.hp = Math.min(p.maxHp, p.hp + p.maxHp * hpRate * dt);
		p.sap = Math.min(p.maxSap, p.sap + p.maxSap * sapRate * dt);
		p.sta = Math.min(p.maxSta, p.sta + p.maxSta * 0.08 * dt);
		if (old[0] !== Math.floor(p.hp) || old[1] !== Math.floor(p.sap) || old[2] !== Math.floor(p.sta)) p.dirty = true;

		// Auto-attack: the client walks into range, the server swings.
		if (p.autoTarget) {
			const t = this.entities.get(p.autoTarget);
			if (!t || !t.alive) { p.autoTarget = 0; p.dirty = true; return; }
			const a = ACTIONS.attack;
			if (dist(p, t) <= a.range + 0.5 && this.now >= (p.cooldowns.attack || 0)) {
				this._startCooldown(p, 'attack', a);
				let base = (8 + 3 * p.level) * (1 + gearOf('weapon', p.equip.weapon).bonus);
				if (p.sta >= a.sta) p.sta -= a.sta;
				else base *= 0.5; // exhausted
				p.dirty = true;
				this._resolveHit(p, t, base, 'melee');
			}
		}
	}

	// --------------------------------------------------------------- snapshots

	enterInfo(e) {
		const info = { id: e.id, k: e.kind, n: e.name, l: e.level, x: +e.x.toFixed(2), y: +e.y.toFixed(2), hp: this.hpPct(e), f: this.flags(e) };
		if (e.kind === 'creature') { info.s = e.sheet; info.c = e.color; info.sz = e.size; if (e.boss) info.b = 1; }
		if (e.kind === 'npc') { info.c = e.color; info.r = e.role; info.sz = e.size; }
		if (e.kind === 'player') { info.g = [e.equip.weapon, e.equip.armor]; }
		return info;
	}

	hpPct(e) {
		return e.alive ? Math.max(1, Math.ceil((e.hp / e.maxHp) * 100)) : 0;
	}

	flags(e) {
		return (e.alive ? 0 : 1) | (this.now - (e.lastCombat || 0) < COMBAT_TIMEOUT ? 2 : 0) | (e.evading ? 4 : 0);
	}

	selfState(p) {
		const cds = {};
		for (const [k, v] of Object.entries(p.cooldowns)) if (v > this.now) cds[k] = v - this.now;
		return {
			t: 'me', id: p.id, name: p.name, level: p.level,
			hp: Math.ceil(p.hp), maxHp: p.maxHp, sap: Math.floor(p.sap), maxSap: p.maxSap,
			sta: Math.floor(p.sta), maxSta: p.maxSta,
			xp: Math.floor(p.xp), xpNext: Rules.xpForLevel(p.level),
			dappers: p.dappers, inventory: p.inventory, equip: p.equip,
			alive: p.alive, target: p.autoTarget, cds,
			region: p.region, kills: p.kills, deaths: p.deaths,
		};
	}
}

module.exports = { EntitiesGameService, gearOf };
