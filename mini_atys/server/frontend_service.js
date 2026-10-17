// Frontend Service: the only process clients talk to.
// Ryzom equivalent: ryzom/server/src/frontend_service. Responsibilities kept:
//  - login and client sessions (client_host.cpp)
//  - decoding client messages and forwarding them to gameplay (fe_receive_sub.cpp)
//  - per-client vision: which entities enter/leave/change, and sending
//    far entities less often (distance_prioritizer.cpp)

'use strict';

const Rules = require('../shared/rules');
const { ITEMS, GEAR, SHOP } = require('./sheets');

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;
const MAX_MSGS_PER_SEC = 60;
const MAX_BUFFERED = 1 << 20;
const HYSTERESIS = 3;
const NEAR = 12;

const GUIDE_LINES = [
	'Welcome to Atys, homin! Silan is a safe haven: no beast will follow you here.',
	'WASD or click to move. Click a creature to target it, then press 1 to attack.',
	'2 casts a Fire Bolt (Sap), 3 heals you or a targeted homin, 4 drinks a potion.',
	'Beasts grow stronger the farther you travel from Silan. Kitins roam the outer lands.',
	'Sell your loot to Merchant Lyna and buy better gear. Rumors speak of a Kirosta Matriarch deep in the Zorai jungle...',
];

