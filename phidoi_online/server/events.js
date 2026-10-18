// The living sky: ambient patrols, raids on Đà Nẵng landmarks and the world boss.
// The single-player missions of PaperWorld become shared world events: every few
// minutes the Black Ink Gang raids one landmark in waves taken from the original
// missions, scaled to the number of pilots who show up; every quarter hour the
// Giant Squid rises over the bay. Everyone nearby fights the same enemies.

import { coastX, KARST, gridH, SEA_Y, clamp } from '../shared/geo.js';
import { RAIDS, BOSS_LAIR, HUB, PVP } from '../shared/rules.js';
import { spawnEnemy, partMask } from './enemies.js';
import { reward } from './players.js';
import { v3, psiTo } from './vec.js';

/* ---------------------------------------------------------------- ambient sky */

// Fighter patrol areas (pairs of carbon-paper darts) and kite anchors.
const PATROLS = [
	{ name: 'Mỹ Khê', x: coastX(-800) + 260, z: -800, r: 900 },
	{ name: 'Sơn Trà', x: 1000, z: -2600, r: 900 },
	{ name: 'Ngũ Hành Sơn', x: 720, z: 880, r: 800 },
	{ name: 'Hội An', x: 900, z: 3350, r: 900 },
	{ name: 'Hải Vân', x: -2200, z: -3300, r: 900 },
	{ name: 'Bà Nà', x: -3000, z: -300, r: 900 },
	{ name: 'Cù Lao Chàm', x: PVP.x, z: PVP.z, r: 1000 },
	{ name: 'Cửa Đại', x: 1900, z: 3900, r: 800 },
];

function kiteSpots(W) {
	const s = [];
	for (let z = -1700; z <= 600; z += 230) s.push([coastX(z) + W.rr(60, 260), z]);
	for (const k of KARST) s.push([k[0] + k[2] * 1.5, k[1] + k[2] * 0.4]);
	s.push([1305, -2200], [1004, -2600], [686, -2500], [430, -2540], [2300, -2600]);
	s.push([560, 3560], [840, 3580], [1000, 3600], [1330, 3700]);
	s.push([3400, 2700], [4100, 2950], [3700, 3200]);
	s.push([-2220, -3400], [-3100, -400], [-2600, 1700], [1800, 2200], [2600, 600]);
	return s.filter(([x, z]) => Math.hypot(x - HUB.x, z - HUB.z) > HUB.safeR + 150);
}

export class Events {
	constructor(W, opts = {}) {
		this.W = W;
		this.o = Object.assign({ firstRaid: 60, raidGap: 150, raidWarn: 20, firstBoss: 300, bossGap: 900, bossLife: 720 }, opts);
		this.slots = []; // ambient spawns: { kind, make(), e, respawnAt }
		this.raid = null;
		this.lastRaid = null;
		this.nextRaidAt = W.t + this.o.firstRaid;
		this.boss = null;
		this.nextBossAt = W.t + this.o.firstBoss;
		W.raid = null;
		this._populate();
	}

	_populate() {
		const W = this.W;
		for (const [x, z] of kiteSpots(W)) {
			this.slots.push({
				respawn: [25, 45],
				make: () => {
					const y = Math.max(gridH(x, z), SEA_Y) + W.rr(45, 110);
					return spawnEnemy(W, 'kite', x, y, z, { anchor: v3(x, y, z) });
				},
			});
		}
		for (const A of PATROLS) {
			for (let i = 0; i < 2; i++) {
				this.slots.push({
					respawn: [35, 60],
					make: () => {
						const a = W.rnd() * 6.28, x = A.x + Math.cos(a) * A.r * 0.5, z = A.z + Math.sin(a) * A.r * 0.5;
						const y = Math.max(gridH(x, z), SEA_Y) + W.rr(140, 260);
						return spawnEnemy(W, 'fighter', x, y, z, { area: A, alt: y, ang: a });
					},
				});
			}
		}
		// one ace roams from area to area
		this.slots.push({
			respawn: [150, 210],
			make: () => {
				const A = W.pick(PATROLS.filter((p) => p.name !== 'Cù Lao Chàm'));
				const y = Math.max(gridH(A.x, A.z), SEA_Y) + 300;
				W.say('☠ Quạ Đen đang lượn trên ' + A.name);
				return spawnEnemy(W, 'ace', A.x, y, A.z, { area: A, alt: y });
			},
		});
		for (const s of this.slots) s.e = s.make();
	}

