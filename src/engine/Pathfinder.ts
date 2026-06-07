import type { IGameState, MovementType, TerrainType } from "./types";
import { hexId, hexDistance, parseHexId, getNeighbors, getHexesInRange } from "./HexUtils";

// ─── Terrain passability per movement type ────────────────────────────────────

function isPassable(terrain: TerrainType, movementType: MovementType): boolean {
  switch (movementType) {
    case "land":      return terrain === "plains" || terrain === "forest";
    case "water":     return terrain === "water";
    case "air":       return true;
    case "ballistic": return true;
  }
}

// ─── BFS reachability ─────────────────────────────────────────────────────────

/**
 * Returns all empty hex IDs a unit can reach from `startHexId` within `range` steps.
 * Occupied hexes (by any unit) block both stopping and passing through.
 * Ballistic units have no movement path (they fire directly — see TurnResolver).
 */
export function getReachable(
  startHexId: string,
  range: number,
  movementType: MovementType,
  state: IGameState,
): string[] {
  if (movementType === "ballistic") return [];

  // cost[id] = minimum steps to reach this hex (includes occupied to block re-entry)
  const cost = new Map<string, number>([[startHexId, 0]]);
  const queue: Array<{ id: string; steps: number }> = [{ id: startHexId, steps: 0 }];
  const reachable: string[] = [];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr.steps >= range) continue;

    const { q, r } = parseHexId(curr.id);
    for (const n of getNeighbors(q, r)) {
      const nId = hexId(n.q, n.r);
      const newSteps = curr.steps + 1;

      if ((cost.get(nId) ?? Infinity) <= newSteps) continue;

      const cell = state.hexMap.get(nId);
      if (!cell) continue;
      if (!isPassable(cell.terrain, movementType)) continue;

      cost.set(nId, newSteps);

      if (cell.unitId === null) {
        reachable.push(nId);
        queue.push({ id: nId, steps: newSteps });
      }
      // Occupied hex: recorded in cost map (blocks re-entry) but NOT queued (blocks pass-through)
    }
  }

  return reachable;
}

// ─── A* path finding ──────────────────────────────────────────────────────────

/**
 * Returns the shortest path (array of hex IDs, start exclusive, goal inclusive)
 * or null if unreachable.
 */
export function findPath(
  startHexId: string,
  goalHexId: string,
  movementType: MovementType,
  state: IGameState,
): string[] | null {
  if (movementType === "ballistic") return [goalHexId];

  const goalCoord = parseHexId(goalHexId);

  function heuristic(id: string): number {
    const { q, r } = parseHexId(id);
    // Cube-distance heuristic
    const dq = Math.abs(q - goalCoord.q);
    const dr = Math.abs(r - goalCoord.r);
    return Math.max(dq, dr, Math.abs(dq - dr));
  }

  const gScore = new Map<string, number>([[startHexId, 0]]);
  const fScore = new Map<string, number>([[startHexId, heuristic(startHexId)]]);
  const cameFrom = new Map<string, string>();
  const open = new Set<string>([startHexId]);

  while (open.size > 0) {
    // Pick open node with lowest fScore
    let current = "";
    let bestF = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < bestF) { bestF = f; current = id; }
    }

    if (current === goalHexId) return reconstructPath(cameFrom, current);

    open.delete(current);
    const { q, r } = parseHexId(current);

    for (const n of getNeighbors(q, r)) {
      const nId = hexId(n.q, n.r);
      const cell = state.hexMap.get(nId);
      if (!cell) continue;
      if (!isPassable(cell.terrain, movementType)) continue;
      if (cell.unitId !== null && nId !== goalHexId) continue; // blocked unless goal

      const tentative = (gScore.get(current) ?? Infinity) + 1;
      if (tentative < (gScore.get(nId) ?? Infinity)) {
        cameFrom.set(nId, current);
        gScore.set(nId, tentative);
        fScore.set(nId, tentative + heuristic(nId));
        open.add(nId);
      }
    }
  }

  return null;
}

// ─── Attack range ─────────────────────────────────────────────────────────────

/**
 * Returns hex IDs containing enemy units that the given unit can attack from its
 * current position, respecting combat range. Indirect-fire units (artillery) cannot
 * target adjacent hexes — minimum range is 2 for them.
 */
export function getAttackableTargets(unitId: string, state: IGameState): string[] {
  const unit = state.units.get(unitId);
  if (!unit) return [];
  const bp = state.unitBlueprints.get(unit.blueprintId);
  if (!bp) return [];

  const isIndirect = bp.specialTraits.includes("indirect_fire");
  const minRange   = isIndirect ? 2 : 1;
  const maxRange   = bp.combat.range;
  const center     = parseHexId(unit.hexId);

  return getHexesInRange(center, maxRange)
    .filter(coord => {
      if (isIndirect && hexDistance(center, coord) < minRange) return false;
      const cell = state.hexMap.get(hexId(coord.q, coord.r));
      if (!cell?.unitId) return false;
      const target = state.units.get(cell.unitId);
      return !!target && target.owner !== unit.owner;
    })
    .map(coord => hexId(coord.q, coord.r));
}

function reconstructPath(cameFrom: Map<string, string>, current: string): string[] {
  const path: string[] = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current)!;
    path.unshift(current);
  }
  path.shift(); // remove start node
  return path;
}
