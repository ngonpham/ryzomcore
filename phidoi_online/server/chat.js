// Chat channel and slash commands (Ryzom input_output_service, reduced).

import { refreshStats, teleport } from './players.js';

export const NAME_RE = /^\p{L}[\p{L}\p{N}_]{2,15}$/u;
export const sanitize = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();

const HELP = [
	'Lệnh: /who phi công đang bay · /top bảng xếp hạng · /pvp bảng hạ phi công · /home về Sky Hub · /help',
	'Mặc định tin nhắn gửi cho mọi phi công trên bầu trời Đà Nẵng.',
];

export class Chat {
	constructor(W, persistence, opts = {}) {
		this.W = W;
		this.persistence = persistence;
		this.dev = !!opts.dev;
		this.events = null;
	}

	handle(P, raw) {
		const text = sanitize(raw).slice(0, 200);
		if (!text) return;
		const W = this.W, now = W.now;
		P.chatTimes = (P.chatTimes || []).filter((t) => now - t < 6000);
		if (P.chatTimes.length >= 6) return this._sys(P, 'Bạn nói nhanh quá, chậm lại chút.');
		P.chatTimes.push(now);
		if (text[0] !== '/') return W.broadcast({ t: 'chat', ch: 'all', from: P.name, lv: P.level, text });
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(' ');
		switch (cmd.toLowerCase()) {
		case '/who': {
			const list = [...W.players.values()].filter((Q) => Q.session).map((Q) => Q.name + ' (' + Q.level + ')');
			return this._sys(P, list.length + ' phi công: ' + list.join(', '));
		}
		case '/top':
			return this._sys(P, 'Kinh nghiệm: ' + this.persistence.top(5, 'xp').map((a, i) => i + 1 + '. ' + a.name + ' cấp ' + a.level).join(' · '));
		case '/pvp':
			return this._sys(P, 'Hạ phi công: ' + this.persistence.top(5, 'pvp').map((a, i) => i + 1 + '. ' + a.name + ' ' + a.pvp).join(' · '));
		case '/home': return this.W.notify(P, { t: 'cmd', cmd: 'home' });
		case '/help': return HELP.forEach((l) => this._sys(P, l));
		}
		if (this.dev && this.events) {
			// test commands, only with --dev
			if (cmd === '/raid') { this.events.nextRaidAt = W.t; this.events.o.raidWarn = +arg || 3; return; }
			if (cmd === '/boss') { this.events.nextBossAt = W.t; return; }
			if (cmd === '/xu') { P.xu += +arg || 1000; P.dirty = true; return; }
			if (cmd === '/lvl') { P.level = Math.max(1, Math.min(30, +arg || 10)); refreshStats(P, true); return; }
			if (cmd === '/tp') {
				const [x, y, z] = rest.map(Number);
				if (![x, y, z].every(Number.isFinite)) return this._sys(P, '/tp x y z');
				return teleport(W, P, x, y, z, P.psi);
			}
		}
		this._sys(P, 'Lệnh không rõ. Gõ /help');
	}

	_sys(P, text) {
		this.W.notify(P, { t: 'chat', ch: 'sys', text });
	}
}
