// Frontend: sessions, login, message dispatch and per-pilot snapshots.
// Like the Ryzom frontend service, each client only receives what is near it,
// and far entities are refreshed less often (distance prioritizer).

import { NAME_RE, sanitize } from './chat.js';
import { CRAFT, UPGRADES, UPGRADE_COST, RAIDS, PVP, HUB, PADS, SPAWN, BOSS_LAIR, TICK_MS } from '../shared/rules.js';
import { createPlayer, clientState, correct, saveData, selfState, respawned, killPlayer, goHome, setCraft, buyUpgrade } from './players.js';
import { gunHits, pvpHits, missileFired, missileHit, dropFlares, pickCrate } from './combat.js';
import { partMask } from './enemies.js';

const VIEW_E = 3000, VIEW_P = 4500, VIEW_C = 2500, VIEW_EV = 3200;
const MAX_MSGS_PER_SEC = 90;
const MAX_BUFFERED = 1 << 20;

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

export class Frontend {
	constructor(W, persistence, events, chat) {
		this.W = W;
		this.persistence = persistence;
		this.events = events;
		this.chat = chat;
		this.sessions = new Set();
		this.cycle = 0;
		this.stats = { bytesOut: 0, msgsIn: 0 };
		W.notify = (P, msg) => { if (P.session) this._send(P.session, msg); };
		W.broadcast = (msg) => { for (const s of this.sessions) if (s.player) this._send(s, msg); };
	}

	attach(ws) {
		const s = { ws, player: null, known: new Map(), msgCount: 0, msgWindow: Date.now(), loggingIn: false };
		this.sessions.add(s);
		ws.on('message', (raw) => this._onMessage(s, raw));
		ws.on('close', () => this._onClose(s));
	}

	_send(s, msg) {
		if (!s.ws.open) return;
		const text = JSON.stringify(msg);
		this.stats.bytesOut += text.length;
		s.ws.send(text);
	}

	_onMessage(s, raw) {
		const now = Date.now();
		if (now - s.msgWindow > 1000) { s.msgWindow = now; s.msgCount = 0; }
		if (++s.msgCount > MAX_MSGS_PER_SEC) return s.ws.close(1008, 'flood');
		this.stats.msgsIn++;
		let m;
		try { m = JSON.parse(raw); } catch { return; }
		if (!m || typeof m !== 'object') return;
		if (m.t === 'ping') return this._send(s, { t: 'pong', ts: m.ts });
		if (!s.player) {
			if (m.t === 'login') this._login(s, m);
			return;
		}
		const W = this.W, P = s.player;
		switch (m.t) {
		case 'st':
			if (!clientState(W, P, m)) correct(W, P);
			break;
		case 'hit':
			if (m.g) gunHits(W, P, m.g);
			if (m.p) pvpHits(W, P, m.p);
			break;
		case 'mis':
			if (!missileFired(W, P, m.tg)) this._send(s, { t: 'err', text: 'Hết tên lửa — đáp xuống bãi chữ H hoặc nhặt thùng 📦' });
			break;
		case 'mh': missileHit(W, P, m.id, m.part, !!m.pl); break;
		case 'flare': dropFlares(W, P); break;
		case 'pick': pickCrate(W, P, m.id); break;
		case 'crash': killPlayer(W, P, null, sanitize(m.why).slice(0, 60) || 'rơi xuống'); break;
		case 'respawned': respawned(W, P); break;
		case 'home': goHome(W, P, false); break;
		case 'craft': setCraft(W, P, String(m.c)); break;
		case 'buy': buyUpgrade(W, P, String(m.u)); break;
		case 'chat': this.chat.handle(P, m.text); break;
		}
	}

	async _login(s, m) {
		if (s.loggingIn) return;
		const name = String(m.name || '').trim();
		const pass = String(m.pass || '');
		if (!NAME_RE.test(name)) return this._send(s, { t: 'loginFail', error: 'Tên phi công: 3–16 chữ cái/số/_ , bắt đầu bằng chữ' });
		if (pass.length < 3 || pass.length > 64) return this._send(s, { t: 'loginFail', error: 'Mật khẩu: 3–64 ký tự' });
		s.loggingIn = true;
		const res = await this.persistence.login(name, pass);
		s.loggingIn = false;
		if (!s.ws.open) return;
		if (!res.ok) return this._send(s, { t: 'loginFail', error: res.error });
		for (const other of this.sessions) {
			if (other.player && other.player.name.toLowerCase() === name.toLowerCase()) {
				this._send(other, { t: 'kicked', reason: 'Phi công này vừa đăng nhập ở nơi khác' });
				this._logout(other);
				other.ws.close(1000, 'replaced');
			}
		}
		const W = this.W;
		const P = createPlayer(W, res.name, this.persistence.getSave(res.name));
		P.session = s;
		s.player = P;
		this._send(s, {
			t: 'welcome', id: P.id, name: P.name, created: res.created, tick: TICK_MS,
			spawn: SPAWN, hub: HUB, pads: PADS, pvp: PVP, raids: RAIDS.map(({ id, name, icon, x, z, r }) => ({ id, name, icon, x, z, r })), lair: BOSS_LAIR,
			crafts: CRAFT, upgrades: UPGRADES, upgradeCost: UPGRADE_COST,
		});
		this._send(s, selfState(W, P));
		this._send(s, this.events.status());
		W.say((res.created ? '🛫 Phi công mới ' : '🛫 ') + P.name + ' cất cánh từ Ahamove Sky Hub');
		console.log('[FES] login ' + P.name + ' (#' + P.id + ') online=' + this.online());
	}

