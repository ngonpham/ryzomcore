/* global window, document */ // used by the functions that run inside the browser pages
// Film director: records a promo video of four pilots flying over Đà Nẵng.
//
// The shard runs in this process and is stepped frame by frame in lockstep with
// four Chromium clients whose requestAnimationFrame and performance.now run on a
// virtual clock, so every video frame is a complete, smooth 1/30 s of the game,
// however slow the machine renders. The pilots are real logged-in players; the
// director only scripts their flight path (game.director.pose) and, for scenic
// shots, the camera (game.director.cam).
//
// Usage:
//   PLAYWRIGHT=/path/to/playwright node tools/film.js [--out promo.mp4] [--preview] [--only name] [--silent]
// Optional: THREE_JS=/path/three.module.js and FONTS_DIR=/dir (fonts.css + files/<md5>.woff2)
// to serve three.js and Google Fonts locally when the browser has no internet access.
// Needs ffmpeg on PATH to encode the frames; the full cut gets tools/soundtrack.js mixed in.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

import { createShard } from '../server/main.js';
import { updatePlayers, refreshStats, teleport } from '../server/players.js';
import { updateEnemies } from '../server/enemies.js';
import { updateBullets, updateEnemyMissiles, updateCrates, killEnemy } from '../server/combat.js';
import { gridH, coastX, SEA_Y } from '../shared/geo.js';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const STILLS = args.includes('--stills'); // 3 sample frames per shot, short warm-up: for framing
const PREVIEW = args.includes('--preview') || STILLS;
const ONLY = opt('--only', null) ? opt('--only').split(',') : null;
const SILENT = args.includes('--silent') || !!ONLY; // the soundtrack is timed to the full cut
const OUT = path.resolve(opt('--out', PREVIEW ? 'film-preview' : 'phidoi-danang-promo.mp4'));
const FPS = 30, DT = 1 / FPS, WARM = Math.round(1.5 * FPS);
const VIEW = { width: 1280, height: 720, scale: PREVIEW ? 0.5 : 1.5 }; // 1920×1080 output, same layout in previews
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ geometry */

const fwd = (psi, gam = 0) => [-Math.sin(psi) * Math.cos(gam), Math.sin(gam), -Math.cos(psi) * Math.cos(gam)];
const psiTo = (dx, dz) => Math.atan2(-dx, -dz);
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const ground = (x, z) => Math.max(gridH(x, z), SEA_Y);

// Pose [x, y, z, psi, gam, phi, v] of a path at time t, attitude from its derivative.
function poseOf(pathFn, t) {
	const e = 1 / 60, a = pathFn(t - e), b = pathFn(t + e), p = pathFn(t);
	const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], h = Math.hypot(d[0], d[2]);
	const v = Math.hypot(d[0], d[1], d[2]) / (2 * e);
	const psi = psiTo(d[0], d[2]), gam = Math.atan2(d[1], h);
	const a2 = pathFn(t + 2 * e), psi2 = psiTo(a2[0] - p[0], a2[2] - p[2]);
	let w = psi2 - psi;
	if (w > Math.PI) w -= 2 * Math.PI;
	if (w < -Math.PI) w += 2 * Math.PI;
	const phi = Math.atan((w / (2 * e)) * v / 9.8);
	return [p[0], p[1], p[2], psi, gam, phi, v];
}
const line = (p0, psi, v, climb = 0) => (t) => add(add(p0, fwd(psi), v * t), [0, climb, 0], t);
const arc = (cx, cz, R, a0, w, y, climb = 0) => (t) => [cx + R * Math.cos(a0 + w * t), y + climb * t, cz + R * Math.sin(a0 + w * t)];

// A point on the Cầu Vàng frame: s along the bridge, o across it (negative = valley side).
const bana = (s, o, y) => [-3121.6 + 0.765 * s - 0.644 * o, y, -325 + 0.644 * s + 0.765 * o];

