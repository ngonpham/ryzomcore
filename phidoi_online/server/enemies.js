// The Black Ink Gang's AI, run on the server for every pilot at once.
// Ported from the single-player PaperWorld phidoi/index.html (updateFighter,
// updateKite, updateBomber, updateBoss): the behaviours are the same, but each
// enemy now picks a target among all connected pilots, and "attack tokens"
// (only a few fighters press the attack on one pilot at a time) are handed out
// per pilot. Equivalent of the Ryzom AI service (ryzom/server/src/ai_service).

import { gridH, SEA_Y, angDiff, clamp, damp } from '../shared/geo.js';
import { ENEMY, EDMG, EBSPD, BOSS_POD_HP, BOSS_CORE_HP, BOSS_PODS, inSafe } from '../shared/rules.js';
import { v3, fwd, psiTo, leadPoint, dist, dot, norm, sub } from './vec.js';

const SLOTS = 2; // fighters allowed to attack the same pilot at once (THƯỜNG)
const _a = v3(), _b = v3(), _c = v3();

export function spawnEnemy(W, k, x, y, z, o = {}) {
	const kd = ENEMY[k];
	const e = {
		id: W.id(), type: 'enemy', k, kd,
		pos: v3(x, y, z), vel: v3(), psi: o.psi ?? W.rr(-3, 3), gam: 0, phi: 0,
		v: kd.v * (k === 'kite' || k === 'boss' ? 1 : W.rr(0.95, 1.08)),
		hp: kd.hp, hpMax: kd.hp, r: kd.r, alive: true,
		st: o.st || 'attack', stT: 0, fireT: W.rr(1.5, 3.5), burst: 0, gunT: 0,
		t: W.rnd() * 10, ph: W.rnd() * 6, anchor: o.anchor || null, lm: o.lm || null,
		alt: o.alt ?? y, minAlt: k === 'bomber' ? 60 : k === 'boss' ? 140 : 40,
		aim: v3(), ang: o.ang ?? W.rnd() * 6.28, brk: 1, clb: 0,
		area: o.area || null, raid: o.raid || null, group: o.group || null,
		target: null, tok: false, scanT: 0, damageBy: new Map(), born: W.now,
	};
	if (k === 'boss') initBoss(e);
	W.enemies.set(e.id, e);
	return e;
}

function initBoss(e) {
	e.parts = [];
	for (let i = 0; i < BOSS_PODS; i++) e.parts.push({ hp: BOSS_POD_HP, max: BOSS_POD_HP, alive: true, core: false });
	e.parts.push({ hp: BOSS_CORE_HP, max: BOSS_CORE_HP, alive: true, core: true });
	e.hp = e.hpMax = e.parts.reduce((s, p) => s + p.hp, 0);
	e.podsLeft = BOSS_PODS;
	e.misT = 6; e.flakT = 4; e.spawnT = 12;
	e.ang = 0;
	e.alt = 250;
}

// Bitmask of live boss parts (bit i = part i), sent to clients.
export const partMask = (e) => e.parts.reduce((m, p, i) => (p.alive ? m | (1 << i) : m), 0);

const playerVel = (P) => P.vel;
const targetable = (P) => P && !P.dead && P.session && !inSafe(P.pos.x, P.pos.z);

// Nearest valid pilot within range (re-evaluated a few times per second).
function pickTarget(W, e, range) {
	if ((e.scanT -= 1) > 0 && e.target && targetable(e.target) && dist(e.target.pos, e.pos) < range * 1.3) return e.target;
	e.scanT = 8;
	let best = null, bd = range;
	for (const P of W.players.values()) {
		if (!targetable(P)) continue;
		const d = dist(P.pos, e.pos);
		if (d < bd) { bd = d; best = P; }
	}
	e.target = best;
	return best;
}

