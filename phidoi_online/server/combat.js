// Combat resolution on the server.
//  - Enemy bullets, ink blobs, bombs and the squid's missiles are simulated here
//    and hit pilots by their last reported position.
//  - Pilots simulate their own tracers and missiles for instant feedback and
//    report hits; the server checks each claim against a gun budget (bullets the
//    guns really fired), missiles in flight and plausible ranges before applying it.
//  - Kills pay XP and Ahamove xu to everyone who did damage, weighted by share.

import { gridH, SEA_Y, clamp } from '../shared/geo.js';
import { MISSILE_DMG, MISSILE_PART_DMG, EDMG, inPvp } from '../shared/rules.js';
import { v3, dist, segD2, sub, norm, dot } from './vec.js';
import { damagePlayer, reward } from './players.js';

const BMAX = 4000;
const GUN_RANGE = 1250, MISSILE_RANGE = 1900, BOSS_RANGE = 1500;
const CRATE_KINDS = ['repair', 'missile', 'flare'];

export function installCombat(W, hooks = {}) {
	W.addBullet = (x, y, z, vx, vy, vz, dmg, life, blob, g, src) => {
		if (W.bullets.length >= BMAX) return;
		const b = { p: v3(x, y, z), prev: v3(x, y, z), v: v3(vx, vy, vz), dmg, life, blob, g, src };
		W.bullets.push(b);
		const r = (n) => Math.round(n * 10) / 10;
		W.emit(x, z, { e: 'eb', b: [r(x), r(y), r(z), r(vx), r(vy), r(vz), blob, life] });
	};

	W.removeEnemy = (e) => {
		e.alive = false;
		W.enemies.delete(e.id);
		if (hooks.onEnemyGone) hooks.onEnemyGone(e);
	};

	// Is a pilot's missile chasing this enemy? (fighters break hard when locked)
	W.missileThreat = (e) => {
		for (const P of W.players.values()) {
			for (const m of P.misFlight) if (m.tgt === e.id && W.now - m.t < 6000 && dist(P.pos, e.pos) < 1500) return true;
		}
		return false;
	};

	let misId = 0;
	W.launchEnemyMissile = (e, from, P) => {
		sub(P.pos, from, W._tmp || (W._tmp = v3()));
		norm(W._tmp);
		const m = { id: ++misId, p: v3(from.x, from.y, from.z), prev: v3(from.x, from.y, from.z), dir: v3(W._tmp.x, W._tmp.y, W._tmp.z), spd: 30, life: 9, arm: 0.3, tgt: P, flare: null, src: e.id };
		W.missiles.set(m.id, m);
		W.emit(from.x, from.z, { e: 'emis', mid: m.id, p: [from.x, from.y, from.z].map(Math.round), d: [m.dir.x, m.dir.y, m.dir.z].map((n) => +n.toFixed(3)), tg: P.id });
	};
}

/* ---------------------------------------------------------------- enemy fire */

function bombHit(W, b) {
	const R = W.raid;
	if (!R || R.state !== 'fight') return;
	const L = R.lm;
	if (Math.hypot(b.p.x - L.x, b.p.z - L.z) < L.r) {
		L.hp = Math.max(0, L.hp - 5);
		W.emit(L.x, L.z, { e: 'lmhit', hp: Math.ceil(L.hp) });
	}
}

