import type { City, Owner, TurnEvent, TurnResult } from "./types";
import type { GameState } from "./GameState";
import { getNeighbors, hexId } from "./HexUtils";
import { runEnemyAI } from "./EnemyAI";

// Re-export so existing consumers importing from TurnResolver still work
export type { TurnEvent, TurnResult };

// ─── Constants ────────────────────────────────────────────────────────────────

const CREDITS_PER_CITY = 30;
const PRODUCTION_PER_FACTORY_LEVEL = 50;
const TURRET_DAMAGE_PER_LEVEL = 15;

// ─── TurnResolver ─────────────────────────────────────────────────────────────

export class TurnResolver {
  constructor(private readonly state: GameState) {}

  /**
   * Resolves one complete game turn:
   * 1. Income (all owners)
   * 2. Production queue advancement (all owners)
   * 3. Turret defensive fire (all owned cities)
   * 4. Enemy AI (moves, attacks, production orders)
   * 5. Reset unit flags
   * 6. Check victory/defeat
   */
  resolve(): TurnResult {
    const result: TurnResult = { turn: this.state.turn, events: [], outcome: "ongoing" };

    this.state.phase = "resolving";

    this.resolveIncome("player", result);
    this.resolveIncome("enemy", result);
    this.resolveProduction("player", result);
    this.resolveProduction("enemy", result);
    this.resolveTurretDamage(result);

    const aiEvents = runEnemyAI(this.state);
    result.events.push(...aiEvents);

    this.state.resetUnitFlags();
    this.state.turn++;
    this.state.phase = "planning";

    result.events.push({
      category: "system",
      owner: "world",
      message: `Turn ${result.turn} complete. Now planning turn ${this.state.turn}.`,
    });

    result.outcome = this.checkOutcome();
    return result;
  }

  private checkOutcome(): "ongoing" | "victory" | "defeat" {
    if (this.state.getCitiesBy("enemy").length === 0) return "victory";
    if (this.state.getCitiesBy("player").length === 0) return "defeat";
    return "ongoing";
  }

  // ─── Income ────────────────────────────────────────────────────────────────

  private resolveIncome(owner: Owner, result: TurnResult): void {
    const cities = this.state.getCitiesBy(owner);
    const res = this.state.resources(owner);

    const gross = cities.length * CREDITS_PER_CITY;
    const before = res.credits;
    res.credits = Math.min(res.credits + gross, res.maxCredits);
    const actual = res.credits - before;
    const capped = gross - actual;

    let msg = `+${actual}$ income (${cities.length} cities × ${CREDITS_PER_CITY}$) → ${res.credits}/${res.maxCredits}$`;
    if (capped > 0) msg += ` [${capped}$ wasted — storage full]`;
    result.events.push({ category: "income", owner, message: msg });
  }

  // ─── Production ────────────────────────────────────────────────────────────

  private resolveProduction(owner: Owner, result: TurnResult): void {
    for (const city of this.state.getCitiesBy(owner)) {
      if (city.productionQueue.length === 0) continue;
      this.advanceCityProduction(city, result);
    }
  }

  private advanceCityProduction(city: City, result: TurnResult): void {
    const output = city.buildings.factoryLevel * PRODUCTION_PER_FACTORY_LEVEL;

    // No factory → queue stalls, log it once per turn
    if (output === 0) {
      result.events.push({
        category: "production",
        owner: city.owner,
        message: `${city.name}: no factory — production stalled.`,
      });
      return;
    }

    const item = city.productionQueue[0]!;
    const bp = this.state.getBlueprint(item.blueprintId);
    if (!bp) return;

    item.progressPoints += output;

    result.events.push({
      category: "production",
      owner: city.owner,
      message: `${city.name}: "${bp.name}" +${output}pt → ${item.progressPoints}/${bp.cost.productionNeeded}pt`,
    });

    if (item.progressPoints < bp.cost.productionNeeded) return;

    // Production complete
    city.productionQueue.shift();
    const spawned = this.state.spawnUnit(bp.id, city.owner, city.hexId);

    if (spawned) {
      result.events.push({
        category: "production",
        owner: city.owner,
        message: `${city.name}: "${bp.name}" complete! [${spawned.instanceId}] deployed on ${city.hexId}.`,
      });
    } else {
      // Hex occupied — re-queue at front with full progress to retry next turn
      city.productionQueue.unshift({
        blueprintId: bp.id,
        progressPoints: bp.cost.productionNeeded,
      });
      result.events.push({
        category: "production",
        owner: city.owner,
        message: `${city.name}: "${bp.name}" complete but hex ${city.hexId} is occupied! Retrying next turn.`,
      });
    }
  }

  // ─── Turret Defensive Fire ──────────────────────────────────────────────────

  private resolveTurretDamage(result: TurnResult): void {
    for (const city of this.state.cities.values()) {
      if (city.buildings.turretLevel === 0) continue;
      if (city.owner === "neutral") continue;

      const damage = city.buildings.turretLevel * TURRET_DAMAGE_PER_LEVEL;
      const enemyOwner: Owner = city.owner === "player" ? "enemy" : "player";
      const { q, r } = this.state.getHexById(city.hexId)!;

      for (const neighbor of getNeighbors(q, r)) {
        const neighborHex = this.state.getHexById(hexId(neighbor.q, neighbor.r));
        if (!neighborHex?.unitId) continue;

        const unit = this.state.getUnit(neighborHex.unitId);
        if (!unit || unit.owner !== enemyOwner) continue;

        unit.hp -= damage;
        const bp = this.state.getBlueprint(unit.blueprintId);
        const name = bp?.name ?? unit.blueprintId;

        result.events.push({
          category: "turret",
          owner: city.owner,
          message: `${city.name} turret fires! ${name} [${unit.instanceId}] takes ${damage} damage → ${unit.hp}HP`,
        });

        if (unit.hp <= 0) {
          this.state.removeUnit(unit.instanceId);
          result.events.push({
            category: "turret",
            owner: city.owner,
            message: `${name} [${unit.instanceId}] destroyed by turret fire!`,
          });
        }
      }
    }
  }
}
