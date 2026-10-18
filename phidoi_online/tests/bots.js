// Load test: N bot pilots fly around Đà Nẵng at 20 Hz, hunt the nearest enemy,
// report hits and answer when they are shot down.
// Usage: node tests/bots.js [count=50] [seconds=30] [url=ws://127.0.0.1:8090/ws]

const COUNT = +(process.argv[2] || 50);
const SECONDS = +(process.argv[3] || 30);
const URL = process.argv[4] || 'ws://127.0.0.1:8090/ws';
const STATUS = URL.replace(/^ws/, 'http').replace(/\/ws$/, '/status');

function bot(i) {
	const ws = new WebSocket(URL);
	const b = { ws, seq: 0, pos: null, psi: 0, enemies: new Map(), xp: 0, downs: 0, corrections: 0, dead: false };
	const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
	ws.onopen = () => send({ t: 'login', name: 'Bot' + i, pass: 'bot-pass' });
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		if (m.t === 'welcome') { b.pos = { ...m.spawn }; b.psi = m.spawn.psi; }
		else if (m.t === 's') {
			for (const a of m.add || []) if (a.k !== 'p' && a.k !== 'crate') b.enemies.set(a.id, { k: a.k });
			for (const r of m.e || []) { const e = b.enemies.get(r[0]); if (e) e.p = [r[1], r[2], r[3]]; }
			for (const id of m.del || []) b.enemies.delete(id);
		} else if (m.t === 'spawn' || m.t === 'correct') {
			b.seq = m.q; b.pos = { x: m.x, y: m.y, z: m.z };
			if (m.t === 'correct') b.corrections++;
		} else if (m.t === 'down') {
			b.dead = true; b.downs++;
			setTimeout(() => { b.dead = false; send({ t: 'respawned' }); }, 1500);
		} else if (m.t === 'reward') b.xp += m.xp;
	};
	let hitT = 0;
	b.step = (dt) => {
		if (!b.pos || b.dead) return;
		// hunt: steer toward the nearest enemy, else circle
		let best = null, bd = 1500;
		for (const [id, e] of b.enemies) {
			if (!e.p || e.k === 'boss') continue;
			const d = Math.hypot(e.p[0] - b.pos.x, e.p[2] - b.pos.z);
			if (d < bd) { bd = d; best = [id, e]; }
		}
		const want = best ? Math.atan2(-(best[1].p[0] - b.pos.x), -(best[1].p[2] - b.pos.z)) : b.psi + 0.3;
		let dpsi = ((want - b.psi + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
		b.psi += Math.max(-1, Math.min(1, dpsi)) * dt;
		const v = 55, vx = -Math.sin(b.psi) * v, vz = -Math.cos(b.psi) * v;
		const ty = best ? Math.max(120, best[1].p[1]) : 220;
		b.pos.x += vx * dt; b.pos.z += vz * dt; b.pos.y += Math.max(-8, Math.min(8, ty - b.pos.y)) * dt;
		const firing = best && bd < 400;
		send({ t: 'st', x: b.pos.x, y: b.pos.y, z: b.pos.z, vx, vy: 0, vz, psi: b.psi, gam: 0, phi: 0, m: 'fly', f: firing ? 1 : 0, q: b.seq });
		if (firing && (hitT += dt) > 0.3) { hitT = 0; if (Math.random() < 0.6) send({ t: 'hit', g: [[best[0], -1, 2]], p: [] }); }
		if (Math.random() < 0.0005) send({ t: 'chat', text: 'Bot' + i + ' đang tuần tra' });
	};
	return b;
}

async function main() {
	const bots = [];
	for (let i = 0; i < COUNT; i++) {
		bots.push(bot(i));
		await new Promise((r) => setTimeout(r, 25));
	}
	const stepTimer = setInterval(() => bots.forEach((b) => b.step(0.05)), 50);
	const report = async () => {
		try {
			const s = await (await fetch(STATUS)).json();
			const xp = bots.reduce((a, b) => a + b.xp, 0), downs = bots.reduce((a, b) => a + b.downs, 0), corr = bots.reduce((a, b) => a + b.corrections, 0);
			console.log(`pilots=${s.pilots} enemies=${s.enemies} bullets=${s.bullets} tickAvg=${s.tickAvgMs}ms tickMax=${s.tickMaxMs}ms out=${(s.bytesOut / 1048576).toFixed(1)}MB in=${s.msgsIn} botXP=${xp} downs=${downs} corrections=${corr} raid=${s.world.raid ? s.world.raid.name + ' ' + s.world.raid.hp + '%' : '-'}`);
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
