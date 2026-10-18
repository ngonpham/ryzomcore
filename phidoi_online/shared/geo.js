// Đà Nẵng → Hội An geography, shared by the server and the browser client.
// Extracted verbatim from PaperWorld phidoi/index.html (branch claude/zen-gauss-3pxtg6)
// so that server-side AI, bullets and crash checks see exactly the terrain the
// players fly over. Do not edit the copied functions without keeping both in sync.

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const angDiff = (a, b) => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
export const hash2 = (a, b) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/* 2D simplex noise */
export const PERM = new Uint8Array(512);
{
  const r = mulberry32(1337), p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
export const GRX = [1, -1, 1, -1, 1, -1, 0, 0], GRY = [1, 1, -1, -1, 0, 0, 1, -1];
export const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
export function sn(x, y) {
  const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2;
  const x0 = x - i + t, y0 = y - j + t, i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0, q, g;
  q = 0.5 - x0 * x0 - y0 * y0;
  if (q > 0) { g = PERM[ii + PERM[jj]] & 7; q *= q; n += q * q * (GRX[g] * x0 + GRY[g] * y0); }
  q = 0.5 - x1 * x1 - y1 * y1;
  if (q > 0) { g = PERM[ii + i1 + PERM[jj + j1]] & 7; q *= q; n += q * q * (GRX[g] * x1 + GRY[g] * y1); }
  q = 0.5 - x2 * x2 - y2 * y2;
  if (q > 0) { g = PERM[ii + 1 + PERM[jj + 1]] & 7; q *= q; n += q * q * (GRX[g] * x2 + GRY[g] * y2); }
  return 70 * n;
}
export function fbm(x, y, o) {
  let v = 0, a = 0.5, f = 1, s = 0;
  for (let i = 0; i < o; i++) { v += a * sn(x * f, y * f); s += a; f *= 2.03; a *= 0.5; }
  return v / s;
}
export function ridged(x, y, o) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < o; i++) { const n = 1 - Math.abs(sn(x * f, y * f)); v += a * n * n; f *= 2.1; a *= 0.5; }
  return v;
}

export const WX0 = -4800, WZ0 = -4400, WSIZE = 9600, GS = 20, GN = WSIZE / GS + 1; // 481×481 world grid
export const SEA_Y = 0;
export const TILE = 400, TN = WSIZE / TILE; // 24×24 terrain tiles

export function mkLine(name, w, pts) {
  const segs = [];
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    segs.push({ ax, az, dx, dz, l2, l: Math.sqrt(l2), s: len });
    len += Math.sqrt(l2);
    x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); z0 = Math.min(z0, az, bz); z1 = Math.max(z1, az, bz);
  }
  const m = w / 2 + 80;
  return { name, w, pts, segs, len, x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m };
}
export const LQ = { d: 0, s: 0, tx: 0, tz: 0 };
export function lineDist(L, x, z) {
  if (x < L.x0 || x > L.x1 || z < L.z0 || z > L.z1) return 1e9;
  let best = 1e18;
  for (const g of L.segs) {
    let t = ((x - g.ax) * g.dx + (z - g.az) * g.dz) / g.l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = g.ax + g.dx * t - x, ez = g.az + g.dz * t - z, d = ex * ex + ez * ez;
    if (d < best) { best = d; LQ.s = g.s + g.l * t; LQ.tx = g.dx / g.l; LQ.tz = g.dz / g.l; }
  }
  return (LQ.d = Math.sqrt(best));
}
export function linePoint(L, s, out = {}) {
  s = clamp(s, 0, L.len - 0.01);
  for (const g of L.segs)
    if (s <= g.s + g.l) {
      const t = (s - g.s) / g.l;
      out.x = g.ax + g.dx * t; out.z = g.az + g.dz * t; out.tx = g.dx / g.l; out.tz = g.dz / g.l;
      return out;
    }
  return out;
}
/* centre-line x of a mostly north–south river at a given z */
export function lineXatZ(L, z) {
  for (const g of L.segs) {
    const za = g.az, zb = g.az + g.dz;
    if ((z - za) * (z - zb) <= 0 && g.dz !== 0) return g.ax + g.dx * ((z - za) / g.dz);
  }
  return null;
}
export const RIVERS = [
  mkLine("han", 96, [[-30, -2250], [-40, -1980], [-55, -1700], [-35, -1400], [-10, -1100], [-5, -880], [-30, -640], [-90, -350], [-190, -60], [-290, 250], [-410, 560], [-600, 860], [-880, 1080], [-1250, 1200], [-1700, 1260], [-2300, 1350], [-2900, 1500], [-3600, 1650]]),
  mkLine("coco", 30, [[-260, 190], [0, 380], [250, 560], [400, 780], [430, 1100], [470, 1500], [520, 2000], [600, 2500], [680, 2950], [760, 3300], [830, 3560]]),
  mkLine("thubon", 112, [[-3600, 4100], [-2400, 3880], [-1700, 3800], [-1000, 3740], [-400, 3660], [150, 3600], [600, 3578], [1000, 3592], [1300, 3640], [1550, 3700], [1750, 3742], [2050, 3790]]),
  mkLine("hoai", 16, [[468, 3300], [478, 3420], [470, 3560]]),
  mkLine("baymau", 14, [[1190, 3700], [1290, 3765], [1410, 3745], [1480, 3815], [1560, 3800]]),
  mkLine("cuda", 34, [[-2500, -1600], [-2300, -1750], [-2100, -1880], [-1950, -2050]]),
];
export const R_HAN = RIVERS[0], R_COCO = RIVERS[1], R_THUBON = RIVERS[2];

