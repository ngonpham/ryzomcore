// Pilot accounts and saves: one JSON file written atomically (temp file + rename).
// Same scheme as mini_atys/server/persistence.js (Ryzom's backup service, reduced).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class Persistence {
	constructor(dir) {
		this.dir = dir;
		this.file = path.join(dir, 'pilots.json');
		this.accounts = {};
		fs.mkdirSync(dir, { recursive: true });
		if (fs.existsSync(this.file)) {
			try {
				this.accounts = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			} catch (e) {
				console.error('[PDS] cannot read ' + this.file + ': ' + e.message);
			}
		}
		this._dirty = false;
	}

	static hash(password, salt) {
		return new Promise((resolve, reject) => {
			crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
		});
	}

	// The first login with an unknown name creates the pilot.
	async login(name, password) {
		const key = name.toLowerCase();
		if (!this.accounts[key]) {
			const salt = crypto.randomBytes(16).toString('hex');
			const hash = await Persistence.hash(password, salt);
			if (!this.accounts[key]) {
				this.accounts[key] = { name, salt, hash, created: Date.now(), save: {} };
				this._dirty = true;
				return { ok: true, created: true, name };
			}
		}
		const acc = this.accounts[key];
		const h = await Persistence.hash(password, acc.salt);
		if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(acc.hash, 'hex'))) {
			return { ok: false, error: 'Sai mật khẩu cho phi công này' };
		}
		return { ok: true, created: false, name: acc.name };
	}

	getSave(name) {
		const acc = this.accounts[name.toLowerCase()];
		return acc ? acc.save || {} : {};
	}

	store(name, save) {
		const acc = this.accounts[name.toLowerCase()];
		if (!acc) return;
		acc.save = save;
		acc.lastSeen = Date.now();
		this._dirty = true;
	}

	flush() {
		if (!this._dirty) return;
		const tmp = this.file + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(this.accounts));
		fs.renameSync(tmp, this.file);
		this._dirty = false;
	}

	top(n, by = 'xp') {
		return Object.values(this.accounts)
			.map((a) => {
				const s = a.save || {};
				return { name: a.name, level: s.level || 1, xp: s.totalXp || 0, kills: s.kills || 0, pvp: s.pvp || 0 };
			})
			.sort((a, b) => b[by] - a[by] || b.level - a.level)
			.slice(0, n);
	}
}