/* steering with terrain look-ahead, a soft ceiling and the edge of the patrol/raid area */
function steerDir(W, e, psiT, gamT, dt, turn, gMax = 0.75) {
	const look = Math.max(e.v * 2.4, 45), fx = -Math.sin(e.psi), fz = -Math.cos(e.psi);
	const top = Math.max(gridH(e.pos.x, e.pos.z), gridH(e.pos.x + fx * look * 0.5, e.pos.z + fz * look * 0.5), gridH(e.pos.x + fx * look, e.pos.z + fz * look), SEA_Y);
	if (e.pos.y < top + e.minAlt) gamT = Math.max(gamT, 0.3 + (top + e.minAlt - e.pos.y) * 0.025);
	if (e.pos.y > 760) gamT = Math.min(gamT, -0.25);
	const A = e.area;
	if (A && !(e.tok && e.st !== 'patrol')) {
		const cx = e.pos.x - A.x, cz = e.pos.z - A.z, R = A.r * 1.15;
		if (cx * cx + cz * cz > R * R) psiT = psiTo(-cx, -cz);
	}
	// the gang keeps out of the Ahamove Sky Hub
	if (inSafe(e.pos.x + fx * 200, e.pos.z + fz * 200)) psiT = psiTo(e.pos.x - 235, e.pos.z + 1260);
	gamT = clamp(gamT, -gMax, gMax);
	const dpsi = clamp(angDiff(psiT, e.psi), -turn * dt, turn * dt);
	e.psi += dpsi;
	e.gam += clamp(gamT - e.gam, -turn * 0.8 * dt, turn * 0.8 * dt);
	e.phi = damp(e.phi, clamp((-dpsi / Math.max(dt, 1e-4) / turn) * 1.1, -1.25, 1.25), 4, dt);
}
function steerTo(W, e, tx, ty, tz, dt, turn, gMax) {
	const dx = tx - e.pos.x, dy = ty - e.pos.y, dz = tz - e.pos.z;
	steerDir(W, e, psiTo(dx, dz), Math.atan2(dy, Math.max(Math.hypot(dx, dz), 1)), dt, turn, gMax);
}
function moveEnemy(e, dt) {
	fwd(e.psi, e.gam, e.vel);
	e.vel.x *= e.v; e.vel.y *= e.v; e.vel.z *= e.v;
	e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt; e.pos.z += e.vel.z * dt;
}

export function enemyShoot(W, e, from, aim, spread, dmg, blob = 0, spd = EBSPD) {
	sub(aim, from, _c);
	norm(_c);
	_c.x += W.rr(-spread, spread); _c.y += W.rr(-spread, spread); _c.z += W.rr(-spread, spread);
	norm(_c);
	const vx = _c.x * spd + (blob ? 0 : e.vel.x), vy = _c.y * spd + (blob ? 0 : e.vel.y), vz = _c.z * spd + (blob ? 0 : e.vel.z);
	W.addBullet(from.x, from.y, from.z, vx, vy, vz, dmg, blob ? 4 : 2.3, blob, 0, e.id);
}

function patrol(W, e, dt, R, turnK = 0.8) {
	const A = e.area || { x: e.pos.x, z: e.pos.z };
	e.ang += (dt * e.v) / R;
	steerTo(W, e, A.x + Math.cos(e.ang) * R, e.alt, A.z + Math.sin(e.ang) * R, dt, e.kd.turn * turnK, 0.4);
}