	_ambient() {
		const W = this.W;
		for (const s of this.slots) {
			if (s.e && s.e.alive) continue;
			if (s.e) { s.e = null; s.respawnAt = W.t + W.rr(s.respawn[0], s.respawn[1]); }
			if (W.t >= s.respawnAt) s.e = s.make();
		}
	}

	/* ------------------------------------------------------------- raids */

	_startRaid() {
		const W = this.W;
		const choices = RAIDS.filter((r) => !this.lastRaid || r.id !== this.lastRaid);
		const def = W.pick(choices);
		this.lastRaid = def.id;
		this.raid = W.raid = {
			id: def.id + '-' + Math.floor(W.t), def, name: def.name, icon: def.icon,
			lm: { x: def.x, y: def.y, z: def.z, r: def.r, hp: 100 },
			area: { x: def.x, z: def.z, r: def.radius },
			state: 'warn', stT: this.o.raidWarn, wave: -1, waves: 3, t: 0, helpers: new Set(),
		};
		W.say('⚠ Băng Mực Đen sắp tấn công ' + def.icon + ' ' + def.name + '! Các phi công hãy xuất kích');
		W.broadcast({ t: 'raid', st: 'warn', name: def.name, icon: def.icon, han: def.han, x: def.x, z: def.z, in: this.o.raidWarn });
	}

	_pilotsNear(x, z, r) {
		let n = 0;
		for (const P of this.W.players.values()) if (P.session && Math.hypot(P.pos.x - x, P.pos.z - z) < r) n++;
		return n;
	}

	// Formation helpers, as in the original missions (angles: 0 = east/sea, π/2 = south).
	_fighters(R, k, n, ang, d, alt) {
		const W = this.W, c = R.area;
		for (let i = 0; i < n; i++) {
			const a = ang + (i - (n - 1) / 2) * 0.1, x = c.x + Math.cos(a) * (d + i * 30), z = c.z + Math.sin(a) * (d + i * 30);
			spawnEnemy(W, k, x, Math.max(alt + W.rr(-20, 30), gridH(x, z) + 80), z, { psi: psiTo(c.x - x, c.z - z), area: R.area, raid: R.id });
		}
	}
	_bombers(R, n, ang, d, alt) {
		const W = this.W, L = R.lm;
		for (let i = 0; i < n; i++) {
			const a = ang + (i - (n - 1) / 2) * 0.09, x = L.x + Math.cos(a) * (d + i * 60), z = L.z + Math.sin(a) * (d + i * 60), y = Math.max(L.y + alt, 90);
			spawnEnemy(W, 'bomber', x, y, z, { psi: psiTo(L.x - x, L.z - z), st: 'run', alt: y + W.rr(-10, 10), lm: L, area: R.area, raid: R.id });
		}
	}
	_kites(R, list) {
		const W = this.W;
		for (const [x, z, h] of list) {
			const y = Math.max(gridH(x, z), SEA_Y) + h;
			spawnEnemy(W, 'kite', x, y, z, { anchor: v3(x, y, z), raid: R.id, area: R.area });
		}
	}

