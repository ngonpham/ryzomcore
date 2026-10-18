// Server gameplay tests on a World without networking: `npm test`.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { sample, gridH, coastX, buildHeights } from '../shared/geo.js';
import { CRAFT, xpFor, PVP, HUB, PADS, UPGRADE_COST, RAIDS } from '../shared/rules.js';
import { World } from '../server/world.js';
import { installCombat, updateBullets, updateEnemyMissiles, updateCrates, gunHits, missileFired, missileHit, pvpHits, spawnCrate, pickCrate, dropFlares } from '../server/combat.js';
import { spawnEnemy, updateEnemies } from '../server/enemies.js';
import { createPlayer, clientState, updatePlayers, gainXp, buyUpgrade, setCraft, teleport } from '../server/players.js';
import { Events } from '../server/events.js';
import { Persistence } from '../server/persistence.js';

let seed = 1;
const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function shard(eventOpts) {
	seed = 7;
	const W = new World({ random: rng });
	installCombat(W);
	W.msgs = [];
	W.notify = (P, m) => W.msgs.push({ to: P.name, ...m });
	W.broadcast = (m) => W.msgs.push({ to: '*', ...m });
	W.step = (dt = 0.05, n = 1) => {
		for (let i = 0; i < n; i++) {
			W.now += dt * 1000; W.t += dt;
			updatePlayers(W, dt); updateEnemies(W, dt); updateBullets(W, dt); updateEnemyMissiles(W, dt); updateCrates(W, dt);
			if (W.ev) W.ev.update(dt);
		}
	};
	if (eventOpts) W.ev = new Events(W, eventOpts);
	return W;
}
function pilot(W, name, x, y, z, save = {}) {
	const P = createPlayer(W, name, save);
	P.session = {};
	P.pos = { x, y, z };
	P.protectUntil = 0;
	return P;
}
const fire = (W, P, seconds) => { for (let i = 0; i < seconds * 20; i++) { P.lastFireAt = W.now; W.step(); } };
const sent = (W, name, t) => W.msgs.filter((m) => m.to === name && m.t === t);

test('geography: shared terrain matches the browser build of PaperWorld', () => {
	// values read from window.__pd in the original game running in Chromium
	buildHeights();
	assert.strictEqual(sample(1000, -2740), 218.26971342195043);
	assert.strictEqual(gridH(235, -1260), 2.5751139521598816);
	assert.ok(sample(3000, 0) < 0, 'open sea is below sea level');
	assert.ok(sample(RAIDS[3].x, RAIDS[3].z) > 0, 'Non Nước is on land');
});

test('ai: kites and fighters attack a pilot and their fire hurts', () => {
	const W = shard();
	const P = pilot(W, 'Bait', coastX(-800) + 200, 150, -800);
	spawnEnemy(W, 'fighter', P.pos.x + 900, 160, P.pos.z, { area: { x: P.pos.x, z: P.pos.z, r: 900 } });
	spawnEnemy(W, 'kite', P.pos.x + 150, 150, P.pos.z, { anchor: { x: P.pos.x + 150, y: 150, z: P.pos.z } });
	W.step(0.05, 20 * 30);
	assert.ok(sent(W, 'Bait', 'hurt').length > 3, 'pilot got shot');
	assert.ok(P.hp < P.stats.hpMax || P.dead);
});

test('ai: the gang never attacks inside the Ahamove Sky Hub', () => {
	const W = shard();
	const P = pilot(W, 'Safe', HUB.x, 160, HUB.z);
	P.inSafe = true;
	spawnEnemy(W, 'kite', HUB.x + 100, 160, HUB.z, { anchor: { x: HUB.x + 100, y: 160, z: HUB.z } });
	W.step(0.05, 20 * 20);
	assert.strictEqual(sent(W, 'Safe', 'hurt').length, 0);
});

test('combat: gun hits need bullets actually fired, in range', () => {
	const W = shard();
	const P = pilot(W, 'Gunner', 1000, 300, 1000);
	const e = spawnEnemy(W, 'fighter', 1050, 300, 1000);
	gunHits(W, P, [[e.id, -1, 20]]);
	assert.strictEqual(e.hp, e.hpMax, 'no trigger pulled: claim rejected');
	fire(W, P, 0.3);
	e.pos = { x: 1050, y: 300, z: 1000 };
	gunHits(W, P, [[e.id, -1, 2]]);
	assert.ok(e.hp < e.hpMax, 'two bullets land');
	const far = spawnEnemy(W, 'fighter', 4000, 300, 1000);
	fire(W, P, 1);
	gunHits(W, P, [[far.id, -1, 5]]);
	assert.strictEqual(far.hp, far.hpMax, 'out of range');
});

