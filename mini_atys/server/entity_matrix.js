// Spatial hash used for vision and area queries, the same idea as
// ryzom/server/src/entities_game_service/entity_matrix.h (16 m cells there,
// CELL tiles here).

'use strict';

const CELL = 8;

class EntityMatrix {
	constructor(w, h) {
		this.cols = Math.ceil(w / CELL);
		this.rows = Math.ceil(h / CELL);
		this.cells = Array.from({ length: this.cols * this.rows }, () => new Set());
	}

	_cellIndex(x, y) {
		const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
		const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
		return cy * this.cols + cx;
	}

	insert(e) {
		e._cell = this._cellIndex(e.x, e.y);
		this.cells[e._cell].add(e);
	}

	remove(e) {
		if (e._cell !== undefined) this.cells[e._cell].delete(e);
		e._cell = undefined;
	}

	update(e) {
		const c = this._cellIndex(e.x, e.y);
		if (c !== e._cell) {
			if (e._cell !== undefined) this.cells[e._cell].delete(e);
			e._cell = c;
			this.cells[c].add(e);
		}
	}

	// Calls fn(entity, dist) for every entity within radius of (x,y).
	forEachInRadius(x, y, radius, fn) {
		const r2 = radius * radius;
		const x0 = Math.max(0, Math.floor((x - radius) / CELL)), x1 = Math.min(this.cols - 1, Math.floor((x + radius) / CELL));
		const y0 = Math.max(0, Math.floor((y - radius) / CELL)), y1 = Math.min(this.rows - 1, Math.floor((y + radius) / CELL));
		for (let cy = y0; cy <= y1; cy++) {
			for (let cx = x0; cx <= x1; cx++) {
				for (const e of this.cells[cy * this.cols + cx]) {
					const dx = e.x - x, dy = e.y - y, d2 = dx * dx + dy * dy;
					if (d2 <= r2) fn(e, Math.sqrt(d2));
				}
			}
		}
	}
}

module.exports = { EntityMatrix };
