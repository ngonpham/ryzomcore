// Gameplay unit tests: run with `npm test` (node --test).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Rules = require('../shared/rules');
const { World } = require('../server/world');
const { EntitiesGameService } = require('../server/egs');
const { AIService } = require('../server/ai_service');
const { Persistence } = require('../server/persistence');

function setup() {
	const world = new World(1337);
	const egs = new EntitiesGameService(world, { random: () => 0.5 });
	const ai = new AIService(world, egs);
	const sent = [];
	egs.notify = (p, m) => sent.push(m);
	return { world, egs, ai, sent };
}

// A walkable spot outside the village, in the requested direction.
function outside(world, dx, dy) {
	for (let d = Rules.TOWN_RADIUS + 3; d < 60; d++) {
		const x = Math.floor(world.cx + dx * d) + 0.5, y = Math.floor(world.cy + dy * d) + 0.5;
		if (Rules.isWalkable(world, x, y) && Rules.isWalkable(world, x + 1.2, y) && !world.isSafe(x, y)) return [x, y];
	}
	throw new Error('no spot');
}

test('world: village is safe, walkable and connected to every region', () => {
	const { world } = setup();
	const [sx, sy] = world.spawnPoint();
	assert.ok(Rules.isWalkable(world, sx, sy));
	assert.ok(world.isSafe(sx, sy));
	const seen = new Set();
	for (let y = 0; y < world.h; y++) {
		for (let x = 0; x < world.w; x++) if (world.walkableTile(x, y)) seen.add(world.regionAt(x + 0.5, y + 0.5));
	}
	assert.deepStrictEqual([...seen].sort(), ['fyros', 'matis', 'silan', 'tryker', 'zorai']);
});

test('world: generation is deterministic for a seed', () => {
	assert.deepStrictEqual(new World(42).tiles, new World(42).tiles);
	assert.notDeepStrictEqual(new World(42).tiles, new World(43).tiles);
});

test('ai: spawn groups populate the continent outside the village', () => {
	const { egs, ai, world } = setup();
	assert.ok(ai.groups.length > 100);
	let creatures = 0;
	for (const e of egs.entities.values()) {
		if (e.kind !== 'creature') continue;
		creatures++;
		assert.ok(!world.isSafe(e.x, e.y), 'creature spawned in Silan');
		assert.ok(Rules.isWalkable(world, e.x, e.y, 0.2));
	}
	assert.ok(creatures > 300);
	assert.ok(ai.groups.some((g) => g.sheet === 'kirosta'), 'boss exists');
});

test('movement: legal steps pass, speed hacks and wall clipping are rejected', () => {
	const { egs, world } = setup();
	const p = egs.createPlayer({ name: 'Mover' });
	egs.now += 100;
	assert.ok(egs.clientMove(p, p.x + 0.4, p.y));
	egs.now += 100;
	assert.ok(!egs.clientMove(p, p.x + 8, p.y), 'teleport must be refused');
	// Wall: stand inside the village hedge, next to a tree, and walk through it
	let inside = null, beyond = null;
	for (let a = 0; a < Math.PI * 2 && !inside; a += 0.05) {
		const hx = world.cx + Math.cos(a) * (Rules.TOWN_RADIUS + 0.6), hy = world.cy + Math.sin(a) * (Rules.TOWN_RADIUS + 0.6);
		if (Rules.tileAt(world, hx, hy) !== Rules.TILE.TREE) continue;
		const ix = world.cx + Math.cos(a) * (Rules.TOWN_RADIUS - 1), iy = world.cy + Math.sin(a) * (Rules.TOWN_RADIUS - 1);
		if (!Rules.isWalkable(world, ix, iy)) continue;
		inside = [ix, iy];
		beyond = [world.cx + Math.cos(a) * (Rules.TOWN_RADIUS + 1.8), world.cy + Math.sin(a) * (Rules.TOWN_RADIUS + 1.8)];
	}
	assert.ok(inside, 'hedge found');
	egs.teleport(p, inside[0], inside[1]);
	egs.now += 1000;
	assert.ok(!egs.clientMove(p, beyond[0], beyond[1]), 'walking through trees must be refused');
	assert.ok(!egs.clientMove(p, NaN, 3));
});

test('combat: a player kills a creature and gets xp, dappers and loot', () => {
	const { egs, ai, world, sent } = setup();
	const [x, y] = outside(world, 1, 0);
	const p = egs.createPlayer({ name: 'Hunter', x, y });
	const c = ai.spawnCreature('yubo', 1, x + 1.2, y);
	egs.doAction(p, 'attack', c.id);
	assert.strictEqual(p.autoTarget, c.id);
	for (let i = 0; i < 400 && c.alive; i++) {
		egs.now += 100;
		egs.update(0.1);
		p.cooldowns.attack = 0;
		ai.update(0.1);
	}
	assert.ok(!c.alive, 'creature should die');
	assert.ok(p.xp > 0, 'xp gained');
	assert.ok(p.dappers > 0, 'dappers looted');
	assert.ok(sent.some((m) => m.t === 'loot'));
	assert.strictEqual(p.kills, 1);
});