test('combat: kills pay XP and xu to every contributor', () => {
	const W = shard();
	const A = pilot(W, 'Ace', 1000, 300, 1000), B = pilot(W, 'Wing', 1010, 300, 1000);
	const e = spawnEnemy(W, 'fighter', 1060, 300, 1000);
	fire(W, A, 1); fire(W, B, 1);
	e.pos = { x: 1060, y: 300, z: 1000 };
	gunHits(W, B, [[e.id, -1, 3]]);
	gunHits(W, A, [[e.id, -1, 10]]);
	assert.ok(!e.alive);
	assert.strictEqual(A.kills, 1);
	assert.ok(A.xp > 0 && B.xp > 0, 'both rewarded');
	assert.ok(A.xp > B.xp, 'bigger share pays more');
	assert.ok(B.xp >= Math.round(60 * 0.35), 'assists get at least 35%');
});

test('combat: missiles must be fired before they can hit', () => {
	const W = shard();
	const P = pilot(W, 'Rocket', 1000, 300, 1000);
	const e = spawnEnemy(W, 'bomber', 1300, 300, 1000);
	missileHit(W, P, e.id, -1);
	assert.strictEqual(e.hp, e.hpMax);
	const before = P.missiles;
	assert.ok(missileFired(W, P, e.id));
	assert.strictEqual(P.missiles, before - 1);
	e.pos = { x: 1300, y: 300, z: 1000 };
	missileHit(W, P, e.id, -1);
	assert.strictEqual(e.hp, e.hpMax - 40);
	missileHit(W, P, e.id, -1);
	assert.strictEqual(e.hp, e.hpMax - 40, 'one missile, one hit');
	P.missiles = 0;
	W.now += 1000;
	assert.ok(!missileFired(W, P, e.id), 'empty rack');
});

test('combat: flares decoy the squid\'s missiles', () => {
	const W = shard();
	const P = pilot(W, 'Flare', 0, 300, 0);
	const boss = spawnEnemy(W, 'boss', 400, 300, 0, { area: { x: 0, z: 0, r: 1700 } });
	W.launchEnemyMissile(boss, { x: 300, y: 300, z: 0 }, P);
	dropFlares(W, P);
	const m = [...W.missiles.values()][0];
	assert.ok(m.flare || !W.missiles.size, 'missile chases the flare (88%) — seeded rng picks a decoy');
	W.step(0.05, 20 * 6);
	assert.strictEqual(sent(W, 'Flare', 'hurt').filter((h) => h.d === 32).length, 0);
});

test('combat: the squid\'s heart is armoured until its six ink sacs burst', () => {
	const W = shard();
	const P = pilot(W, 'Hunter', 0, 300, 0);
	P.protectUntil = Infinity; // this test is about the boss's armour, not its flak
	const B = spawnEnemy(W, 'boss', 100, 300, 0, { area: { x: 0, z: 0, r: 1700 } });
	fire(W, P, 3);
	B.pos = { x: 100, y: 300, z: 0 };
	gunHits(W, P, [[B.id, 6, 20]]);
	assert.strictEqual(B.parts[6].hp, B.parts[6].max, 'core shielded');
	for (let i = 0; i < 6; i++) { fire(W, P, 3); B.pos = { x: 100, y: 300, z: 0 }; for (let k = 0; k < 3; k++) gunHits(W, P, [[B.id, i, 20]]); }
	assert.strictEqual(B.podsLeft, 0);
	for (let k = 0; k < 10 && B.alive; k++) { fire(W, P, 3); B.pos = { x: 100, y: 300, z: 0 }; gunHits(W, P, [[B.id, 6, 20]]); }
	assert.ok(!B.alive, 'boss down');
	assert.strictEqual(P.bosses, 1);
	assert.ok(W.crates.size >= 6, 'loot rains down');
});

test('pvp: pilots can shoot each other only in the Cù Lao Chàm zone', () => {
	const W = shard();
	const A = pilot(W, 'Red', HUB.x + 1000, 300, HUB.z), B = pilot(W, 'Blue', HUB.x + 1050, 300, HUB.z);
	fire(W, A, 1);
	pvpHits(W, A, [[B.id, 5]]);
	assert.strictEqual(B.hp, B.stats.hpMax, 'outside the zone');
	A.pos = { x: PVP.x, y: 300, z: PVP.z }; B.pos = { x: PVP.x + 50, y: 300, z: PVP.z };
	A.inPvp = B.inPvp = true;
	fire(W, A, 3);
	for (let i = 0; i < 10 && !B.dead; i++) { fire(W, A, 2); A.pos = { x: PVP.x, y: 300, z: PVP.z }; B.pos = { x: PVP.x + 50, y: 300, z: PVP.z }; pvpHits(W, A, [[B.id, 20]]); }
	assert.ok(B.dead, 'shot down');
	assert.strictEqual(A.pvp, 1);
	assert.ok(sent(W, 'Blue', 'down').some((m) => m.by === 'Red'));
});

