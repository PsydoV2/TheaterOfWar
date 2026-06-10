import type { TerrainType, Owner } from "../engine/types";

export const HEX_SIZE = 1.2;
export const HEX_HEIGHT = 0.18;
export const HEX_SEGMENTS = 6;
export const HEX_GAP = 0.15;

/** Axial → world XZ (pointy-top hex layout). */
export function hexToWorld(q: number, r: number): { x: number; z: number } {
  return {
    x: HEX_SIZE * Math.sqrt(3) * (q + r * 0.5),
    z: HEX_SIZE * 1.5 * r,
  };
}

export const TERRAIN_CONFIG: Record<
  TerrainType,
  { baseColor: number; elevation: number }
> = {
  plains: { baseColor: 0x6aaa3a, elevation: 0 },
  forest: { baseColor: 0x2d5a1b, elevation: 0 },
  water: { baseColor: 0x1e5f8a, elevation: -0.22 },
  mountain: { baseColor: 0x7a7268, elevation: 0 },
};

export const OWNER_COLORS: Record<Owner, number> = {
  player: 0x4488ee,
  enemy: 0xee3333,
  neutral: 0xaaaaaa,
};
