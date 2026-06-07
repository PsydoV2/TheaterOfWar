import * as THREE from "three";
import type { IGameState, HexCell, Owner } from "../engine/types";
import {
  HEX_SIZE, HEX_HEIGHT, HEX_SEGMENTS, HEX_GAP,
  hexToWorld, TERRAIN_CONFIG, OWNER_COLORS,
} from "./constants";
import type { ModelLoader } from "./ModelLoader";

// Scale for terrain hex tile GLB: horizontal footprint matches (HEX_SIZE - HEX_GAP) diameter
const TILE_SCALE  = (HEX_SIZE - HEX_GAP) * 2;
// Scale for city building model
const CITY_SCALE  = HEX_SIZE * 0.55;

const MODEL_HEX: Record<string, string> = {
  plains:   "/models/hex_plains.glb",
  forest:   "/models/hex_forest.glb",
  mountain: "/models/hex_mountain.glb",
  water:    "/models/hex_water.glb",
};

// ─── Shared read-only geometries (used for procedural fallbacks + overlays) ───

const GEO_HEX_HIT = new THREE.CylinderGeometry(
  HEX_SIZE - HEX_GAP, HEX_SIZE - HEX_GAP, HEX_HEIGHT, HEX_SEGMENTS
);
const GEO_HEX_VISUAL = new THREE.CylinderGeometry(
  HEX_SIZE - HEX_GAP, HEX_SIZE - HEX_GAP, HEX_HEIGHT, HEX_SEGMENTS
);
const GEO_PYRAMID = new THREE.ConeGeometry(HEX_SIZE * 0.52, HEX_SIZE * 0.95, 4);
const GEO_TREE    = new THREE.ConeGeometry(HEX_SIZE * 0.18, HEX_SIZE * 0.48, 5);
const GEO_CITY    = new THREE.BoxGeometry(0.38, 0.38, 0.38);
const GEO_HOVER   = new THREE.CylinderGeometry(
  HEX_SIZE - HEX_GAP + 0.06,
  HEX_SIZE - HEX_GAP + 0.06,
  0.04, HEX_SEGMENTS
);

// Pointy-top rotation: vertices point along ±Z
const HEX_ROT_Y = Math.PI / 6;

const MAT_INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });
const MAT_HOVER     = new THREE.MeshBasicMaterial({ color: 0xffdd44, transparent: true, opacity: 0.42 });
const MAT_RANGE     = new THREE.MeshBasicMaterial({ color: 0x22ddcc, transparent: true, opacity: 0.30 });
const MAT_RANGE_ENEMY = new THREE.MeshBasicMaterial({ color: 0xff6622, transparent: true, opacity: 0.28 });

// Tree offsets — deterministic
const TREE_OFFSETS = [
  { dx:  0.00, dz:  0.00 },
  { dx:  0.38, dz:  0.30 },
  { dx: -0.30, dz:  0.38 },
];

// ─── HexRenderer ─────────────────────────────────────────────────────────────