// V formation: [right, up, back] metres from the leader.
const SLOTS = [[0, 0, 0], [-15, 1.2, 13], [15, 1.2, 13], [0, 2.6, 27]];
function slotPose(lead, s) {
	const [x, y, z, psi, gam, phi, v] = lead;
	const r = [Math.cos(psi), 0, -Math.sin(psi)], f = fwd(psi, 0);
	return [x + r[0] * s[0] - f[0] * s[2], y + s[1], z + r[2] * s[0] - f[2] * s[2], psi, gam, phi, v];
}

// Cameras: functions of (t, lead pose) → [x, y, z, lookX, lookY, lookZ, fov]
const center = (L) => slotPose(L, [0, 1.5, 13]);
const fixedCam = (pos, fov = 50, lookOff = [0, 0, 0]) => (t, L) => { const c = center(L); return [...pos, c[0] + lookOff[0], c[1] + lookOff[1], c[2] + lookOff[2], fov]; };
// side/front tracking camera in the formation's frame: [right, up, forward]
const trackCam = (off, look = [0, 0, 0], fov = 50, drift = [0, 0, 0]) => (t, L) => {
	const [x, y, z, psi] = L, r = [Math.cos(psi), 0, -Math.sin(psi)], f = fwd(psi, 0), c = center(L);
	const o = [off[0] + drift[0] * t, off[1] + drift[1] * t, off[2] + drift[2] * t];
	const p = [x + r[0] * o[0] + f[0] * o[2], y + o[1], z + r[2] * o[0] + f[2] * o[2]];
	return [...p, c[0] + r[0] * look[0] + f[0] * look[2], c[1] + look[1], c[2] + r[2] * look[0] + f[2] * look[2], fov];
};

/* ------------------------------------------------------------------ the shots */

const SHOTS = [
	{
		name: 'mykhe', dur: 4.6, hour: 6.35,
		cap: ['PHI ĐỘI GIẤY ONLINE', 'Bay trên bầu trời Đà Nẵng', 'Biển Mỹ Khê lúc bình minh'], title: true,
		path: line([coastX(-120) + 60, 46, -120], 0, 40),
		cam: trackCam([62, 14, 22], [0, 2, -4], 48, [-2, 0.2, -1.5]),
	},
	{
		name: 'sontra', dur: 4.2, hour: 7.6,
		cap: ['BÁN ĐẢO SƠN TRÀ', 'Chùa Linh Ứng', 'Tượng Quan Âm hướng ra biển Đông'],
		// the statue faces the sea (south-east): the flight dives off the ridge behind it, over its head, out to sea
		path: (t) => { const d = 90 - 40 * t; return [1305 - 0.707 * d, 170 - 15 * t, -2318 - 0.707 * d]; },
		cam: (t) => [1305 + 0.707 * (85 - 2 * t) + 0.707 * 30, 70, -2318 + 0.707 * (85 - 2 * t) - 0.707 * 30, 1305, 100, -2318, 55],
	},
	{
		name: 'bana', dur: 4.2, hour: 15.4,
		cap: ['BÀ NÀ HILLS', 'Cầu Vàng', 'Dải lụa vàng trên đôi bàn tay đá'],
		// along the bridge on the valley side, from the upper end down
		// along the Golden Bridge on its valley side, camera further out in the valley looking back at it
		path: line(bana(10, -72, 448), psiTo(0.765, 0.644), 40, -1.5),
		cam: (t, L) => { const b = bana(25, 0, 426), c = center(L); return [...bana(55 + t * 3, -165, 404), b[0] * 0.6 + c[0] * 0.4, b[1] * 0.6 + c[1] * 0.4, b[2] * 0.6 + c[2] * 0.4, 55]; },
	},
	{
		name: 'nguhanh', dur: 4.2, hour: 10.8,
		cap: ['NGŨ HÀNH SƠN', 'Núi đá Non Nước', 'Kim – Mộc – Thủy – Hỏa – Thổ giữa đồng xanh'],
		path: arc(731.5, 797.5, 170, -0.2, 0.17, 76),
		cam: (t) => [949 - t * 2, 55, 873 - t * 1.5, 760, 80, 790, 52],
	},
	{
		name: 'dragon', dur: 4.2, hour: 18.15,
		cap: ['SÔNG HÀN', 'Cầu Rồng', 'Hoàng hôn trên thành phố của những cây cầu'],
		path: line([-8, 50, -900], 0, 42),
		cam: fixedCam([75, 30, -1120], 52, [0, -10, 0]),
	},
	{
		name: 'hoian', dur: 4.2, hour: 18.95,
		cap: ['QUẢNG NAM', 'Phố cổ Hội An', 'Đèn lồng thắp sáng bên sông Thu Bồn'],
		path: line([930, 36, 3566], psiTo(-1, 0), 40),
		cam: trackCam([-30, -14, 55], [0, -6, 0], 56, [0, 0, -7]),
	},
	{
		name: 'boss', dur: 4.6, hour: 16.9, hud: true,
		cap: ['4 PHI CÔNG · 1 BẦU TRỜI', 'Cùng giữ Đà Nẵng', 'Hạ Mực Khổng Lồ giữa vịnh'], end: true,
		boss: true,
	},
];

