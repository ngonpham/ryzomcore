// End-to-end test over real WebSockets against a live shard.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Rules = require('../shared/rules');
const { createShard } = require('../server/main');

function client(port) {
	const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
	const c = {
		ws, msgs: [], cursor: 0, waiters: [],
		send: (m) => ws.send(JSON.stringify(m)),
		opened: new Promise((r) => { ws.onopen = r; }),
		closed: new Promise((r) => { ws.onclose = r; }),
		mark() { c.cursor = c.msgs.length; },
		wait(pred, ms = 5000) {
			for (let i = c.cursor; i < c.msgs.length; i++) if (pred(c.msgs[i])) return Promise.resolve(c.msgs[i]);
			return new Promise((resolve, reject) => {
				const w = { pred, resolve };
				c.waiters.push(w);
				setTimeout(() => reject(new Error('timeout waiting for ' + pred)), ms).unref();
			});
		},
	};
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		c.msgs.push(m);
		for (const w of [...c.waiters]) if (w.pred(m)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(m); }
	};
	return c;
}

async function login(port, name, pass) {
	const c = client(port);
	await c.opened;
	c.send({ t: 'login', name, pass });
	c.welcome = await c.wait((m) => m.t === 'welcome' || m.t === 'loginFail');
	return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tile path (BFS) from a to b, returned as tile-center waypoints.
function findPath(world, a, b) {
	const w = world.w, start = Math.floor(a[1]) * w + Math.floor(a[0]), goal = Math.floor(b[1]) * w + Math.floor(b[0]);
	const prev = new Int32Array(w * world.h).fill(-1);
	prev[start] = start;
	const q = [start];
	while (q.length) {
		const i = q.shift();
		if (i === goal) break;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const x = (i % w) + dx, y = ((i / w) | 0) + dy, j = y * w + x;
			if (prev[j] === -1 && Rules.isWalkable(world, x + 0.5, y + 0.5)) { prev[j] = i; q.push(j); }
		}
	}
	const path = [];
	for (let i = goal; i !== start; i = prev[i]) path.unshift([(i % w) + 0.5, ((i / w) | 0) + 0.5]);
	return path;
}

async function walkPath(c, from, path) {
	let pos = from;
	for (const wp of path) pos = await walkTo(c, pos, wp);
	return pos;
}

async function walkTo(c, from, to) {
	let [x, y] = from;
	for (;;) {
		const d = Math.hypot(to[0] - x, to[1] - y);
		if (d < 0.05) break;
		const s = Math.min(0.2, d);
		x += ((to[0] - x) / d) * s;
		y += ((to[1] - y) / d) * s;
		c.send({ t: 'pos', x, y });
		await sleep(50);
	}
	return [x, y];
}

