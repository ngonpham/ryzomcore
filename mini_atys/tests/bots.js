// Load test: N bots log in, roam with legal (validated) moves and hunt
// whatever they see. Usage: node tests/bots.js [count=50] [seconds=30] [url=ws://127.0.0.1:8080/ws]
// Prints the shard's /status (tick time, players, traffic) every 5 seconds.

'use strict';

const Rules = require('../shared/rules');

const COUNT = +(process.argv[2] || 50);
const SECONDS = +(process.argv[3] || 30);
const URL = process.argv[4] || 'ws://127.0.0.1:8080/ws';
const STATUS = URL.replace(/^ws/, 'http').replace(/\/ws$/, '/status');

function bot(i) {
	const ws = new WebSocket(URL);
	const b = { ws, map: null, x: 0, y: 0, goal: null, seen: new Map(), kills: 0, corrections: 0, alive: true, target: 0 };
	const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
	ws.onopen = () => send({ t: 'login', name: 'Bot' + i, pass: 'bot-pass' });
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		if (m.t === 'welcome') {
			const tiles = Buffer.from(m.map.tiles, 'base64');
			b.map = { w: m.map.w, h: m.map.h, tiles };
			b.x = m.x; b.y = m.y; b.id = m.id;
		} else if (m.t === 'tick') {
			for (const e of m.add || []) b.seen.set(e.id, e);
			for (const [id, x, y, hp, f] of m.upd || []) { const e = b.seen.get(id); if (e) Object.assign(e, { x, y, hp, f }); }
			for (const id of m.del || []) b.seen.delete(id);
		} else if (m.t === 'correct' || m.t === 'teleport') {
			b.x = m.x; b.y = m.y; b.goal = null;
			if (m.t === 'correct') b.corrections++;
		} else if (m.t === 'me') {
			b.alive = m.alive;
			b.target = m.target;
			if (!m.alive) setTimeout(() => send({ t: 'respawn' }), 1500);
		} else if (m.t === 'xp') b.kills++;
	};
	b.step = (dt) => {
		if (!b.map || !b.alive) return;
		let prey = null, pd = 10;
		for (const e of b.seen.values()) {
			if (e.k !== 'creature' || (e.f & 1) || e.b) continue;
			const d = Math.hypot(e.x - b.x, e.y - b.y);
			if (d < pd) { pd = d; prey = e; }
		}
		if (prey) {
			if (b.target !== prey.id) send({ t: 'act', a: 'attack', target: prey.id });
			if (pd > 1.5) b.goal = [prey.x, prey.y];
			else { b.goal = null; if (Math.random() < 0.05) send({ t: 'act', a: 'fire', target: prey.id }); }
		} else if (!b.goal || Math.random() < 0.01) {
			b.goal = [b.x + (Math.random() - 0.5) * 30, b.y + (Math.random() - 0.5) * 30];
		}
		if (b.goal) {
			const [nx, ny] = Rules.steer(b.map, b.x, b.y, b.goal[0], b.goal[1], Rules.PLAYER_SPEED * 0.9 * dt);
			if (nx === b.x && ny === b.y) b.goal = null;
			else { b.x = nx; b.y = ny; send({ t: 'pos', x: nx, y: ny }); }
		}
		if (Math.random() < 0.002) send({ t: 'chat', text: 'Bot' + i + ' says hi' });
	};
	return b;
}

async function main() {
	const bots = [];
	for (let i = 0; i < COUNT; i++) {
		bots.push(bot(i));
		await new Promise((r) => setTimeout(r, 20));
	}
	const stepTimer = setInterval(() => bots.forEach((b) => b.step(0.1)), 100);
	const report = async () => {
		try {
			const s = await (await fetch(STATUS)).json();
			const kills = bots.reduce((a, b) => a + b.kills, 0);
			const corr = bots.reduce((a, b) => a + b.corrections, 0);
			console.log('players=' + s.players + ' creatures=' + s.creatures + ' tickAvg=' + s.tickAvgMs + 'ms tickMax=' + s.tickMaxMs +
				'ms out=' + (s.bytesOut / 1048576).toFixed(1) + 'MB in=' + s.msgsIn + ' botKills=' + kills + ' corrections=' + corr);
		} catch (e) {
			console.log('status error: ' + e.message);
		}
	};
	const reportTimer = setInterval(report, 5000);
	await new Promise((r) => setTimeout(r, SECONDS * 1000));
	await report();
	clearInterval(stepTimer);
	clearInterval(reportTimer);
	bots.forEach((b) => b.ws.close());
	setTimeout(() => process.exit(0), 300);
}

main();