/* fighters and aces: attack (lead pursuit), evade (break turn when someone is on their tail), extend */
function updateFighter(W, e, dt) {
	const kd = e.kd;
	const P = pickTarget(W, e, e.raid ? 1700 : 1150);
	if (!P) {
		e.st = 'attack';
		patrol(W, e, dt, e.area ? Math.min(e.area.r * 0.45, 520) : 420);
		e.v = damp(e.v, kd.v, 1, dt);
		moveEnemy(e, dt);
		return;
	}
	fwd(e.psi, e.gam, _a);
	e.stT -= dt;
	sub(P.pos, e.pos, _b);
	const d = Math.hypot(_b.x, _b.y, _b.z) || 1;
	_b.x /= d; _b.y /= d; _b.z /= d;
	const ahead = dot(_a, _b);
	const pf = fwd(P.psi, P.gam, _c);
	const onTail = ahead < -0.3 && -dot(pf, _b) > 0.8 && d < 400;
	const threat = W.missileThreat(e);
	if (e.st === 'attack') {
		if (e.stT <= 0 && ((onTail && W.rnd() < dt * 0.45) || (threat && W.rnd() < dt * 1.2))) { e.st = 'evade'; e.stT = W.rr(1.1, 2.2); e.brk = W.rnd() < 0.5 ? -1 : 1; e.clb = W.rr(-0.45, 0.6); }
		else if (d < 60) { e.st = 'extend'; e.stT = W.rr(1.8, 2.8); }
	} else if (e.stT <= 0) { e.st = 'attack'; e.stT = W.rr(3, 5.5); }
	if (e.st === 'attack' && d < 140 && ahead > 0.75 && dot(pf, _b) < -0.75) { e.st = 'evade'; e.stT = W.rr(1.2, 2); e.brk = W.rnd() < 0.5 ? -1 : 1; e.clb = 0.4; }
	let spd = kd.v;
	if (e.st === 'attack' && !e.tok) {
		// waiting for a turn to attack: circle the fight at a distance
		const a = e.ph + W.t * 0.25;
		steerTo(W, e, P.pos.x + Math.cos(a) * 480, clamp(P.pos.y + 25 * Math.sin(a * 2), 110, 480), P.pos.z + Math.sin(a) * 480, dt, kd.turn * 0.8);
		if (d > 900) spd *= 1.25;
	} else if (e.st === 'attack') {
		leadPoint(e.pos, P.pos, playerVel(P), EBSPD + e.v, e.aim);
		steerTo(W, e, e.aim.x, e.aim.y, e.aim.z, dt, kd.turn);
		if (d > 700) spd *= 1.3;
		sub(e.aim, e.pos, _c);
		norm(_c);
		const off = Math.acos(clamp(dot(_a, _c), -1, 1));
		if (e.burst <= 0 && (e.fireT -= dt) <= 0 && off < 0.1 && d < 520 && W.now > P.protectUntil) {
			e.burst = e.k === 'ace' ? 7 : 4;
			e.fireT = W.rr(1.1, 2.2);
		}
	} else if (e.st === 'evade') {
		steerDir(W, e, e.psi + e.brk * 1.6, e.clb, dt, kd.turn * 1.3);
		spd *= 1.15;
	} else {
		steerDir(W, e, e.psi, 0.12, dt, kd.turn);
		spd *= 1.1;
	}
	e.v = damp(e.v, spd, 1.2, dt);
	moveEnemy(e, dt);
	if (e.burst > 0 && (e.gunT -= dt) <= 0) {
		e.gunT = 0.075;
		e.burst--;
		fwd(e.psi, e.gam, _c);
		_a.x = e.pos.x + _c.x * e.r; _a.y = e.pos.y + _c.y * e.r; _a.z = e.pos.z + _c.z * e.r;
		enemyShoot(W, e, _a, e.aim, 0.04, e.k === 'ace' ? EDMG.ace : EDMG.fighter);
	}
}

