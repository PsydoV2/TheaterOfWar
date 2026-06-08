import type { HexCell, City, BuildingLevels, Owner, TerrainType } from "./types";
import { hexId, getNeighbors } from "./HexUtils";

export interface MapData {
  cells: HexCell[];
  cities: City[];
}

const EMPTY_BUILDINGS: BuildingLevels = {
  factoryLevel: 0,
  barracksLevel: 0,
  warehouseLevel: 0,
  airportLevel: 0,
  harborLevel: 0,
  turretLevel: 0,
  marketLevel: 0,
};

function makeCity(
  id: string,
  name: string,
  owner: Owner,
  q: number,
  r: number,
  buildings: Partial<BuildingLevels> = {}
): City {
  return {
    id,
    name,
    owner,
    hexId: hexId(q, r),
    buildings: { ...EMPTY_BUILDINGS, ...buildings },
    productionQueue: [],
  };
}

function hexDist(q: number, r: number): number {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
}

// Seeded PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Map dimensions ───────────────────────────────────────────────────────────
// Playfield: dist 0–6. Water border: dist 7–8.
const PLAYFIELD_RADIUS = 6;
const MAP_RADIUS = 8;

// ─── City definitions ─────────────────────────────────────────────────────────
// Player/Enemy HQs at dist 5 (inland).
// Port & Airfield at dist 6 (coastal — adjacent to border water at dist 7).
// Neutral cities: mix of inland (dist 1–4) and coastal (dist 6).

interface CityDef {
  id: string;
  name: string;
  owner: Owner;
  buildings?: Partial<BuildingLevels>;
}

const CITY_LOCATIONS: Record<string, CityDef> = {
  // ── Player (bottom-left) ────────────────────────────────────────────────────
  "-4_5": {
    id: "city_player_hq",
    name: "Allied Command",
    owner: "player",
    buildings: { barracksLevel: 1, factoryLevel: 1, warehouseLevel: 1 },
  },
  "-5_6": {
    id: "city_player_port",
    name: "Allied Harbor",
    owner: "player",
    buildings: { barracksLevel: 1, factoryLevel: 1, warehouseLevel: 1 },
  },

  // ── Enemy (top-right) ───────────────────────────────────────────────────────
  "4_-5": {
    id: "city_enemy_hq",
    name: "Enemy Stronghold",
    owner: "enemy",
    buildings: { barracksLevel: 1, factoryLevel: 1, warehouseLevel: 1 },
  },
  "5_-6": {
    id: "city_enemy_port",
    name: "Enemy Harbor",
    owner: "enemy",
    buildings: { barracksLevel: 1, factoryLevel: 1, warehouseLevel: 1 },
  },

  // ── Neutral inland ─────────────────────────────────────────────────────────
  "-3_1": { id: "city_neutral_w", name: "Westbridge",    owner: "neutral" },
  "3_-2": { id: "city_neutral_e", name: "Eastgate",      owner: "neutral" },
  "-1_3": { id: "city_neutral_s", name: "Riverside",     owner: "neutral" },
  "1_-3": { id: "city_neutral_n", name: "Northern Pass", owner: "neutral" },

  // ── Neutral coastal (dist 6) ────────────────────────────────────────────────
  "6_-2": { id: "city_neutral_ec", name: "Harbor Town", owner: "neutral" },
  "-6_2": { id: "city_neutral_wc", name: "West Haven",  owner: "neutral" },
};

// ─── Static terrain (no-seed fallback) ───────────────────────────────────────
// City hexes are always plains regardless of what's listed here.

