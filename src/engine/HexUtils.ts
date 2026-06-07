// Axial coordinate hex math. See: https://www.redblobgames.com/grids/hexagons/

export interface AxialCoord {
  q: number;
  r: number;
}

interface CubeCoord {
  x: number;
  y: number;
  z: number;
}

// Flat-top hex neighbors in axial coordinates (E, NE, NW, W, SW, SE)
const AXIAL_DIRECTIONS: Readonly<AxialCoord[]> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexId(q: number, r: number): string {
  return `${q}_${r}`;
}

export function parseHexId(id: string): AxialCoord {
  const parts = id.split("_");
  return { q: Number(parts[0]), r: Number(parts[1]) };
}

function axialToCube(q: number, r: number): CubeCoord {
  return { x: q, y: -q - r, z: r };
}

function cubeDistance(a: CubeCoord, b: CubeCoord): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.z - b.z)
  );
}

export function hexDistance(a: AxialCoord, b: AxialCoord): number {
  return cubeDistance(axialToCube(a.q, a.r), axialToCube(b.q, b.r));
}

export function getNeighbors(q: number, r: number): AxialCoord[] {
  return AXIAL_DIRECTIONS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

/** Returns all hexes within [1, range] distance from center (center excluded). */
export function getHexesInRange(
  center: AxialCoord,
  range: number
): AxialCoord[] {
  const results: AxialCoord[] = [];
  for (let dq = -range; dq <= range; dq++) {
    const rMin = Math.max(-range, -dq - range);
    const rMax = Math.min(range, -dq + range);
    for (let dr = rMin; dr <= rMax; dr++) {
      if (dq !== 0 || dr !== 0) {
        results.push({ q: center.q + dq, r: center.r + dr });
      }
    }
  }
  return results;
}

/** Returns all hex IDs along the shortest path from a to b (a* lite — straight-line cube lerp). */
export function hexLineDraw(a: AxialCoord, b: AxialCoord): AxialCoord[] {
  const dist = hexDistance(a, b);
  if (dist === 0) return [a];
  const results: AxialCoord[] = [];
  for (let i = 0; i <= dist; i++) {
    const t = i / dist;
    const ca = axialToCube(a.q, a.r);
    const cb = axialToCube(b.q, b.r);
    const cx = ca.x + (cb.x - ca.x) * t;
    const cy = ca.y + (cb.y - ca.y) * t;
    const cz = ca.z + (cb.z - ca.z) * t;
    results.push(cubeRound(cx, cy, cz));
  }
  return results;
}

function cubeRound(x: number, y: number, z: number): AxialCoord {
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { q: rx, r: rz };
}