/* kites: bob around their anchor, stare at the nearest pilot and spit ink */
function updateKite(W, e, dt) {
	e.t += dt;
	const A = e.anchor;
	let tx = A.x + Math.cos(e.t * 0.22 + e.ph) * 45, ty = A.y + Math.sin(e.t * 0.7 + e.ph) * 7, tz = A.z + Math.sin(e.t * 0.22 + e.ph) * 45;
	const P = pickTarget(W, e, 520);
	let d = 1e9;
	if (P) {
		d = dist(e.pos, P.pos);
		const k = Math.min(1, 90 / Math.max(d, 1));
		tx += (P.pos.x - tx) * k * 0.6;
		tz += (P.pos.z - tz) * k * 0.6;
		ty = Math.max(ty, Math.min(P.pos.y, A.y + 60));
	}
	_a.x = tx - e.pos.x; _a.y = ty - e.pos.y; _a.z = tz - e.pos.z;
	const l = Math.hypot(_a.x, _a.y, _a.z) || 1, s = Math.min(e.kd.v, l * 0.9) / l;
	e.vel.x = _a.x * s; e.vel.y = _a.y * s; e.vel.z = _a.z * s;
	e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt; e.pos.z += e.vel.z * dt;
	const fx = P ? P.pos.x - e.pos.x : 1, fz = P ? P.pos.z - e.pos.z : 0;
	e.psi += angDiff(psiTo(fx, fz), e.psi) * (1 - Math.exp(-2.5 * dt));
	e.gam = 0;
	e.phi = Math.sin(e.t * 1.3 + e.ph) * 0.18;
	if (P && d < 460 && (e.fireT -= dt) <= 0 && W.now > P.protectUntil) {
		e.fireT = W.rr(2.4, 4.2);
		leadPoint(e.pos, P.pos, playerVel(P), 140, e.aim);
		enemyShoot(W, e, e.pos, e.aim, 0.05, EDMG.kite, 1, 140);
	}
}

/* bombers: run in on the landmark, drop a stick of ink bombs, swing round, repeat */
function updateBomber(W, e, dt) {
	const kd = e.kd, L = e.lm;
	e.stT -= dt;
	if (!L) {
		patrol(W, e, dt, 520, 1);
		moveEnemy(e, dt);
	} else {
		const dx = L.x - e.pos.x, dz = L.z - e.pos.z, hd = Math.hypot(dx, dz), fx = -Math.sin(e.psi), fz = -Math.cos(e.psi);
		if (e.st === 'drop') {
			steerDir(W, e, e.psi, 0, dt, kd.turn, 0.3);
			if ((e.dropT -= dt) <= 0) {
				e.dropT = 0.3;
				W.addBullet(e.pos.x + W.rr(-3, 3), e.pos.y - 2, e.pos.z + W.rr(-1, 1), e.vel.x, -3, e.vel.z, EDMG.bomb, 14, 2, 24, e.id);
			}
			if (e.stT <= 0) { e.st = 'leave'; e.stT = W.rr(9, 13); e.lx = L.x + fx * 900 + W.rr(-200, 200); e.lz = L.z + fz * 900 + W.rr(-200, 200); }
		} else if (e.st === 'leave') {
			steerTo(W, e, e.lx, e.alt, e.lz, dt, kd.turn, 0.3);
			if (e.stT <= 0) e.st = 'run';
		} else {
			steerTo(W, e, L.x, e.alt, L.z, dt, kd.turn, 0.3);
			if (hd < 120 && dx * fx + dz * fz > 0) { e.st = 'drop'; e.stT = 2.8; e.dropT = 0; }
		}
		e.v = damp(e.v, kd.v, 1, dt);
		moveEnemy(e, dt);
	}
	// tail gunner: shoots whoever sits behind the wing
	const P = pickTarget(W, e, 400);
	if (P && W.now > P.protectUntil) {
		sub(P.pos, e.pos, _b);
		const d = Math.hypot(_b.x, _b.y, _b.z);
		if (dot(fwd(e.psi, e.gam, _a), _b) < d * 0.25 && e.burst <= 0 && (e.fireT -= dt) <= 0) { e.burst = 4; e.fireT = W.rr(1.3, 2.4); }
		if (e.burst > 0 && (e.gunT -= dt) <= 0) {
			e.gunT = 0.11;
			e.burst--;
			fwd(e.psi, e.gam, _a);
			_c.x = e.pos.x - _a.x * 4.2; _c.y = e.pos.y + 1.4; _c.z = e.pos.z - _a.z * 4.2;
			leadPoint(_c, P.pos, playerVel(P), EBSPD, e.aim);
			enemyShoot(W, e, _c, e.aim, 0.05, EDMG.tail);
		}
	} else e.burst = 0;
}