/* east coast: Mỹ Khê → Non Nước → An Bàng → Cửa Đại */
export const coastX = (z) => (z < -2250 ? 520 + (z + 2250) * 1.2 : 520 + 0.17 * (z + 2250) + 22 * Math.sin(z * 0.0021) + 10 * Math.sin(z * 0.0063 + 1));
export function sdMain(x, z) {
  const sE = coastX(z) - x;
  const ex = (x + 1000) / 1350, ez = (z + 2900) / 1000, sB = (Math.sqrt(ex * ex + ez * ez) - 1) * 1050; // Đà Nẵng bay
  const sN = (z - Math.min(-3800 + Math.max(0, x + 1300) * 3, -2300)) / 3.16; // Hải Vân cape
  return Math.min(sE, sB, sN);
}
export function sdEll(x, z, cx, cz, rx, rz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot), dx = x - cx, dz = z - cz;
  const u = (dx * c - dz * s) / rx, v = (dx * s + dz * c) / rz;
  return (1 - Math.sqrt(u * u + v * v)) * Math.min(rx, rz);
}
export const SONTRA = [
  [1150, -2650, 920, 430, -0.05],
  [2020, -2720, 360, 250, 0.2],
  [620, -2330, 300, 230, 0],
];
export const ST_PEAKS = [
  [1000, -2740, 380, 188], // Ốc Sơn (~690 m)
  [600, -2560, 220, 118], // Bàn Cờ
  [1520, -2700, 320, 138],
  [2050, -2730, 230, 92],
  [1250, -2440, 200, 52],
];
export const ISLANDS = [
  // Cù Lao Chàm archipelago: x, z, rx, rz, height, rot
  [3800, 2650, 520, 230, 165, -0.25], // Hòn Lao
  [3150, 2900, 140, 60, 45, 0.3], // Hòn Dài
  [3300, 2480, 70, 55, 35, 0], // Hòn Mồ
  [4300, 3050, 120, 80, 55, 0.5], // Hòn Khô
  [4050, 3260, 90, 65, 45, 0], // Hòn Tai
  [3550, 3160, 160, 90, 70, -0.4], // Hòn Lá
];
export const KARST = [
  // Ngũ Hành Sơn: x, z, r, height, name
  [760, 760, 105, 92, "Thủy Sơn"],
  [905, 700, 40, 40, "Mộc Sơn"],
  [585, 905, 48, 60, "Hỏa Sơn"],
  [640, 975, 38, 44, "Âm Hỏa Sơn"],
  [530, 1080, 44, 48, "Kim Sơn"],
  [840, 1010, 55, 38, "Thổ Sơn"],
];
export function sdSonTra(x, z) {
  if (x < -400 || x > 2600 || z < -3300 || z > -1900) return -500;
  let s = -1e9;
  for (const e of SONTRA) s = Math.max(s, sdEll(x, z, e[0], e[1], e[2], e[3], e[4]));
  return s;
}
export function sdIslands(x, z) {
  if (x < 2700 || z < 2100 || z > 3600) return -500;
  let s = -1e9;
  for (const e of ISLANDS) s = Math.max(s, sdEll(x, z, e[0], e[1], e[2], e[3], e[5]));
  return s;
}
export const gauss = (x, z, cx, cz, r) => { const dx = (x - cx) / r, dz = (z - cz) / r; return Math.exp(-(dx * dx + dz * dz)); };
/* west mountains: Hải Vân pass to the north-west, Bà Nà hills to the west */
export const mtnEdge = (z) => -2050 - 0.12 * (z + 2000);
export const mtnMask = (x, z) => Math.max(smooth(mtnEdge(z), mtnEdge(z) - 1000, x), smooth(-3250, -3650, z) * smooth(-900, -1400, x));
export const cityMask = (x, z) =>
  smooth(-1850, -1650, x + 90 * sn(z * 0.003, 4.1)) * smooth(760, 560, z + 110 * sn(x * 0.0025, 1.3)) * smooth(-2300, -2150, z) * (1 - smooth(-250, 120, sdSonTra(x, z)));
export const hoianMask = (x, z) => smooth(400, 450, x) * smooth(960, 910, x) * smooth(3350, 3390, z) * smooth(3545, 3515, z);
export const riceMask = (x, z) => smooth(780, 1050, z) * (1 - smooth(4900, 5100, z));

