// Mini Atys shard: wires every "service" together in one Node.js process.
//
//   Ryzom service                 Mini Atys module
//   tick_service              ->  tick_service.js
//   frontend_service          ->  frontend_service.js + net/websocket.js
//   entities_game_service     ->  egs.js (+ entity_matrix.js, sheets.js)
//   ai_service                ->  ai_service.js
//   gpm_service (move check)  ->  shared/rules.js + egs.clientMove()
//   input_output_service      ->  chat.js
//   backup_service / PDS      ->  persistence.js
//   ryzom_admin_service       ->  GET /status
//
// Usage: node server/main.js [--port 8080] [--data ./data] [--seed 1337] [--dev]

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const Rules = require('../shared/rules');
const { attachWebSocketServer } = require('./net/websocket');
const { World } = require('./world');
const { EntitiesGameService } = require('./egs');
const { AIService } = require('./ai_service');
const { FrontendService } = require('./frontend_service');
const { ChatService } = require('./chat');
const { Persistence } = require('./persistence');
const { TickService } = require('./tick_service');

const ROOT = path.join(__dirname, '..');
const STATIC = {
	'/': ['client/index.html', 'text/html; charset=utf-8'],
	'/index.html': ['client/index.html', 'text/html; charset=utf-8'],
	'/game.js': ['client/game.js', 'application/javascript; charset=utf-8'],
	'/style.css': ['client/style.css', 'text/css; charset=utf-8'],
	'/shared/rules.js': ['shared/rules.js', 'application/javascript; charset=utf-8'],
};

function createShard(opts = {}) {
	const world = new World(opts.seed || 1337, opts.size || 192);
	const persistence = new Persistence(opts.dataDir || path.join(ROOT, 'data'));
	const egs = new EntitiesGameService(world);
	const ai = new AIService(world, egs);
	const fes = new FrontendService(egs, persistence);
	const chat = new ChatService(egs, fes, persistence, { dev: opts.dev });
	fes.chat = chat;
	egs.onLevelUp = (p) => chat.system(p.name + ' reached level ' + p.level + '!');

	const ts = new TickService(Rules.TICK_MS, [
		(dt) => egs.update(dt),
		(dt) => ai.update(dt),
		() => fes.flush(),
	]);

	const server = http.createServer((req, res) => {
		const url = (req.url || '/').split('?')[0];
		if (url === '/status') {
			let creatures = 0;
			for (const e of egs.entities.values()) if (e.kind === 'creature') creatures++;
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			return res.end(JSON.stringify({
				cycle: ts.cycle, players: egs.players.size, creatures, spawnGroups: ai.groups.length,
				tickAvgMs: +ts.stats.avgMs.toFixed(2), tickMaxMs: +ts.stats.maxMs.toFixed(2),
				bytesOut: fes.stats.bytesOut, msgsIn: fes.stats.msgsIn,
				online: [...egs.players.values()].map((p) => ({ name: p.name, level: p.level, region: p.region })),
				top: persistence.topPlayers(10),
			}));
		}
		const entry = STATIC[url];
		if (!entry) { res.writeHead(404); return res.end('not found'); }
		fs.readFile(path.join(ROOT, entry[0]), (err, data) => {
			if (err) { res.writeHead(500); return res.end('error'); }
			res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
			res.end(data);
		});
	});
	attachWebSocketServer(server, '/ws', (ws) => fes.attach(ws));

	let saveTimer = null;
	return {
		world, egs, ai, fes, chat, persistence, ts, server,
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
	const o = { port: +(process.env.PORT || 8080), dataDir: process.env.DATA_DIR, seed: +(process.env.SEED || 1337), dev: !!process.env.DEV };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--port') o.port = +argv[++i];
		else if (a === '--data') o.dataDir = argv[++i];
		else if (a === '--seed') o.seed = +argv[++i];
		else if (a === '--dev') o.dev = true;
	}
	return o;
}

if (require.main === module) {
	const o = parseArgs(process.argv.slice(2));
	const shard = createShard(o);
	shard.listen(o.port).then((port) => {
		let creatures = 0;
		for (const e of shard.egs.entities.values()) if (e.kind === 'creature') creatures++;
		console.log('[Mini Atys] shard up: http://localhost:' + port + '  (' + shard.world.w + 'x' + shard.world.h +
			' tiles, ' + shard.ai.groups.length + ' spawn groups, ' + creatures + ' creatures' + (o.dev ? ', dev commands ON' : '') + ')');
	});
	const shutdown = async () => {
		console.log('[Mini Atys] saving and shutting down...');
		await shard.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

module.exports = { createShard };
