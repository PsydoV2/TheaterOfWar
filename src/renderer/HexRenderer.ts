import * as THREE from "three";
import type { IGameState, HexCell, Owner, BuildingKey, BuildingLevels } from "../engine/types";
import {
  HEX_SIZE,
  HEX_HEIGHT,
  HEX_SEGMENTS,
  HEX_GAP,
  hexToWorld,
  TERRAIN_CONFIG,
  OWNER_COLORS,
} from "./constants";
import type { ModelLoader } from "./ModelLoader";

// Scale for terrain hex tile GLB: horizontal footprint matches (HEX_SIZE - HEX_GAP) diameter
const TILE_SCALE = (HEX_SIZE - HEX_GAP) * 2;
// Scale for city building model
const CITY_SCALE = HEX_SIZE * 0.55;
// Scale for individual building GLBs placed around the hex edge
const BUILDING_SCALE = HEX_SIZE * 0.42;

const MODEL_HEX: Record<string, string> = {
  plains: "/models/hex_plains.glb",
  forest: "/models/hex_forest.glb",
  mountain: "/models/hex_mountain.glb",
  water: "/models/hex_water.glb",
};

const MODEL_CITY: Record<Owner, string> = {
  player: "/models/building_city_friendly.glb",
  enemy: "/models/building_city_enemy.glb",
  neutral: "/models/building_city_neutral.glb",
};

// ─── Shared read-only geometries (used for procedural fallbacks + overlays) ───

const GEO_HEX_HIT = new THREE.CylinderGeometry(
  HEX_SIZE - HEX_GAP,
  HEX_SIZE - HEX_GAP,
  HEX_HEIGHT,
  HEX_SEGMENTS,
);
const GEO_HEX_VISUAL = new THREE.CylinderGeometry(
  HEX_SIZE - HEX_GAP,
  HEX_SIZE - HEX_GAP,
  HEX_HEIGHT,
  HEX_SEGMENTS,
);
const GEO_PYRAMID = new THREE.ConeGeometry(HEX_SIZE * 0.52, HEX_SIZE * 0.95, 4);
const GEO_TREE = new THREE.ConeGeometry(HEX_SIZE * 0.18, HEX_SIZE * 0.48, 5);
const GEO_CITY = new THREE.BoxGeometry(0.38, 0.38, 0.38);
const GEO_HOVER = new THREE.CylinderGeometry(
  HEX_SIZE - HEX_GAP + 0.06,
  HEX_SIZE - HEX_GAP + 0.06,
  0.04,
  HEX_SEGMENTS,
);

// Rotation to align GLB hex tile flat sides with neighbour directions
const HEX_ROT_Y = Math.PI / 3;

// ─── Building marker definitions ──────────────────────────────────────────────
// Buildings placed at the hex edge (~0.82 world units from center, 6 directions + S).
// Hex inradius = HEX_SIZE * sqrt(3)/2 ≈ 1.04, so 0.82 sits just inside the edge.

interface BuildingMarkerDef {
  model: string | null; // GLB path; null = procedural box fallback
  color: number;        // used only when model is null
  ox: number;           // x offset from hex center
  oz: number;           // z offset
}

const BUILDING_MARKER: Record<BuildingKey, BuildingMarkerDef> = {
  factory:   { model: "/models/building_factory.glb",   color: 0x888888, ox:  0.82, oz:  0.00 },
  barracks:  { model: "/models/building_barracks.glb",  color: 0x556633, ox:  0.41, oz:  0.71 },
  warehouse: { model: "/models/building_warehouse.glb", color: 0xaa8855, ox: -0.41, oz:  0.71 },
  airport:   { model: "/models/building_airport.glb",   color: 0xaaccff, ox: -0.82, oz:  0.00 },
  harbor:    { model: "/models/building_harbor.glb",    color: 0x2255bb, ox: -0.41, oz: -0.71 },
  turret:    { model: "/models/building_turret.glb",    color: 0x334455, ox:  0.41, oz: -0.71 },
  market:    { model: null,                              color: 0xddaa00, ox:  0.00, oz:  0.82 },
};

