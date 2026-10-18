// Pilots: state reported by clients (validated), health and ammunition
// (server-authoritative), progression, hangar upgrades, death and respawn.
// Equivalent of the character part of the Ryzom EGS plus the GPMS move checker.

import { CRAFT, pilotStats, xpFor, MAX_LEVEL, UPGRADES, UPGRADE_COST, UPGRADE_MAX, PADS, SPAWN, inPvp, inSafe } from '../shared/rules.js';
import { WX0, WZ0, WSIZE } from '../shared/geo.js';
import { v3 } from './vec.js';

const MODES = ['fly', 'water', 'landed', 'crash'];
const PROTECT_MS = 3000;

export function createPlayer(W, name, save) {
	const P = {
		id: W.id(), type: 'player', name,
		level: Math.min(MAX_LEVEL, save.level || 1), xp: save.xp || 0, totalXp: save.totalXp || 0, xu: save.xu || 0,
		up: Object.assign({ gun: 0, armor: 0, missile: 0, flare: 0 }, save.up || {}),
		craft: CRAFT[save.craft] ? save.craft : 'jet',
		kills: save.kills || 0, deaths: save.deaths || 0, pvp: save.pvp || 0, bosses: save.bosses || 0, raids: save.raids || 0,
		pos: v3(SPAWN.x, SPAWN.y, SPAWN.z), vel: v3(), psi: SPAWN.psi, gam: 0, phi: 0, mode: 'fly',
		firing: false, lastFireAt: 0, gunTokens: 0, misFlight: [], lastStAt: W.now, allowJump: true, seq: 0,
		dead: false, protectUntil: W.now + PROTECT_MS, lastHurtAt: 0, padT: 0,
		session: null, dirty: true, stats: null, hp: 0, missiles: 0, flares: 0,
		raidDmg: 0, raidId: null,
	};
	if (CRAFT[P.craft].unlock > P.level) P.craft = 'jet';
	refreshStats(P, true);
	W.players.set(P.id, P);
	return P;
}

export function refreshStats(P, refill) {
	const old = P.stats;
	P.stats = pilotStats(P.craft, P.level, P.up);
	if (refill || !old) {
		P.hp = P.stats.hpMax;
		P.missiles = P.stats.missiles;
		P.flares = P.stats.flares;
	} else {
		P.hp = Math.min(P.stats.hpMax, P.hp + Math.max(0, P.stats.hpMax - old.hpMax));
		P.missiles = Math.min(P.stats.missiles, P.missiles + Math.max(0, P.stats.missiles - old.missiles));
		P.flares = Math.min(P.stats.flares, P.flares + Math.max(0, P.stats.flares - old.flares));
	}
	P.dirty = true;
}

export function saveData(P) {
	return {
		level: P.level, xp: Math.floor(P.xp), totalXp: Math.floor(P.totalXp), xu: Math.floor(P.xu), up: P.up, craft: P.craft,
		kills: P.kills, deaths: P.deaths, pvp: P.pvp, bosses: P.bosses, raids: P.raids,
	};
}

const finite = (...a) => a.every((v) => typeof v === 'number' && Number.isFinite(v));

// Client state report: position, velocity, attitude, flight mode, trigger.
// Returns false when the position must be corrected (speed hack, teleport).
export function clientState(W, P, m) {
	const x = +m.x, y = +m.y, z = +m.z;
	if (!finite(x, y, z)) return true;
	// Reports sent before the client saw our last teleport/correction are stale.
	if ((m.q | 0) !== P.seq) return true;
	const elapsed = Math.min(1.5, Math.max(0.001, (W.now - P.lastStAt) / 1000));
	P.lastStAt = W.now;
	if (P.dead) return true; // the wreck is falling client-side; wait for "respawned"
	const out = x < WX0 - 2000 || x > WX0 + WSIZE + 2000 || z < WZ0 - 2000 || z > WZ0 + WSIZE + 2000 || y > 2500 || y < -50;
	const d = Math.hypot(x - P.pos.x, y - P.pos.y, z - P.pos.z);
	const maxD = (P.stats.vmax * 1.6 + 30) * elapsed + 25;
	if (!P.allowJump && (out || d > maxD)) return false;
	if (out) return false;
	P.allowJump = false;
	P.pos.x = x; P.pos.y = y; P.pos.z = z;
	if (finite(+m.vx, +m.vy, +m.vz)) { P.vel.x = +m.vx; P.vel.y = +m.vy; P.vel.z = +m.vz; }
	if (finite(+m.psi, +m.gam, +m.phi)) { P.psi = +m.psi; P.gam = +m.gam; P.phi = +m.phi; }
	P.mode = MODES.includes(m.m) ? m.m : 'fly';
	const firing = !!m.f;
	if (firing) P.lastFireAt = W.now;
	if (firing !== P.firing) P.firing = firing;
	const pvp = inPvp(x, z), safe = inSafe(x, z);
	if (pvp !== P.inPvp || safe !== P.inSafe) {
		P.inPvp = pvp; P.inSafe = safe; P.dirty = true;
		if (pvp) W.notify(P, { t: 'zone', z: 'pvp' });
		else if (safe) W.notify(P, { t: 'zone', z: 'safe' });
		else W.notify(P, { t: 'zone', z: 'open' });
	}
	return true;
}