export function updateBullets(W, dt) {
	const list = W.bullets;
	for (let i = list.length - 1; i >= 0; i--) {
		const b = list[i];
		b.prev.x = b.p.x; b.prev.y = b.p.y; b.prev.z = b.p.z;
		if (b.g) b.v.y -= b.g * dt;
		b.p.x += b.v.x * dt; b.p.y += b.v.y * dt; b.p.z += b.v.z * dt;
		b.life -= dt;
		let dead = b.life <= 0;
		if (!dead) {
			for (const P of W.players.values()) {
				if (P.dead || !P.session) continue;
				const r = P.stats.radius + (b.blob === 2 ? 2.5 : 1);
				if (Math.abs(P.pos.x - b.p.x) > 60 || Math.abs(P.pos.z - b.p.z) > 60) continue;
				if (segD2(b.prev, b.p, P.pos) < r * r) {
					const src = W.enemies.get(b.src);
					// "from" points back along the bullet so the HUD shows where the fire came from
					const from = { x: b.p.x - b.v.x * 0.3, y: b.p.y - b.v.y * 0.3, z: b.p.z - b.v.z * 0.3 };
					damagePlayer(W, P, b.dmg, from, { name: src ? src.kd.name : 'Băng Mực Đen' });
					dead = true;
					break;
				}
			}
		}
		if (!dead && b.p.y < Math.max(gridH(b.p.x, b.p.z), SEA_Y)) {
			dead = true;
			if (b.blob === 2) bombHit(W, b);
		}
		if (dead) { list[i] = list[list.length - 1]; list.pop(); }
	}
}

export function updateEnemyMissiles(W, dt) {
	for (const [id, m] of W.missiles) {
		m.life -= dt;
		m.arm -= dt;
		m.spd = Math.min(100, m.spd + 55 * dt);
		const P = m.tgt;
		let tp = null;
		if (m.flare) tp = m.flare.life > 0 ? m.flare.p : null;
		else if (P && !P.dead && P.session) tp = P.pos;
		if (tp) {
			const d = dist(m.p, tp);
			const aim = v3(tp.x - m.p.x, tp.y - m.p.y, tp.z - m.p.z);
			if (!m.flare) { const k = Math.min(1.5, d / m.spd) * 0.7; aim.x += P.vel.x * k; aim.y += P.vel.y * k; aim.z += P.vel.z * k; }
			norm(aim);
			const ang = Math.acos(clamp(dot(m.dir, aim), -1, 1));
			if (ang > 1.9) { m.tgt = null; m.flare = null; }
			else if (ang > 1e-4) {
				const t = Math.min(1, (1.45 * dt) / ang);
				m.dir.x += (aim.x - m.dir.x) * t; m.dir.y += (aim.y - m.dir.y) * t; m.dir.z += (aim.z - m.dir.z) * t;
				norm(m.dir);
			}
		}
		if (m.flare) m.flare.life -= dt;
		m.prev.x = m.p.x; m.prev.y = m.p.y; m.prev.z = m.p.z;
		m.p.x += m.dir.x * m.spd * dt; m.p.y += m.dir.y * m.spd * dt; m.p.z += m.dir.z * m.spd * dt;
		let boom = m.life <= 0 || m.p.y < Math.max(gridH(m.p.x, m.p.z), SEA_Y);
		if (!boom && m.flare && segD2(m.prev, m.p, m.flare.p) < 81) boom = true;
		if (!boom && !m.flare && P && !P.dead && m.arm <= 0) {
			const r = P.stats.radius + 3.5;
			if (segD2(m.prev, m.p, P.pos) < r * r) {
				damagePlayer(W, P, EDMG.missile, { x: m.p.x - m.dir.x * 30, y: m.p.y - m.dir.y * 30, z: m.p.z - m.dir.z * 30 }, { name: 'tên lửa Mực Khổng Lồ' });
				boom = true;
			}
		}
		if (boom) {
			W.missiles.delete(id);
			W.emit(m.p.x, m.p.z, { e: 'mx', mid: id, p: [m.p.x, m.p.y, m.p.z].map(Math.round) });
		}
	}
}

// A pilot dropped flares: most ink missiles chasing them lose the lock.
export function dropFlares(W, P) {
	if (P.dead || P.flares <= 0) return;
	if (W.now - (P.flareAt || 0) < 900) return;
	P.flareAt = W.now;
	P.flares--;
	P.dirty = true;
	const flare = { p: v3(P.pos.x, P.pos.y - 3, P.pos.z), life: 3.4 };
	for (const m of W.missiles.values()) if (m.tgt === P && dist(m.p, P.pos) < 950 && W.rnd() < 0.88) { m.flare = flare; m.tgt = null; }
	W.emit(P.pos.x, P.pos.z, { e: 'flare', id: P.id });
}

