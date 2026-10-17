// Character persistence. Ryzom saves characters through the Backup Service
// (ryzom/server/src/backup_service) as PDR files; here a single JSON file
// written atomically (write to temp, then rename) is enough.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Persistence {
	constructor(dir) {
		this.dir = dir;
		this.file = path.join(dir, 'characters.json');
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

	// Returns { ok, created, name, save } or { ok:false, error }.
	// The first login with an unknown name creates the character.
	async login(name, password) {
		const key = name.toLowerCase();
		if (!this.accounts[key]) {
			const salt = crypto.randomBytes(16).toString('hex');
			const hash = await Persistence.hash(password, salt);
			if (!this.accounts[key]) { // still free after the async hash
				this.accounts[key] = { name, salt, hash, created: Date.now(), save: {} };
				this._dirty = true;
				return { ok: true, created: true, name, save: {} };
			}
		}
		const acc = this.accounts[key];
		const h = await Persistence.hash(password, acc.salt);
		if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(acc.hash, 'hex'))) {
			return { ok: false, error: 'Wrong password for this character' };
		}
		return { ok: true, created: false, name: acc.name, save: acc.save || {} };
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

	topPlayers(n) {
		return Object.values(this.accounts)
			.map((a) => ({ name: a.name, level: (a.save && a.save.level) || 1, kills: (a.save && a.save.kills) || 0 }))
			.sort((a, b) => b.level - a.level || b.kills - a.kills)
			.slice(0, n);
	}
}

module.exports = { Persistence };