export function updatePlayers(W, dt) {
	for (const P of W.players.values()) {
		if (P.dead || !P.session) continue;
		// gun budget: bullets reported as hits can't exceed what the guns fired
		const firingNow = W.now - P.lastFireAt < 400;
		const cap = P.stats.rate * 3;
		if (firingNow) P.gunTokens = Math.min(cap, P.gunTokens + P.stats.rate * 1.3 * dt);
		else if (W.now - P.lastFireAt > 3000) P.gunTokens = Math.max(0, P.gunTokens - P.stats.rate * dt);
		P.misFlight = P.misFlight.filter((m) => W.now - m.t < 9000);
		// repairs: Ahamove pads (full service), the seaplane on water, slow mending at the hub
		const old = [Math.floor(P.hp), P.missiles, P.flares];
		if (P.mode === 'landed') {
			const pad = PADS.find((p) => Math.hypot(p.x - P.pos.x, p.z - P.pos.z) < p.r + 4 && Math.abs(p.y - P.pos.y) < 6);
			if (pad) {
				P.hp = Math.min(P.stats.hpMax, P.hp + 18 * dt);
				if ((P.padT += dt) > 0.8) {
					P.padT = 0;
					P.missiles = Math.min(P.stats.missiles, P.missiles + 1);
					P.flares = Math.min(P.stats.flares, P.flares + 1);
				}
			} else P.hp = Math.min(P.stats.hpMax, P.hp + 4 * dt);
		} else if (P.mode === 'water' && P.craft === 'seaplane' && P.pos.y < 4) {
			P.hp = Math.min(P.stats.hpMax, P.hp + 7 * dt);
		} else if (P.inSafe && W.now - P.lastHurtAt > 8000) {
			P.hp = Math.min(P.stats.hpMax, P.hp + 3 * dt);
		}
		if (old[0] !== Math.floor(P.hp) || old[1] !== P.missiles || old[2] !== P.flares) P.dirty = true;
	}
}

export function damagePlayer(W, P, d, from, by) {
	if (P.dead || !P.session || W.now < P.protectUntil || P.inSafe) return;
	P.hp -= d;
	P.lastHurtAt = W.now;
	P.dirty = true;
	W.notify(P, { t: 'hurt', d: Math.round(d * 10) / 10, fx: Math.round(from.x), fy: Math.round(from.y), fz: Math.round(from.z) });
	if (P.hp <= 0) killPlayer(W, P, by);
}

// by: { name, player? } — a pilot shot down by another pilot earns them a bounty.
export function killPlayer(W, P, by, why) {
	if (P.dead) return;
	P.dead = true;
	P.hp = 0;
	P.deaths++;
	P.firing = false;
	P.dirty = true;
	const killer = by && by.player;
	W.notify(P, { t: 'down', by: by ? by.name : '', why: why || '' });
	W.emit(P.pos.x, P.pos.z, { e: 'pdown', id: P.id });
	if (killer && killer !== P) {
		killer.pvp++;
		killer.kills++;
		reward(W, killer, 80 + 15 * P.level, 30 + 5 * P.level, 'Hạ ' + P.name);
		W.say('⚔ ' + killer.name + ' bắn hạ ' + P.name + ' trên ' + 'Cù Lao Chàm');
	} else if (by) {
		W.say('✂ ' + P.name + ' bị ' + by.name + ' bắn rơi');
	} else {
		W.say('✂ ' + P.name + ' ' + (why || 'rơi xuống'));
	}
}