	online() {
		let n = 0;
		for (const s of this.sessions) if (s.player) n++;
		return n;
	}

	_logout(s) {
		const P = s.player;
		if (!P) return;
		this.persistence.store(P.name, saveData(P));
		P.session = null;
		this.W.players.delete(P.id);
		s.player = null;
		this.W.say('🛬 ' + P.name + ' hạ cánh rời bầu trời');
		console.log('[FES] logout ' + P.name + ' online=' + this.online());
	}

	_onClose(s) {
		this._logout(s);
		this.sessions.delete(s);
	}

	saveAll() {
		for (const s of this.sessions) if (s.player) this.persistence.store(s.player.name, saveData(s.player));
	}

	_addInfo(x) {
		if (x.type === 'player') return { id: x.id, k: 'p', n: x.name, c: x.craft, l: x.level };
		if (x.type === 'crate') return { id: x.id, k: 'crate', kind: x.kind, x: r1(x.pos.x), y: r1(x.pos.y), z: r1(x.pos.z), landed: x.landed };
		const a = { id: x.id, k: x.k };
		if (x.anchor) a.an = [r1(x.anchor.x), r1(x.anchor.y), r1(x.anchor.z)];
		if (x.parts) { a.mask = partMask(x); a.pods = x.podsLeft; }
		return a;
	}

	// Called once per game cycle after the simulation.
	flush() {
		this.cycle++;
		const W = this.W;
		const events = W.events;
		W.events = [];
		const feed = W.feed;
		W.feed = [];
		for (const line of feed) for (const s of this.sessions) if (s.player) this._send(s, { t: 'chat', ch: 'sys', text: line });
		const second = this.cycle % 20 === 0;
		const status = second ? this.events.status() : null;
		const roster = this.cycle % 40 === 0 ? { t: 'roster', p: [...W.players.values()].filter((P) => P.session).map((P) => [P.id, P.name, Math.round(P.pos.x), Math.round(P.pos.z), P.level, P.dead ? 1 : 0]) } : null;

		for (const s of this.sessions) {
			const P = s.player;
			if (!P) continue;
			if (s.ws.bufferedAmount > MAX_BUFFERED) continue;
			const known = s.known, seen = new Set(), add = [], pl = [], en = [];
			const px = P.pos.x, pz = P.pos.z, cyc = this.cycle;
			// candidates in view, nearest first
			const near = [];
			for (const Q of W.players.values()) {
				if (Q === P || !Q.session) continue;
				const d = Math.hypot(Q.pos.x - px, Q.pos.z - pz);
				if (d <= VIEW_P) near.push([d, Q]);
			}
			for (const e of W.enemies.values()) {
				const d = Math.hypot(e.pos.x - px, e.pos.z - pz);
				if (d <= (e.k === 'boss' ? VIEW_E * 1.5 : VIEW_E)) near.push([d, e]);
			}
			near.sort((x, y) => x[0] - y[0]);
			// distance prioritizer (Ryzom FES): the nearest few at 20 Hz, then 10, 5 and 4 Hz by
			// distance and by rank, so a crowd cannot flood one client
			const period = (d, rank) => Math.max(d < 300 ? 1 : d < 1000 ? 2 : d < 2500 ? 4 : 5, rank < 10 ? 1 : rank < 30 ? 2 : rank < 60 ? 4 : 5);
			near.forEach(([d, x], rank) => {
				seen.add(x.id);
				const isP = x.type === 'player';
				const sig = isP ? x.craft + x.level : 1;
				if (known.get(x.id) !== sig) { add.push(this._addInfo(x)); known.set(x.id, sig); }
				else if ((cyc + x.id) % period(d, rank) !== 0) return;
				if (isP) {
					const f = (x.dead ? 1 : 0) | (x.firing && W.now - x.lastFireAt < 300 ? 2 : 0) | (W.now < x.protectUntil ? 4 : 0) | (x.inPvp ? 8 : 0);
					pl.push([x.id, r1(x.pos.x), r1(x.pos.y), r1(x.pos.z), r2(x.psi), r2(x.gam), r2(x.phi), Math.ceil((100 * Math.max(0, x.hp)) / x.stats.hpMax), f]);
				} else {
					const row = [x.id, r1(x.pos.x), r1(x.pos.y), r1(x.pos.z), r2(x.psi), r2(x.gam), r2(x.phi), Math.ceil((100 * x.hp) / x.hpMax), x.st === 'drop' ? 1 : 0];
					if (x.parts) row.push(partMask(x));
					en.push(row);
				}
			});
			for (const c of W.crates.values()) {
				if (Math.hypot(c.pos.x - px, c.pos.z - pz) > VIEW_C) continue;
				seen.add(c.id);
				if (!known.has(c.id)) { add.push(this._addInfo(c)); known.set(c.id, 1); }
			}
			const del = [];
			for (const id of known.keys()) if (!seen.has(id)) { del.push(id); known.delete(id); }
			const ev = [];
			for (const { x, z, ev: e } of events) if (Math.abs(x - px) < VIEW_EV && Math.abs(z - pz) < VIEW_EV) ev.push(e);
			const msg = { t: 's', c: cyc };
			if (add.length) msg.add = add;
			if (pl.length) msg.p = pl;
			if (en.length) msg.e = en;
			if (del.length) msg.del = del;
			if (ev.length) msg.ev = ev;
			if (msg.add || msg.p || msg.e || msg.del || msg.ev) this._send(s, msg);
			if (P.dirty) { P.dirty = false; this._send(s, selfState(W, P)); }
			if (status) this._send(s, status);
			if (roster) this._send(s, roster);
		}
	}
}
