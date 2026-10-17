// Mini Atys browser client.
// Like the Ryzom client (ryzom/client/src), the local character is moved by
// the client and its position is sent to the server, which validates it.
// Every other entity is rendered from server snapshots with interpolation.

(function () {
	'use strict';

	const R = window.Rules;
	const $ = (id) => document.getElementById(id);
	const canvas = $('game');
	const ctx = canvas.getContext('2d');
	const CHUNK = 16;
	const INTERP_DELAY = 130; // ms behind the newest snapshot
	const KITINS = { kipee: 1, kincher: 1, kirosta: 1 };
	const ICONS = { attack: '⚔', fire: '🔥', heal: '✚', potion: '🧪', crystal: '💎' };
	const TILE_COLORS = ['#5b8c3a', '#d8c088', '#2f6e9e', '#3a6630', '#b8a57c', '#9b7b52', '#8d8a80', '#3f6a33', '#2f5a35', '#5c9cb8'];

	let TS = 32; // pixels per tile
	let W = 0, H = 0, dpr = 1;

	const S = {
		ws: null, myId: 0, me: null, map: null, chunks: new Map(), minimap: null,
		entities: new Map(), px: 0, py: 0, pdir: Math.PI / 2, moving: false,
		target: 0, chase: null, moveTo: null, keys: {},
		floats: [], effects: [], items: {}, gear: {}, shop: [],
		lastSent: { x: 0, y: 0, t: 0 }, cds: {}, ping: 0, lastAttackAnim: 0,
		shopOpen: false,
	};

	// ------------------------------------------------------------ networking

	function send(m) {
		if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m));
	}

	function connect(name, pass) {
		if (S.ws) { S.ws.onclose = null; S.ws.close(); }
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const ws = new WebSocket(proto + '//' + location.host + '/ws');
		S.ws = ws;
		loginMsg('Connecting...');
		ws.onopen = () => send({ t: 'login', name, pass });
		ws.onmessage = (ev) => {
			let m;
			try { m = JSON.parse(ev.data); } catch (e) { return; }
			handle(m);
		};
		ws.onclose = () => { if (S.ws === ws) disconnected(); };
		try { localStorage.setItem('miniatys.name', name); } catch (e) { /* storage unavailable */ }
	}

	function disconnected() {
		S.ws = null;
		S.myId = 0;
		$('hud').classList.add('hidden');
		$('login').classList.remove('hidden');
		if (!$('login-msg').classList.contains('error')) loginMsg('Disconnected from the shard.', true);
	}

	function handle(m) {
		switch (m.t) {
		case 'loginFail': loginMsg(m.error, true); S.ws.close(); break;
		case 'kicked': loginMsg(m.reason, true); break;
		case 'welcome': onWelcome(m); break;
		case 'me': onMe(m); break;
		case 'tick': onTick(m); break;
		case 'teleport':
			S.px = m.x; S.py = m.y; S.moveTo = null; S.chase = null;
			S.lastSent = { x: m.x, y: m.y, t: performance.now() };
			break;
		case 'correct':
			S.px = m.x; S.py = m.y;
			S.lastSent = { x: m.x, y: m.y, t: performance.now() };
			break;
		case 'chat': chatLine(m.ch, m.from, m.text); break;
		case 'err': toast(m.text, true); break;
		case 'loot': chatLine('loot', null, m.text); break;
		case 'xp': addFloat(S.px, S.py - 0.9, '+' + m.v + ' XP', '#c49bff', 1.1); break;
		case 'shop':
			$('shop-title').textContent = m.npc;
			$('panel-bag').classList.add('hidden');
			S.shopOpen = true;
			renderShop();
			show('panel-shop');
			break;
		case 'dialog':
			$('dialog-title').textContent = m.npc;
			$('dialog-body').innerHTML = m.lines.map((l) => '<p>' + esc(l) + '</p>').join('');
			show('panel-dialog');
			break;
		case 'pong': S.ping = Math.round(performance.now() - m.ts); $('ping').textContent = S.ping; break;
		}
	}

	function onWelcome(m) {
		S.myId = m.id;
		const bin = atob(m.map.tiles);
		const tiles = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) tiles[i] = bin.charCodeAt(i);
		S.map = { w: m.map.w, h: m.map.h, tiles };
		S.chunks.clear();
		S.entities.clear();
		S.items = m.items;
		S.gear = m.gear;
		S.shop = m.shop;
		S.px = m.x; S.py = m.y;
		S.lastSent = { x: m.x, y: m.y, t: performance.now() };
		S.target = 0; S.chase = null; S.moveTo = null;
		buildMinimap();
		$('login').classList.add('hidden');
		$('hud').classList.remove('hidden');
		$('login-msg').classList.remove('error');
		$('chatlog').innerHTML = '';
		chatLine('sys', null, m.motd);
		chatLine('sys', null, m.online + ' homin(s) online. Press H for help.');
		if (m.created) show('panel-help');
	}

	function onMe(m) {
		S.me = m;
		const now = performance.now();
		for (const k of Object.keys(R.ACTIONS)) {
			const ms = m.cds[k] || 0;
			S.cds[k] = ms > 0 ? { end: now + ms, total: R.ACTIONS[k].cooldown * 1000 } : null;
		}
		$('self-name').textContent = m.name;
		$('self-level').textContent = m.level;
		setBar('hp', m.hp, m.maxHp);
		setBar('sap', m.sap, m.maxSap);
		setBar('sta', m.sta, m.maxSta);
		$('self-dappers').textContent = m.dappers;
		$('xpfill').style.width = (100 * m.xp / m.xpNext).toFixed(1) + '%';
		$('xptxt').textContent = m.level >= R.MAX_LEVEL ? 'MAX LEVEL' : m.xp + ' / ' + m.xpNext + ' XP';
		$('region').textContent = regionName(m.region);
		$('death').classList.toggle('hidden', m.alive);
		if (!m.alive) { S.chase = null; S.moveTo = null; }
		if (!$('panel-bag').classList.contains('hidden')) renderBag();
		if (S.shopOpen) renderShop();
	}

	function onTick(m) {
		const now = performance.now();
		if (m.add) {
			for (const a of m.add) {
				a.buf = [{ t: now, x: a.x, y: a.y }];
				a.dir = Math.PI / 2;
				a.atk = 0;
				a.lastMove = 0;
				S.entities.set(a.id, a);
			}
		}
		if (m.upd) {
			for (const [id, x, y, hp, f] of m.upd) {
				const e = S.entities.get(id);
				if (!e) continue;
				const last = e.buf[e.buf.length - 1];
				if (Math.abs(last.x - x) > 0.01 || Math.abs(last.y - y) > 0.01) {
					e.dir = Math.atan2(y - last.y, x - last.x);
					e.lastMove = now;
				}
				e.buf.push({ t: now, x, y });
				if (e.buf.length > 12) e.buf.shift();
				e.hp = hp;
				e.f = f;
			}
		}
		if (m.del) {
			for (const id of m.del) {
				S.entities.delete(id);
				if (S.target === id) S.target = 0;
			}
		}
		if (m.ev) for (const ev of m.ev) onEvent(ev);
	}

	function onEvent(ev) {
		const t = S.entities.get(ev.t || ev.id);
		const pos = t ? entityPos(t) : null;
		switch (ev.e) {
		case 'dmg': {
			const src = S.entities.get(ev.s);
			if (src) {
				src.atk = performance.now();
				if (t) src.dir = Math.atan2(entityPos(t)[1] - entityPos(src)[1], entityPos(t)[0] - entityPos(src)[0]);
				if (ev.s === S.myId && t) S.pdir = src.dir;
			}
			if (!pos) break;
			if (ev.k === 'miss') addFloat(pos[0], pos[1] - 0.6, 'miss', '#cccccc', 0.9);
			else if (ev.k === 'evade') addFloat(pos[0], pos[1] - 0.6, 'evade', '#cccccc', 0.9);
			else if (ev.k === 'heal') addFloat(pos[0], pos[1] - 0.6, '+' + ev.v, '#5fe36a', 1.1);
			else {
				const mine = ev.t === S.myId;
				const color = mine ? '#ff5a4a' : ev.k === 'fire' ? '#ff9a3c' : ev.k === 'crit' ? '#ffd84a' : '#ffffff';
				addFloat(pos[0], pos[1] - 0.6, ev.v + (ev.k === 'crit' ? '!' : ''), color, ev.k === 'crit' ? 1.5 : 1.1);
				if (ev.k === 'fire' && src) S.effects.push({ kind: 'bolt', from: entityPos(src), to: pos, t0: performance.now(), dur: 250 });
			}
			break;
		}
		case 'death':
			if (ev.id === S.myId) chatLine('err', null, 'You died.');
			else if (t && t.k === 'creature' && ev.by === S.myId) chatLine('sys', null, 'You killed ' + t.n + '.');
			break;
		case 'levelup':
			if (pos) S.effects.push({ kind: 'ring', x: pos[0], y: pos[1], color: '#ffd84a', t0: performance.now(), dur: 1200 });
			if (t) t.l = ev.l;
			if (ev.id === S.myId) toast('Level ' + ev.l + '!');
			break;
		case 'respawn':
			if (pos) S.effects.push({ kind: 'ring', x: pos[0], y: pos[1], color: '#8fe3ff', t0: performance.now(), dur: 900 });
			break;
		case 'sap':
			if (pos) S.effects.push({ kind: 'ring', x: pos[0], y: pos[1], color: '#4f9be8', t0: performance.now(), dur: 700 });
			break;
		}
	}

	// ----------------------------------------------------------------- input

	function useAction(id) {
		if (!S.me || !S.me.alive) return;
		const a = R.ACTIONS[id];
		const t = S.entities.get(S.target);
		if (id === 'attack' || id === 'fire') {
			if (!t || t.k !== 'creature' || (t.f & 1)) return toast('Select a living creature first', true);
			S.moveTo = null;
			if (id === 'attack') {
				// The server swings while in range; the client keeps following the target.
				send({ t: 'act', a: 'attack', target: t.id });
				S.chase = { action: 'attack', id: t.id, since: performance.now() };
				return;
			}
			const tp = entityPos(t);
			if (Math.hypot(tp[0] - S.px, tp[1] - S.py) > a.range - 0.2) S.chase = { action: 'fire', id: t.id, since: performance.now() };
			else send({ t: 'act', a: 'fire', target: t.id });
		} else if (id === 'heal') {
			if (t && t.k === 'player' && t.id !== S.myId && !(t.f & 1)) {
				const tp = entityPos(t);
				if (Math.hypot(tp[0] - S.px, tp[1] - S.py) > a.range - 0.2) { S.chase = { action: 'heal', id: t.id, since: performance.now() }; return; }
				send({ t: 'act', a: 'heal', target: t.id });
			} else send({ t: 'act', a: 'heal', target: S.myId });
		} else {
			send({ t: 'act', a: id });
		}
	}

	function stopAll() {
		S.target = 0;
		S.chase = null;
		send({ t: 'stop' });
	}

	function talkTo(npc) {
		const p = entityPos(npc);
		if (Math.hypot(p[0] - S.px, p[1] - S.py) < 3.2) send({ t: 'talk', id: npc.id });
		else S.chase = { action: 'talk', id: npc.id, since: performance.now() };
	}

	function nearestCreature() {
		let best = null, bd = 16;
		for (const e of S.entities.values()) {
			if (e.k !== 'creature' || (e.f & 1) || e.id === S.target) continue;
			const p = entityPos(e);
			const d = Math.hypot(p[0] - S.px, p[1] - S.py);
			if (d < bd) { bd = d; best = e; }
		}
		return best;
	}

	function nearestNpc() {
		for (const e of S.entities.values()) {
			if (e.k === 'npc') {
				const p = entityPos(e);
				if (Math.hypot(p[0] - S.px, p[1] - S.py) < 4) return e;
			}
		}
		return null;
	}

	const KEYMAP = { '1': 'attack', '2': 'fire', '3': 'heal', '4': 'potion', '5': 'crystal' };

	function hotkey(k) {
		if (KEYMAP[k]) return useAction(KEYMAP[k]);
		if (k === 'tab') { const c = nearestCreature(); if (c) S.target = c.id; return; }
		if (k === 'escape') { hideAll(); return stopAll(); }
		if (k === 'i') {
			$('panel-shop').classList.add('hidden');
			S.shopOpen = false;
			toggle('panel-bag');
			renderBag();
			return;
		}
		if (k === 'h') return toggle('panel-help');
		if (k === 'e' || k === 'f') { const n = nearestNpc(); if (n) talkTo(n); }
	}

	window.addEventListener('keydown', (ev) => {
		if (!S.myId) return;
		const chatFocused = document.activeElement === $('chatinput');
		const k = ev.key.toLowerCase();
		if (chatFocused) {
			if (k === 'escape') $('chatinput').blur();
			return;
		}
		if (k === 'enter') { ev.preventDefault(); $('chatinput').focus(); return; }
		if (k === 'tab') ev.preventDefault();
		S.keys[k] = true;
		if (!ev.repeat) hotkey(k);
	});
	window.addEventListener('keyup', (ev) => { S.keys[ev.key.toLowerCase()] = false; });
	window.addEventListener('blur', () => { S.keys = {}; });

	$('chatinput').addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter') {
			const text = ev.target.value.trim();
			if (text) send({ t: 'chat', text });
			ev.target.value = '';
			ev.target.blur();
		}
	});

	canvas.addEventListener('pointerdown', (ev) => {
		if (!S.myId || !S.me || !S.me.alive) return;
		document.activeElement.blur();
		const wx = (ev.clientX + camX()) / TS, wy = (ev.clientY + camY()) / TS;
		let hit = null, hd = Infinity;
		for (const e of S.entities.values()) {
			if (e.id === S.myId) continue;
			const p = entityPos(e);
			const d = Math.hypot(p[0] - wx, p[1] - wy);
			if (d < Math.max(0.6, (e.sz || 0.4) + 0.25) && d < hd) { hit = e; hd = d; }
		}
		if (hit) {
			S.target = hit.id;
			if (hit.k === 'creature' && !(hit.f & 1)) useAction('attack');
			else if (hit.k === 'npc') talkTo(hit);
			return;
		}
		S.chase = null;
		S.moveTo = [wx, wy];
		S.effects.push({ kind: 'click', x: wx, y: wy, color: '#ffffff', t0: performance.now(), dur: 400 });
	});
	canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

	$('login-form').addEventListener('submit', (ev) => {
		ev.preventDefault();
		$('login-msg').classList.remove('error');
		connect($('name').value.trim(), $('pass').value);
	});
	$('respawn-btn').addEventListener('click', () => send({ t: 'respawn' }));
	document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
		$(b.dataset.close).classList.add('hidden');
		if (b.dataset.close === 'panel-shop') S.shopOpen = false;
	}));
	document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => hotkey(b.dataset.key)));

	// --------------------------------------------------------------- movement

	function updateSelf(dt) {
		if (!S.map || !S.me || !S.me.alive) return;
		let dx = 0, dy = 0;
		const k = S.keys;
		if (k.w || k.arrowup) dy -= 1;
		if (k.s || k.arrowdown) dy += 1;
		if (k.a || k.arrowleft) dx -= 1;
		if (k.d || k.arrowright) dx += 1;
		const step = R.PLAYER_SPEED * dt;
		const ox = S.px, oy = S.py;

		if (dx || dy) {
			const n = Math.hypot(dx, dy);
			S.moveTo = null;
			S.chase = null;
			[S.px, S.py] = R.moveWithSlide(S.map, S.px, S.py, (dx / n) * step, (dy / n) * step);
		} else if (S.chase) {
			const t = S.entities.get(S.chase.id);
			if (!t || (t.f & 1) || (S.chase.action === 'attack' && S.me.target !== t.id && performance.now() - S.chase.since > 600)) {
				S.chase = null;
			} else {
				const tp = entityPos(t);
				const a = R.ACTIONS[S.chase.action];
				const range = (S.chase.action === 'talk' ? 3 : a.range) - 0.3;
				const d = Math.hypot(tp[0] - S.px, tp[1] - S.py);
				if (d > range) {
					[S.px, S.py] = R.steer(S.map, S.px, S.py, tp[0], tp[1], Math.min(step, d - range + 0.05));
				} else {
					S.pdir = Math.atan2(tp[1] - S.py, tp[0] - S.px);
					if (S.chase.action === 'talk') { send({ t: 'talk', id: t.id }); S.chase = null; }
					else if (S.chase.action !== 'attack') { send({ t: 'act', a: S.chase.action, target: t.id }); S.chase = null; }
				}
			}
		} else if (S.moveTo) {
			const [tx, ty] = S.moveTo;
			[S.px, S.py] = R.steer(S.map, S.px, S.py, tx, ty, step);
			if (Math.hypot(tx - S.px, ty - S.py) < 0.15 || (S.px === ox && S.py === oy)) S.moveTo = null;
		}

		S.moving = S.px !== ox || S.py !== oy;
		if (S.moving) S.pdir = Math.atan2(S.py - oy, S.px - ox);
		const now = performance.now();
		if ((S.px !== S.lastSent.x || S.py !== S.lastSent.y) && now - S.lastSent.t >= 50) {
			const x = Math.round(S.px * 1000) / 1000, y = Math.round(S.py * 1000) / 1000;
			send({ t: 'pos', x, y });
			S.lastSent = { x: S.px, y: S.py, t: now };
		}
	}

	function entityPos(e) {
		if (e.id === S.myId) return [S.px, S.py];
		const buf = e.buf;
		const rt = performance.now() - INTERP_DELAY;
		if (rt <= buf[0].t) return [buf[0].x, buf[0].y];
		for (let i = buf.length - 1; i > 0; i--) {
			const a = buf[i - 1], b = buf[i];
			if (rt >= a.t) {
				if (rt >= b.t) return [b.x, b.y];
				const f = (rt - a.t) / (b.t - a.t);
				return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
			}
		}
		const last = buf[buf.length - 1];
		return [last.x, last.y];
	}

	// --------------------------------------------------------------- drawing

	function camX() { return Math.round(S.px * TS - W / 2); }
	function camY() { return Math.round(S.py * TS - H / 2); }

	function hash(x, y, s) {
		let h = (x * 374761393 + y * 668265263 + (s || 0) * 2246822519) | 0;
		h = Math.imul(h ^ (h >>> 13), 1274126177);
		return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
	}

	function shade(hex, f) {
		const n = parseInt(hex.slice(1), 16);
		const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
		return 'rgb(' + c(n >> 16) + ',' + c((n >> 8) & 255) + ',' + c(n & 255) + ')';
	}

	function buildChunk(cx, cy) {
		const c = document.createElement('canvas');
		c.width = c.height = CHUNK * TS;
		const g = c.getContext('2d');
		const T = R.TILE;
		for (let ty = 0; ty < CHUNK; ty++) {
			for (let tx = 0; tx < CHUNK; tx++) {
				const wx = cx * CHUNK + tx, wy = cy * CHUNK + ty;
				const t = R.tileAt(S.map, wx + 0.5, wy + 0.5);
				const x = tx * TS, y = ty * TS;
				let base = TILE_COLORS[t];
				if (t === T.TREE) base = TILE_COLORS[T.FOREST];
				if (t === T.ROCK) base = TILE_COLORS[T.SAND];
				g.fillStyle = base;
				g.fillRect(x, y, TS, TS);
				for (let i = 0; i < 4; i++) {
					const r = hash(wx, wy, i);
					g.fillStyle = shade(base, 0.85 + hash(wx, wy, i + 9) * 0.3);
					g.fillRect(x + Math.floor(r * TS * 0.85), y + Math.floor(hash(wx, wy, i + 4) * TS * 0.85), 3, 3);
				}
				if (t === T.STONE) {
					g.strokeStyle = 'rgba(0,0,0,0.18)';
					g.strokeRect(x + 0.5, y + 0.5, TS - 1, TS - 1);
					if ((wx + wy) % 2) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x, y, TS, TS); }
				} else if (t === T.WATER || t === T.SHALLOW) {
					g.strokeStyle = 'rgba(255,255,255,0.18)';
					g.beginPath();
					const wy0 = y + TS * (0.3 + hash(wx, wy, 7) * 0.4);
					g.moveTo(x + TS * 0.2, wy0);
					g.quadraticCurveTo(x + TS * 0.5, wy0 - 4, x + TS * 0.8, wy0);
					g.stroke();
				} else if (t === T.TREE) {
					const ox = (hash(wx, wy, 1) - 0.5) * TS * 0.2, oy = (hash(wx, wy, 2) - 0.5) * TS * 0.2;
					const r = TS * (0.42 + hash(wx, wy, 3) * 0.12);
					const green = hash(wx, wy, 5) > 0.5 ? '#2c5a22' : '#24502e';
					g.fillStyle = 'rgba(0,0,0,0.25)';
					g.beginPath(); g.ellipse(x + TS / 2 + ox + 3, y + TS / 2 + oy + 4, r, r * 0.8, 0, 0, 7); g.fill();
					g.fillStyle = green;
					g.beginPath(); g.arc(x + TS / 2 + ox, y + TS / 2 + oy, r, 0, 7); g.fill();
					g.fillStyle = shade(green === '#2c5a22' ? '#2c5a22' : '#24502e', 1.35);
					g.beginPath(); g.arc(x + TS / 2 + ox - r * 0.25, y + TS / 2 + oy - r * 0.25, r * 0.55, 0, 7); g.fill();
				} else if (t === T.ROCK) {
					const s = 0.7 + hash(wx, wy, 3) * 0.25;
					g.fillStyle = '#7d7468';
					g.beginPath();
					g.moveTo(x + TS * (0.5 - 0.42 * s), y + TS * 0.8);
					g.lineTo(x + TS * (0.5 - 0.3 * s), y + TS * (0.8 - 0.6 * s));
					g.lineTo(x + TS * (0.5 + 0.15 * s), y + TS * (0.8 - 0.7 * s));
					g.lineTo(x + TS * (0.5 + 0.45 * s), y + TS * (0.8 - 0.3 * s));
					g.lineTo(x + TS * (0.5 + 0.4 * s), y + TS * 0.85);
					g.closePath();
					g.fill();
					g.fillStyle = 'rgba(255,255,255,0.15)';
					g.fillRect(x + TS * 0.38, y + TS * (0.8 - 0.55 * s), TS * 0.15, TS * 0.12);
				}
			}
		}
		return c;
	}

	function drawMap() {
		const cx0 = Math.floor(camX() / (CHUNK * TS)), cy0 = Math.floor(camY() / (CHUNK * TS));
		const cx1 = Math.floor((camX() + W) / (CHUNK * TS)), cy1 = Math.floor((camY() + H) / (CHUNK * TS));
		for (let cy = cy0; cy <= cy1; cy++) {
			for (let cx = cx0; cx <= cx1; cx++) {
				if (cx < 0 || cy < 0 || cx * CHUNK >= S.map.w || cy * CHUNK >= S.map.h) continue;
				const key = cx + ',' + cy;
				let c = S.chunks.get(key);
				if (!c) { c = buildChunk(cx, cy); S.chunks.set(key, c); }
				ctx.drawImage(c, cx * CHUNK * TS - camX(), cy * CHUNK * TS - camY());
			}
		}
	}

	function conColor(level) {
		if (!S.me) return '#fff';
		const d = level - S.me.level;
		if (d >= 5) return '#ff4a4a';
		if (d >= 3) return '#ff9a3c';
		if (d >= -2) return '#ffd84a';
		if (d >= -5) return '#5fd35f';
		return '#9a9a9a';
	}

	function drawEntity(e, now) {
		const [wx, wy] = entityPos(e);
		const sx = wx * TS - camX(), sy = wy * TS - camY();
		if (sx < -80 || sy < -80 || sx > W + 80 || sy > H + 80) return;
		const dead = e.f & 1;
		const size = (e.sz || 0.36) * TS * 1.45;
		const isMe = e.id === S.myId;
		const dir = isMe ? S.pdir : e.dir;
		const moving = isMe ? S.moving : now - e.lastMove < 250;
		const atkT = (now - e.atk) / 220;
		const lunge = atkT < 1 ? Math.sin(atkT * Math.PI) * TS * 0.18 : 0;
		const walk = moving ? Math.sin(now / 90) : 0;

		ctx.save();
		ctx.translate(sx, sy);
		if (dead) ctx.globalAlpha = 0.45;

		if (S.target === e.id) {
			ctx.strokeStyle = e.k === 'creature' ? '#ff5a4a' : e.k === 'npc' ? '#e8b04a' : '#5fe36a';
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.ellipse(0, size * 0.55, size * 1.25, size * 0.55, 0, 0, 7);
			ctx.stroke();
		}
		ctx.fillStyle = 'rgba(0,0,0,0.3)';
		ctx.beginPath();
		ctx.ellipse(0, size * 0.55, size * 0.95, size * 0.4, 0, 0, 7);
		ctx.fill();

		ctx.save();
		ctx.rotate(dir + (dead ? 0.6 : 0));
		ctx.translate(lunge, 0);
		if (e.k === 'creature') drawCreature(e, size, walk, dead);
		else if (e.k === 'npc') drawHumanoid(size, e.c, '#e0c49a', null, 0);
		else drawHumanoid(size, isMe ? '#e8b04a' : '#4a90e2', '#f0cfa0', e.g, walk);
		ctx.restore();

		// Labels
		ctx.textAlign = 'center';
		ctx.font = (e.b ? 'bold 13px' : '12px') + ' system-ui, sans-serif';
		const label = e.k === 'npc' ? e.n : e.n + (e.k === 'creature' ? ' ' + e.l : '');
		const ly = -size - 14;
		ctx.lineWidth = 3;
		ctx.strokeStyle = 'rgba(0,0,0,0.8)';
		ctx.strokeText(label, 0, ly);
		ctx.fillStyle = e.k === 'npc' ? '#ffe9a8' : e.k === 'player' ? (isMe ? '#ffd27a' : '#9cd0ff') : conColor(e.l);
		ctx.fillText(label, 0, ly);
		if (e.k === 'npc') {
			ctx.font = 'bold 16px system-ui, sans-serif';
			ctx.fillStyle = '#ffd84a';
			ctx.strokeText(e.r === 'merchant' ? '$' : '?', 0, ly - 15);
			ctx.fillText(e.r === 'merchant' ? '$' : '?', 0, ly - 15);
		}
		if (e.k !== 'npc' && !dead && (e.hp < 100 || S.target === e.id || (e.f & 2))) {
			const bw = Math.max(30, size * 2.2);
			ctx.fillStyle = 'rgba(0,0,0,0.7)';
			ctx.fillRect(-bw / 2 - 1, ly + 4, bw + 2, 6);
			ctx.fillStyle = e.k === 'creature' ? '#d9443a' : '#4ccf54';
			ctx.fillRect(-bw / 2, ly + 5, bw * e.hp / 100, 4);
		}
		if (e.f & 4) {
			ctx.fillStyle = '#cfe8ff';
			ctx.font = '11px system-ui, sans-serif';
			ctx.fillText('evading', 0, ly - 14);
		}
		ctx.restore();
	}

	function drawHumanoid(size, cloth, skin, gear, walk) {
		// Top-down homin facing +x
		ctx.fillStyle = shade(cloth, 0.7);
		ctx.beginPath(); ctx.ellipse(-size * 0.1 + walk * 2, -size * 0.35, size * 0.28, size * 0.18, 0, 0, 7); ctx.fill();
		ctx.beginPath(); ctx.ellipse(-size * 0.1 - walk * 2, size * 0.35, size * 0.28, size * 0.18, 0, 0, 7); ctx.fill();
		ctx.fillStyle = cloth;
		ctx.beginPath(); ctx.ellipse(0, 0, size * 0.5, size * 0.8, 0, 0, 7); ctx.fill();
		ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
		if (gear) {
			const big = gear[0] === 'axe' ? 1.25 : gear[0] === 'sword' ? 1.1 : 0.8;
			ctx.strokeStyle = gear[0] === 'axe' ? '#d8d04a' : '#d0d6de';
			ctx.lineWidth = 3;
			ctx.beginPath(); ctx.moveTo(size * 0.2, size * 0.6); ctx.lineTo(size * (0.2 + big), size * 0.55); ctx.stroke();
			if (gear[1] !== 'cloth') {
				ctx.strokeStyle = gear[1] === 'heavy' ? '#c0c4c8' : '#8a6a3a';
				ctx.lineWidth = 2.5;
				ctx.beginPath(); ctx.ellipse(0, 0, size * 0.42, size * 0.7, 0, 0, 7); ctx.stroke();
			}
		}
		ctx.fillStyle = skin;
		ctx.beginPath(); ctx.arc(size * 0.12, 0, size * 0.33, 0, 7); ctx.fill();
		ctx.fillStyle = 'rgba(60,40,20,0.8)';
		ctx.beginPath(); ctx.arc(size * 0.02, 0, size * 0.28, Math.PI * 0.5, Math.PI * 1.5); ctx.fill();
	}

	function drawCreature(e, size, walk, dead) {
		const col = e.c || '#aaa';
		if (KITINS[e.s]) {
			// Kitin: segmented insect with six legs and mandibles
			ctx.strokeStyle = shade(col, 0.55);
			ctx.lineWidth = Math.max(2, size * 0.09);
			for (let i = -1; i <= 1; i++) {
				const sw = (i % 2 ? walk : -walk) * size * 0.15;
				for (const side of [-1, 1]) {
					ctx.beginPath();
					ctx.moveTo(i * size * 0.3, 0);
					ctx.lineTo(i * size * 0.35 + sw, side * size * 0.75);
					ctx.lineTo(i * size * 0.5 + sw, side * size * 0.95);
					ctx.stroke();
				}
			}
			ctx.fillStyle = shade(col, 0.8);
			ctx.beginPath(); ctx.ellipse(-size * 0.6, 0, size * 0.55, size * 0.4, 0, 0, 7); ctx.fill();
			ctx.fillStyle = col;
			ctx.beginPath(); ctx.ellipse(0, 0, size * 0.35, size * 0.32, 0, 0, 7); ctx.fill();
			ctx.beginPath(); ctx.ellipse(size * 0.45, 0, size * 0.25, size * 0.25, 0, 0, 7); ctx.fill();
			ctx.strokeStyle = shade(col, 0.4);
			ctx.lineWidth = 2;
			for (const side of [-1, 1]) {
				ctx.beginPath(); ctx.moveTo(size * 0.6, side * size * 0.1);
				ctx.quadraticCurveTo(size * 0.9, side * size * 0.25, size * 0.95, side * size * 0.02); ctx.stroke();
			}
			ctx.fillStyle = dead ? '#555' : '#ff3b30';
			ctx.beginPath(); ctx.arc(size * 0.55, -size * 0.1, 2, 0, 7); ctx.arc(size * 0.55, size * 0.1, 2, 0, 7); ctx.fill();
			return;
		}
		// Quadruped fauna (yubo, gingo, mektoub, torbak, ragus)
		const neck = e.s === 'mektoub' ? 0.5 : 0.2;
		ctx.fillStyle = shade(col, 0.6);
		for (const [lx, ly] of [[0.35, -0.4], [0.35, 0.4], [-0.4, -0.4], [-0.4, 0.4]]) {
			ctx.beginPath();
			ctx.ellipse(size * lx + walk * size * 0.12 * (ly > 0 ? 1 : -1), size * ly, size * 0.15, size * 0.12, 0, 0, 7);
			ctx.fill();
		}
		ctx.strokeStyle = shade(col, 0.7);
		ctx.lineWidth = 2;
		ctx.beginPath(); ctx.moveTo(-size * 0.6, 0); ctx.lineTo(-size * 0.95, walk * size * 0.15); ctx.stroke();
		ctx.fillStyle = col;
		ctx.beginPath(); ctx.ellipse(0, 0, size * 0.65, size * 0.42, 0, 0, 7); ctx.fill();
		ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1.2; ctx.stroke();
		ctx.fillStyle = shade(col, 1.1);
		ctx.beginPath(); ctx.arc(size * (0.55 + neck), 0, size * 0.3, 0, 7); ctx.fill();
		if (e.s === 'gingo' || e.s === 'ragus') {
			ctx.fillStyle = shade(col, 0.7);
			for (const side of [-1, 1]) {
				ctx.beginPath();
				ctx.moveTo(size * (0.5 + neck), side * size * 0.15);
				ctx.lineTo(size * (0.4 + neck), side * size * 0.42);
				ctx.lineTo(size * (0.65 + neck), side * size * 0.22);
				ctx.fill();
			}
		}
		if (e.s === 'torbak') {
			ctx.strokeStyle = '#efe6cf'; ctx.lineWidth = 2.5;
			for (const side of [-1, 1]) {
				ctx.beginPath(); ctx.moveTo(size * (0.7 + neck), side * size * 0.15);
				ctx.quadraticCurveTo(size * (1.0 + neck), side * size * 0.3, size * (1.0 + neck), side * size * 0.05); ctx.stroke();
			}
		}
		ctx.fillStyle = dead ? '#555' : '#111';
		ctx.beginPath(); ctx.arc(size * (0.68 + neck), -size * 0.12, 1.8, 0, 7); ctx.arc(size * (0.68 + neck), size * 0.12, 1.8, 0, 7); ctx.fill();
	}

	function addFloat(x, y, text, color, scale) {
		S.floats.push({ x: x + (Math.random() - 0.5) * 0.4, y, text, color, scale: scale || 1, t0: performance.now() });
	}

	function drawFloats(now) {
		ctx.textAlign = 'center';
		S.floats = S.floats.filter((f) => now - f.t0 < 1100);
		for (const f of S.floats) {
			const k = (now - f.t0) / 1100;
			const sx = f.x * TS - camX(), sy = f.y * TS - camY() - k * 36;
			ctx.globalAlpha = 1 - k * k;
			ctx.font = 'bold ' + Math.round(14 * f.scale) + 'px system-ui, sans-serif';
			ctx.lineWidth = 3;
			ctx.strokeStyle = 'rgba(0,0,0,0.85)';
			ctx.strokeText(f.text, sx, sy);
			ctx.fillStyle = f.color;
			ctx.fillText(f.text, sx, sy);
		}
		ctx.globalAlpha = 1;
	}

	function drawEffects(now) {
		S.effects = S.effects.filter((fx) => now - fx.t0 < fx.dur);
		for (const fx of S.effects) {
			const k = (now - fx.t0) / fx.dur;
			ctx.globalAlpha = 1 - k;
			if (fx.kind === 'ring' || fx.kind === 'click') {
				ctx.strokeStyle = fx.color;
				ctx.lineWidth = fx.kind === 'click' ? 2 : 4;
				const r = fx.kind === 'click' ? 4 + k * 10 : 10 + k * TS * 1.6;
				ctx.beginPath();
				ctx.ellipse(fx.x * TS - camX(), fx.y * TS - camY(), r, r * (fx.kind === 'click' ? 0.6 : 1), 0, 0, 7);
				ctx.stroke();
			} else if (fx.kind === 'bolt') {
				const x = fx.from[0] + (fx.to[0] - fx.from[0]) * k, y = fx.from[1] + (fx.to[1] - fx.from[1]) * k;
				const g = ctx.createRadialGradient(x * TS - camX(), y * TS - camY(), 1, x * TS - camX(), y * TS - camY(), 12);
				g.addColorStop(0, '#fff6c0');
				g.addColorStop(0.4, '#ff9a3c');
				g.addColorStop(1, 'rgba(255,80,0,0)');
				ctx.globalAlpha = 1;
				ctx.fillStyle = g;
				ctx.beginPath(); ctx.arc(x * TS - camX(), y * TS - camY(), 12, 0, 7); ctx.fill();
			}
		}
		ctx.globalAlpha = 1;
	}

	function buildMinimap() {
		const c = document.createElement('canvas');
		c.width = S.map.w;
		c.height = S.map.h;
		const g = c.getContext('2d');
		const img = g.createImageData(S.map.w, S.map.h);
		for (let i = 0; i < S.map.tiles.length; i++) {
			const t = S.map.tiles[i];
			const n = parseInt((t === R.TILE.TREE ? '#24502e' : t === R.TILE.ROCK ? '#7d7468' : TILE_COLORS[t]).slice(1), 16);
			img.data[i * 4] = n >> 16;
			img.data[i * 4 + 1] = (n >> 8) & 255;
			img.data[i * 4 + 2] = n & 255;
			img.data[i * 4 + 3] = 255;
		}
		g.putImageData(img, 0, 0);
		S.minimap = c;
	}

	let lastMini = 0;
	function drawMinimap(now) {
		if (now - lastMini < 200 || !S.minimap) return;
		lastMini = now;
		const mc = $('minimap'), g = mc.getContext('2d');
		const k = mc.width / S.map.w;
		g.imageSmoothingEnabled = false;
		g.drawImage(S.minimap, 0, 0, mc.width, mc.height);
		g.strokeStyle = 'rgba(255,255,255,0.5)';
		g.strokeRect((S.px * TS - W / 2) / TS * k, (S.py * TS - H / 2) / TS * k, W / TS * k, H / TS * k);
		for (const e of S.entities.values()) {
			if (e.id === S.myId || (e.f & 1)) continue;
			const p = entityPos(e);
			g.fillStyle = e.k === 'player' ? '#4aa8ff' : e.k === 'npc' ? '#ffd84a' : e.b ? '#ff00ff' : '#d9443a';
			g.fillRect(p[0] * k - 1, p[1] * k - 1, e.k === 'creature' && !e.b ? 2 : 3, e.k === 'creature' && !e.b ? 2 : 3);
		}
		g.fillStyle = '#fff';
		g.beginPath(); g.arc(S.px * k, S.py * k, 3, 0, 7); g.fill();
		$('coords').textContent = Math.floor(S.px) + ',' + Math.floor(S.py);
	}

	// ------------------------------------------------------------------- UI

	function setBar(id, v, max) {
		$('bar-' + id).style.width = Math.max(0, Math.min(100, (100 * v) / max)) + '%';
		$('txt-' + id).textContent = v + ' / ' + max;
	}

	function regionName(r) {
		return { silan: 'Silan Village (safe)', matis: 'Matis Forest', fyros: 'Fyros Desert', tryker: 'Tryker Lakes', zorai: 'Zorai Jungle' }[r] || '-';
	}

	function buildActionBar() {
		const bar = $('actionbar');
		bar.innerHTML = '';
		for (const [id, a] of Object.entries(R.ACTIONS)) {
			const el = document.createElement('div');
			el.className = 'slot';
			el.id = 'slot-' + id;
			el.innerHTML = '<span class="key">' + a.key + '</span><span class="icon">' + ICONS[id] + '</span>' +
				'<span class="label">' + a.name + '</span><span class="count"></span><div class="cd"></div>';
			el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); useAction(id); });
			bar.appendChild(el);
		}
	}

	function updateActionBar(now) {
		if (!S.me) return;
		for (const [id, a] of Object.entries(R.ACTIONS)) {
			const el = $('slot-' + id);
			const cd = S.cds[id];
			const rem = cd ? Math.max(0, cd.end - now) : 0;
			el.querySelector('.cd').style.height = (rem > 0 ? (100 * rem) / cd.total : 0) + '%';
			const noRes = S.me.sap < a.sap || (a.item && !(S.me.inventory[a.item] > 0));
			el.classList.toggle('nores', !!noRes);
			el.classList.toggle('active', id === 'attack' && !!S.me.target);
			if (a.item) el.querySelector('.count').textContent = S.me.inventory[a.item] || 0;
		}
	}

	let lastTargetKey = '';
	function updateTargetFrame() {
		const t = S.entities.get(S.target);
		const key = t ? t.id + ':' + t.hp + ':' + t.l + ':' + t.f : '';
		if (key === lastTargetKey) return;
		lastTargetKey = key;
		$('target-frame').classList.toggle('hidden', !t);
		if (!t) return;
		$('target-name').textContent = t.n + (t.f & 1 ? ' (dead)' : '');
		$('target-name').style.color = t.k === 'creature' ? conColor(t.l) : '#9cd0ff';
		$('target-level').textContent = t.k === 'npc' ? '-' : t.l;
		$('target-hp').parentNode.classList.toggle('hidden', t.k === 'npc');
		$('target-hp').style.width = t.hp + '%';
		$('target-hp-txt').textContent = t.hp + '%';
	}

	function renderBag() {
		if (!S.me) return;
		const m = S.me;
		let h = '<div class="row"><span>Dappers</span><b>' + m.dappers + '</b></div>';
		h += '<div class="row"><span>Kills / Deaths</span><span>' + m.kills + ' / ' + m.deaths + '</span></div>';
		h += '<div class="section">Equipment</div>';
		for (const slot of ['weapon', 'amp', 'armor']) {
			const g = (S.gear[slot] || []).find((x) => x.id === m.equip[slot]);
			h += '<div class="row"><span class="muted">' + slot + '</span><span>' + esc(g ? g.name : m.equip[slot]) +
				(g && g.bonus ? ' <span class="muted">+' + Math.round(g.bonus * 100) + '%</span>' : '') + '</span></div>';
		}
		h += '<div class="section">Bag</div>';
		const entries = Object.entries(m.inventory);
		if (!entries.length) h += '<div class="muted">Empty</div>';
		for (const [id, n] of entries) {
			const it = S.items[id] || { name: id };
			h += '<div class="row"><span>' + esc(it.name) + '</span><span>× ' + n + '</span></div>';
		}
		$('bag-body').innerHTML = h;
	}

	function renderShop() {
		if (!S.me) return;
		const m = S.me;
		let h = '<div class="row"><span>Your dappers</span><b>' + m.dappers + '</b></div><div class="section">Consumables</div>';
		for (const id of S.shop) {
			const it = S.items[id];
			h += '<div class="row"><span>' + esc(it.name) + ' <span class="muted">(have ' + (m.inventory[id] || 0) + ')</span></span>' +
				'<button data-buy="' + id + '"' + (m.dappers < it.price ? ' disabled' : '') + '>' + it.price + ' d</button></div>';
		}
		h += '<div class="section">Gear upgrades</div>';
		for (const slot of ['weapon', 'amp', 'armor']) {
			const tiers = S.gear[slot];
			const cur = tiers.findIndex((g) => g.id === m.equip[slot]);
			const next = tiers[cur + 1];
			if (!next) { h += '<div class="row"><span>' + esc(tiers[cur].name) + '</span><span class="muted">best</span></div>'; continue; }
			h += '<div class="row"><span>' + esc(next.name) + ' <span class="muted">+' + Math.round(next.bonus * 100) + '% ' +
				(slot === 'weapon' ? 'melee' : slot === 'amp' ? 'magic' : 'armor') + '</span></span>' +
				'<button data-buy="' + next.id + '"' + (m.dappers < next.price ? ' disabled' : '') + '>' + next.price + ' d</button></div>';
		}
		let value = 0;
		for (const [id, n] of Object.entries(m.inventory)) if (!S.shop.includes(id) && S.items[id]) value += S.items[id].sell * n;
		h += '<div class="section">Sell</div><div class="row"><span>All materials</span>' +
			'<button data-sell="1"' + (value ? '' : ' disabled') + '>+' + value + ' d</button></div>';
		$('shop-body').innerHTML = h;
		$('shop-body').querySelectorAll('[data-buy]').forEach((b) => b.addEventListener('click', () => send({ t: 'buy', item: b.dataset.buy })));
		$('shop-body').querySelectorAll('[data-sell]').forEach((b) => b.addEventListener('click', () => send({ t: 'sell' })));
	}

	function chatLine(ch, from, text) {
		const log = $('chatlog');
		const div = document.createElement('div');
		div.className = 'ch-' + ch;
		const prefix = ch === 'world' ? '[World] ' + from + ': ' : ch === 'say' ? from + ': ' : ch === 'emote' ? from + ' ' : '';
		div.textContent = prefix + text;
		const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
		log.appendChild(div);
		while (log.children.length > 120) log.removeChild(log.firstChild);
		if (atBottom) log.scrollTop = log.scrollHeight;
	}

	let toastTimer = 0;
	function toast(text, isErr) {
		const el = $('toast');
		el.textContent = text;
		el.className = 'show' + (isErr ? ' err' : '');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => { el.className = ''; }, isErr ? 1200 : 2000);
	}

	function loginMsg(text, isErr) {
		$('login-msg').textContent = text;
		$('login-msg').classList.toggle('error', !!isErr);
	}

	function show(id) { $(id).classList.remove('hidden'); }
	function toggle(id) { $(id).classList.toggle('hidden'); }
	function hideAll() {
		for (const id of ['panel-bag', 'panel-shop', 'panel-dialog', 'panel-help']) $(id).classList.add('hidden');
		S.shopOpen = false;
	}
	function esc(s) {
		return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	}

	// ------------------------------------------------------------- main loop

	function resize() {
		dpr = window.devicePixelRatio || 1;
		W = window.innerWidth;
		H = window.innerHeight;
		canvas.width = Math.round(W * dpr);
		canvas.height = Math.round(H * dpr);
		const newTS = W < 700 ? 26 : 32;
		if (newTS !== TS) { TS = newTS; S.chunks.clear(); }
	}
	window.addEventListener('resize', resize);

	let last = performance.now();
	function frame(now) {
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#0b0f0c';
		ctx.fillRect(0, 0, W, H);
		if (S.map && S.myId) {
			updateSelf(dt);
			drawMap();
			const list = [...S.entities.values()].sort((a, b) => {
				const da = a.f & 1, db = b.f & 1;
				if (da !== db) return db - da; // corpses below the living
				return entityPos(a)[1] - entityPos(b)[1];
			});
			for (const e of list) drawEntity(e, now);
			drawEffects(now);
			drawFloats(now);
			drawMinimap(now);
			updateActionBar(now);
			updateTargetFrame();
		}
		requestAnimationFrame(frame);
	}

	setInterval(() => send({ t: 'ping', ts: performance.now() }), 2000);
	try { $('name').value = localStorage.getItem('miniatys.name') || ''; } catch (e) { /* storage unavailable */ }
	resize();
	buildActionBar();
	requestAnimationFrame(frame);
}());
