// ─── Primitives ───────────────────────────────────────────────────────────────

export type TerrainType = "plains" | "forest" | "mountain" | "water";
export type MovementType = "land" | "water" | "air" | "ballistic";
export type Owner = "player" | "enemy" | "neutral";
export type GamePhase = "planning" | "resolving" | "victory" | "defeat";

/** Keys matching BuildingLevels properties (without "Level" suffix). */
export type BuildingKey =
  | "barracks"
  | "factory"
  | "warehouse"
  | "airport"
  | "harbor"
  | "turret";

// ─── Map ─────────────────────────────────────────────────────────────────────

export interface HexCell {
  /** Axial coordinate notation "q_r". */
  id: string;
  q: number;
  r: number;
  terrain: TerrainType;
  cityId: string | null;
  /** Only one unit per cell (Advance Wars–style, no stacking). */
  unitId: string | null;
}

// ─── Cities & Buildings ───────────────────────────────────────────────────────

export interface BuildingLevels {
  factoryLevel: number;   // 0–3
  barracksLevel: number;  // 0–3
  warehouseLevel: number; // 0–3
  airportLevel: number;   // 0–1 (binary presence)
  harborLevel: number;    // 0–1 (binary presence)
  turretLevel: number;    // 0–3
}

export interface ProductionQueueItem {
  blueprintId: string;
  progressPoints: number;
}

export interface City {
  id: string;
  name: string;
  owner: Owner;
  hexId: string;
  buildings: BuildingLevels;
  /** FIFO queue — only [0] receives production each turn. */
  productionQueue: ProductionQueueItem[];
}

// ─── Unit Blueprints (data-driven JSON registry) ──────────────────────────────

export interface UnitBlueprint {
  id: string;
  name: string;
  requiredBuilding: BuildingKey;
  requiredBuildingLevel: number;
  maxHp: number;
  cost: {
    credits: number;
    productionNeeded: number;
  };
  movement: {
    type: MovementType;
    range: number;
  };
  combat: {
    damageVsLand: number;
    damageVsAir: number;
    damageVsSea: number;
    range: number;
  };
  specialTraits: string[];
}

// ─── Unit Instances (runtime state, separate from blueprints) ─────────────────

export interface MilitaryUnit {
  instanceId: string;
  blueprintId: string;
  owner: Owner;
  hexId: string;
  hp: number;
  hasMoved: boolean;
  hasAttacked: boolean;
}

// ─── Resources ───────────────────────────────────────────────────────────────

export interface PlayerResources {
  credits: number;
  maxCredits: number;
}

// ─── Turn resolution ─────────────────────────────────────────────────────────

export interface TurnEvent {
  category: "income" | "production" | "turret" | "combat" | "ai" | "system";
  owner: Owner | "world";
  message: string;
}

export interface TurnResult {
  turn: number;
  events: TurnEvent[];
  outcome: "ongoing" | "victory" | "defeat";
}

// ─── Root State Interface ─────────────────────────────────────────────────────

export interface IGameState {
  turn: number;
  phase: GamePhase;
  hexMap: Map<string, HexCell>;
  cities: Map<string, City>;
  units: Map<string, MilitaryUnit>;
  playerResources: PlayerResources;
  enemyResources: PlayerResources;
  unitBlueprints: Map<string, UnitBlueprint>;
  unitInstanceCounter: number;
  removeUnit(instanceId: string): void;
}