export const S = { h: 0, sd: 0, riv: 0, city: 0, hoian: 0, rice: 0, M: 0, rock: 0, karst: 0, st: 0, isl: 0 };
export function sample(x, z) {
  const sm = sdMain(x, z), ss = sdSonTra(x, z), si = sdIslands(x, z);
  const hvR = smooth(-1500, -2300, x) * smooth(-2300, -3100, z);
  const rock = Math.max(smooth(-220, 80, ss), smooth(-220, 80, si), hvR);
  let sd = Math.max(sm, ss, si);
  sd += (3 + 30 * rock) * fbm(x * 0.0042 + 3.3, z * 0.0042 - 1.7, 3) + 4 * rock * sn(x * 0.02, z * 0.02);
  const M = mtnMask(x, z);
  S.sd = sd; S.rock = rock; S.M = M; S.st = ss; S.isl = si; S.karst = 0; S.riv = 0;
  S.city = S.hoian = S.rice = 0;
  let h;
  if (sd < 0) {
    h = Math.max(-36, -0.9 + sd * (0.032 + 0.05 * rock) + 1.2 * sn(x * 0.006, z * 0.006));
  } else {
    h = 0.15 + 2.4 * smooth(0, 70, sd) + (0.8 * sn(x * 0.008, z * 0.008) + 0.4 * sn(x * 0.03, z * 0.03)) * smooth(60, 260, sd);
    const cf = smooth(-10, 70 + 110 * (1 - rock), sd);
    if (M > 0.001) {
      const hm = M * (60 + 360 * ridged(x * 0.00072 + 5.1, z * 0.00072 - 2.3, 4)) + 270 * gauss(x, z, -3450, -250, 560) + 190 * gauss(x, z, -2500, -3420, 520) + 120 * gauss(x, z, -3000, 1800, 700);
      h = Math.max(h, h + hm * M * cf);
    }
    if (ss > -60) {
      let hs = 0;
      for (const p of ST_PEAKS) hs += p[3] * gauss(x, z, p[0], p[1], p[2]);
      hs = hs * smooth(-20, 170, ss) + 34 * ridged(x * 0.003 + 1.7, z * 0.003, 3) * smooth(0, 220, ss);
      h = Math.max(h, hs * cf + 1);
    }
    if (si > -60) {
      let hi = 0;
      for (const e of ISLANDS) hi = Math.max(hi, e[4] * smooth(-10, Math.min(e[2], e[3]) * 0.9, sdEll(x, z, e[0], e[1], e[2], e[3], e[5])));
      hi += 14 * ridged(x * 0.006, z * 0.006, 2) * smooth(0, 60, si);
      h = Math.max(h, hi * cf + 1);
    }
    // flatten the towns and the paddies
    const ci = cityMask(x, z) * smooth(25, 90, sd);
    if (ci > 0) { h = lerp(h, 2.6 + 0.25 * sn(x * 0.01, z * 0.01), ci); S.city = ci; }
    const ho = hoianMask(x, z);
    if (ho > 0) { h = lerp(h, 2.3, ho); S.hoian = ho; }
    const ri = riceMask(x, z) * (1 - M) * smooth(130, 260, sd) * (1 - ho);
    if (ri > 0) { h = lerp(h, 1.6 + 0.3 * sn(x * 0.004, z * 0.004), ri * 0.85); S.rice = ri; }
    // Ngũ Hành Sơn karsts
    if (x > 420 && x < 1000 && z > 600 && z < 1120) {
      for (let i = 0; i < KARST.length; i++) {
        const k = KARST[i], d = Math.hypot(x - k[0], z - k[1]);
        if (d > k[2] * 1.3) continue;
        const n = fbm(x * 0.03 + i * 7, z * 0.03, 2) * 14;
        const pr = smooth(k[2] * 1.02, k[2] * 0.62, d + n);
        if (pr <= 0) continue;
        const hk = 2.5 + k[3] * Math.pow(pr, 0.38) * (0.78 + 0.34 * ridged(x * 0.03 + i, z * 0.03, 2)) + 6 * pr * sn(x * 0.08, z * 0.08);
        if (hk > h) { h = hk; S.karst = Math.max(S.karst, pr); }
      }
    }
  }
  // rivers
  for (const L of RIVERS) {
    const d = lineDist(L, x, z);
    if (d > L.w / 2 + 60) continue;
    const half = L.w / 2, bed = -3.4 - Math.min(2, L.w * 0.02);
    const t = smooth(half - 5, half + 30, d);
    if (h > bed) h = bed + (h - bed) * t;
    S.riv = Math.max(S.riv, 1 - smooth(half - 3, half + 5, d));
  }
  S.h = h;
  return h;
}
export const heightFn = (x, z) => sample(x, z);

/* world grid (20 m), heights only — the client also builds colours from it */
export const GH = new Float32Array(GN * GN);
export function buildHeights(onRow) {
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) GH[j * GN + i] = sample(WX0 + i * GS, WZ0 + j * GS);
    if (onRow) onRow(j);
  }
}
export function gridH(x, z) {
  const fx = clamp((x - WX0) / GS, 0, GN - 1.001), fz = clamp((z - WZ0) / GS, 0, GN - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * GN + i;
  const h00 = GH[k], h10 = GH[k + 1], h01 = GH[k + GN], h11 = GH[k + GN + 1];
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}
