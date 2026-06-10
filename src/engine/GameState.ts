import type {
  IGameState,
  HexCell,
  City,
  MilitaryUnit,
  UnitBlueprint,
  Owner,
  GamePhase,
  PlayerResources,
  BuildingKey,
} from "./types";
import { generateStarterMap } from "./MapGenerator";
import { hexId, getNeighbors } from "./HexUtils";
import blueprintData from "../data/units.json";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_MAX_CREDITS = 500;
const WAREHOUSE_CAPACITY_BONUS = 250;

// BuildingKey → keyof BuildingLevels  (e.g. "factory" → "factoryLevel")
const BUILDING_LEVEL_KEY: Record<BuildingKey, string> = {
  barracks:  "barracksLevel",
  factory:   "factoryLevel",
  warehouse: "warehouseLevel",
  airport:   "airportLevel",
  harbor:    "harborLevel",
  turret:    "turretLevel",
  market:    "marketLevel",
};

// ─── GameState ────────────────────────────────────────────────────────────────

export class GameState implements IGameState {
  turn: number = 1;
  phase: GamePhase = "planning";
  hexMap: Map<string, HexCell> = new Map();
  cities: Map<string, City> = new Map();
  units: Map<string, MilitaryUnit> = new Map();
  playerResources: PlayerResources = { credits: 200, maxCredits: BASE_MAX_CREDITS };
  enemyResources: PlayerResources = { credits: 200, maxCredits: BASE_MAX_CREDITS };
  unitBlueprints: Map<string, UnitBlueprint> = new Map();
  unitInstanceCounter: number = 0;
  readonly seed: number | undefined;