class FrontendService {
	constructor(egs, persistence, opts = {}) {
		this.egs = egs;
		this.persistence = persistence;
		this.sessions = new Set();
		this.byPlayer = new Map();
		this.chat = null;
		this.cycle = 0;
		this.stats = { bytesOut: 0, msgsIn: 0 };
		this.motd = opts.motd || 'Welcome to Mini Atys, a tiny MMORPG inspired by Ryzom Core.';
		egs.notify = (p, msg) => {
			const s = this.byPlayer.get(p.id);
			if (s) this._send(s, msg);
		};
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

	broadcast(msg) {
		for (const s of this.sessions) if (s.player) this._send(s, msg);
	}

	_onMessage(s, raw) {
		const now = Date.now();
		if (now - s.msgWindow > 1000) { s.msgWindow = now; s.msgCount = 0; }
		if (++s.msgCount > MAX_MSGS_PER_SEC) return s.ws.close(1008, 'flood');
		this.stats.msgsIn++;
		let m;
		try { m = JSON.parse(raw); } catch (e) { return; }
		if (!m || typeof m !== 'object') return;
		if (m.t === 'ping') return this._send(s, { t: 'pong', ts: m.ts });
		if (!s.player) {
			if (m.t === 'login') this._login(s, m);
			return;
		}
		const p = s.player;
		const egs = this.egs;
		switch (m.t) {
		case 'pos':
			if (!egs.clientMove(p, +m.x, +m.y)) this._send(s, { t: 'correct', x: p.x, y: p.y });
			break;
		case 'act': egs.doAction(p, String(m.a), m.target | 0); break;
		case 'stop': egs.stopAttack(p); break;
		case 'chat': if (this.chat) this.chat.handle(p, m.text); break;
		case 'respawn': egs.respawn(p); break;
		case 'buy': egs.buy(p, String(m.item)); break;
		case 'sell': egs.sellAll(p); break;
		case 'talk': this._talk(s, m.id | 0); break;
		}
	}

	async _login(s, m) {
		if (s.loggingIn) return;
		const name = String(m.name || '').trim();
		const pass = String(m.pass || '');
		if (!NAME_RE.test(name)) return this._send(s, { t: 'loginFail', error: 'Name: 3-16 letters/digits/_ starting with a letter' });
		if (pass.length < 3 || pass.length > 64) return this._send(s, { t: 'loginFail', error: 'Password: 3-64 characters' });
		s.loggingIn = true;
		const res = await this.persistence.login(name, pass);
		s.loggingIn = false;
		if (!s.ws.open) return;
		if (!res.ok) return this._send(s, { t: 'loginFail', error: res.error });

		// Only one session per character: the newest one wins.
		for (const other of this.sessions) {
			if (other.player && other.player.name.toLowerCase() === name.toLowerCase()) {
				this._send(other, { t: 'kicked', reason: 'Logged in from another place' });
				this._logout(other);
				other.ws.close(1000, 'replaced');
			}
		}

		// Read the save after kicking: the old session has just stored it.
		const p = this.egs.createPlayer(Object.assign({}, this.persistence.getSave(res.name), { name: res.name }));
		p.region = this.egs.world.regionAt(p.x, p.y);
		s.player = p;
		this.byPlayer.set(p.id, s);
		this._send(s, {
			t: 'welcome', id: p.id, name: p.name, created: res.created, x: p.x, y: p.y,
			map: this.egs.world.serialize(), tick: Rules.TICK_MS, motd: this.motd,
			items: Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, { name: v.name, sell: v.sell || 0, price: v.price || 0 }])),
			gear: GEAR, shop: SHOP, online: this.byPlayer.size,
		});
		this._send(s, this.egs.selfState(p));
		if (this.chat) this.chat.system(p.name + (res.created ? ' has arrived on Atys for the first time!' : ' has entered Atys.'));
		console.log('[FES] login ' + p.name + ' (#' + p.id + ') online=' + this.byPlayer.size);
	}

	_talk(s, id) {
		const p = s.player;
		const npc = this.egs.entities.get(id);
		if (!npc || npc.kind !== 'npc' || Math.hypot(npc.x - p.x, npc.y - p.y) > 4) {
			return this._send(s, { t: 'err', text: 'Get closer to talk' });
		}
		if (npc.role === 'merchant') this._send(s, { t: 'shop', npc: npc.name });
		else this._send(s, { t: 'dialog', npc: npc.name, lines: GUIDE_LINES });
	}

	_logout(s) {
		const p = s.player;
		if (!p) return;
		this.persistence.store(p.name, this.egs.saveData(p));
		this.egs.removeEntity(p);
		this.byPlayer.delete(p.id);
		s.player = null;
		if (this.chat) this.chat.system(p.name + ' has left Atys.');
		console.log('[FES] logout ' + p.name + ' online=' + this.byPlayer.size);
	}

	_onClose(s) {
		this._logout(s);
		this.sessions.delete(s);
	}

	saveAll() {
		for (const s of this.sessions) if (s.player) this.persistence.store(s.player.name, this.egs.saveData(s.player));
	}

	// Called once per game cycle after gameplay has run.
	flush() {
		this.cycle++;
		const events = this.egs.events;
		this.egs.events = [];
		const R = Rules.VIEW_RADIUS;
		for (const s of this.sessions) {
			const p = s.player;
			if (!p) continue;
			if (s.ws.bufferedAmount > MAX_BUFFERED) continue; // slow client: retry next cycle
			const known = s.known;
			const add = [], upd = [], seen = new Set();
			this.egs.matrix.forEachInRadius(p.x, p.y, R + HYSTERESIS, (e, d) => {
				const was = known.get(e.id);
				if (was === undefined && d > R) return;
				seen.add(e.id);
				const hp = this.egs.hpPct(e), f = this.egs.flags(e);
				const x = Math.round(e.x * 100) / 100, y = Math.round(e.y * 100) / 100;
				const sig = x + ',' + y + ',' + hp + ',' + f;
				if (was === undefined) {
					add.push(this.egs.enterInfo(e));
					known.set(e.id, sig);
				} else if (was !== sig) {
					// Distance prioritizer: far entities are refreshed every other cycle.
					if (d > NEAR && (this.cycle + e.id) % 2) return;
					upd.push([e.id, x, y, hp, f]);
					known.set(e.id, sig);
				}
			});
			const del = [];
			for (const id of known.keys()) if (!seen.has(id)) { del.push(id); known.delete(id); }
			const ev = [];
			for (const { x, y, ev: e } of events) {
				if (Math.abs(x - p.x) <= R + HYSTERESIS && Math.abs(y - p.y) <= R + HYSTERESIS) ev.push(e);
			}
			if (add.length || upd.length || del.length || ev.length) {
				const msg = { t: 'tick', c: this.cycle };
				if (add.length) msg.add = add;
				if (upd.length) msg.upd = upd;
				if (del.length) msg.del = del;
				if (ev.length) msg.ev = ev;
				this._send(s, msg);
			}
			if (p.dirty) {
				p.dirty = false;
				this._send(s, this.egs.selfState(p));
			}
		}
	}
}

module.exports = { FrontendService };
