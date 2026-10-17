// Chat and slash commands. Ryzom routes chat through the Input Output
// Service (ryzom/server/src/input_output_service, chat_manager.cpp) with
// "say" (local), "region" and "universe" channels; we keep say + universe.

'use strict';

const { CREATURES } = require('./sheets');

const SAY_RADIUS = 20;
const HELP = [
	'Commands: /w <text> universe chat, /s <text> local chat, /me <action>,',
	'/who online players, /top leaderboard, /stuck return to Silan, /help',
];

class ChatService {
	constructor(egs, frontend, persistence, opts = {}) {
		this.egs = egs;
		this.frontend = frontend;
		this.persistence = persistence;
		this.dev = !!opts.dev;
	}

	handle(p, raw) {
		let text = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
		if (!text) return;
		const now = this.egs.now;
		p.chatTimes = (p.chatTimes || []).filter((t) => now - t < 6000);
		if (p.chatTimes.length >= 6) return this._sys(p, 'You are talking too fast.');
		p.chatTimes.push(now);

		if (text[0] !== '/') return this.say(p, text);
		const sp = text.indexOf(' ');
		const cmd = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
		const arg = sp < 0 ? '' : text.slice(sp + 1).trim();
		switch (cmd) {
		case '/s': case '/say': return arg && this.say(p, arg);
		case '/w': case '/world': case '/u': return arg && this.universe(p, arg);
		case '/me': return arg && this._local(p, { t: 'chat', ch: 'emote', from: p.name, text: arg });
		case '/who': {
			const names = [...this.egs.players.values()].map((q) => q.name + ' (' + q.level + ')');
			return this._sys(p, names.length + ' online: ' + names.join(', '));
		}
		case '/top': {
			const top = this.persistence.topPlayers(5).map((a, i) => (i + 1) + '. ' + a.name + ' lvl ' + a.level);
			return this._sys(p, 'Leaderboard: ' + top.join('  '));
		}
		case '/stuck': {
			if (!p.alive) return this._sys(p, 'You are dead. Use the respawn button.');
			if (now - p.lastCombat < 6000) return this._sys(p, 'You cannot do that while in combat.');
			const [x, y] = this.egs.world.spawnPoint();
			return this.egs.teleport(p, x, y);
		}
		case '/help': return HELP.forEach((l) => this._sys(p, l));
		case '/spawn':
			if (this.dev) {
				const [sheet, lvl] = arg.split(/\s+/);
				if (!Object.hasOwn(CREATURES, sheet)) return this._sys(p, 'Unknown creature: ' + sheet);
				const c = this.egs.ai.spawnCreature(sheet, Math.max(1, Math.min(30, parseInt(lvl, 10) || 1)), p.x + 1.2, p.y);
				return this._sys(p, 'Spawned ' + c.name + ' #' + c.id);
			}
			// falls through
		default:
			return this._sys(p, 'Unknown command. Type /help');
		}
	}

	say(p, text) {
		this._local(p, { t: 'chat', ch: 'say', from: p.name, text });
	}

	universe(p, text) {
		this.frontend.broadcast({ t: 'chat', ch: 'world', from: p.name, text });
	}

	system(text) {
		this.frontend.broadcast({ t: 'chat', ch: 'sys', text });
	}

	_local(p, msg) {
		this.egs.matrix.forEachInRadius(p.x, p.y, SAY_RADIUS, (e) => {
			if (e.kind === 'player') this.egs.notify(e, msg);
		});
	}

	_sys(p, text) {
		this.egs.notify(p, { t: 'chat', ch: 'sys', text });
	}
}

module.exports = { ChatService };