/* ---------------------------------------------------------------- pilot fire */

function addDamage(e, P, d) {
	e.damageBy.set(P.id, (e.damageBy.get(P.id) || 0) + d);
}

function damageEnemy(W, e, P, d, partIdx) {
	if (!e.alive) return;
	if (e.parts) {
		let pt = e.parts[partIdx];
		if (!pt || !pt.alive) pt = e.parts.find((p) => p.alive && !p.core);
		if (!pt) pt = e.parts[e.parts.length - 1];
		if (pt.core && e.podsLeft > 0) return; // the armoured heart: break the ink sacs first
		const dd = Math.min(d, pt.hp);
		pt.hp -= dd;
		e.hp -= dd;
		addDamage(e, P, dd);
		if (pt.hp <= 0) {
			pt.alive = false;
			if (pt.core) return killEnemy(W, e, P);
			e.podsLeft--;
			W.emit(e.pos.x, e.pos.z, { e: 'pod', id: e.id, left: e.podsLeft });
			if (e.podsLeft === 0) { e.misT = 2; e.spawnT = 3; W.say('❤ Tim Mực Khổng Lồ đã lộ!'); }
		}
		return;
	}
	const dd = Math.min(d, e.hp);
	e.hp -= dd;
	addDamage(e, P, dd);
	if (e.hp <= 0) killEnemy(W, e, P);
}

export function killEnemy(W, e, killer) {
	if (!e.alive) return;
	W.emit(e.pos.x, e.pos.z, { e: 'kill', id: e.id, by: killer ? killer.id : 0 });
	W.removeEnemy(e);
	let total = 0;
	for (const d of e.damageBy.values()) total += d;
	for (const [pid, d] of e.damageBy) {
		const P = W.players.get(pid);
		if (!P || !P.session) continue;
		const share = Math.max(0.35, d / (total || 1));
		reward(W, P, Math.round(e.kd.xp * share), Math.round(e.kd.xu * share), e.kd.name);
		if (P === killer) P.kills++;
		if (e.k === 'boss') P.bosses++;
		if (e.raid && W.raid && W.raid.id === e.raid) W.raid.helpers.add(P.id);
	}
	if (e.k === 'boss') {
		W.say('🦑 Mực Khổng Lồ đã gục! Cảm ơn ' + [...e.damageBy.keys()].map((id) => (W.players.get(id) || {}).name).filter(Boolean).join(', '));
		for (let k = 0; k < 6; k++) spawnCrate(W, W.pick(CRATE_KINDS), e.pos.x + W.rr(-60, 60), e.pos.y, e.pos.z + W.rr(-60, 60));
	} else if (W.rnd() < 0.15) spawnCrate(W, W.pick(CRATE_KINDS), e.pos.x, e.pos.y + 10, e.pos.z);
	if (e.k === 'ace') W.say('☠ Quạ Đen bị ' + (killer ? killer.name : '?') + ' hạ gục');
}

// Gun hits: [[enemyId, part, bullets], ...]. Each bullet spends one token of the gun budget.
export function gunHits(W, P, list) {
	if (P.dead || !Array.isArray(list)) return;
	for (const h of list.slice(0, 32)) {
		if (!Array.isArray(h)) continue;
		const e = W.enemies.get(h[0] | 0);
		const n = Math.min(Math.max(h[2] | 0, 1), 20);
		if (!e || !e.alive) continue;
		const range = e.parts ? BOSS_RANGE : GUN_RANGE;
		if (dist(P.pos, e.pos) > range) continue;
		const ok = Math.min(n, Math.floor(P.gunTokens));
		if (ok <= 0) continue;
		P.gunTokens -= ok;
		damageEnemy(W, e, P, ok * P.stats.gunDmg, h[1] | 0);
	}
}

