// End-to-end over real WebSockets against a live shard.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createShard } from '../server/main.js';

function client(port) {
	const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
	const c = {
		ws, msgs: [], waiters: [], seq: 0, enemies: new Map(), pilots: new Map(),
		send: (m) => ws.send(JSON.stringify(m)),
		opened: new Promise((r) => (ws.onopen = r)),
		closed: new Promise((r) => (ws.onclose = r)),
		wait(pred, ms = 6000) {
			const hit = c.msgs.find(pred);
			if (hit) return Promise.resolve(hit);
			return new Promise((resolve, reject) => {
				c.waiters.push({ pred, resolve });
				setTimeout(() => reject(new Error('timeout waiting for ' + pred)), ms).unref();
			});
		},
		clear() { c.msgs = []; },
	};
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		if (m.t === 's') {
			for (const a of m.add || []) if (a.k !== 'p' && a.k !== 'crate') c.enemies.set(a.id, { k: a.k });
			for (const r of m.e || []) { const e = c.enemies.get(r[0]); if (e) e.pos = [r[1], r[2], r[3]]; }
			for (const r of m.p || []) c.pilots.set(r[0], { pos: [r[1], r[2], r[3]], hp: r[7], f: r[8] });
			for (const id of m.del || []) { c.enemies.delete(id); c.pilots.delete(id); }
		}
		if (m.t === 'spawn' || m.t === 'correct') c.seq = m.q;
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

test('network: pilots share the sky, fight, and keep their progress', { timeout: 90000 }, async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phidoi-net-'));
	const shard = createShard({ dataDir, dev: true, events: { firstRaid: 9999, firstBoss: 9999 } });
	const port = await shard.listen(0, '127.0.0.1');
	try {
		const a = await login(port, 'Ánh', 'mat-khau');
		assert.strictEqual(a.welcome.t, 'welcome');
		assert.ok(a.welcome.created);
		assert.ok(a.welcome.crafts.jet && a.welcome.raids.length === 5);
		const b = await login(port, 'Bình', 'mat-khau-2');
		assert.strictEqual(b.welcome.t, 'welcome');

		assert.strictEqual((await login(port, 'ánh', 'sai')).welcome.t, 'loginFail', 'wrong password');
		assert.strictEqual((await login(port, '1x', 'abc')).welcome.t, 'loginFail', 'bad name');

		// both start at the Sky Hub and see each other; the world status arrives every second
		await a.wait((m) => m.t === 's' && (m.p || []).some((r) => r[0] === b.welcome.id));
		const w = await a.wait((m) => m.t === 'w' && m.online >= 2);
		assert.ok(w.online >= 2);
		assert.ok(a.enemies.size > 5, 'enemies streamed in');

		// chat goes to everyone
		a.send({ t: 'chat', text: 'Xin chào phi đội!' });
		const said = await b.wait((m) => m.t === 'chat' && m.from === 'Ánh');
		assert.strictEqual(said.text, 'Xin chào phi đội!');

		// movement: a legal step is visible to others, a teleport gets corrected
		const s0 = a.welcome.spawn;
		await sleep(120);
		a.send({ t: 'st', x: s0.x - 5, y: s0.y, z: s0.z, vx: -60, vy: 0, vz: 0, psi: s0.psi, gam: 0, phi: 0, m: 'fly', f: 0, q: a.seq });
		await sleep(150);
		a.send({ t: 'st', x: s0.x + 3000, y: s0.y, z: s0.z, q: a.seq });
		const corr = await a.wait((m) => m.t === 'correct');
		assert.ok(Math.abs(corr.x - (s0.x - 5)) < 0.01);
		await b.wait((m) => m.t === 's' && (m.p || []).some((r) => r[0] === a.welcome.id && Math.abs(r[1] - (s0.x - 5)) < 0.2));

		// combat: fly next to the nearest kite (GM teleport), pull the trigger, report the hits
		const [kid, kite] = [...a.enemies].filter(([, e]) => e.k === 'kite' && e.pos).sort((x, y) => Math.hypot(x[1].pos[0] - s0.x, x[1].pos[2] - s0.z) - Math.hypot(y[1].pos[0] - s0.x, y[1].pos[2] - s0.z))[0];
		a.send({ t: 'chat', text: `/tp ${kite.pos[0] - 60} ${kite.pos[1]} ${kite.pos[2]}` });
		await a.wait((m) => m.t === 'spawn');
		for (let i = 0; i < 25; i++) {
			const p = a.enemies.get(kid) ? a.enemies.get(kid).pos : kite.pos;
			a.send({ t: 'st', x: p[0] - 60, y: p[1], z: p[2], vx: 0, vy: 0, vz: 0, psi: 0, gam: 0, phi: 0, m: 'fly', f: 1, q: a.seq });
			await sleep(50);
		}
		a.send({ t: 'hit', g: [[kid, -1, 8]], p: [] });
		const kill = await a.wait((m) => m.t === 's' && (m.ev || []).some((e) => e.e === 'kill' && e.id === kid));
		assert.ok(kill);
		const reward = await a.wait((m) => m.t === 'reward');
		assert.ok(reward.xp > 0 && reward.xu > 0);
		const me = await a.wait((m) => m.t === 'me' && m.xp > 0);

		// self-crash and respawn
		a.send({ t: 'crash', why: 'đâm vào núi' });
		await a.wait((m) => m.t === 'me' && m.dead);
		a.send({ t: 'respawned' });
		await a.wait((m) => m.t === 'me' && !m.dead && m.hp === m.hpMax);

		// status endpoint (admin service)
		const status = await (await fetch('http://127.0.0.1:' + port + '/status')).json();
		assert.strictEqual(status.pilots, 2);
		assert.ok(status.enemies > 20);

		// reconnect: same pilot, same progress; a second login kicks the first
		a.ws.close();
		await a.closed;
		await sleep(100);
		const a2 = await login(port, 'ÁNH', 'mat-khau');
		assert.strictEqual(a2.welcome.t, 'welcome');
		assert.ok(!a2.welcome.created);
		const me2 = await a2.wait((m) => m.t === 'me');
		assert.strictEqual(me2.xp, me.xp);
		assert.strictEqual(me2.deaths, 1);
		const a3 = await login(port, 'Ánh', 'mat-khau');
		assert.strictEqual(a3.welcome.t, 'welcome');
		await a2.wait((m) => m.t === 'kicked');
		for (const c of [b, a2, a3]) c.ws.close();
	} finally {
		await shard.close();
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});