export function respawned(W, P) {
	if (!P.dead) return;
	P.dead = false;
	refreshStats(P, true);
	P.protectUntil = W.now + PROTECT_MS;
	P.allowJump = true;
	P.lastStAt = W.now;
	P.dirty = true;
}

// Fly back to the Sky Hub (the hangar), e.g. to change aircraft.
export function goHome(W, P, force) {
	if (!force && W.now - P.lastHurtAt < 8000) return W.notify(P, { t: 'err', text: 'Đang giao chiến — chưa thể về Sky Hub' });
	P.dead = false;
	P.allowJump = true;
	P.protectUntil = W.now + PROTECT_MS;
	teleport(W, P, SPAWN.x, SPAWN.y, SPAWN.z, SPAWN.psi);
}

// Server-imposed position: bump the sequence so in-flight reports are ignored.
export function teleport(W, P, x, y, z, psi) {
	P.seq++;
	P.allowJump = true;
	P.pos.x = x; P.pos.y = y; P.pos.z = z;
	P.lastStAt = W.now;
	P.dirty = true;
	W.notify(P, { t: 'spawn', x, y, z, psi, q: P.seq });
}

// Rejected report: send the pilot back to the last good position.
export function correct(W, P) {
	P.seq++;
	W.notify(P, { t: 'correct', x: P.pos.x, y: P.pos.y, z: P.pos.z, q: P.seq });
}

export function setCraft(W, P, id) {
	const C = CRAFT[id];
	if (!C) return;
	if (C.unlock > P.level) return W.notify(P, { t: 'err', text: C.name + ' mở khoá ở cấp ' + C.unlock });
	if (P.craft === id) return;
	const ok = P.dead || P.inSafe || P.mode === 'landed';
	if (!ok) return W.notify(P, { t: 'err', text: 'Về Sky Hub hoặc đáp xuống bãi chữ H để đổi máy bay' });
	P.craft = id;
	refreshStats(P, true);
	goHome(W, P, true);
	W.notify(P, { t: 'craft', c: id });
}

export function buyUpgrade(W, P, u) {
	if (!Object.hasOwn(UPGRADES, u)) return;
	const tier = P.up[u] || 0;
	if (tier >= UPGRADE_MAX) return W.notify(P, { t: 'err', text: 'Đã nâng cấp tối đa' });
	const cost = UPGRADE_COST[tier];
	if (P.xu < cost) return W.notify(P, { t: 'err', text: 'Không đủ xu Ahamove (cần ' + cost + ')' });
	P.xu -= cost;
	P.up[u] = tier + 1;
	refreshStats(P, false);
	W.notify(P, { t: 'info', text: UPGRADES[u].icon + ' ' + UPGRADES[u].name + ' cấp ' + P.up[u] });
}

export function reward(W, P, xp, xu, label) {
	P.xu += xu;
	gainXp(W, P, xp);
	W.notify(P, { t: 'reward', xp, xu, label: label || '' });
	P.dirty = true;
}

export function gainXp(W, P, amount) {
	P.totalXp += amount;
	if (P.level >= MAX_LEVEL) return;
	P.xp += amount;
	while (P.level < MAX_LEVEL && P.xp >= xpFor(P.level)) {
		P.xp -= xpFor(P.level);
		P.level++;
		refreshStats(P, false);
		W.notify(P, { t: 'lvl', l: P.level });
		W.say('★ ' + P.name + ' lên cấp ' + P.level);
		for (const C of Object.values(CRAFT)) if (C.unlock === P.level) W.notify(P, { t: 'info', text: 'Mở khoá ' + C.icon + ' ' + C.name + '!' });
	}
	if (P.level >= MAX_LEVEL) P.xp = 0;
}

export function selfState(W, P) {
	return {
		t: 'me', id: P.id, name: P.name, craft: P.craft, level: P.level, xp: Math.floor(P.xp), xpNext: xpFor(P.level), xu: Math.floor(P.xu),
		hp: Math.ceil(Math.max(0, P.hp)), hpMax: P.stats.hpMax, missiles: P.missiles, missilesMax: P.stats.missiles,
		flares: P.flares, flaresMax: P.stats.flares, up: P.up, dead: P.dead,
		kills: P.kills, deaths: P.deaths, pvp: P.pvp, bosses: P.bosses, raids: P.raids,
		pvpZone: !!P.inPvp, safe: !!P.inSafe, dmg: +P.stats.gunDmg.toFixed(2),
	};
}