/* ------------------------------------------------------------------ browser */

const PILOTS = [
	{ name: 'Linh', craft: 'jet' },
	{ name: 'Quân', craft: 'seaplane' },
	{ name: 'Mai', craft: 'heli' },
	{ name: 'Tuấn', craft: 'jet' },
];

const FILM_CLOCK = `(() => {
	const realRAF = window.requestAnimationFrame.bind(window), realNow = performance.now.bind(performance);
	const F = { on: false, t: 0, q: [] };
	F.enable = () => { F.t = realNow(); F.on = true; };
	F.step = (ms) => { F.t += ms; const cbs = F.q; F.q = []; for (const cb of cbs) cb(F.t); };
	window.__film = F;
	performance.now = () => (F.on ? F.t : realNow());
	window.requestAnimationFrame = (cb) => { if (F.on) { F.q.push(cb); return 1; } return realRAF(cb); };
})();`;

const FILM_CSS = `
#toast, #tip, #title, #warn, #lift, #rotate { display: none !important; }
#chatLog div { animation: none !important; opacity: 1 !important; }
#filmOv { position: fixed; inset: 0; pointer-events: none; z-index: 60; font-family: 'Be Vietnam Pro', sans-serif; color: #1f1d2b; }
#filmCap { position: absolute; left: 5%; bottom: 12%; padding: 12px 22px 15px; background: rgba(251, 248, 239, 0.92); border: 2px solid #1f1d2b;
  border-radius: 6px; box-shadow: 4px 4px 0 #1f1d2b; transform: rotate(-1.2deg); max-width: 60%; }
#filmCap.title { left: 50%; bottom: auto; top: 50%; transform: translate(-50%, -50%) rotate(-1.2deg); text-align: center; padding: 18px 34px 22px; }
#filmCap .k { font: 800 12px 'Be Vietnam Pro', sans-serif; letter-spacing: 0.32em; color: #d6452f; }
#filmCap .h { font-family: 'Pacifico', cursive; font-size: 42px; line-height: 1.3; }
#filmCap.title .h { font-size: 58px; }
#filmCap .s { font: 600 15px 'Be Vietnam Pro', sans-serif; opacity: 0.82; }
#filmEnd { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(244, 239, 226, 0.78); text-align: center; }
#filmEnd .h { font-family: 'Pacifico', cursive; font-size: 72px; line-height: 1.25; color: #1f1d2b; }
#filmEnd .h i { color: #f37021; font-style: normal; }
#filmEnd .s { font: 700 18px 'Be Vietnam Pro', sans-serif; margin-top: 6px; }
#filmEnd .p { font: 800 13px 'Be Vietnam Pro', sans-serif; letter-spacing: 0.3em; color: #1f5fbf; margin-top: 18px; }
#filmEnd .places { font: 600 14px 'Be Vietnam Pro', sans-serif; opacity: 0.75; margin-top: 10px; }
`;

