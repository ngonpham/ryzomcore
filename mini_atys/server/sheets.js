// Static game data. Ryzom keeps this in georges "sheets" (*.creature,
// *.sitem, *.sphrase) loaded by ryzom/server/src/entities_game_service/egs_sheets.
// We keep the same idea: plain data tables, no logic.

'use strict';

// Creatures of Atys. `regions` biases where a creature appears.
const CREATURES = {
	yubo: {
		name: 'Yubo', minLevel: 1, maxLevel: 4, aggressive: false,
		hp: [30, 12], dmg: [3, 1.5], attackSpeed: 1.8, range: 1.4, speed: 2.6, aggroRadius: 0,
		color: '#f2c37a', size: 0.35, loot: 'yubo_skin', regions: ['matis', 'fyros', 'tryker', 'zorai'],
	},
	mektoub: {
		name: 'Mektoub', minLevel: 3, maxLevel: 8, aggressive: false,
		hp: [60, 18], dmg: [4, 2], attackSpeed: 2.2, range: 1.6, speed: 2.4, aggroRadius: 0,
		color: '#b98e5a', size: 0.48, loot: 'mektoub_hide', regions: ['fyros', 'tryker'],
	},
	gingo: {
		name: 'Gingo', minLevel: 4, maxLevel: 11, aggressive: true,
		hp: [40, 15], dmg: [5, 2.5], attackSpeed: 1.6, range: 1.4, speed: 3.6, aggroRadius: 6,
		color: '#9aa6b2', size: 0.4, loot: 'gingo_fang', regions: ['matis', 'tryker', 'zorai'],
	},
	torbak: {
		name: 'Torbak', minLevel: 8, maxLevel: 16, aggressive: true,
		hp: [70, 20], dmg: [6, 3], attackSpeed: 2.0, range: 1.6, speed: 3.2, aggroRadius: 6,
		color: '#c86b3c', size: 0.5, loot: 'torbak_horn', regions: ['fyros'],
	},
	ragus: {
		name: 'Ragus', minLevel: 9, maxLevel: 17, aggressive: true,
		hp: [55, 17], dmg: [7, 3.2], attackSpeed: 1.5, range: 1.4, speed: 3.8, aggroRadius: 7,
		color: '#6f5b8f', size: 0.45, loot: 'ragus_claw', regions: ['matis', 'zorai', 'tryker'],
	},
	kipee: {
		name: 'Kipee', minLevel: 14, maxLevel: 22, aggressive: true,
		hp: [70, 20], dmg: [8, 3.5], attackSpeed: 1.6, range: 1.5, speed: 3.6, aggroRadius: 7,
		color: '#d8d04a', size: 0.42, loot: 'kitin_shell', regions: ['fyros', 'zorai', 'matis', 'tryker'],
	},
	kincher: {
		name: 'Kincher', minLevel: 19, maxLevel: 28, aggressive: true,
		hp: [90, 24], dmg: [10, 4], attackSpeed: 1.8, range: 1.7, speed: 3.8, aggroRadius: 8,
		color: '#e07a2e', size: 0.55, loot: 'kitin_shell', regions: ['fyros', 'zorai', 'matis', 'tryker'],
	},
	kirosta: {
		name: 'Kirosta Matriarch', minLevel: 30, maxLevel: 30, aggressive: true, boss: true,
		hp: [3000, 0], dmg: [60, 0], attackSpeed: 2.2, range: 2.2, speed: 3.4, aggroRadius: 9,
		color: '#ff3b30', size: 0.95, loot: 'kirosta_heart', regions: [],
	},
};

const ITEMS = {
	potion: { name: 'Health Potion', price: 25, sell: 8, stack: true },
	crystal: { name: 'Sap Crystal', price: 30, sell: 10, stack: true },
	yubo_skin: { name: 'Yubo Skin', sell: 3, stack: true },
	mektoub_hide: { name: 'Mektoub Hide', sell: 6, stack: true },
	gingo_fang: { name: 'Gingo Fang', sell: 7, stack: true },
	torbak_horn: { name: 'Torbak Horn', sell: 12, stack: true },
	ragus_claw: { name: 'Ragus Claw', sell: 12, stack: true },
	kitin_shell: { name: 'Kitin Shell', sell: 20, stack: true },
	kirosta_heart: { name: 'Kirosta Heart', sell: 1500, stack: true },
};

// Gear: buying a higher tier replaces the previous one in the same slot.
const GEAR = {
	weapon: [
		{ id: 'dagger', name: 'Bone Dagger', bonus: 0, price: 0 },
		{ id: 'sword', name: 'Fyros Sword', bonus: 0.25, price: 150 },
		{ id: 'axe', name: 'Kitin Axe', bonus: 0.6, price: 900 },
	],
	amp: [
		{ id: 'none', name: 'Bare Hands', bonus: 0, price: 0 },
		{ id: 'amp', name: 'Matis Amplifier', bonus: 0.25, price: 150 },
		{ id: 'staff', name: 'Zorai Staff', bonus: 0.6, price: 900 },
	],
	armor: [
		{ id: 'cloth', name: 'Refugee Clothes', bonus: 0, price: 0 },
		{ id: 'light', name: 'Tryker Light Armor', bonus: 0.15, price: 200 },
		{ id: 'heavy', name: 'Fyros Heavy Armor', bonus: 0.3, price: 1200 },
	],
};

const SHOP = ['potion', 'crystal'];

module.exports = { CREATURES, ITEMS, GEAR, SHOP };