	// Waves per landmark, after the six single-player missions. s = squad scale (≥ 1).
	_wave(R, w, s) {
		const W = this.W, L = R.lm, n = (k) => Math.max(1, Math.round(k * s));
		const ring = (cnt, r0, r1, h0, h1) => [...Array(cnt)].map(() => { const a = W.rnd() * 6.28, r = W.rr(r0, r1); return [L.x + Math.cos(a) * r, L.z + Math.sin(a) * r, W.rr(h0, h1)]; });
		switch (R.def.id) {
		case 'mykhe':
			if (w === 0) return this._kites(R, [...Array(n(6))].map((_, i) => { const z = L.z + 600 - i * 220; return [coastX(z) + W.rr(40, 220), z, W.rr(30, 70)]; }));
			if (w === 1) { this._kites(R, ring(n(4), 200, 600, 40, 90)); return this._fighters(R, 'fighter', n(2), -0.25, 1200, 150); }
			this._bombers(R, n(2), 0.1, 1400, 120); return this._fighters(R, 'fighter', n(3), 0.3, 1300, 180);
		case 'dragon':
			if (w === 0) return this._fighters(R, 'fighter', n(3), -1.9, 1100, 170);
			if (w === 1) { this._bombers(R, n(2), 0.15, 1400, 120); return this._fighters(R, 'fighter', n(2), 0.3, 1300, 190); }
			this._bombers(R, n(2), -0.6, 1400, 130); this._bombers(R, n(1), 0.7, 1500, 115); return this._fighters(R, 'fighter', n(3), 0.1, 1300, 210);
		case 'sontra':
			if (w === 0) return this._fighters(R, 'fighter', n(4), -1.2, 1000, 270);
			if (w === 1) { this._fighters(R, 'fighter', n(3), 0.2, 1100, 300); return this._kites(R, ring(n(4), 120, 400, 50, 70)); }
			this._fighters(R, 'ace', 1, -0.4, 1100, 330); this._fighters(R, 'fighter', n(2), -0.7, 1150, 300); return this._bombers(R, n(2), 0.2, 1400, 140);
		case 'nonnuoc':
			if (w === 0) return this._kites(R, KARST.slice(0, n(6)).map((k) => { const a = W.rnd() * 6.28; return [k[0] + Math.cos(a) * k[2] * 1.45, k[1] + Math.sin(a) * k[2] * 1.45, k[3] * 0.55 + W.rr(8, 22)]; }));
			if (w === 1) { this._bombers(R, n(2), Math.PI, 1300, 110); return this._fighters(R, 'fighter', n(2), Math.PI * 0.92, 1200, 160); }
			this._bombers(R, n(3), 0.1, 1300, 120); return this._fighters(R, 'fighter', n(3), 0.3, 1200, 180);
		default: // hoian
			if (w === 0) { this._kites(R, ring(n(5), 80, 300, 25, 40)); return this._fighters(R, 'fighter', n(2), -0.2, 1200, 160); }
			if (w === 1) { this._bombers(R, n(3), 0.05, 1500, 120); return this._fighters(R, 'fighter', n(2), 0.2, 1400, 170); }
			this._bombers(R, n(2), -0.5, 1500, 120); this._bombers(R, n(2), 0.6, 1500, 130); return this._fighters(R, 'fighter', n(3), 0, 1400, 180);
		}
	}

	_raidAlive(R) {
		for (const e of this.W.enemies.values()) if (e.raid === R.id && e.alive) return true;
		return false;
	}

	_endRaid(won, reason) {
		const W = this.W, R = this.raid;
		R.state = won ? 'win' : 'fail';
		for (const e of [...W.enemies.values()]) if (e.raid === R.id) W.removeEnemy(e);
		const hpK = R.lm.hp / 100;
		const pay = new Set(R.helpers);
		for (const P of W.players.values()) if (P.session && Math.hypot(P.pos.x - R.lm.x, P.pos.z - R.lm.z) < R.area.r) pay.add(P.id);
		for (const id of pay) {
			const P = W.players.get(id);
			if (!P || !P.session) continue;
			if (won) { P.raids++; reward(W, P, Math.round(300 + 300 * hpK), Math.round(100 + 150 * hpK), 'Giữ ' + R.name); }
			else reward(W, P, 60, 20, 'Tham chiến ' + R.name);
		}
		if (won) W.say('🎆 ' + R.name + ' đã được giữ vững (' + Math.ceil(R.lm.hp) + '%) nhờ ' + pay.size + ' phi công!');
		else W.say('✂ ' + R.name + ' thất thủ: ' + reason);
		W.broadcast({ t: 'raid', st: won ? 'win' : 'fail', name: R.name, icon: R.def.icon, hp: Math.ceil(R.lm.hp), x: R.lm.x, z: R.lm.z, pilots: pay.size, reason: reason || '' });
		this.raid = W.raid = null;
		this.nextRaidAt = W.t + this.o.raidGap;
	}

