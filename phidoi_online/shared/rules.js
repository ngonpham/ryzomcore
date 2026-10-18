// Game rules shared by the server and the browser client: aircraft, enemies,
// progression, upgrades, zones and the landmarks that raids target.
// Numbers for aircraft and enemies come from PaperWorld phidoi/index.html (CRAFT, EK, DIFF "THƯỜNG").

import { coastX } from "./geo.js";

export const TICK_MS = 50; // 20 Hz game cycle
export const BSPD = 430; // player bullet speed (m/s)
export const EBSPD = 250; // enemy bullet speed (m/s)

export const CRAFT = {
  jet: { id: "jet", name: "Phản lực giấy", icon: "✈", hp: 100, rate: 14, dmg: 1, guns: 2, missiles: 6, flares: 8, vmax: 150, radius: 2.2, unlock: 1 },
  seaplane: { id: "seaplane", name: "Thủy phi cơ", icon: "🛩", hp: 160, rate: 16, dmg: 1.15, guns: 4, missiles: 10, flares: 6, vmax: 112, radius: 4, unlock: 4 },
  heli: { id: "heli", name: "Trực thăng Ahamove", icon: "🚁", hp: 140, rate: 11, dmg: 1, guns: 1, missiles: 8, flares: 10, vmax: 60, radius: 3.5, unlock: 7 },
};
export const CRAFT_IDS = Object.keys(CRAFT);

// hp, collision radius, cruise speed, turn rate — plus what a kill is worth.
export const ENEMY = {
  kite: { name: "Diều mực", hp: 5, r: 3.8, v: 14, turn: 1.2, xp: 25, xu: 8 },
  fighter: { name: "Phi cơ giấy than", hp: 11, r: 4.4, v: 50, turn: 1.1, xp: 60, xu: 20 },
  ace: { name: "Quạ Đen", hp: 55, r: 4.8, v: 56, turn: 1.4, xp: 400, xu: 150 },
  bomber: { name: "Oanh tạc cơ mực", hp: 50, r: 10, v: 32, turn: 0.42, xp: 150, xu: 45 },
  boss: { name: "Mực Khổng Lồ", hp: 1, r: 75, v: 11, turn: 0.35, xp: 4000, xu: 1500 },
};
export const ENEMY_IDS = Object.keys(ENEMY);
export const BOSS_POD_HP = 40, BOSS_CORE_HP = 160, BOSS_PODS = 6;

// Damage dealt by enemies to players (THƯỜNG difficulty in the original game).
export const EDMG = { fighter: 2.5, ace: 3.5, kite: 5, bomb: 7, flak: 7, missile: 32, tail: 2.5, ram: 25 };
export const MISSILE_DMG = 40, MISSILE_PART_DMG = 35;

export const MAX_LEVEL = 30;
export const xpFor = (level) => Math.round(150 * Math.pow(level, 1.5));
export const levelHpMul = (level) => 1 + 0.03 * (level - 1);
export const levelDmgMul = (level) => 1 + 0.02 * (level - 1);

// Hangar upgrades bought with Ahamove xu. Each tier costs UPGRADE_COST[tier].
export const UPGRADES = {
  gun: { name: "Súng", desc: "+12% sát thương đạn mỗi cấp", icon: "🔫" },
  armor: { name: "Giáp giấy", desc: "+12% độ bền mỗi cấp", icon: "🛡" },
  missile: { name: "Tên lửa", desc: "+1 tên lửa và +10% sát thương mỗi cấp", icon: "🚀" },
  flare: { name: "Pháo sáng", desc: "+2 pháo sáng mỗi cấp", icon: "✦" },
};
export const UPGRADE_COST = [150, 350, 700, 1300, 2200];
export const UPGRADE_MAX = UPGRADE_COST.length;

// Effective stats of a pilot in a given craft.
export function pilotStats(craftId, level, up) {
  const C = CRAFT[craftId] || CRAFT.jet;
  up = up || {};
  return {
    hpMax: Math.round(C.hp * levelHpMul(level) * (1 + 0.12 * (up.armor || 0))),
    gunDmg: C.dmg * levelDmgMul(level) * (1 + 0.12 * (up.gun || 0)),
    missileMul: levelDmgMul(level) * (1 + 0.1 * (up.missile || 0)),
    missiles: C.missiles + (up.missile || 0),
    flares: C.flares + 2 * (up.flare || 0),
    rate: C.rate,
    radius: C.radius,
    vmax: C.vmax,
  };
}

// Ahamove Sky Hub: spawn point, repair pad and a safe zone the ink gang does not enter.
export const HUB = { x: 235, y: 53.96, z: -1260, safeR: 380 };
export const SPAWN = { x: 330, y: 170, z: -1180, psi: Math.PI / 2 }; // heading west over the Hàn river
export const PADS = [
  { x: 235, y: 53.96, z: -1260, r: 8.5, hub: true },
  { x: coastX(-300) - 120, y: 2.7, z: -300, r: 9 },
  { x: 960, y: 2.4, z: 3330, r: 9 },
  { x: 205, y: 2.7, z: -2395, r: 6.5 },
];
// Free-for-all airspace around Cù Lao Chàm: pilots can shoot each other here.
export const PVP = { x: 3800, z: 2800, r: 1300, name: "Vùng trời tự do Cù Lao Chàm" };
export const inPvp = (x, z) => Math.hypot(x - PVP.x, z - PVP.z) < PVP.r;
export const inSafe = (x, z) => Math.hypot(x - HUB.x, z - HUB.z) < HUB.safeR;

// Landmarks the Black Ink Gang raids. Coordinates measured from the built PaperWorld map.
export const RAIDS = [
  { id: "mykhe", name: "Bãi biển Mỹ Khê", icon: "🏖", han: "美溪", x: coastX(-800) + 60, y: 4, z: -800, r: 160, radius: 1500 },
  { id: "dragon", name: "Cầu Rồng", icon: "🐉", han: "龍橋", x: -8.2, y: 14, z: -1019.8, r: 110, radius: 1700 },
  { id: "sontra", name: "Chùa Linh Ứng · Sơn Trà", icon: "⛰", han: "山茶", x: 1305, y: 84, z: -2318, r: 110, radius: 1500 },
  { id: "nonnuoc", name: "Làng đá Non Nước", icon: "🗻", han: "五行山", x: 690, y: 6, z: 1140, r: 120, radius: 1400 },
  { id: "hoian", name: "Phố cổ Hội An", icon: "🏮", han: "會安", x: 700, y: 8, z: 3460, r: 230, radius: 1600 },
];
export const BOSS_LAIR = { x: -250, z: -2250, name: "Vịnh Đà Nẵng" };

export const ZONE_NAMES = { pvp: PVP.name, safe: "Ahamove Sky Hub (an toàn)" };