const BUILDING_KEYS: BuildingKey[] = [
  "factory", "barracks", "warehouse", "airport", "harbor", "turret", "market",
];

const MAT_INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });
const MAT_HOVER = new THREE.MeshBasicMaterial({
  color: 0xffdd44,
  transparent: true,
  opacity: 0.42,
});
const MAT_RANGE = new THREE.MeshBasicMaterial({
  color: 0x22ddcc,
  transparent: true,
  opacity: 0.3,
});
const MAT_RANGE_ENEMY = new THREE.MeshBasicMaterial({
  color: 0xff6622,
  transparent: true,
  opacity: 0.28,
});

// Tree offsets — deterministic
const TREE_OFFSETS = [
  { dx: 0.0, dz: 0.0 },
  { dx: 0.38, dz: 0.3 },
  { dx: -0.3, dz: 0.38 },
];

// ─── HexRenderer ─────────────────────────────────────────────────────────────

interface CityEntry {
  model: THREE.Object3D;
  ring: THREE.Mesh;
  pos: THREE.Vector3; // world position of the city surface center
}

export class HexRenderer {
  private readonly baseMeshes = new Map<string, THREE.Mesh>(); // invisible hit-test meshes
  private readonly meshToHexId = new Map<THREE.Mesh, string>();
  private readonly cities = new Map<string, CityEntry>(); // hexId → city visual
  private readonly buildingMarkers = new Map<string, THREE.Object3D[]>(); // hexId → markers
  private readonly hoverMesh: THREE.Mesh;
  private readonly rangeOverlays: THREE.Mesh[] = [];
  private readonly scene: THREE.Scene;
  private models!: ModelLoader;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.hoverMesh = new THREE.Mesh(GEO_HOVER, MAT_HOVER);
    this.hoverMesh.visible = false;
    this.hoverMesh.rotation.y = HEX_ROT_Y;
    this.hoverMesh.renderOrder = 2;
    scene.add(this.hoverMesh);
  }

  buildGrid(state: IGameState, models: ModelLoader): void {
    this.models = models;
    for (const cell of state.hexMap.values()) {
      this.buildCell(cell, state, models);
    }
    // Show initial building markers for all pre-built cities
    for (const city of state.cities.values()) {
      this.updateCityBuildings(city.hexId, city.buildings);
    }
  }

  // ─── Cell construction ────────────────────────────────────────────────────

  private buildCell(
    cell: HexCell,
    state: IGameState,
    models: ModelLoader,
  ): void {
    const cfg = TERRAIN_CONFIG[cell.terrain];
    const { x, z } = hexToWorld(cell.q, cell.r);
    const y = cfg.elevation;

    // Invisible hit-test mesh (raycasting only)
    const hitMesh = new THREE.Mesh(GEO_HEX_HIT, MAT_INVISIBLE);
    hitMesh.position.set(x, y + HEX_HEIGHT / 2, z);
    hitMesh.rotation.y = HEX_ROT_Y;
    this.scene.add(hitMesh);
    this.baseMeshes.set(cell.id, hitMesh);
    this.meshToHexId.set(hitMesh, cell.id);

    // Visual tile: GLB if available, otherwise procedural
    const modelPath = MODEL_HEX[cell.terrain];
    const glb = models.has(modelPath)
      ? models.clone(modelPath, TILE_SCALE)
      : null;

    if (glb) {
      glb.position.set(x, y, z);
      glb.rotation.y = HEX_ROT_Y;
      this.scene.add(glb);
    } else {
      this.buildProceduralCell(cell, x, y, z);
    }

    // City marker
    if (cell.cityId) {
      const city = state.cities.get(cell.cityId);
      if (city) this.addCityMarker(cell.id, x, y, z, city.owner, models);
    }
  }

  private buildProceduralCell(
    cell: HexCell,
    x: number,
    y: number,
    z: number,
  ): void {
    const cfg = TERRAIN_CONFIG[cell.terrain];
    const mat = new THREE.MeshLambertMaterial({ color: cfg.baseColor });
    const mesh = new THREE.Mesh(GEO_HEX_VISUAL, mat);
    mesh.position.set(x, y + HEX_HEIGHT / 2, z);
    mesh.rotation.y = HEX_ROT_Y;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const surfY = y + HEX_HEIGHT;
    switch (cell.terrain) {
      case "mountain":
        this.addMountain(x, surfY, z);
        break;
      case "forest":
        this.addForest(x, surfY, z);
        break;
    }
  }

  private addMountain(x: number, baseY: number, z: number): void {
    const mat = new THREE.MeshLambertMaterial({ color: 0xa09890 });
    const peak = new THREE.Mesh(GEO_PYRAMID, mat);
    peak.position.set(x, baseY + HEX_SIZE * 0.475, z);
    peak.rotation.y = Math.PI / 4;
    peak.castShadow = true;
    this.scene.add(peak);
  }

  private addForest(x: number, baseY: number, z: number): void {
    const mat = new THREE.MeshLambertMaterial({ color: 0x1e7a2b });
    for (const { dx, dz } of TREE_OFFSETS) {
      const tree = new THREE.Mesh(GEO_TREE, mat);
      tree.position.set(x + dx, baseY + HEX_SIZE * 0.24, z + dz);
      tree.castShadow = true;
      this.scene.add(tree);
    }
  }

  private addCityMarker(
    hId: string,
    x: number,
    y: number,
    z: number,
    owner: Owner,
    models: ModelLoader,
  ): void {
    const surfY = y + HEX_HEIGHT;
    const pos = new THREE.Vector3(x, surfY, z);

    const model = this.spawnCityModel(owner, pos, models);

    // Ownership ring beneath city model (also acts as fallback visibility)
    const ringGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.04, HEX_SEGMENTS);
    const ringMat = new THREE.MeshBasicMaterial({ color: OWNER_COLORS[owner] });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, surfY + 0.01, z);
    ring.rotation.y = HEX_ROT_Y;
    ring.renderOrder = 1;
    this.scene.add(ring);

    this.cities.set(hId, { model, ring, pos });
  }

  private spawnCityModel(
    owner: Owner,
    pos: THREE.Vector3,
    models: ModelLoader,
  ): THREE.Object3D {
    const path = MODEL_CITY[owner];
    const glb = models.has(path) ? models.clone(path, CITY_SCALE) : null;

    if (glb) {
      glb.position.copy(pos);
      this.scene.add(glb);
      return glb;
    }

    // Procedural fallback
    const mat = new THREE.MeshPhongMaterial({
      color: OWNER_COLORS[owner],
      shininess: 70,
    });
    const cube = new THREE.Mesh(GEO_CITY, mat);
    cube.position.set(pos.x, pos.y + 0.19, pos.z);
    cube.castShadow = true;
    this.scene.add(cube);
    return cube;
  }

  /** Swaps the city GLB model and ownership ring color when a city is captured. */
  updateCityMarker(hexId: string, owner: Owner): void {
    const entry = this.cities.get(hexId);
    if (!entry) return;

    // Remove old model, place the new one
    this.scene.remove(entry.model);
    entry.model = this.spawnCityModel(owner, entry.pos, this.models);

    // Update ring color
    (entry.ring.material as THREE.MeshBasicMaterial).color.setHex(
      OWNER_COLORS[owner],
    );
  }

  syncCityOwners(state: IGameState): void {
    for (const hId of this.cities.keys()) {
      const cell = state.hexMap.get(hId);
      if (!cell?.cityId) continue;
      const city = state.cities.get(cell.cityId);
      if (!city) continue;
      this.updateCityMarker(hId, city.owner);
    }
  }

  // ─── Range highlight ─────────────────────────────────────────────────────

  setRangeHighlight(moveIds: string[], attackIds: string[] = []): void {
    this.clearRangeHighlight();
    for (const id of moveIds) this.addRangeOverlay(id, MAT_RANGE);
    for (const id of attackIds) this.addRangeOverlay(id, MAT_RANGE_ENEMY);
  }

  /** Highlight a movement path (brighter overlay on each step hex). */
  private pathOverlays: THREE.Mesh[] = [];
  private static readonly MAT_PATH = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
  });

  setPathHighlight(hexIds: string[]): void {
    this.clearPathHighlight();
    for (const id of hexIds) {
      const base = this.baseMeshes.get(id);
      if (!base) continue;
      const overlay = new THREE.Mesh(GEO_HOVER, HexRenderer.MAT_PATH);
      overlay.position.set(base.position.x, base.position.y + HEX_HEIGHT * 0.58, base.position.z);
      overlay.rotation.y = HEX_ROT_Y;
      overlay.renderOrder = 2;
      this.scene.add(overlay);
      this.pathOverlays.push(overlay);
    }
  }

  clearPathHighlight(): void {
    for (const m of this.pathOverlays) this.scene.remove(m);
    this.pathOverlays.length = 0;
  }

  private addRangeOverlay(id: string, mat: THREE.MeshBasicMaterial): void {
    const base = this.baseMeshes.get(id);
    if (!base) return;
    const overlay = new THREE.Mesh(GEO_HOVER, mat);
    overlay.position.set(
      base.position.x,
      base.position.y + HEX_HEIGHT * 0.55,
      base.position.z,
    );
    overlay.rotation.y = HEX_ROT_Y;
    overlay.renderOrder = 1;
    this.scene.add(overlay);
    this.rangeOverlays.push(overlay);
  }

  clearRangeHighlight(): void {
    for (const m of this.rangeOverlays) this.scene.remove(m);
    this.rangeOverlays.length = 0;
  }

  // ─── Building markers ─────────────────────────────────────────────────────

  /** Creates or replaces building markers (GLB models) for a city hex. */
  updateCityBuildings(hexId: string, buildings: BuildingLevels): void {
    for (const obj of this.buildingMarkers.get(hexId) ?? []) this.scene.remove(obj);

    const entry = this.cities.get(hexId);
    if (!entry) return;
    const surfY = entry.pos.y;
    const wx = entry.pos.x;
    const wz = entry.pos.z;
    const markers: THREE.Object3D[] = [];

    for (const key of BUILDING_KEYS) {
      const level = buildings[`${key}Level` as keyof BuildingLevels] as number;
      if (level === 0) continue;

      const def = BUILDING_MARKER[key];
      const bx = wx + def.ox;
      const bz = wz + def.oz;
      // Rotate building to face the hex center
      const rotY = Math.atan2(-def.ox, -def.oz);

      let placed = false;
      if (def.model && this.models.has(def.model)) {
        const glb = this.models.clone(def.model, BUILDING_SCALE);
        if (glb) {
          glb.position.set(bx, surfY, bz);
          glb.rotation.y = rotY;
          this.scene.add(glb);
          markers.push(glb);
          placed = true;
        }
      }

      // Procedural fallback (also used for market which has no GLB)
      if (!placed) {
        const h = 0.10 + level * 0.06;
        const mat = new THREE.MeshPhongMaterial({ color: def.color, shininess: 40 });
        const geo = new THREE.BoxGeometry(0.14, h, 0.14);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.position.set(bx, surfY + h / 2, bz);
        this.scene.add(mesh);
        markers.push(mesh);
      }
    }

    this.buildingMarkers.set(hexId, markers);
  }

  // ─── Raycasting interface ─────────────────────────────────────────────────

  getInteractiveMeshes(): THREE.Mesh[] {
    return [...this.baseMeshes.values()];
  }

  hexIdForMesh(mesh: THREE.Mesh): string | undefined {
    return this.meshToHexId.get(mesh);
  }

  // ─── Hover ────────────────────────────────────────────────────────────────

  setHovered(hexId: string | null): void {
    if (!hexId) {
      this.hoverMesh.visible = false;
      return;
    }
    const base = this.baseMeshes.get(hexId);
    if (!base) return;
    const { x, y, z } = base.position;
    this.hoverMesh.position.set(x, y + HEX_HEIGHT * 0.55, z);
    this.hoverMesh.visible = true;
  }
}