const STATIC_TERRAIN_OVERRIDES: Record<string, TerrainType> = {
  // Central mountain barrier (between player and enemy)
  "0_-2": "mountain", "1_-2": "mountain", "-1_-1": "mountain",
  "0_-3": "mountain",                     "-1_-4": "mountain",
  "2_-4": "mountain", "-2_-1": "mountain",
  // Extended northern barrier
  "-3_-2": "mountain", "-2_-3": "mountain",
  "0_-4": "mountain",  "1_-4": "mountain",
  // Eastern hills
  "4_0":  "mountain",  "5_-1": "mountain",
  // Western ridge
  "-4_1": "mountain",  "-5_2": "mountain",

  // Central forests
  "-2_0": "forest", "-1_1": "forest", "2_-1": "forest",
  "1_1":  "forest", "2_1": "forest",  "-2_3": "forest",
  "0_3":  "forest", "-3_2": "forest", "3_0": "forest",
  // Extended forests
  "-4_3": "forest", "-5_3": "forest",
  "4_-3": "forest", "5_-3": "forest",
  "-1_5": "forest", "1_3":  "forest",
  "-5_1": "forest", "4_2":  "forest",

  // Inland river (connected chain: 1_-1 → 1_0 → 0_1 → 0_2 → -1_2 → -2_2)
  "1_-1": "water", "1_0": "water", "0_1": "water",
  "0_2":  "water", "-1_2": "water", "-2_2": "water",
};

// ─── Seeded terrain generation ────────────────────────────────────────────────

const TERRAIN_THRESHOLDS: [number, TerrainType][] = [
  [0.10, "water"],
  [0.25, "mountain"],
  [0.50, "forest"],
  [1.00, "plains"],
];

function pickTerrain(roll: number): TerrainType {
  for (const [threshold, t] of TERRAIN_THRESHOLDS) {
    if (roll < threshold) return t;
  }
  return "plains";
}

/** Converts isolated water tiles (no water neighbors) to plains. Repeats until stable. */
function removeIsolatedWater(terrain: Map<string, TerrainType>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, t] of terrain) {
      if (t !== "water") continue;
      const [q, r] = id.split("_").map(Number) as [number, number];
      const hasWaterNeighbor = getNeighbors(q, r).some(
        (n) => terrain.get(hexId(n.q, n.r)) === "water"
      );
      if (!hasWaterNeighbor) {
        terrain.set(id, "plains");
        changed = true;
      }
    }
  }
}

function generateTerrainWithSeed(
  rng: () => number,
  cityHexIds: Set<string>,
): Map<string, TerrainType> {
  const terrain = new Map<string, TerrainType>();
  for (let q = -PLAYFIELD_RADIUS; q <= PLAYFIELD_RADIUS; q++) {
    const rMin = Math.max(-PLAYFIELD_RADIUS, -q - PLAYFIELD_RADIUS);
    const rMax = Math.min(PLAYFIELD_RADIUS, -q + PLAYFIELD_RADIUS);
    for (let r = rMin; r <= rMax; r++) {
      const id = hexId(q, r);
      terrain.set(id, cityHexIds.has(id) ? "plains" : pickTerrain(rng()));
    }
  }
  removeIsolatedWater(terrain);
  return terrain;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateStarterMap(seed?: number): MapData {
  const cells: HexCell[] = [];
  const cities: City[] = [];

  const cityHexIds = new Set(Object.keys(CITY_LOCATIONS));
  const seededTerrain =
    seed !== undefined
      ? generateTerrainWithSeed(mulberry32(seed), cityHexIds)
      : null;

  for (let q = -MAP_RADIUS; q <= MAP_RADIUS; q++) {
    const rMin = Math.max(-MAP_RADIUS, -q - MAP_RADIUS);
    const rMax = Math.min(MAP_RADIUS, -q + MAP_RADIUS);
    for (let r = rMin; r <= rMax; r++) {
      const id = hexId(q, r);
      const dist = hexDist(q, r);
      const isEdge = dist > PLAYFIELD_RADIUS;

      const cityDef = !isEdge ? CITY_LOCATIONS[id] : undefined;

      // City hexes are always plains so units can traverse them
      let terrain: TerrainType;
      if (isEdge) {
        terrain = "water";
      } else if (cityDef) {
        terrain = "plains";
      } else if (seededTerrain) {
        terrain = seededTerrain.get(id) ?? "plains";
      } else {
        terrain = STATIC_TERRAIN_OVERRIDES[id] ?? "plains";
      }

      cells.push({ id, q, r, terrain, cityId: cityDef?.id ?? null, unitId: null });

      if (cityDef) {
        cities.push(
          makeCity(cityDef.id, cityDef.name, cityDef.owner, q, r, cityDef.buildings)
        );
      }
    }
  }

  return { cells, cities };
}
