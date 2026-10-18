// Small vector helpers for the server (the client uses THREE.Vector3).

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; };
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const sub = (a, b, o = v3()) => ((o.x = a.x - b.x), (o.y = a.y - b.y), (o.z = a.z - b.z), o);
export const norm = (a) => { const l = len(a) || 1; a.x /= l; a.y /= l; a.z /= l; return a; };
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const addScaled = (a, b, s) => ((a.x += b.x * s), (a.y += b.y * s), (a.z += b.z * s), a);
export const copy = (a, b) => ((a.x = b.x), (a.y = b.y), (a.z = b.z), a);

// Heading/pitch conventions of the PaperWorld flight model.
export const psiTo = (dx, dz) => Math.atan2(-dx, -dz);
export const fwd = (psi, gam, o = v3()) => ((o.x = -Math.sin(psi) * Math.cos(gam)), (o.y = Math.sin(gam)), (o.z = -Math.cos(psi) * Math.cos(gam)), o);

// Squared distance from c to the segment a→b.
export function segD2(a, b, c) {
	const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, l2 = abx * abx + aby * aby + abz * abz;
	let t = l2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const dx = a.x + abx * t - c.x, dy = a.y + aby * t - c.y, dz = a.z + abz * t - c.z;
	return dx * dx + dy * dy + dz * dz;
}

// Where to aim so that a projectile of speed spd meets a target moving at tv.
export function leadPoint(src, tp, tv, spd, out = v3()) {
	let t = dist(src, tp) / spd;
	out.x = tp.x + tv.x * t; out.y = tp.y + tv.y * t; out.z = tp.z + tv.z * t;
	t = Math.min(dist(src, out) / spd, 3);
	out.x = tp.x + tv.x * t; out.y = tp.y + tv.y * t; out.z = tp.z + tv.z * t;
	return out;
}
