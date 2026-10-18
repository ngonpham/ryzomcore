// Phi Đội Giấy Online — the shard. One Node.js process, one module per
// "service", wired the same way as mini_atys (see ../../mini_atys/server/main.js):
//
//   tick service      -> tick.js (20 Hz)
//   frontend service  -> frontend.js + net/websocket.js
//   EGS (pilots)      -> players.js, combat.js
//   AI service        -> enemies.js, events.js (patrols, raids, world boss)
//   GPMS              -> shared/geo.js (the Đà Nẵng terrain) + players.clientState()
//   IOS (chat)        -> chat.js
//   PDS / backup      -> persistence.js
//
// Usage: node server/main.js [--port 8090] [--data ./data] [--dev]

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { TICK_MS } from '../shared/rules.js';
import { attachWebSocketServer } from './net/websocket.js';
import { World } from './world.js';
import { installCombat, updateBullets, updateEnemyMissiles, updateCrates } from './combat.js';
import { updateEnemies } from './enemies.js';
import { updatePlayers } from './players.js';
import { Events } from './events.js';
import { Frontend } from './frontend.js';
import { Chat } from './chat.js';
import { Persistence } from './persistence.js';
import { TickService } from './tick.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = 'application/javascript; charset=utf-8';
const STATIC = {
	'/': ['client/index.html', 'text/html; charset=utf-8'],
	'/index.html': ['client/index.html', 'text/html; charset=utf-8'],
	'/shared/geo.js': ['shared/geo.js', JS],
	'/shared/rules.js': ['shared/rules.js', JS],
	'/manifest.webmanifest': ['client/manifest.webmanifest', 'application/manifest+json'],
	'/icons/icon-192.png': ['client/icons/icon-192.png', 'image/png'],
	'/icons/icon-512.png': ['client/icons/icon-512.png', 'image/png'],
};

export function createShard(opts = {}) {
	const W = new World(opts);
	const persistence = new Persistence(opts.dataDir || path.join(ROOT, 'data'));
	const chat = new Chat(W, persistence, { dev: opts.dev });
	installCombat(W);
	const events = new Events(W, opts.events);
	chat.events = events;
	const fes = new Frontend(W, persistence, events, chat);

	const step = (dt) => {
		W.now = Date.now();
		W.t += dt;
		updatePlayers(W, dt);
		updateEnemies(W, dt);
		updateBullets(W, dt);
		updateEnemyMissiles(W, dt);
		updateCrates(W, dt);
		events.update(dt);
	};
	const ts = new TickService(TICK_MS, [step, () => fes.flush()]);

	const server = http.createServer((req, res) => {
		const url = (req.url || '/').split('?')[0];
		if (url === '/status') {
			const kinds = {};
			for (const e of W.enemies.values()) kinds[e.k] = (kinds[e.k] || 0) + 1;
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			return res.end(JSON.stringify({
				cycle: ts.cycle, pilots: fes.online(), enemies: W.enemies.size, kinds, bullets: W.bullets.length, crates: W.crates.size,
				tickAvgMs: +ts.stats.avgMs.toFixed(2), tickMaxMs: +ts.stats.maxMs.toFixed(2), bytesOut: fes.stats.bytesOut, msgsIn: fes.stats.msgsIn,
				world: events.status(), top: persistence.top(10),
			}));
		}
		const entry = STATIC[url];
		if (!entry) { res.writeHead(404); return res.end('not found'); }
		fs.readFile(path.join(ROOT, entry[0]), (err, data) => {
			if (err) { res.writeHead(404); return res.end('not found'); }
			res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
			res.end(data);
		});
	});
	attachWebSocketServer(server, '/ws', (ws) => fes.attach(ws));

	let saveTimer = null;
	return {
		W, events, fes, chat, persistence, ts, server, step,
		listen(port, host) {
			return new Promise((resolve) => {
				server.listen(port, host, () => {
					ts.start();
					saveTimer = setInterval(() => { fes.saveAll(); persistence.flush(); }, 30000);
					resolve(server.address().port);
				});
			});
		},
		async close() {
			ts.stop();
			clearInterval(saveTimer);
			fes.saveAll();
			persistence.flush();
			for (const s of fes.sessions) s.ws.close(1001, 'shutdown');
			await new Promise((r) => server.close(r));
		},
	};
}

function parseArgs(argv) {
	const o = { port: +(process.env.PORT || 8090), dataDir: process.env.DATA_DIR, dev: !!process.env.DEV };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--port') o.port = +argv[++i];
		else if (argv[i] === '--data') o.dataDir = argv[++i];
		else if (argv[i] === '--dev') o.dev = true;
	}
	return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const o = parseArgs(process.argv.slice(2));
	const t0 = Date.now();
	const shard = createShard(o);
	shard.listen(o.port).then((port) => {
		console.log('[Phi Đội Giấy Online] http://localhost:' + port + ' · terrain + ' + shard.W.enemies.size + ' enemies ready in ' + (Date.now() - t0) + ' ms' + (o.dev ? ' · dev commands ON' : ''));
	});
	const shutdown = async () => {
		console.log('[Phi Đội Giấy Online] saving and shutting down…');
		await shard.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
