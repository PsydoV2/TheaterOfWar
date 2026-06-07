import type { TurnEvent } from "./types";
import type { GameState } from "./GameState";
import { getReachable, getAttackableTargets } from "./Pathfinder";
import { hexDistance, parseHexId } from "./HexUtils";
import { resolveCombatPair } from "./CombatResolver";
import type { CombatEvent } from "./CombatResolver";

// Preferred units to build, in priority order
const PRODUCTION_PRIORITY = ["tank_medium", "infantry_elite", "infantry_basic"];

function nearestPlayerTarget(fromHexId: string, state: GameState): string | null {
  const from = parseHexId(fromHexId);
  let best: string | null = null;
  let bestDist = Infinity;

  for (const unit of state.getUnitsBy("player")) {
    const d = hexDistance(from, parseHexId(unit.hexId));
    if (d < bestDist) { bestDist = d; best = unit.hexId; }
  }
  for (const city of state.getCitiesBy("player")) {
    const d = hexDistance(from, parseHexId(city.hexId));
    if (d < bestDist) { bestDist = d; best = city.hexId; }
  }
  return best;
}

function formatCombatEvents(evt: CombatEvent): TurnEvent[] {
  const events: TurnEvent[] = [];
  events.push({
    category: "combat",
    owner: "enemy",
    message:
      `${evt.aName} attacks ${evt.bName}: ` +
      `deals ${evt.aDamage}dmg (${evt.bHpAfter}HP)` +
      (evt.bDestroyed ? " — destroyed!" : ""),
  });
  if (evt.bDamage > 0) {
    events.push({
      category: "combat",
      owner: "enemy",
      message:
        `${evt.bName} retaliates: ` +
        `deals ${evt.bDamage}dmg (${evt.aHpAfter}HP)` +
        (evt.aDestroyed ? " — destroyed!" : ""),
    });
  }
  return events;
}

// Returns false if the attacker was destroyed
function tryAttack(unitId: string, state: GameState, events: TurnEvent[]): boolean {
  const unit = state.units.get(unitId);
  if (!unit || unit.hasAttacked) return true;

  const attackable = getAttackableTargets(unitId, state);
  if (attackable.length === 0) return true;

  const targetCell = state.getHexById(attackable[0]!);
  if (!targetCell?.unitId) return true;

  const evt = resolveCombatPair(unitId, targetCell.unitId, state);
  if (!evt) return true;

  unit.hasAttacked = true;
  events.push(...formatCombatEvents(evt));
  return !evt.aDestroyed;
}

export function runEnemyAI(state: GameState): TurnEvent[] {
  const events: TurnEvent[] = [];

  // Queue production in idle enemy cities
  for (const city of state.getCitiesBy("enemy")) {
    if (city.productionQueue.length > 0) continue;
    for (const bpId of PRODUCTION_PRIORITY) {
      const bp = state.getBlueprint(bpId);
      if (!bp) continue;
      const err = state.queueProduction(city.id, bpId);
      if (!err) {
        events.push({ category: "ai", owner: "enemy", message: `${city.name}: queuing ${bp.name}` });
        break;
      }
    }
  }

  // Move and attack with each enemy unit (snapshot to avoid iterator invalidation)
  for (const unit of [...state.getUnitsBy("enemy")]) {
    if (unit.hasMoved && unit.hasAttacked) continue;

    const bp = state.getBlueprint(unit.blueprintId);
    if (!bp) continue;

    const target = nearestPlayerTarget(unit.hexId, state);
    if (!target) continue;

    // Attack before moving (beneficial for artillery and entrenched units)
    if (!unit.hasAttacked) {
      const survived = tryAttack(unit.instanceId, state, events);
      if (!survived) continue;
    }

    // Move toward target
    if (!unit.hasMoved) {
      const reachable = getReachable(unit.hexId, bp.movement.range, bp.movement.type, state);
      if (reachable.length === 0) continue;

      const targetCoord = parseHexId(target);
      const bestMove = reachable.reduce((acc, id) =>
        hexDistance(parseHexId(id), targetCoord) < hexDistance(parseHexId(acc), targetCoord)
          ? id
          : acc
      );

      const prevHex = unit.hexId;
      state.moveUnit(unit.instanceId, bestMove);
      events.push({
        category: "ai",
        owner: "enemy",
        message: `${bp.name} [${unit.instanceId}] moves ${prevHex} → ${bestMove}`,
      });

      // City capture
      const destCell = state.getHexById(bestMove);
      if (destCell?.cityId) {
        const city = state.getCity(destCell.cityId);
        if (city && city.owner !== "enemy") {
          state.captureCity(destCell.cityId, "enemy");
          events.push({ category: "ai", owner: "enemy", message: `${city.name} captured by enemy forces!` });
        }
      }

      // Attack after moving
      if (!unit.hasAttacked) tryAttack(unit.instanceId, state, events);
    }
  }

  return events;
}