test('combat: fire bolt costs sap, respects range and cooldown', () => {
	const { egs, ai, world, sent } = setup();
	const [x, y] = outside(world, -1, 0);
	const p = egs.createPlayer({ name: 'Mage', x, y });
	const c = ai.spawnCreature('mektoub', 3, x + 1.2, y);
	const sap = p.sap;
	egs.doAction(p, 'fire', c.id);
	assert.strictEqual(p.sap, sap - Rules.ACTIONS.fire.sap);
	assert.ok(c.hp < c.maxHp);
	egs.doAction(p, 'fire', c.id);
	assert.ok(sent.some((m) => m.t === 'err' && /not ready/.test(m.text)));
	const far = ai.spawnCreature('mektoub', 3, x + 0, y + 30);
	p.cooldowns.fire = 0;
	egs.doAction(p, 'fire', far.id);
	assert.ok(sent.some((m) => m.t === 'err' && /too far/.test(m.text)));
});

test('ai: aggressive creatures pull nearby players, leash home and evade', () => {
	const { egs, ai, world } = setup();
	const [x, y] = outside(world, 0, 1);
	const p = egs.createPlayer({ name: 'Bait', x, y });
	const c = ai.spawnCreature('gingo', 6, x + 3, y);
	ai.update(0.1);
	assert.ok(c.aggro.has(p.id), 'gingo should aggro');
	assert.strictEqual(c.state, 'combat');
	// Drag it beyond the leash radius
	c.x = c.homeX + 25;
	ai.update(0.1);
	assert.strictEqual(c.state, 'return');
	assert.ok(c.evading);
	egs.damage(p, c, 10, 'melee');
	assert.strictEqual(c.hp, c.maxHp, 'evading creatures take no damage');
});

test('ai: passive creatures only fight back', () => {
	const { egs, ai, world } = setup();
	const [x, y] = outside(world, -1, -1);
	const p = egs.createPlayer({ name: 'Calm', x, y });
	const c = ai.spawnCreature('yubo', 2, x + 1, y);
	ai.update(0.1);
	assert.strictEqual(c.aggro.size, 0);
	egs.damage(p, c, 5, 'melee');
	assert.ok(c.aggro.has(p.id));
});

test('death: penalty, respawn in Silan at half health', () => {
	const { egs, ai, world } = setup();
	const [x, y] = outside(world, 1, 1);
	const p = egs.createPlayer({ name: 'Doomed', x, y, level: 3, xp: 200 });
	const c = ai.spawnCreature('kincher', 25, x + 1, y);
	egs.damage(c, p, 99999, 'melee');
	assert.ok(!p.alive);
	assert.strictEqual(p.xp, 200 - Math.floor(Rules.xpForLevel(3) * 0.1));
	assert.ok(!egs.clientMove(p, p.x + 0.1, p.y), 'the dead cannot move');
	egs.respawn(p);
	assert.ok(p.alive);
	assert.ok(world.isSafe(p.x, p.y));
	assert.strictEqual(p.hp, Math.ceil(p.maxHp / 2));
});

test('progression: level up raises stats and heals', () => {
	const { egs } = setup();
	const p = egs.createPlayer({ name: 'Grower' });
	p.hp = 10;
	egs.gainXp(p, Rules.xpForLevel(1) + Rules.xpForLevel(2) + 5);
	assert.strictEqual(p.level, 3);
	assert.strictEqual(p.xp, 5);
	assert.strictEqual(p.maxHp, Rules.playerStats(3).maxHp);
	assert.strictEqual(p.hp, p.maxHp);
});

test('trade: merchant buys loot and sells potions and gear', () => {
	const { egs, sent } = setup();
	const merchant = [...egs.entities.values()].find((e) => e.role === 'merchant');
	const p = egs.createPlayer({ name: 'Trader', x: merchant.x + 1, y: merchant.y, dappers: 0, inventory: { kitin_shell: 2, potion: 1 } });
	egs.sellAll(p);
	assert.strictEqual(p.dappers, 40);
	assert.strictEqual(p.inventory.potion, 1, 'consumables are kept');
	egs.buy(p, 'potion');
	assert.strictEqual(p.inventory.potion, 2);
	assert.strictEqual(p.dappers, 15);
	egs.buy(p, 'sword');
	assert.ok(sent.some((m) => m.t === 'err' && /Not enough/.test(m.text)));
	p.dappers = 1000;
	egs.buy(p, 'sword');
	assert.strictEqual(p.equip.weapon, 'sword');
	egs.teleport(p, merchant.x + 10, merchant.y);
	egs.buy(p, 'potion');
	assert.ok(sent.some((m) => m.t === 'err' && /next to the merchant/.test(m.text)));
});

test('persistence: accounts, passwords and saves survive a restart', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniatys-'));
	try {
		const a = new Persistence(dir);
		const r1 = await a.login('Saver', 'secret');
		assert.ok(r1.ok && r1.created);
		a.store('Saver', { level: 7, xp: 12 });
		a.flush();
		const b = new Persistence(dir);
		const bad = await b.login('saver', 'nope');
		assert.ok(!bad.ok);
		const r2 = await b.login('saver', 'secret');
		assert.ok(r2.ok && !r2.created);
		assert.strictEqual(r2.name, 'Saver');
		assert.strictEqual(r2.save.level, 7);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
