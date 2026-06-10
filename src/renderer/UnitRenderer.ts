import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
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

// When a unit sits on a city hex, shift it to the hex edge so it doesn't clip
// into the city building model. The offset is in world XZ space.
const CITY_UNIT_OFFSET_X = HEX_SIZE * 0.42;
const CITY_UNIT_OFFSET_Z = HEX_SIZE * 0.30;

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

interface ShakeAnim {
  instanceId: string;
  origin: THREE.Vector3;
  elapsed: number;
  duration: number;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ─── HP label helpers ─────────────────────────────────────────────────────────

function hpColor(pct: number): string {
  if (pct > 0.6) return "#4ade80"; // green
  if (pct > 0.3) return "#facc15"; // yellow
  return "#f87171";                // red
}

function makeHpLabel(hp: number, maxHp: number): CSS2DObject {
  const div = document.createElement("div");
  div.style.cssText = [
    "font: bold 11px/1 monospace",
    "padding: 1px 4px",
    "border-radius: 3px",
    "background: rgba(0,0,0,0.55)",
    "pointer-events: none",
    "user-select: none",
    "white-space: nowrap",
  ].join(";");
  div.style.color = hpColor(hp / maxHp);
  div.textContent = String(hp);
  div.dataset["maxHp"] = String(maxHp);

  const obj = new CSS2DObject(div);
  obj.name = "hp-label";
  // Position above the unit mesh
  obj.position.set(0, 0.75, 0);
  return obj;
}

// ─── UnitRenderer ─────────────────────────────────────────────────────────────

export class UnitRenderer {
  private readonly unitGroups = new Map<string, THREE.Group>();
  private readonly selectionRing: THREE.Mesh;
  private readonly animations: UnitAnim[] = [];
  private readonly shakes: ShakeAnim[] = [];
  private readonly scene: THREE.Scene;
  private models: ModelLoader | null = null;
  private selectionPulseTime = 0;

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

    // Remove stale groups (and clean up CSS2DObject DOM elements explicitly)
    for (const [id, group] of this.unitGroups) {
      if (!state.units.has(id)) {
        group.traverse((child) => {
          if (child.name === "hp-label") {
            (child as CSS2DObject).element.remove();
          }
        });
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

    // HP label (CSS2D element, always faces camera)
    const bp = state.unitBlueprints.get(unit.blueprintId);
    const maxHp = bp?.maxHp ?? unit.hp;
    group.add(makeHpLabel(unit.hp, maxHp));

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
      if (child.name === "hp-label") {
        const obj = child as CSS2DObject;
        const div = obj.element as HTMLDivElement;
        const maxHp = parseInt(div.dataset["maxHp"] ?? "100", 10);
        div.textContent = unit.stackSize > 1
          ? `${unit.hp} ×${unit.stackSize}`
          : String(unit.hp);
        div.style.color = hpColor(unit.hp / maxHp);
        div.style.opacity = acted ? "0.5" : "1";
        return;
      }

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

  /**
   * Play a charge-and-retreat animation: attacker lunges 60% toward the defender
   * then snaps back. Call this BEFORE resolving combat so the animation overlaps
   * with the combat calculation.
   */
  playAttackAnimation(attackerId: string, defenderId: string): void {
    const atkGroup = this.unitGroups.get(attackerId);
    const defGroup = this.unitGroups.get(defenderId);
    if (!atkGroup || !defGroup) return;

    const origin = atkGroup.position.clone();
    const chargePos = origin.clone().lerp(defGroup.position, 0.55);

    // Lunge toward defender
    this.animations.push({ instanceId: attackerId, from: origin, to: chargePos, elapsed: 0, duration: 0.14 });

    // Retreat back after lunge (scheduled via setTimeout to fire after charge)
    const retreatOrigin = origin.clone();
    setTimeout(() => {
      const g = this.unitGroups.get(attackerId);
      if (!g) return;
      this.animations.push({ instanceId: attackerId, from: g.position.clone(), to: retreatOrigin, elapsed: 0, duration: 0.18 });
    }, 140);
  }

  /** Play a short hit-shake on a unit (called after combat). */
  shakeUnit(instanceId: string): void {
    const group = this.unitGroups.get(instanceId);
    if (!group) return;
    // Cancel any existing shake for this unit before starting a new one
    const idx = this.shakes.findIndex((s) => s.instanceId === instanceId);
    if (idx !== -1) this.shakes.splice(idx, 1);
    this.shakes.push({
      instanceId,
      origin: group.position.clone(),
      elapsed: 0,
      duration: 0.3,
    });
  }

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
    // Pulse selection ring opacity
    if (this.selectionRing.visible) {
      this.selectionPulseTime += dt * 2.8;
      (this.selectionRing.material as THREE.MeshBasicMaterial).opacity =
        0.50 + 0.35 * (0.5 + 0.5 * Math.sin(this.selectionPulseTime * Math.PI * 2));
    } else {
      this.selectionPulseTime = 0;
    }

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

    // Hit-shake: rapid lateral oscillation that decays
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i]!;
      s.elapsed += dt;
      const t = Math.min(1, s.elapsed / s.duration);
      const decay = 1 - t;
      const offset = Math.sin(t * Math.PI * 8) * 0.12 * decay;

      const group = this.unitGroups.get(s.instanceId);
      if (group) {
        group.position.set(
          s.origin.x + offset,
          s.origin.y,
          s.origin.z + offset * 0.5,
        );
      }

      if (t >= 1) {
        // Restore exact origin position
        const g = this.unitGroups.get(s.instanceId);
        if (g) g.position.copy(s.origin);
        this.shakes.splice(i, 1);
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private worldPosForHex(hId: string, state: IGameState): THREE.Vector3 {
    const { q, r } = parseHexId(hId);
    const { x, z }  = hexToWorld(q, r);
    const cell       = state.hexMap.get(hId);
    const elev       = cell ? TERRAIN_CONFIG[cell.terrain].elevation : 0;

    // Shift unit to hex edge when sharing the tile with a city building
    const offsetX = cell?.cityId ? CITY_UNIT_OFFSET_X : 0;
    const offsetZ = cell?.cityId ? CITY_UNIT_OFFSET_Z : 0;

    return new THREE.Vector3(x + offsetX, elev + HEX_HEIGHT + 0.14, z + offsetZ);
  }

  private snapToHex(instanceId: string, hId: string, state: IGameState): void {
    const group = this.unitGroups.get(instanceId);
    if (!group) return;
    group.position.copy(this.worldPosForHex(hId, state));
  }

  applyFog(visibleHexIds: Set<string>, state: IGameState): void {
    for (const [id, group] of this.unitGroups) {
      const unit = state.units.get(id);
      if (!unit || unit.owner === "player") {
        group.visible = true;
        continue;
      }
      group.visible = visibleHexIds.has(unit.hexId);
    }
  }

  getUnitMeshes(): THREE.Object3D[] {
    return [...this.unitGroups.values()];
  }
}