export class HexRenderer {
  private readonly baseMeshes    = new Map<string, THREE.Mesh>();     // invisible hit-test meshes
  private readonly meshToHexId   = new Map<THREE.Mesh, string>();
  private readonly cityMarkers   = new Map<string, THREE.Object3D>(); // visual only
  private readonly cityRings     = new Map<string, THREE.Mesh>();     // colored ownership rings
  private readonly hoverMesh: THREE.Mesh;
  private readonly rangeOverlays: THREE.Mesh[] = [];
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.hoverMesh = new THREE.Mesh(GEO_HOVER, MAT_HOVER);
    this.hoverMesh.visible = false;
    this.hoverMesh.rotation.y = HEX_ROT_Y;
    this.hoverMesh.renderOrder = 2;
    scene.add(this.hoverMesh);
  }

  buildGrid(state: IGameState, models: ModelLoader): void {
    for (const cell of state.hexMap.values()) {
      this.buildCell(cell, state, models);
    }
  }

  // ─── Cell construction ────────────────────────────────────────────────────

  private buildCell(cell: HexCell, state: IGameState, models: ModelLoader): void {
    const cfg       = TERRAIN_CONFIG[cell.terrain];
    const { x, z }  = hexToWorld(cell.q, cell.r);
    const y         = cfg.elevation;

    // Invisible hit-test mesh (raycasting only)
    const hitMesh = new THREE.Mesh(GEO_HEX_HIT, MAT_INVISIBLE);
    hitMesh.position.set(x, y + HEX_HEIGHT / 2, z);
    hitMesh.rotation.y = HEX_ROT_Y;
    this.scene.add(hitMesh);
    this.baseMeshes.set(cell.id, hitMesh);
    this.meshToHexId.set(hitMesh, cell.id);

    // Visual tile: GLB if available, otherwise procedural
    const modelPath = MODEL_HEX[cell.terrain];
    const glb = models.has(modelPath) ? models.clone(modelPath, TILE_SCALE) : null;

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

  private buildProceduralCell(cell: HexCell, x: number, y: number, z: number): void {
    const cfg = TERRAIN_CONFIG[cell.terrain];
    const mat  = new THREE.MeshLambertMaterial({ color: cfg.baseColor });
    const mesh = new THREE.Mesh(GEO_HEX_VISUAL, mat);
    mesh.position.set(x, y + HEX_HEIGHT / 2, z);
    mesh.rotation.y = HEX_ROT_Y;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const surfY = y + HEX_HEIGHT;
    switch (cell.terrain) {
      case "mountain": this.addMountain(x, surfY, z); break;
      case "forest":   this.addForest(x, surfY, z);   break;
    }
  }

  private addMountain(x: number, baseY: number, z: number): void {
    const mat  = new THREE.MeshLambertMaterial({ color: 0xa09890 });
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

  private addCityMarker(hId: string, x: number, y: number, z: number, owner: Owner, models: ModelLoader): void {
    const surfY = y + HEX_HEIGHT;

    const glb = models.has("/models/building_city.glb")
      ? models.clone("/models/building_city.glb", CITY_SCALE)
      : null;

    if (glb) {
      glb.position.set(x, surfY, z);
      this.scene.add(glb);
      this.cityMarkers.set(hId, glb);
    } else {
      const mat  = new THREE.MeshPhongMaterial({ color: OWNER_COLORS[owner], shininess: 70 });
      const cube = new THREE.Mesh(GEO_CITY, mat);
      cube.position.set(x, surfY + 0.19, z);
      cube.castShadow = true;
      this.scene.add(cube);
      this.cityMarkers.set(hId, cube);
    }

    // Ownership ring beneath city marker
    const ringGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.04, HEX_SEGMENTS);
    const ringMat = new THREE.MeshBasicMaterial({ color: OWNER_COLORS[owner] });
    const ring    = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, surfY + 0.01, z);
    ring.rotation.y = HEX_ROT_Y;
    ring.renderOrder = 1;
    this.scene.add(ring);
    this.cityRings.set(hId, ring);
  }

  /** Updates the ownership ring color when a city is captured. */
  updateCityMarker(hexId: string, owner: Owner): void {
    const ring = this.cityRings.get(hexId);
    if (ring) (ring.material as THREE.MeshBasicMaterial).color.setHex(OWNER_COLORS[owner]);
  }

  syncCityOwners(state: IGameState): void {
    for (const [hId, ring] of this.cityRings) {
      const cell = state.hexMap.get(hId);
      if (!cell?.cityId) continue;
      const city = state.cities.get(cell.cityId);
      if (!city) continue;
      (ring.material as THREE.MeshBasicMaterial).color.setHex(OWNER_COLORS[city.owner]);
    }
  }

  // ─── Range highlight ─────────────────────────────────────────────────────

  setRangeHighlight(moveIds: string[], attackIds: string[] = []): void {
    this.clearRangeHighlight();
    for (const id of moveIds)   this.addRangeOverlay(id, MAT_RANGE);
    for (const id of attackIds) this.addRangeOverlay(id, MAT_RANGE_ENEMY);
  }

  private addRangeOverlay(id: string, mat: THREE.MeshBasicMaterial): void {
    const base = this.baseMeshes.get(id);
    if (!base) return;
    const overlay = new THREE.Mesh(GEO_HOVER, mat);
    overlay.position.set(base.position.x, base.position.y + HEX_HEIGHT * 0.55, base.position.z);
    overlay.rotation.y = HEX_ROT_Y;
    overlay.renderOrder = 1;
    this.scene.add(overlay);
    this.rangeOverlays.push(overlay);
  }

  clearRangeHighlight(): void {
    for (const m of this.rangeOverlays) this.scene.remove(m);
    this.rangeOverlays.length = 0;
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
