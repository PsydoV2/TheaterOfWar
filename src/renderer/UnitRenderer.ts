import * as THREE from "three";
import type { IGameState, MilitaryUnit } from "../engine/types";
import { hexToWorld, HEX_HEIGHT, TERRAIN_CONFIG, OWNER_COLORS, HEX_SIZE, HEX_SEGMENTS } from "./constants";
import { parseHexId } from "../engine/HexUtils";
import type { ModelLoader } from "./ModelLoader";

// ─── Unit model paths ─────────────────────────────────────────────────────────

const UNIT_MODEL: Record<string, string> = {
  infantry_basic:  "/models/unit_infantry.glb",
  infantry_elite:  "/models/unit_infantry.glb",
  tank_medium:     "/models/unit_tank.glb",
  tank_heavy:      "/models/unit_tank.glb",
  artillery:       "/models/unit_artillery.glb",
  apc:             "/models/unit_tank.glb",
  fighter_jet:     "/models/unit_fighter.glb",
  bomber:          "/models/unit_bomber.glb",
  destroyer:       "/models/unit_warship.glb",
  submarine:       "/models/unit_submarine.glb",
  ballistic_nuke:  "/models/unit_nuke.glb",
};

const UNIT_SCALE = HEX_SIZE * 0.72;

// ─── Fallback geometries ──────────────────────────────────────────────────────

const GEO_LAND      = new THREE.CylinderGeometry(0.42, 0.42, 0.28, 6);
const GEO_AIR       = new THREE.BoxGeometry(0.38, 0.38, 0.38);
const GEO_WATER     = new THREE.CylinderGeometry(0.48, 0.34, 0.22, 6);
const GEO_BALLISTIC = new THREE.ConeGeometry(0.15, 0.55, 4);

const GEO_SELECTION_RING = new THREE.RingGeometry(0.5, 0.62, 6);
const GEO_OWNER_RING     = new THREE.CylinderGeometry(0.46, 0.46, 0.04, HEX_SEGMENTS);

const MAT_SELECTION = new THREE.MeshBasicMaterial({
  color: 0xffee00,
  transparent: true,
  opacity: 0.85,
  side: THREE.DoubleSide,
});

// ─── Animation ────────────────────────────────────────────────────────────────

interface UnitAnim {
  instanceId: string;
  from: THREE.Vector3;
  to: THREE.Vector3;
  elapsed: number;
  duration: number;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ─── UnitRenderer ─────────────────────────────────────────────────────────────

export class UnitRenderer {
  private readonly unitGroups = new Map<string, THREE.Group>();
  private readonly selectionRing: THREE.Mesh;
  private readonly animations: UnitAnim[] = [];
  private readonly scene: THREE.Scene;
  private models: ModelLoader | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.selectionRing = new THREE.Mesh(GEO_SELECTION_RING, MAT_SELECTION);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.selectionRing.renderOrder = 3;
    scene.add(this.selectionRing);
  }

  // ─── State sync ──────────────────────────────────────────────────────────

  syncWithState(state: IGameState, models?: ModelLoader): void {
    if (models) this.models = models;

    // Remove stale groups
    for (const [id, group] of this.unitGroups) {
      if (!state.units.has(id)) {
        this.scene.remove(group);
        this.unitGroups.delete(id);
      }
    }

    // Add new / update existing
    for (const unit of state.units.values()) {
      if (!this.unitGroups.has(unit.instanceId)) {
        this.createGroup(unit, state);
      } else {
        this.snapToHex(unit.instanceId, unit.hexId, state);
      }
      this.updateAppearance(unit);
    }
  }

