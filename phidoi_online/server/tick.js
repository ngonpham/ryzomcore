// Fixed-rate game cycle (Ryzom tick_service, reduced to one process).

export class TickService {
	constructor(stepMs, steps) {
		this.stepMs = stepMs;
		this.steps = steps; // (dtSeconds) => void
		this.cycle = 0;
		this.timer = null;
		this.stats = { avgMs: 0, maxMs: 0 };
	}

	start() {
		let next = Date.now();
		let last = next;
		const loop = () => {
			const t0 = Date.now();
			const dt = Math.min(0.15, (t0 - last) / 1000);
			last = t0;
			this.cycle++;
			for (const step of this.steps) {
				try {
					step(dt);
				} catch (e) {
					console.error('[TS] cycle ' + this.cycle + ': ' + (e.stack || e));
				}
			}
			const spent = Date.now() - t0;
			this.stats.avgMs = this.stats.avgMs * 0.95 + spent * 0.05;
			this.stats.maxMs = Math.max(this.stats.maxMs * 0.999, spent);
			next += this.stepMs;
			if (Date.now() - next > this.stepMs * 5) next = Date.now();
			this.timer = setTimeout(loop, Math.max(0, next - Date.now()));
		};
		this.timer = setTimeout(loop, this.stepMs);
	}

	stop() {
		clearTimeout(this.timer);
		this.timer = null;
	}
}