test('network: login, vision, chat, anti-cheat, combat, trade, persistence', { timeout: 60000 }, async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniatys-net-'));
	const shard = createShard({ dataDir, dev: true });
	const port = await shard.listen(0, '127.0.0.1');
	try {
		// Login + character creation
		const a = await login(port, 'Alice', 'pw-alice');
		assert.strictEqual(a.welcome.t, 'welcome');
		assert.ok(a.welcome.created);
		assert.strictEqual(Buffer.from(a.welcome.map.tiles, 'base64').length, a.welcome.map.w * a.welcome.map.h);
		const b = await login(port, 'Bob', 'pw-bob');
		assert.strictEqual(b.welcome.t, 'welcome');

		// Bad name / wrong password
		const bad = await login(port, 'x', 'pw');
		assert.strictEqual(bad.welcome.t, 'loginFail');
		const wrong = await login(port, 'alice', 'not-it');
		assert.strictEqual(wrong.welcome.t, 'loginFail');

		// Vision: Alice sees Bob and the village NPCs
		await a.wait((m) => m.t === 'tick' && m.add && m.add.some((e) => e.id === b.welcome.id));
		const merchant = a.msgs.filter((m) => m.t === 'tick' && m.add).flatMap((m) => m.add).find((e) => e.r === 'merchant');
		assert.ok(merchant, 'merchant visible');

		// Local chat reaches Bob
		a.send({ t: 'chat', text: 'hello Atys' });
		const said = await b.wait((m) => m.t === 'chat' && m.ch === 'say');
		assert.strictEqual(said.from, 'Alice');
		assert.strictEqual(said.text, 'hello Atys');

		// Movement: a legal step is accepted, a teleport is corrected
		await sleep(150);
		let pos = [a.welcome.x + 0.2, a.welcome.y];
		a.mark();
		a.send({ t: 'pos', x: pos[0], y: pos[1] });
		await sleep(150);
		assert.ok(!a.msgs.slice(a.cursor).some((m) => m.t === 'correct'));
		a.send({ t: 'pos', x: pos[0] + 15, y: pos[1] });
		const corr = await a.wait((m) => m.t === 'correct');
		assert.ok(Math.abs(corr.x - pos[0]) < 1e-6);

		// Combat: leave the village (creatures evade attacks from the safe zone),
		// spawn a yubo (dev command), kill it, get xp and loot
		const world = shard.world;
		let field = null;
		for (let d = Rules.TOWN_RADIUS + 3; !field; d++) {
			const x = world.cx + 0.5, y = world.cy + d + 0.5;
			if (Rules.isWalkable(world, x, y) && Rules.isWalkable(world, x + 1.2, y)) field = [x, y];
		}
		pos = await walkPath(a, pos, findPath(world, pos, field));
		a.mark();
		a.send({ t: 'chat', text: '/spawn yubo 1' });
		const spawned = await a.wait((m) => m.t === 'chat' && /Spawned Yubo #(\d+)/.test(m.text));
		const yuboId = +/#(\d+)/.exec(spawned.text)[1];
		a.send({ t: 'act', a: 'attack', target: yuboId });
		const xp = await a.wait((m) => m.t === 'xp', 30000);
		assert.ok(xp.v > 0);
		await a.wait((m) => m.t === 'loot');
		const meAfterKill = await a.wait((m) => m.t === 'me' && m.xp > 0 && m.dappers > 0);

		// Trade: walk to the merchant, open the shop, sell
		pos = await walkPath(a, pos, findPath(world, pos, [merchant.x + 1.5, merchant.y]));
		a.mark();
		a.send({ t: 'talk', id: merchant.id });
		await a.wait((m) => m.t === 'shop');
		a.send({ t: 'sell' });
		await a.wait((m) => m.t === 'chat' && m.ch === 'sys' && /Sold|Nothing to sell/.test(m.text));

		// Status endpoint (admin service equivalent)
		const status = await (await fetch('http://127.0.0.1:' + port + '/status')).json();
		assert.strictEqual(status.players, 2);
		assert.ok(status.creatures > 300);

		// Persistence: reconnect and find the same character where we left it
		a.ws.close();
		await a.closed;
		await sleep(100);
		const a2 = await login(port, 'alice', 'pw-alice');
		assert.strictEqual(a2.welcome.t, 'welcome');
		assert.ok(!a2.welcome.created);
		assert.strictEqual(a2.welcome.name, 'Alice');
		assert.ok(Math.hypot(a2.welcome.x - pos[0], a2.welcome.y - pos[1]) < 0.01, 'position restored');
		const me2 = await a2.wait((m) => m.t === 'me');
		assert.strictEqual(me2.xp, meAfterKill.xp);

		// Second login with the same character kicks the first session
		const a3 = await login(port, 'Alice', 'pw-alice');
		assert.strictEqual(a3.welcome.t, 'welcome');
		await a2.wait((m) => m.t === 'kicked');

		for (const c of [b, bad, wrong, a2, a3]) c.ws.close();
	} finally {
		await shard.close();
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});