  constructor(seed?: number) {
    this.seed = seed;
    this.loadBlueprints();
    this.initMap();
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  private loadBlueprints(): void {
    for (const bp of blueprintData as UnitBlueprint[]) {
      this.unitBlueprints.set(bp.id, bp);
    }
  }

  private initMap(): void {
    const { cells, cities } = generateStarterMap(this.seed);
    for (const cell of cells) this.hexMap.set(cell.id, cell);
    for (const city of cities) this.cities.set(city.id, city);
    this.recalcMaxCredits("player");
    this.recalcMaxCredits("enemy");
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  getHex(q: number, r: number): HexCell | undefined {
    return this.hexMap.get(hexId(q, r));
  }

  getHexById(id: string): HexCell | undefined {
    return this.hexMap.get(id);
  }

  getCity(cityId: string): City | undefined {
    return this.cities.get(cityId);
  }

  getUnit(instanceId: string): MilitaryUnit | undefined {
    return this.units.get(instanceId);
  }

  getCitiesBy(owner: Owner): City[] {
    return [...this.cities.values()].filter((c) => c.owner === owner);
  }

  getUnitsBy(owner: Owner): MilitaryUnit[] {
    return [...this.units.values()].filter((u) => u.owner === owner);
  }

  getBlueprint(blueprintId: string): UnitBlueprint | undefined {
    return this.unitBlueprints.get(blueprintId);
  }

  resources(owner: Owner): PlayerResources {
    return owner === "player" ? this.playerResources : this.enemyResources;
  }

  // ─── Resource Helpers ────────────────────────────────────────────────────────

  recalcMaxCredits(owner: Owner): void {
    let max = BASE_MAX_CREDITS;
    for (const city of this.getCitiesBy(owner)) {
      max += city.buildings.warehouseLevel * WAREHOUSE_CAPACITY_BONUS;
    }
    this.resources(owner).maxCredits = max;
  }

  // ─── Production Queue ────────────────────────────────────────────────────────

  /**
   * Attempts to queue a unit blueprint for production in a given city.
   * Deducts credits immediately on success.
   * Returns an error string on failure, null on success.
   */
  queueProduction(cityId: string, blueprintId: string): string | null {
    const city = this.cities.get(cityId);
    if (!city) return "City not found.";
    if (city.owner === "neutral") return "Cannot produce in a neutral city.";

    const bp = this.unitBlueprints.get(blueprintId);
    if (!bp) return `Unknown blueprint: ${blueprintId}`;

    const levelKey = BUILDING_LEVEL_KEY[bp.requiredBuilding] as keyof typeof city.buildings;
    const currentLevel = city.buildings[levelKey] as number;
    if (currentLevel < bp.requiredBuildingLevel) {
      return `Requires ${bp.requiredBuilding} level ${bp.requiredBuildingLevel} (current: ${currentLevel}).`;
    }

    const res = this.resources(city.owner);
    if (res.credits < bp.cost.credits) {
      return `Insufficient credits (need ${bp.cost.credits}, have ${res.credits}).`;
    }

    res.credits -= bp.cost.credits;
    city.productionQueue.push({ blueprintId, progressPoints: 0 });
    return null;
  }

  // ─── Building Upgrades ───────────────────────────────────────────────────────

  private static readonly UPGRADE_COSTS: Record<BuildingKey, number[]> = {
    factory:   [100, 200, 300],
    barracks:  [80,  160, 240],
    warehouse: [120, 240, 360],
    airport:   [200],
    harbor:    [200],
    turret:    [90,  180, 270],
    market:    [150, 300, 450],
  };

  private static readonly MAX_LEVELS: Record<BuildingKey, number> = {
    factory:   3,
    barracks:  3,
    warehouse: 3,
    airport:   1,
    harbor:    1,
    turret:    3,
    market:    3,
  };

  /** Returns true if any neighbor hex of the city is water terrain. */
  isCityCoastal(cityId: string): boolean {
    const city = this.cities.get(cityId);
    if (!city) return false;
    const hex = this.hexMap.get(city.hexId);
    if (!hex) return false;
    return getNeighbors(hex.q, hex.r).some((n) => {
      const nHex = this.hexMap.get(hexId(n.q, n.r));
      return nHex?.terrain === "water";
    });
  }

  /**
   * Instantly upgrades a building in a city. Returns an error string or null on success.
   */
  upgradeBuilding(cityId: string, building: BuildingKey): string | null {
    const city = this.cities.get(cityId);
    if (!city) return "City not found.";
    if (city.owner !== "player") return "Can only upgrade player-owned cities.";

    if (building === "harbor" && !this.isCityCoastal(cityId)) {
      return "Harbor requires a coastal city (adjacent to water).";
    }

    const levelKey = BUILDING_LEVEL_KEY[building] as keyof typeof city.buildings;
    const currentLevel = city.buildings[levelKey] as number;
    const maxLevel = GameState.MAX_LEVELS[building];

    if (currentLevel >= maxLevel) return `${building} is already at max level.`;

    const cost = GameState.UPGRADE_COSTS[building][currentLevel];
    if (cost === undefined) return "Invalid upgrade level.";

    const res = this.playerResources;
    if (res.credits < cost) {
      return `Insufficient credits (need ${cost}$, have ${res.credits}$).`;
    }

    res.credits -= cost;
    (city.buildings[levelKey] as number)++;
    this.recalcMaxCredits("player");
    return null;
  }

  // ─── Production Queue ────────────────────────────────────────────────────────

  /**
   * Transfers ownership of a city to a new owner and clears its production queue.
   * Previous owner gets 50% refund on any queued production.
   */
  captureCity(cityId: string, newOwner: Owner): void {
    const city = this.cities.get(cityId);
    if (!city) return;
    const prevOwner = city.owner;
    if (prevOwner !== "neutral") {
      const res = this.resources(prevOwner);
      for (const item of city.productionQueue) {
        const bp = this.unitBlueprints.get(item.blueprintId);
        if (bp) res.credits = Math.min(res.credits + Math.floor(bp.cost.credits * 0.5), res.maxCredits);
      }
    }
    city.owner = newOwner;
    city.productionQueue = [];
    if (prevOwner !== "neutral") this.recalcMaxCredits(prevOwner);
    this.recalcMaxCredits(newOwner);
  }

  /**
   * Cancels a queue item by index. Full credit refund since credits were pre-paid.
   */
  cancelProduction(cityId: string, index: number): void {
    const city = this.cities.get(cityId);
    if (!city) return;
    const item = city.productionQueue[index];
    if (!item) return;
    const bp = this.unitBlueprints.get(item.blueprintId);
    if (bp) {
      const res = this.resources(city.owner);
      res.credits = Math.min(res.credits + bp.cost.credits, res.maxCredits);
    }
    city.productionQueue.splice(index, 1);
  }

  // ─── Unit Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Spawns a unit instance on a hex. Returns the unit or null if the hex is occupied.
   */
  spawnUnit(blueprintId: string, owner: Owner, targetHexId: string): MilitaryUnit | null {
    const bp = this.unitBlueprints.get(blueprintId);
    if (!bp) return null;

    const hex = this.hexMap.get(targetHexId);
    if (!hex || hex.unitId !== null) return null;

    const instanceId = `unit_${String(++this.unitInstanceCounter).padStart(3, "0")}`;
    const unit: MilitaryUnit = {
      instanceId,
      blueprintId,
      owner,
      hexId: targetHexId,
      hp: bp.maxHp,
      hasMoved: false,
      hasAttacked: false,
      movementLeft: bp.movement.range,
      stackSize: 1,
    };

    this.units.set(instanceId, unit);
    hex.unitId = instanceId;
    return unit;
  }

  /**
   * Removes a unit from the board and clears its hex reference.
   */
  removeUnit(instanceId: string): void {
    const unit = this.units.get(instanceId);
    if (!unit) return;
    const hex = this.hexMap.get(unit.hexId);
    if (hex) hex.unitId = null;
    this.units.delete(instanceId);
  }

  /**
   * Merges two friendly land units on the same hex — adds the moving unit's HP to
   * the target and removes the moving unit from the board. Returns false if the
   * merge is not valid (different owners, etc.).
   */
  mergeUnits(movingId: string, targetId: string): boolean {
    const moving = this.units.get(movingId);
    const target = this.units.get(targetId);
    if (!moving || !target) return false;
    if (moving.owner !== target.owner) return false;

    const bp = this.unitBlueprints.get(target.blueprintId);
    target.hp = Math.min(target.hp + moving.hp, bp?.maxHp ?? target.hp + moving.hp);
    target.stackSize += moving.stackSize;
    target.hasMoved = true;
    target.movementLeft = 0;

    const sourceHex = this.hexMap.get(moving.hexId);
    if (sourceHex) sourceHex.unitId = null;
    this.units.delete(movingId);
    return true;
  }

  /**
   * Moves a unit to a new hex (no pathfinding validation here — that is Phase 4).
   */
  /**
   * Moves a unit to a new hex. `movementCost` deducts from remaining movement
   * points; pass "all" (default) to exhaust all movement (used by AI and merges).
   */
  moveUnit(instanceId: string, targetHexId: string, movementCost: number | "all" = "all"): boolean {
    const unit = this.units.get(instanceId);
    if (!unit) return false;

    const targetHex = this.hexMap.get(targetHexId);
    if (!targetHex || targetHex.unitId !== null) return false;

    const sourceHex = this.hexMap.get(unit.hexId);
    if (sourceHex) sourceHex.unitId = null;

    targetHex.unitId = instanceId;
    unit.hexId = targetHexId;
    unit.hasMoved = true;
    unit.movementLeft = movementCost === "all"
      ? 0
      : Math.max(0, unit.movementLeft - movementCost);
    return true;
  }

  resetUnitFlags(): void {
    for (const unit of this.units.values()) {
      unit.hasMoved = false;
      unit.hasAttacked = false;
      unit.movementLeft = this.unitBlueprints.get(unit.blueprintId)?.movement.range ?? 1;
    }
  }
}