/* Mực Khổng Lồ: circles the bay, fires ink missiles and flak, calls in kites and fighters */
function updateBoss(W, e, dt) {
	const ph2 = e.podsLeft === 0, C = e.area;
	e.t += dt;
	const R = 420;
	e.ang += ((ph2 ? 16 : 11) / R) * dt;
	const ty = e.alt + Math.sin(e.t * 0.3) * 25;
	steerTo(W, e, C.x + Math.cos(e.ang + 0.35) * R, ty, C.z + Math.sin(e.ang + 0.35) * R, dt, 0.35, 0.2);
	e.v = damp(e.v, ph2 ? 16 : 11, 0.5, dt);
	moveEnemy(e, dt);
	const P = pickTarget(W, e, 1600);
	if (!P) return;
	const d = dist(e.pos, P.pos);
	if ((e.misT -= dt) <= 0) {
		e.misT = ph2 ? 4.5 : 7.5;
		for (let k = 0; k < 2; k++) {
			_a.x = e.pos.x + W.rr(-20, 20); _a.y = e.pos.y + W.rr(-5, 5); _a.z = e.pos.z + W.rr(-20, 20);
			W.launchEnemyMissile(e, _a, P);
		}
	}
	if ((e.flakT -= dt) <= 0 && d < 600) {
		e.flakT = ph2 ? 2.3 : 3.6;
		_a.x = e.pos.x; _a.y = e.pos.y - 15; _a.z = e.pos.z;
		leadPoint(_a, P.pos, playerVel(P), 130, e.aim);
		for (let k = 0; k < (ph2 ? 12 : 8); k++) enemyShoot(W, e, _a, e.aim, 0.13, EDMG.flak, 1, 130);
	}
	if ((e.spawnT -= dt) <= 0) {
		e.spawnT = ph2 ? 15 : 19;
		let kites = 0, ftr = 0;
		for (const x of W.enemies.values()) if (x.group === e.id) { if (x.k === 'kite') kites++; else ftr++; }
		for (let k = 0; k < 2 && kites + k < 6; k++) {
			const x = e.pos.x + W.rr(-60, 60), z = e.pos.z + W.rr(-60, 60), y = e.pos.y - 40;
			spawnEnemy(W, 'kite', x, y, z, { anchor: v3(x, W.ground(x, z) + W.rr(90, 160), z), group: e.id, area: e.area });
		}
		if (ph2 && ftr < 3) spawnEnemy(W, 'fighter', e.pos.x, e.pos.y - 30, e.pos.z, { psi: e.psi, group: e.id, area: { x: C.x, z: C.z, r: 1700 } });
	}
}

// Hand out attack tokens: each pilot is pressed by at most SLOTS fighters, aces first.
function assignTokens(W) {
	const byTarget = new Map();
	for (const e of W.enemies.values()) {
		e.tok = false;
		if (!e.alive || (e.k !== 'fighter' && e.k !== 'ace') || !e.target) continue;
		if (!byTarget.has(e.target)) byTarget.set(e.target, []);
		byTarget.get(e.target).push(e);
	}
	for (const [P, list] of byTarget) {
		list.sort((a, b) => dist(a.pos, P.pos) - (a.k === 'ace' ? 1e4 : 0) - (dist(b.pos, P.pos) - (b.k === 'ace' ? 1e4 : 0)));
		for (let i = 0; i < list.length && i < SLOTS; i++) list[i].tok = true;
	}
}

let tokenT = 0;
export function updateEnemies(W, dt) {
	if ((tokenT -= dt) <= 0) { tokenT = 0.25; assignTokens(W); }
	for (const e of W.enemies.values()) {
		if (!e.alive) continue;
		if (e.k === 'kite') updateKite(W, e, dt);
		else if (e.k === 'bomber') updateBomber(W, e, dt);
		else if (e.k === 'boss') updateBoss(W, e, dt);
		else updateFighter(W, e, dt);
		if (e.k !== 'kite' && e.k !== 'boss' && e.pos.y < W.ground(e.pos.x, e.pos.z) + 1.5) {
			W.emit(e.pos.x, e.pos.z, { e: 'crashE', id: e.id });
			W.removeEnemy(e);
		}
	}
}