async function openPilot(browser, url, i) {
	const filmed = i === 0;
	const ctx = await browser.newContext({ viewport: filmed ? { width: VIEW.width, height: VIEW.height } : { width: 320, height: 180 }, deviceScaleFactor: filmed ? VIEW.scale : 1 });
	const page = await ctx.newPage();
	if (process.env.THREE_JS) {
		const body = fs.readFileSync(process.env.THREE_JS);
		await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js', (r) => r.fulfill({ body, contentType: 'application/javascript' }));
	}
	if (process.env.FONTS_DIR) {
		const dir = process.env.FONTS_DIR;
		await page.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ body: fs.readFileSync(path.join(dir, 'fonts.css')), contentType: 'text/css' }));
		await page.route(/fonts\.gstatic\.com/, (r) => {
			const f = path.join(dir, 'files', crypto.createHash('md5').update(r.request().url() + '\n').digest('hex').slice(0, 16) + '.woff2');
			return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f), contentType: 'font/woff2' }) : r.abort();
		});
	}
	page.on('pageerror', (e) => console.error('[page ' + i + '] ' + e));
	await page.addInitScript(FILM_CLOCK);
	await page.goto(url + (filmed ? (PREVIEW ? '?q=1' : '?q=2') : '?q=0'), { waitUntil: 'domcontentloaded', timeout: 180000 });
	await page.waitForFunction(() => window.__pd && !document.getElementById('go').disabled, null, { timeout: 180000 });
	await page.fill('#lName', PILOTS[i].name);
	await page.fill('#lPass', 'phi-doi-' + i);
	await page.click('#go');
	await page.waitForFunction(() => window.__pd.game.started && window.__pd.NET.me, null, { timeout: 30000 });
	await page.addStyleTag({ content: FILM_CSS });
	if (filmed) {
		await page.evaluate(() => {
			const ov = document.createElement('div');
			ov.id = 'filmOv';
			ov.innerHTML = '<div id="filmCap"><div class="k"></div><div class="h"></div><div class="s"></div></div>' +
				'<div id="filmEnd"><div class="h">Phi Đội Giấy <i>Online</i></div><div class="s">Bay cùng bạn bè trên bầu trời Đà Nẵng</div>' +
				'<div class="places">Mỹ Khê · Sơn Trà · Bà Nà · Ngũ Hành Sơn · Cầu Rồng · Hội An</div><div class="p">CHƠI NGAY TRÊN TRÌNH DUYỆT · ĐIỆN THOẠI & MÁY TÍNH</div></div>';
			document.body.appendChild(ov);
		});
	}
	return page;
}

// One video frame on one client: pose, camera, overlay, then exactly one game frame.
function clientFrame(a) {
	const P = window.__pd, g = P.game;
	g.director = { pose: a.pose, cam: a.cam };
	P.ENV.hour = P.ENV.target = a.hour;
	if (g.studio !== !a.hud) { g.studio = !a.hud; document.body.classList.toggle('studio', g.studio); }
	P.keys[' '] = !!a.fire;
	if (a.fade !== undefined) g.fade = a.fade;
	if (a.camMode !== undefined) g.camMode = a.camMode;
	if (a.ov) {
		const cap = document.getElementById('filmCap'), end = document.getElementById('filmEnd');
		cap.className = a.ov.title ? 'title' : '';
		const [k, h, s] = a.ov.cap;
		if (cap.children[1].textContent !== h) { cap.children[0].textContent = k; cap.children[1].textContent = h; cap.children[2].textContent = s; }
		cap.style.opacity = a.ov.o;
		end.style.opacity = a.ov.end;
	}
	window.__film.step(1000 / 30);
}

/* ------------------------------------------------------------------ main */

