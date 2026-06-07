import type { HexCell, City, BuildingLevels, Owner, TerrainType } from "./types";
import { hexId } from "./HexUtils";

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

// ─── Static Map Definition ────────────────────────────────────────────────────
// Radius-5 hex grid (91 cells). Outer ring (distance = 5) is ocean water.

const TERRAIN_OVERRIDES: Record<string, TerrainType> = {
  // Central mountain range (barrier between player and enemy)
  "0_-2": "mountain",
  "1_-2": "mountain",
  "-1_-1": "mountain",
  "0_-3": "mountain",
  "1_-3": "mountain",
  "-1_-4": "mountain",
  // Secondary ridgeline
  "2_-4": "mountain",
  "-2_-1": "mountain",
  // Forests
  "-2_0": "forest",
  "-1_1": "forest",
  "2_-1": "forest",
  "1_1": "forest",
  "-3_1": "forest",
  "3_-2": "forest",
  "2_1": "forest",
  "-2_3": "forest",
  "0_3": "forest",
  "-3_2": "forest",
  "3_0": "forest",
  // Inland rivers and lakes
  "0_0": "water",
  "0_1": "water",
  "-1_2": "water",
  "1_-1": "water",
  "0_2": "water",
  "-1_-2": "water",
  "1_0": "water",
};

interface CityDef {
  id: string;
  name: string;
  owner: Owner;
  buildings?: Partial<BuildingLevels>;
}

const CITY_LOCATIONS: Record<string, CityDef> = {
  // Player cities — bottom-left quadrant
  "-4_3": {
    id: "city_player_hq",
    name: "Allied Command",
    owner: "player",
    buildings: { barracksLevel: 1, factoryLevel: 1, warehouseLevel: 1 },
  },
  "-3_4": {
    id: "city_player_outpost",
    name: "Fort Alpha",
    owner: "player",
    buildings: { barracksLevel: 1, factoryLevel: 1 },
  },
  // Enemy cities — top-right quadrant
  "4_-3": {
    id: "city_enemy_hq",
    name: "Enemy Stronghold",
    owner: "enemy",
    buildings: { barracksLevel: 1, factoryLevel: 1, warehouseLevel: 1 },
  },
  "3_-4": {
    id: "city_enemy_outpost",
    name: "Enemy Outpost",
    owner: "enemy",
    buildings: { barracksLevel: 1, factoryLevel: 1 },
  },
  // Neutral cities — scattered across the playfield
  "-2_1": {
    id: "city_neutral_west",
    name: "Westbridge",
    owner: "neutral",
  },
  "2_-2": {
    id: "city_neutral_east",
    name: "Eastgate",
    owner: "neutral",
  },
  "-1_3": {
    id: "city_neutral_south",
    name: "Riverside",
    owner: "neutral",
  },
  "-1_-3": {
    id: "city_neutral_north",
    name: "Northern Pass",
    owner: "neutral",
  },
  "3_1": {
    id: "city_neutral_harbor",
    name: "Harbor Town",
    owner: "neutral",
  },
};

export function generateStarterMap(): MapData {
  const cells: HexCell[] = [];
  const cities: City[] = [];
  const RADIUS = 5;

  for (let q = -RADIUS; q <= RADIUS; q++) {
    const rMin = Math.max(-RADIUS, -q - RADIUS);
    const rMax = Math.min(RADIUS, -q + RADIUS);
    for (let r = rMin; r <= rMax; r++) {
      const id = hexId(q, r);
      const dist = hexDist(q, r);
      const isEdge = dist >= RADIUS;

      // Outer ring cells are ocean — no overrides apply there
      const terrain: TerrainType = isEdge ? "water" : (TERRAIN_OVERRIDES[id] ?? "plains");

      const cityDef = !isEdge ? CITY_LOCATIONS[id] : undefined;

      cells.push({
        id,
        q,
        r,
        terrain,
        cityId: cityDef?.id ?? null,
        unitId: null,
      });

      if (cityDef) {
        cities.push(
          makeCity(cityDef.id, cityDef.name, cityDef.owner, q, r, cityDef.buildings)
        );
      }
    }
  }

  return { cells, cities };
}
