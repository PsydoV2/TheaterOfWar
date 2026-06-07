import type { IGameState, UnitBlueprint, TerrainType } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

const TERRAIN_DEFENSE: Record<TerrainType, number> = {
  plains:   0.00,
  forest:   0.15,
  mountain: 0.30,
  water:    0.00,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function damageForTarget(attBp: UnitBlueprint, defBp: UnitBlueprint): number {
  switch (defBp.movement.type) {
    case "air":   return attBp.combat.damageVsAir;
    case "water": return attBp.combat.damageVsSea;
    default:      return attBp.combat.damageVsLand;
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CombatEvent {
  aName: string;
  bName: string;
  aId: string;
  bId: string;
  aDamage: number;  // damage A dealt to B
  bDamage: number;  // damage B dealt to A
  aHpAfter: number;
  bHpAfter: number;
  aDestroyed: boolean;
  bDestroyed: boolean;
}

// ─── Simultaneous combat resolver ─────────────────────────────────────────────

/**
 * Resolves combat between two adjacent enemy units simultaneously.
 * Both deal damage at the same time — no first-strike advantage.
 * Indirect-fire units (e.g. artillery) cannot counterattack at melee range.
 */
export function resolveCombatPair(
  idA: string,
  idB: string,
  state: IGameState,
): CombatEvent | null {
  const a = state.units.get(idA);
  const b = state.units.get(idB);
  if (!a || !b) return null;

  const aBp = state.unitBlueprints.get(a.blueprintId);
  const bBp = state.unitBlueprints.get(b.blueprintId);
  if (!aBp || !bBp) return null;

  const bCell  = state.hexMap.get(b.hexId);
  const aCell  = state.hexMap.get(a.hexId);
  const bDef   = TERRAIN_DEFENSE[bCell?.terrain ?? "plains"];
  const aDef   = TERRAIN_DEFENSE[aCell?.terrain ?? "plains"];

  // A hits B
  const rawADmg = damageForTarget(aBp, bBp);
  const aDamage = Math.max(1, Math.round(rawADmg * (1 - bDef)));

  // B hits A (unless indirect_fire trait — indirect units can't melee-counter)
  const bCanCounter = !bBp.specialTraits.includes("indirect_fire");
  const rawBDmg = bCanCounter ? damageForTarget(bBp, aBp) : 0;
  const bDamage = Math.max(0, Math.round(rawBDmg * (1 - aDef)));

  // Apply simultaneously
  a.hp -= bDamage;
  b.hp -= aDamage;

  const aDestroyed = a.hp <= 0;
  const bDestroyed = b.hp <= 0;

  const aHpAfter = Math.max(0, a.hp);
  const bHpAfter = Math.max(0, b.hp);

  if (aDestroyed) state.removeUnit(idA);
  if (bDestroyed) state.removeUnit(idB);

  return {
    aId: idA, bId: idB,
    aName: aBp.name, bName: bBp.name,
    aDamage, bDamage,
    aHpAfter, bHpAfter,
    aDestroyed, bDestroyed,
  };
}