test('movement: speed hacks are corrected, teleports make old reports stale', () => {
	const W = shard();
	const P = pilot(W, 'Mover', 0, 300, 0);
	P.allowJump = false;
	W.now += 100;
	assert.ok(clientState(W, P, { x: 10, y: 300, z: 0, q: 0 }));
	W.now += 100;
	assert.ok(!clientState(W, P, { x: 900, y: 300, z: 0, q: 0 }), 'jet cannot do 9 km/s');
	assert.ok(!clientState(W, P, { x: 0, y: 99999, z: 0, q: 0 }) || P.pos.y < 2500);
	teleport(W, P, 3000, 300, 3000, 0);
	assert.ok(clientState(W, P, { x: 20, y: 300, z: 0, q: 0 }), 'stale report is ignored (not corrected)');
	assert.strictEqual(P.pos.x, 3000);
	assert.ok(clientState(W, P, { x: 3005, y: 300, z: 3000, q: P.seq }));
	assert.strictEqual(P.pos.x, 3005);
});

test('repairs: Ahamove pads mend and re-arm', () => {
	const W = shard();
	const pad = PADS[1];
	const P = pilot(W, 'Lander', pad.x, pad.y + 1, pad.z);
	P.hp = 10; P.missiles = 0; P.mode = 'landed';
	W.step(0.05, 20 * 5);
	assert.ok(P.hp > 90);
	assert.ok(P.missiles >= 5);
});

test('progression: levels, upgrades and aircraft unlocks', () => {
	const W = shard();
	const P = pilot(W, 'Rookie', HUB.x, 160, HUB.z);
	P.inSafe = true;
	setCraft(W, P, 'seaplane');
	assert.strictEqual(P.craft, 'jet', 'seaplane is locked at level 1');
	gainXp(W, P, xpFor(1) + xpFor(2) + xpFor(3));
	assert.strictEqual(P.level, 4);
	setCraft(W, P, 'seaplane');
	assert.strictEqual(P.craft, 'seaplane');
	assert.strictEqual(P.stats.hpMax, Math.round(CRAFT.seaplane.hp * (1 + 0.03 * 3)));
	P.xu = UPGRADE_COST[0] + UPGRADE_COST[1];
	buyUpgrade(W, P, 'armor'); buyUpgrade(W, P, 'armor'); buyUpgrade(W, P, 'armor');
	assert.strictEqual(P.up.armor, 2);
	assert.strictEqual(P.xu, 0);
	buyUpgrade(W, P, '__proto__');
	assert.strictEqual(P.up.__proto__, Object.prototype, 'no prototype pollution');
});

test('crates: picked up only when flying through them', () => {
	const W = shard();
	const P = pilot(W, 'Picker', 500, 200, 500);
	P.hp = 20;
	const c = spawnCrate(W, 'repair', 900, 200, 500);
	pickCrate(W, P, c.id);
	assert.ok(W.crates.has(c.id), 'too far');
	P.pos = { x: 900, y: 200, z: 505 };
	pickCrate(W, P, c.id);
	assert.ok(!W.crates.has(c.id));
	assert.ok(P.hp > 60);
});

test('raids: waves on a landmark, rewards for the defenders', () => {
	const W = shard({ firstRaid: 0, raidWarn: 1, firstBoss: 99999 });
	W.step(0.05, 2);
	const R = W.raid;
	assert.ok(R, 'raid started');
	const L = R.lm;
	const P = pilot(W, 'Guard', L.x, 250, L.z);
	P.allowJump = true;
	for (let wave = 0; wave < 3; wave++) {
		W.step(0.05, 20 * 8); // the wave arrives
		for (const e of [...W.enemies.values()]) if (e.raid === R.id) { fire(W, P, 2); e.pos = { ...P.pos }; P.protectUntil = W.now + 1e9; gunHits(W, P, [[e.id, -1, 20]]); for (let k = 0; k < 5 && e.alive; k++) { fire(W, P, 2); e.pos = { ...P.pos }; gunHits(W, P, [[e.id, -1, 20]]); } }
	}
	W.step(0.05, 20 * 8);
	assert.strictEqual(W.raid, null, 'raid over');
	const end = W.msgs.find((m) => m.t === 'raid' && (m.st === 'win' || m.st === 'fail'));
	assert.strictEqual(end.st, 'win');
	assert.strictEqual(P.raids, 1);
	assert.ok(W.msgs.some((m) => m.to === 'Guard' && m.t === 'reward' && /Giữ/.test(m.label)));
});

test('raids: an undefended landmark falls', () => {
	const W = shard({ firstRaid: 0, raidWarn: 1, firstBoss: 99999 });
	W.step(0.05, 2);
	assert.ok(W.raid);
	for (let i = 0; i < 20 * 600 && W.raid; i++) W.step(0.05, 1);
	const end = W.msgs.find((m) => m.t === 'raid' && (m.st === 'win' || m.st === 'fail'));
	assert.ok(end, 'raid ended');
	assert.strictEqual(end.st, 'fail');
});

test('persistence: pilots and their progress survive a restart', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phidoi-'));
	try {
		const a = new Persistence(dir);
		assert.ok((await a.login('Phượng', 'secret')).created, 'Vietnamese names work');
		a.store('Phượng', { level: 9, xu: 500 });
		a.flush();
		const b = new Persistence(dir);
		assert.ok(!(await b.login('phượng', 'wrong')).ok);
		const r = await b.login('phượng', 'secret');
		assert.ok(r.ok && !r.created);
		assert.strictEqual(b.getSave('Phượng').level, 9);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