async function main() {
	const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phidoi-film-'));
	const frames = PREVIEW ? OUT : fs.mkdtempSync(path.join(os.tmpdir(), 'phidoi-frames-'));
	fs.mkdirSync(frames, { recursive: true });
	const shard = createShard({ dataDir, dev: true, events: { firstRaid: 590, firstBoss: 890 } });
	const W = shard.W, events = shard.events, fes = shard.fes;
	const port = await new Promise((r) => shard.server.listen(0, '127.0.0.1', () => r(shard.server.address().port)));
	shard.ts.start();
	const url = 'http://127.0.0.1:' + port + '/';
	const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
	console.log('[film] logging in 4 pilots…');
	const pages = [];
	for (let i = 0; i < PILOTS.length; i++) pages.push(await openPilot(browser, url, i));
	await sleep(1500);
	const pilots = PILOTS.map((p) => [...W.players.values()].find((P) => P.name === p.name));
	for (let i = 0; i < pilots.length; i++) {
		const P = pilots[i];
		P.level = 8;
		refreshStats(P, true);
		P.protectUntil = Infinity; // the film crew does not get shot down
		if (PILOTS[i].craft !== 'jet') await pages[i].evaluate((c) => window.__pd.netSend({ t: 'craft', c }), PILOTS[i].craft);
	}
	await sleep(1500);
	for (const P of pilots) P.protectUntil = Infinity;
	const chats = ['Tập hợp ở vịnh, Mực Khổng Lồ lên rồi!', 'Quân đây, thủy phi cơ sẵn sàng 🛩', 'Mai bay trực thăng Ahamove yểm trợ 🚁', 'Tuấn vào đội hình, khai hoả!'];
	shard.ts.stop();
	await Promise.all(pages.map((p) => p.evaluate(() => window.__film.enable())));

	const step = () => {
		W.now += DT * 1000;
		W.t += DT;
		updatePlayers(W, DT); updateEnemies(W, DT); updateBullets(W, DT); updateEnemyMissiles(W, DT); updateCrates(W, DT);
		events.update(DT);
		fes.flush();
	};

	let n = 0;
	const t0 = Date.now();
	for (const S of SHOTS) {
		if (ONLY && !ONLY.includes(S.name)) continue;
		const total = Math.round(S.dur * FPS);
		const samples = STILLS ? [6, Math.floor(total / 2), total - 4] : [null];
		let boss = null, pathFn = S.path, camFn = S.cam;
		if (S.boss) {
			// raise the Giant Squid through the world-event system, so every HUD shows the world boss
			for (const e of [...W.enemies.values()]) if (e.k === 'boss') W.removeEnemy(e);
			events.boss = null;
			events.nextBossAt = W.t;
			events.update(0);
			boss = events.boss.e;
			for (let k = 0; k < 3; k++) { boss.parts[k].alive = false; boss.parts[k].hp = 0; }
			boss.podsLeft = 3;
			boss.hp = boss.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);
			pathFn = line([boss.pos.x + 20, 212, boss.pos.z + 330], psiTo(-0.06, -1), 38, 3);
			camFn = null; // the game's own chase camera, with the HUD on
			await pages[0].evaluate(() => { document.getElementById('chatLog').innerHTML = ''; });
			for (let i = 0; i < pages.length; i++) await pages[i].evaluate((m) => window.__pd.netSend({ t: 'chat', text: m }), chats[i]);
			// staged beats (the pilots' own hits count too): the last sacs burst, then the heart gives way
			S.beats = [
				[1.0, () => { boss.parts[3].alive = false; boss.podsLeft--; }],
				[1.7, () => { boss.parts[4].alive = false; boss.podsLeft--; }],
				[2.3, () => { boss.parts[5].alive = false; boss.podsLeft = 0; }],
				[2.95, () => { if (boss.alive) killEnemy(W, boss, pilots[0]); }],
			];
		}
		// clear the scenery of patrols for the travel shots
		const p0 = pathFn(-WARM * DT), p1 = pathFn(S.dur);
		if (!S.boss) for (const e of [...W.enemies.values()]) if (Math.min(Math.hypot(e.pos.x - p0[0], e.pos.z - p0[2]), Math.hypot(e.pos.x - p1[0], e.pos.z - p1[2])) < 1300) W.removeEnemy(e);
		const clear = (L) => { let m = 1e9; for (const s of SLOTS) { const q = slotPose(L, s); m = Math.min(m, q[1] - ground(q[0], q[2])); } return m; };
		console.log(`[film] shot ${S.name}: ${total} frames, lowest clearance ${Math.round(Math.min(clear(poseOf(pathFn, 0)), clear(poseOf(pathFn, S.dur / 2)), clear(poseOf(pathFn, S.dur))))} m`);
		for (const sample of samples) {
			// a full shot runs from -WARM; a still warms up for 20 frames before its sample
			const from = sample === null ? -WARM : sample - 20, to = sample === null ? total : sample + 1;
			// teleport the four pilots to their slots (also invalidates in-flight reports)
			const lead0 = poseOf(pathFn, from * DT);
			pilots.forEach((P, i) => { const q = slotPose(lead0, SLOTS[i]); teleport(W, P, q[0], q[1], q[2], q[3]); });
			for (let f = from; f < to; f++) {
				const t = f * DT;
				const lead = poseOf(pathFn, t);
				if (S.beats && sample === null) for (const bt of S.beats) if (!bt.done && t >= bt[0]) { bt.done = true; bt[1](); }
				step();
				await sleep(12);
				const capO = S.end && t > S.dur - 1.7 ? 0 : Math.min(1, Math.max(0, (t - 0.25) / 0.35), Math.max(0, (S.dur - 0.2 - t) / 0.35));
				const endO = S.end ? Math.min(1, Math.max(0, (t - (S.dur - 1.6)) / 0.4)) : 0;
				await Promise.all(pages.map((p, i) => p.evaluate(clientFrame, {
					pose: slotPose(lead, SLOTS[i]),
					cam: i === 0 && camFn ? camFn(t, lead) : null,
					hour: S.hour, hud: !!S.hud,
					fire: S.boss && t > -0.6 && t < S.dur - 1.2,
					fade: f === 0 ? 0.6 : undefined,
					camMode: S.boss ? 4 : 0,
					ov: i === 0 ? { cap: S.cap, title: !!S.title, o: f < 0 ? 0 : capO, end: endO } : null,
				})));
				if (f < 0) continue;
				const keep = !PREVIEW || (STILLS ? f === sample : f === 6 || f === Math.floor(total / 2) || f === total - 4);
				if (keep) {
					const file = PREVIEW ? path.join(frames, `${S.name}-${String(f).padStart(3, '0')}.jpg`) : path.join(frames, String(n).padStart(5, '0') + '.jpg');
					await pages[0].screenshot({ path: file, type: 'jpeg', quality: 94 });
					n++;
				}
				if (f % 30 === 0) console.log(`[film]   ${S.name} t=${t.toFixed(1)}s · ${n} frames · ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed${boss ? ' · boss ' + (boss.alive ? Math.round(boss.hp) + ' hp' : 'down') : ''}`);
			}
		}
	}
	await browser.close();
	await new Promise((r) => shard.server.close(r));
	if (!PREVIEW) {
		console.log('[film] encoding ' + n + ' frames → ' + OUT);
		const video = SILENT ? OUT : path.join(frames, 'silent.mp4');
		execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, '%05d.jpg'),
			'-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
		if (!SILENT) {
			console.log('[film] mixing the soundtrack');
			// imported lazily: soundtrack.js itself imports the shot list from this module
			const { addSoundtrack } = await import('./soundtrack.js');
			addSoundtrack(video, OUT, path.join(frames, 'soundtrack.wav'));
		}
		fs.rmSync(frames, { recursive: true, force: true });
	}
	fs.rmSync(dataDir, { recursive: true, force: true });
	console.log('[film] done in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
	process.exit(0);
}

// tools/soundtrack.js reuses the shot list to place engines, cuts and hits in time.
export { SHOTS, SLOTS, FPS, poseOf, slotPose };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