  private createGroup(unit: MilitaryUnit, state: IGameState): void {
    const group = new THREE.Group();

    // Ownership ring
    const ringMat  = new THREE.MeshBasicMaterial({ color: OWNER_COLORS[unit.owner] });
    const ring      = new THREE.Mesh(GEO_OWNER_RING, ringMat);
    ring.position.y = 0.02;
    ring.renderOrder = 1;
    group.add(ring);

    // Unit model (GLB or procedural fallback)
    const modelPath = UNIT_MODEL[unit.blueprintId];
    const glbObj    = this.models && modelPath ? this.models.clone(modelPath, UNIT_SCALE) : null;

    if (glbObj) {
      glbObj.position.y = 0.06;
      group.add(glbObj);
    } else {
      group.add(this.makeProceduralMesh(unit, state));
    }

    const pos = this.worldPosForHex(unit.hexId, state);
    group.position.copy(pos);
    this.scene.add(group);
    this.unitGroups.set(unit.instanceId, group);
  }

  private makeProceduralMesh(unit: MilitaryUnit, state: IGameState): THREE.Mesh {
    const bp = state.unitBlueprints.get(unit.blueprintId);
    const movType = bp?.movement.type ?? "land";
    const color   = OWNER_COLORS[unit.owner];
    const mat     = new THREE.MeshPhongMaterial({ color, shininess: 80, emissive: color, emissiveIntensity: 0.1 });

    let geo: THREE.BufferGeometry;
    switch (movType) {
      case "water":     geo = GEO_WATER;     break;
      case "air":       geo = GEO_AIR;       break;
      case "ballistic": geo = GEO_BALLISTIC; break;
      default:          geo = GEO_LAND;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    if (movType === "air") mesh.rotation.y = Math.PI / 4;
    return mesh;
  }

  private updateAppearance(unit: MilitaryUnit): void {
    const group = this.unitGroups.get(unit.instanceId);
    if (!group) return;
    const acted = unit.hasMoved || unit.hasAttacked;
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mat = (child as THREE.Mesh).material as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial;
        if ("opacity" in mat) {
          mat.opacity     = acted ? 0.55 : 1.0;
          mat.transparent = acted;
        }
      }
    });
  }

  // ─── Selection ────────────────────────────────────────────────────────────

  setSelected(instanceId: string | null): void {
    if (!instanceId) {
      this.selectionRing.visible = false;
      return;
    }
    const group = this.unitGroups.get(instanceId);
    if (!group) return;
    this.selectionRing.position.set(group.position.x, group.position.y - 0.08, group.position.z);
    this.selectionRing.visible = true;
  }

  private updateSelectionRingPosition(instanceId: string): void {
    if (!this.selectionRing.visible) return;
    const group = this.unitGroups.get(instanceId);
    if (!group) return;
    this.selectionRing.position.set(group.position.x, group.position.y - 0.08, group.position.z);
  }

  // ─── Animation ───────────────────────────────────────────────────────────

  animateTo(instanceId: string, targetHexId: string, state: IGameState): void {
    const group = this.unitGroups.get(instanceId);
    if (!group) return;

    this.animations.push({
      instanceId,
      from:     group.position.clone(),
      to:       this.worldPosForHex(targetHexId, state),
      elapsed:  0,
      duration: 0.4,
    });
  }

  update(dt: number): void {
    for (let i = this.animations.length - 1; i >= 0; i--) {
      const anim = this.animations[i]!;
      anim.elapsed += dt;
      const t = Math.min(1, anim.elapsed / anim.duration);

      const group = this.unitGroups.get(anim.instanceId);
      if (group) {
        group.position.lerpVectors(anim.from, anim.to, easeInOut(t));
        this.updateSelectionRingPosition(anim.instanceId);
      }

      if (t >= 1) this.animations.splice(i, 1);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private worldPosForHex(hId: string, state: IGameState): THREE.Vector3 {
    const { q, r } = parseHexId(hId);
    const { x, z }  = hexToWorld(q, r);
    const cell       = state.hexMap.get(hId);
    const elev       = cell ? TERRAIN_CONFIG[cell.terrain].elevation : 0;
    return new THREE.Vector3(x, elev + HEX_HEIGHT + 0.14, z);
  }

  private snapToHex(instanceId: string, hId: string, state: IGameState): void {
    const group = this.unitGroups.get(instanceId);
    if (!group) return;
    group.position.copy(this.worldPosForHex(hId, state));
  }

  getUnitMeshes(): THREE.Object3D[] {
    return [...this.unitGroups.values()];
  }
}