// Missile fired: spend one from the rack, remember it for the hit claim.
export function missileFired(W, P, tgt) {
	if (P.dead || P.missiles <= 0) return false;
	if (W.now - (P.misAt || 0) < 400) return false;
	P.misAt = W.now;
	P.missiles--;
	P.dirty = true;
	P.misFlight.push({ t: W.now, tgt: tgt | 0 });
	W.emit(P.pos.x, P.pos.z, { e: 'pmis', id: P.id, tg: tgt | 0 });
	return true;
}

export function missileHit(W, P, id, part, isPlayer) {
	// Prefer the missile that was locked on this target; a dumb-fired one can hit anything.
	let i = P.misFlight.findIndex((m) => m.tgt === (id | 0));
	if (i < 0) i = P.misFlight.length ? 0 : -1;
	if (i < 0) return;
	P.misFlight.splice(i, 1);
	if (isPlayer) {
		const Q = W.players.get(id | 0);
		if (Q && Q !== P && pvpAllowed(W, P, Q) && dist(P.pos, Q.pos) < MISSILE_RANGE) damagePlayer(W, Q, MISSILE_DMG * 0.75 * P.stats.missileMul, P.pos, { name: P.name, player: P });
		return;
	}
	const e = W.enemies.get(id | 0);
	if (!e || !e.alive || dist(P.pos, e.pos) > MISSILE_RANGE) return;
	damageEnemy(W, e, P, (e.parts ? MISSILE_PART_DMG : MISSILE_DMG) * P.stats.missileMul, part | 0);
}

export const pvpAllowed = (W, P, Q) => inPvp(P.pos.x, P.pos.z) && inPvp(Q.pos.x, Q.pos.z) && !Q.dead && W.now > Q.protectUntil && W.now > P.protectUntil;

// PvP gun hits: [[playerId, bullets], ...] — only inside the free-fire zone.
export function pvpHits(W, P, list) {
	if (P.dead || !Array.isArray(list)) return;
	for (const h of list.slice(0, 16)) {
		if (!Array.isArray(h)) continue;
		const Q = W.players.get(h[0] | 0);
		if (!Q || Q === P || !pvpAllowed(W, P, Q) || dist(P.pos, Q.pos) > GUN_RANGE) continue;
		const ok = Math.min(Math.min(Math.max(h[1] | 0, 1), 20), Math.floor(P.gunTokens));
		if (ok <= 0) continue;
		P.gunTokens -= ok;
		damagePlayer(W, Q, ok * P.stats.gunDmg, P.pos, { name: P.name, player: P });
	}
}

/* ---------------------------------------------------------------- crates */

export function spawnCrate(W, kind, x, y, z) {
	const c = { id: W.id(), type: 'crate', kind, pos: v3(x, y, z), landed: false, life: 45 };
	W.crates.set(c.id, c);
	return c;
}

export function updateCrates(W, dt) {
	for (const c of W.crates.values()) {
		c.life -= dt;
		const gnd = W.ground(c.pos.x, c.pos.z);
		if (!c.landed) {
			c.pos.y -= 3.2 * dt;
			if (c.pos.y < gnd + 1.3) { c.pos.y = gnd + 1.3; c.landed = true; }
		}
		if (c.life <= 0) W.crates.delete(c.id);
	}
}

export function pickCrate(W, P, id) {
	const c = W.crates.get(id | 0);
	if (!c || P.dead || dist(P.pos, c.pos) > 35) return;
	W.crates.delete(c.id);
	const S = P.stats;
	if (c.kind === 'repair') P.hp = Math.min(S.hpMax, P.hp + S.hpMax * 0.5);
	if (c.kind === 'missile') P.missiles = Math.min(S.missiles, P.missiles + Math.ceil(S.missiles * 0.6));
	if (c.kind === 'flare') P.flares = Math.min(S.flares, P.flares + 5);
	P.dirty = true;
	reward(W, P, 10, 5, '📦 Ahamove');
	W.notify(P, { t: 'picked', id: c.id, kind: c.kind });
}