	_updateRaid(dt) {
		const W = this.W, R = this.raid;
		R.t += dt;
		R.stT -= dt;
		if (R.state === 'warn' || R.state === 'between') {
			if (R.stT <= 0) {
				R.wave++;
				R.state = 'fight';
				const pilots = Math.max(1, this._pilotsNear(R.lm.x, R.lm.z, R.area.r * 1.5));
				this._wave(R, R.wave, clamp(1 + 0.4 * (pilots - 1), 1, 3));
				W.broadcast({ t: 'raid', st: 'wave', name: R.name, icon: R.def.icon, wave: R.wave + 1, waves: R.waves, x: R.lm.x, z: R.lm.z });
			}
		} else if (R.state === 'fight') {
			if (R.lm.hp <= 0) return this._endRaid(false, 'chìm trong mực');
			if (R.t > 480) return this._endRaid(false, 'Băng Mực Đen chiếm giữ quá lâu');
			if (!this._raidAlive(R)) {
				if (R.wave >= R.waves - 1) return this._endRaid(true);
				R.state = 'between';
				R.stT = 6;
			}
		}
	}

	/* ------------------------------------------------------------- world boss */

	_startBoss() {
		const W = this.W, c = BOSS_LAIR;
		const e = spawnEnemy(W, 'boss', c.x + 420, 250, c.z, { psi: Math.PI, area: { x: c.x, z: c.z, r: 1700 } });
		this.boss = { e, until: W.t + this.o.bossLife };
		W.say('🦑 MỰC KHỔNG LỒ trồi lên giữa ' + c.name + '! Mọi phi công tập hợp!');
		W.broadcast({ t: 'boss', st: 'rise', x: c.x, z: c.z });
	}

	_updateBoss() {
		const W = this.W, B = this.boss;
		if (!B.e.alive) {
			W.broadcast({ t: 'boss', st: 'down' });
			this.boss = null;
			this.nextBossAt = W.t + this.o.bossGap;
			return;
		}
		if (W.t > B.until) {
			W.removeEnemy(B.e);
			W.say('🦑 Mực Khổng Lồ đã lặn mất xuống vịnh…');
			W.broadcast({ t: 'boss', st: 'gone' });
			this.boss = null;
			this.nextBossAt = W.t + this.o.bossGap;
		}
	}

	update(dt) {
		const W = this.W;
		this._ambient();
		if (this.raid) this._updateRaid(dt);
		else if (W.t >= this.nextRaidAt) this._startRaid();
		if (this.boss) this._updateBoss();
		else if (W.t >= this.nextBossAt) this._startBoss();
	}

	// Compact world status for the HUD, sent to everyone once a second.
	status() {
		const W = this.W, R = this.raid, B = this.boss;
		return {
			t: 'w',
			raid: R ? { name: R.name, icon: R.def.icon, x: Math.round(R.lm.x), z: Math.round(R.lm.z), r: R.area.r, hp: Math.ceil(R.lm.hp), st: R.state, wave: R.wave + 1, waves: R.waves, in: Math.max(0, Math.ceil(R.stT)) } : null,
			boss: B ? { id: B.e.id, x: Math.round(B.e.pos.x), z: Math.round(B.e.pos.z), hp: Math.ceil((100 * B.e.hp) / B.e.hpMax), pods: B.e.podsLeft, mask: partMask(B.e), left: Math.ceil(B.until - W.t) } : null,
			nextRaid: R ? 0 : Math.max(0, Math.ceil(this.nextRaidAt - W.t)),
			nextBoss: B ? 0 : Math.max(0, Math.ceil(this.nextBossAt - W.t)),
			online: [...W.players.values()].filter((P) => P.session).length,
		};
	}
}
