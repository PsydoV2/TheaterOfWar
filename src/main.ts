import "./style.css";
import { GameState } from "./engine/GameState";
import { TurnResolver } from "./engine/TurnResolver";
import type { Owner } from "./engine/types";
import { getReachable, getAttackableTargets, findPath } from "./engine/Pathfinder";
import { hexId, parseHexId, getHexesInRange } from "./engine/HexUtils";
import { resolveCombatPair, previewCombat } from "./engine/CombatResolver";
import type { CombatEvent } from "./engine/CombatResolver";
import { SceneManager } from "./renderer/SceneManager";
import { HexRenderer } from "./renderer/HexRenderer";
import { UnitRenderer } from "./renderer/UnitRenderer";
import { InputManager } from "./renderer/InputManager";
import { ModelLoader } from "./renderer/ModelLoader";
import { hexToWorld } from "./renderer/constants";
import { CityPanel } from "./ui/CityPanel";
import { el } from "./ui/dom";

// ─── Model preload ────────────────────────────────────────────────────────────

const MODEL_PATHS = [
  "/models/hex_plains.glb",
  "/models/hex_forest.glb",
  "/models/hex_mountain.glb",
  "/models/hex_water.glb",
  "/models/building_city_friendly.glb",
  "/models/building_city_enemy.glb",
  "/models/building_city_neutral.glb",
  "/models/building_factory.glb",
  "/models/building_barracks.glb",
  "/models/building_warehouse.glb",
  "/models/building_airport.glb",
  "/models/building_harbor.glb",
  "/models/building_turret.glb",
  "/models/unit_infantry.glb",
  "/models/unit_tank.glb",
  "/models/unit_artillery.glb",
  "/models/unit_fighter.glb",
  "/models/unit_bomber.glb",
  "/models/unit_warship.glb",
  "/models/unit_submarine.glb",
  "/models/unit_nuke.glb",
];

void (async () => {

// Loading screen
const loadingScreen = el("div",
  "fixed inset-0 z-[500] flex flex-col items-center justify-center bg-gray-950 text-gray-300"
);
loadingScreen.appendChild(el("div", "text-2xl font-black tracking-widest text-amber-400 uppercase mb-4", "Theater of War"));
loadingScreen.appendChild(el("div", "text-sm font-mono text-gray-500 animate-pulse", "Loading assets…"));
document.body.appendChild(loadingScreen);

const modelLoader = new ModelLoader();
await modelLoader.preload(MODEL_PATHS);
loadingScreen.remove();

// ─── Seed (URL param ?seed=N, or random) ─────────────────────────────────────

const urlSeed = new URLSearchParams(location.search).get("seed");
const seed = urlSeed !== null ? parseInt(urlSeed, 10) : Math.floor(Math.random() * 1_000_000);
if (!urlSeed) {
  const u = new URL(location.href);
  u.searchParams.set("seed", String(seed));
  history.replaceState(null, "", u);
}

// ─── Game State ───────────────────────────────────────────────────────────────

const state    = new GameState(seed);
const resolver = new TurnResolver(state);

// ─── Stats ────────────────────────────────────────────────────────────────────

const stats = { playerKills: 0, playerLosses: 0, citiesCaptured: 0 };

// ─── Canvas ───────────────────────────────────────────────────────────────────

const canvas = document.createElement("canvas");
document.body.appendChild(canvas);

// ─── Renderer ─────────────────────────────────────────────────────────────────

const sceneManager = new SceneManager(canvas);
const hexRenderer  = new HexRenderer(sceneManager.scene);
const unitRenderer = new UnitRenderer(sceneManager.scene);

hexRenderer.buildGrid(state, modelLoader);
unitRenderer.syncWithState(state, modelLoader);

// ─── City Panel ───────────────────────────────────────────────────────────────

const cityPanel = new CityPanel(
  state,
  (cityId) => {
    updateResources();
    const city = state.getCity(cityId);
    if (city) hexRenderer.updateCityBuildings(city.hexId, city.buildings);
  },
  (msg) => showToast(msg, "error"),
);

// ─── Selection State ──────────────────────────────────────────────────────────

let selectedUnitId:      string | null = null;
let currentReachable:    string[]      = [];
let currentAttackable:   string[]      = [];
let pendingAttackTarget: string | null = null;
let currentHoveredHex:   string | null = null;

// ─── Fog of War ───────────────────────────────────────────────────────────────

const UNIT_VISION = 3;
const CITY_VISION = 2;

function computeVisibleHexes(): Set<string> {
  const visible = new Set<string>();
  for (const unit of state.getUnitsBy("player")) {
    const coord = parseHexId(unit.hexId);
    visible.add(unit.hexId);
    for (const n of getHexesInRange(coord, UNIT_VISION)) {
      const id = hexId(n.q, n.r);
      if (state.getHexById(id)) visible.add(id);
    }
  }
  for (const city of state.getCitiesBy("player")) {
    const coord = parseHexId(city.hexId);
    visible.add(city.hexId);
    for (const n of getHexesInRange(coord, CITY_VISION)) {
      const id = hexId(n.q, n.r);
      if (state.getHexById(id)) visible.add(id);
    }
  }
  return visible;
}

function updateFog(): void {
  const visible = computeVisibleHexes();
  hexRenderer.applyFog(visible);
  unitRenderer.applyFog(visible, state);
  updateMinimap();
}

function selectUnit(instanceId: string): void {
  const unit = state.getUnit(instanceId);
  if (!unit || unit.owner !== "player") return;
  if (unit.movementLeft === 0 && unit.hasAttacked) return;

  const bp = state.getBlueprint(unit.blueprintId);
  if (!bp) return;

  const reachable  = unit.movementLeft > 0
    ? getReachable(unit.hexId, unit.movementLeft, bp.movement.type, state)
    : [];
  const attackable = unit.hasAttacked ? [] : getAttackableTargets(instanceId, state);

  if (reachable.length === 0 && attackable.length === 0) { deselect(); return; }

  pendingAttackTarget = null;
  selectedUnitId    = instanceId;
  currentReachable  = reachable;
  currentAttackable = attackable;
  hexRenderer.setRangeHighlight(currentReachable, currentAttackable);
  unitRenderer.setSelected(instanceId);
  updateUnitHud(currentHoveredHex);
  updateHoverPanel(null);
}

function deselect(): void {
  selectedUnitId      = null;
  currentReachable    = [];
  currentAttackable   = [];
  pendingAttackTarget = null;
  hexRenderer.clearRangeHighlight();
  hexRenderer.clearPathHighlight();
  unitRenderer.setSelected(null);
  updateUnitHud(null);
  updateHoverPanel(currentHoveredHex);
}

// ─── Combat ───────────────────────────────────────────────────────────────────

function performAttack(attackerId: string, defenderId: string): void {
  const attacker = state.getUnit(attackerId);
  if (!attacker || attacker.hasAttacked) return;

  unitRenderer.playAttackAnimation(attackerId, defenderId);

  const evt = resolveCombatPair(attackerId, defenderId, state);
  if (!evt) return;

  const attackerSurvived = !evt.aDestroyed;
  if (attackerSurvived) state.getUnit(attackerId)!.hasAttacked = true;

  recordCombatEvent(evt);
  unitRenderer.syncWithState(state);

  if (!evt.aDestroyed && evt.aDamage > 0) unitRenderer.shakeUnit(attackerId);
  if (!evt.bDestroyed && evt.bDamage > 0) unitRenderer.shakeUnit(defenderId);

  updateMinimap();
  updateIdleUnits();

  if (attackerSurvived) selectUnit(attackerId);
  else deselect();
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message: string, type: "error" | "success" | "info" = "info"): void {
  const colorMap = {
    error:   "bg-red-950/90 border-red-700 text-red-300",
    success: "bg-green-950/90 border-green-700 text-green-300",
    info:    "bg-gray-900/90 border-gray-600 text-gray-300",
  };
  const toast = document.createElement("div");
  toast.className =
    `fixed top-20 left-1/2 -translate-x-1/2 z-[450] px-4 py-2 rounded border ` +
    `font-mono text-xs pointer-events-none shadow-lg ${colorMap[type]}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = "opacity 0.3s";
    toast.style.opacity = "0";
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, 2800);
}

// ─── Combat event (stats + toasts) ───────────────────────────────────────────

function recordCombatEvent(evt: CombatEvent): void {
  if (evt.bDestroyed) { stats.playerKills++;  showToast(`${evt.bName} destroyed!`, "success"); }
  if (evt.aDestroyed) { stats.playerLosses++; showToast(`${evt.aName} lost!`, "error"); }
}

// ─── Minimap ──────────────────────────────────────────────────────────────────

const MM_W = 160, MM_H = 130;
const MM_CX = 80, MM_CY = 65, MM_SCALE = 14;

const minimapCanvas = document.createElement("canvas");
minimapCanvas.width  = MM_W;
minimapCanvas.height = MM_H;
minimapCanvas.style.cssText =
  `position:fixed;top:58px;right:4px;z-index:40;` +
  `width:${MM_W}px;height:${MM_H}px;` +
  `border:1px solid #374151;border-radius:4px;` +
  `opacity:0.9;cursor:crosshair;`;
document.body.appendChild(minimapCanvas);

minimapCanvas.addEventListener("click", (e: MouseEvent) => {
  const rect = minimapCanvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (MM_W / rect.width);
  const py = (e.clientY - rect.top)  * (MM_H / rect.height);
  const r_approx = (py - MM_CY) / (0.866 * MM_SCALE);
  const q_approx = (px - MM_CX) / MM_SCALE - r_approx * 0.5;
  const { x, z } = hexToWorld(q_approx, r_approx);
  sceneManager.controls.target.set(x, 0, z);
  sceneManager.controls.update();
});

function updateMinimap(): void {
  const ctx = minimapCanvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, MM_W, MM_H);
  ctx.fillStyle = "rgba(5,8,15,0.85)";
  ctx.fillRect(0, 0, MM_W, MM_H);

  const terrainColor: Record<string, string> = {
    plains:   "#2a4020",
    forest:   "#1a2e18",
    mountain: "#3a3030",
    water:    "#152540",
  };

  for (const cell of state.hexMap.values()) {
    const px = MM_CX + (cell.q + cell.r * 0.5) * MM_SCALE;
    const py = MM_CY + cell.r * 0.866 * MM_SCALE;

    ctx.fillStyle = terrainColor[cell.terrain] ?? "#333";
    ctx.beginPath();
    ctx.arc(px, py, 6.5, 0, Math.PI * 2);
    ctx.fill();

    if (cell.cityId) {
      const city = state.getCity(cell.cityId);
      if (city) {
        ctx.fillStyle =
          city.owner === "player" ? "#3b82f6" :
          city.owner === "enemy"  ? "#ef4444" : "#9ca3af";
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (cell.unitId) {
      const unit = state.getUnit(cell.unitId);
      if (unit) {
        ctx.fillStyle = unit.owner === "player" ? "#93c5fd" : "#fca5a5";
        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (selectedUnitId) {
    const unit = state.getUnit(selectedUnitId);
    if (unit) {
      const cell = state.getHexById(unit.hexId);
      if (cell) {
        const px = MM_CX + (cell.q + cell.r * 0.5) * MM_SCALE;
        const py = MM_CY + cell.r * 0.866 * MM_SCALE;
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

// ─── UI Overlay ───────────────────────────────────────────────────────────────

const overlay = el("div", "fixed inset-0 pointer-events-none");
document.body.appendChild(overlay);

// ── Top bar ───────────────────────────────────────────────────────────────────

const topBar = el("div",
  "absolute top-0 left-0 right-0 flex items-center justify-between pl-5 pr-[22rem] py-3 " +
  "bg-gradient-to-b from-black/80 to-transparent pointer-events-none"
);

const titleBlock = el("div", "");
titleBlock.appendChild(el("h1", "text-xl font-bold tracking-widest text-amber-400 uppercase", "Theater of War"));
titleBlock.appendChild(el("div", "text-xs font-mono text-gray-600", `seed: ${seed}`));

const resourceBar = el("div", "flex gap-5 text-xs font-mono items-center");
const creditsEl    = el("div", "text-blue-300");
const productionEl = el("div", "text-amber-300");
const unitsEl      = el("div", "text-green-400");
resourceBar.appendChild(creditsEl);
resourceBar.appendChild(productionEl);
resourceBar.appendChild(unitsEl);

topBar.appendChild(titleBlock);
topBar.appendChild(resourceBar);
overlay.appendChild(topBar);

// ─── End Turn HUD ─────────────────────────────────────────────────────────────

const endTurnHud = el("div",
  "fixed bottom-7 left-1/2 -translate-x-1/2 z-[200] pointer-events-auto " +
  "flex flex-col items-center gap-1.5"
);

const turnLabel = el("div",
  "text-gray-600 text-[10px] font-mono uppercase tracking-[0.3em] select-none"
);

const btnEndTurn = el("button",
  "bg-amber-500 text-gray-950 font-black uppercase tracking-[0.12em] text-base " +
  "px-14 py-3 w-56 " +
  "shadow-[0_0_32px_rgba(245,158,11,0.45),0_2px_12px_rgba(0,0,0,0.7)] " +
  "hover:bg-amber-400 hover:shadow-[0_0_52px_rgba(245,158,11,0.7),0_2px_12px_rgba(0,0,0,0.7)] " +
  "active:scale-[0.97] active:bg-amber-600 " +
  "transition-all duration-150 " +
  "disabled:opacity-20 disabled:pointer-events-none",
  "END TURN"
);

const idleUnitsIndicator = el("button",
  "text-amber-400 text-[10px] font-mono uppercase tracking-wider " +
  "hover:text-amber-300 transition-colors select-none cursor-pointer " +
  "bg-transparent border-0 p-0"
);
idleUnitsIndicator.style.display = "none";

let idleCycleIdx = 0;
idleUnitsIndicator.addEventListener("click", () => {
  const idle = state.getUnitsBy("player").filter(u => u.movementLeft > 0 || !u.hasAttacked);
  if (idle.length === 0) return;
  idleCycleIdx = idleCycleIdx % idle.length;
  const unit = idle[idleCycleIdx]!;
  idleCycleIdx++;
  const cell = state.getHexById(unit.hexId);
  if (cell) {
    const { x, z } = hexToWorld(cell.q, cell.r);
    sceneManager.controls.target.set(x, 0, z);
    sceneManager.controls.update();
  }
  selectUnit(unit.instanceId);
});

endTurnHud.appendChild(turnLabel);
endTurnHud.appendChild(btnEndTurn);
endTurnHud.appendChild(idleUnitsIndicator);
document.body.appendChild(endTurnHud);

// ─── Left panel: hover info (no selection) ───────────────────────────────────

const hoverPanel = el("div",
  "fixed bottom-4 left-4 w-60 bg-black/75 border border-gray-700 rounded-lg p-3 " +
  "text-xs font-mono text-gray-300 pointer-events-none transition-opacity duration-150"
);
hoverPanel.style.opacity = "0";
document.body.appendChild(hoverPanel);

// ─── Left panel: unit HUD (unit selected) ────────────────────────────────────

const unitHud = el("div",
  "fixed bottom-4 left-4 w-60 bg-black/85 border border-gray-700 rounded-lg " +
  "text-xs font-mono text-gray-300 overflow-hidden transition-opacity duration-150 pointer-events-auto"
);
unitHud.style.opacity = "0";
unitHud.style.pointerEvents = "none";
document.body.appendChild(unitHud);

// ─── UI Update Helpers ────────────────────────────────────────────────────────

function ownerColor(owner: Owner | "world"): string {
  if (owner === "player") return "text-blue-400";
  if (owner === "enemy")  return "text-red-400";
  return "text-gray-400";
}

function updateResources(): void {
  const pr = state.playerResources;

  const playerCities   = state.getCitiesBy("player");
  const incomePerTurn  = playerCities.length * 30
    + playerCities.reduce((s, c) => s + c.buildings.marketLevel * 25, 0);
  const prodPerTurn    = playerCities.reduce((sum, c) => sum + c.buildings.factoryLevel * 50, 0);
  const unitCount      = state.getUnitsBy("player").length;

  creditsEl.textContent    = `💰 ${pr.credits}/${pr.maxCredits}$ (+${incomePerTurn}/turn)`;
  productionEl.textContent = `⚙️ ${prodPerTurn}/turn`;
  unitsEl.textContent      = `🪖 ${unitCount} units`;
  turnLabel.textContent    = `Turn ${state.turn}`;

  updateIdleUnits();
}

function updateIdleUnits(): void {
  const idle = state.getUnitsBy("player").filter(u => u.movementLeft > 0 || !u.hasAttacked);
  if (idle.length === 0) {
    idleUnitsIndicator.style.display = "none";
    idleCycleIdx = 0;
  } else {
    idleUnitsIndicator.style.display = "block";
    idleUnitsIndicator.textContent = `▸ ${idle.length} unit${idle.length !== 1 ? "s" : ""} not yet acted`;
  }
}

// ─── Unit HUD ─────────────────────────────────────────────────────────────────

function updateUnitHud(hoveredHexId: string | null): void {
  if (!selectedUnitId) {
    unitHud.style.opacity = "0";
    unitHud.style.pointerEvents = "none";
    return;
  }

  const unit = state.getUnit(selectedUnitId);
  const bp   = unit ? state.getBlueprint(unit.blueprintId) : null;
  if (!unit || !bp) return;

  unitHud.replaceChildren();

  // ── Static unit section ─────────────────────────────────────────────────
  const staticSection = el("div", "p-3");

  const nameRow = el("div", "flex items-center justify-between mb-2.5");
  const nameText = bp.name + (unit.stackSize > 1 ? ` ×${unit.stackSize}` : "");
  nameRow.appendChild(el("span", "text-white font-bold text-sm", nameText));
  const deselectBtn = el("button",
    "text-gray-600 hover:text-gray-300 text-[10px] px-1.5 py-0.5 border border-gray-700 " +
    "hover:border-gray-500 rounded transition-colors cursor-pointer font-mono",
    "ESC"
  );
  deselectBtn.addEventListener("click", () => deselect());
  nameRow.appendChild(deselectBtn);
  staticSection.appendChild(nameRow);

  // HP bar
  const hpPct = unit.hp / bp.maxHp;
  const hpBarColor  = hpPct > 0.6 ? "bg-green-500"  : hpPct > 0.3 ? "bg-yellow-500"  : "bg-red-500";
  const hpTextColor = hpPct > 0.6 ? "text-green-400" : hpPct > 0.3 ? "text-yellow-400" : "text-red-400";
  const hpWrapper = el("div", "mb-3");
  const hpLabelRow = el("div", "flex justify-between mb-1");
  hpLabelRow.appendChild(el("span", "text-gray-500", "HP"));
  hpLabelRow.appendChild(el("span", hpTextColor, `${unit.hp} / ${bp.maxHp}`));
  hpWrapper.appendChild(hpLabelRow);
  const hpTrack = el("div", "h-1.5 bg-gray-800 rounded-full overflow-hidden");
  const hpFill  = el("div", `h-full ${hpBarColor} rounded-full`);
  hpFill.style.width = `${hpPct * 100}%`;
  hpTrack.appendChild(hpFill);
  hpWrapper.appendChild(hpTrack);
  staticSection.appendChild(hpWrapper);

  // Move pips + Attack badge
  const statusRow = el("div", "flex gap-5 items-start");

  const moveGroup = el("div", "");
  moveGroup.appendChild(el("div", "text-gray-500 text-[10px] uppercase tracking-wider mb-1.5", "Move"));
  const movePips = el("div", "flex gap-0.5");
  for (let i = 0; i < bp.movement.range; i++) {
    movePips.appendChild(el("div",
      `w-2 h-2 rounded-sm ${i < unit.movementLeft ? "bg-cyan-400" : "bg-gray-700"}`
    ));
  }
  moveGroup.appendChild(movePips);
  statusRow.appendChild(moveGroup);

  const atkGroup = el("div", "");
  atkGroup.appendChild(el("div", "text-gray-500 text-[10px] uppercase tracking-wider mb-1.5", "Attack"));
  atkGroup.appendChild(el("div",
    `text-[11px] font-bold ${unit.hasAttacked ? "text-gray-600" : "text-red-400"}`,
    unit.hasAttacked ? "SPENT" : "READY"
  ));
  statusRow.appendChild(atkGroup);

  staticSection.appendChild(statusRow);
  unitHud.appendChild(staticSection);

  // ── Hover context section ───────────────────────────────────────────────
  if (hoveredHexId) {
    const cell    = state.getHexById(hoveredHexId);
    const hovUnit = cell?.unitId ? state.getUnit(cell.unitId) : null;

    if (currentAttackable.includes(hoveredHexId) && hovUnit && hovUnit.owner !== "player") {
      const preview = previewCombat(selectedUnitId, hovUnit.instanceId, state);
      if (preview) {
        unitHud.appendChild(el("div", "border-t border-gray-800"));
        const pvSection = el("div", "p-3 space-y-1");
        pvSection.appendChild(el("div", "text-gray-500 text-[10px] uppercase tracking-wider mb-0.5", "Combat Preview"));
        pvSection.appendChild(
          el("div", preview.defenderDestroyed ? "text-green-400" : "text-emerald-400",
            `→ Deal ${preview.attackerDeals}  (${preview.defenderHpAfter}HP left)`)
        );
        if (preview.defenderDestroyed)
          pvSection.appendChild(el("div", "text-green-300 font-bold", "✓ Enemy destroyed"));
        if (preview.defenderCounters > 0) {
          pvSection.appendChild(
            el("div", preview.attackerDestroyed ? "text-red-500 font-bold" : "text-orange-400",
              `← Counter ${preview.defenderCounters}  (you: ${preview.attackerHpAfter}HP)`)
          );
        }
        if (preview.attackerDestroyed)
          pvSection.appendChild(el("div", "text-red-400 font-bold", "⚠ You will be destroyed!"));

        pvSection.appendChild(el("div",
          `mt-1 font-bold ${pendingAttackTarget === hovUnit.instanceId ? "text-red-400" : "text-orange-400"}`,
          pendingAttackTarget === hovUnit.instanceId ? "⚔ Click again to confirm" : "⚔ Click to attack"
        ));
        unitHud.appendChild(pvSection);
      }
    } else if (currentReachable.includes(hoveredHexId) && !cell?.unitId) {
      unitHud.appendChild(el("div", "border-t border-gray-800"));
      const moveSection = el("div", "p-3");
      moveSection.appendChild(el("div", "text-cyan-300 font-bold", "→ Click to move here"));
      unitHud.appendChild(moveSection);
    }
  }

  unitHud.style.opacity = "1";
  unitHud.style.pointerEvents = "auto";
}

// ─── Hover Panel (no selection) ───────────────────────────────────────────────

function updateHoverPanel(hId: string | null): void {
  if (selectedUnitId) { hoverPanel.style.opacity = "0"; return; }
  if (!hId)           { hoverPanel.style.opacity = "0"; return; }

  const cell = state.getHexById(hId);
  if (!cell) return;

  hoverPanel.replaceChildren();

  // Terrain line
  const terrainRow = el("div", "flex justify-between");
  terrainRow.appendChild(el("span", "text-gray-300 capitalize", cell.terrain));
  terrainRow.appendChild(el("span", "text-gray-600", `${cell.q}, ${cell.r}`));
  hoverPanel.appendChild(terrainRow);

  // City section
  if (cell.cityId) {
    const city = state.getCity(cell.cityId);
    if (city) {
      hoverPanel.appendChild(el("div", "border-t border-gray-800 mt-1.5 pt-1.5"));
      hoverPanel.appendChild(el("div", "font-bold text-white", city.name));
      const ownerLine = el("div", "mt-0.5");
      ownerLine.appendChild(document.createTextNode("Owner: "));
      ownerLine.appendChild(el("span", ownerColor(city.owner), city.owner.toUpperCase()));
      hoverPanel.appendChild(ownerLine);

      if (city.owner !== "neutral") {
        const income = 30 + city.buildings.marketLevel * 25;
        const prod   = city.buildings.factoryLevel * 50;
        hoverPanel.appendChild(el("div", "text-yellow-600 mt-0.5 text-[10px]",
          `+${income}$/turn${prod > 0 ? `  ⚙+${prod}/turn` : ""}`));
      }

      const q = city.productionQueue[0];
      if (q) {
        const bpQ = state.getBlueprint(q.blueprintId);
        if (bpQ) {
          const pct = Math.round((q.progressPoints / bpQ.cost.productionNeeded) * 100);
          hoverPanel.appendChild(el("div", "text-yellow-400 mt-0.5", `⚙ ${bpQ.name} — ${pct}%`));
        }
      }

      if (city.owner === "player")
        hoverPanel.appendChild(el("div", "text-blue-400 mt-1.5 text-[10px]", "↵ Click to manage"));
    }
  }

  // Unit section (for scouting enemy/own units when nothing selected)
  const hovUnit = cell.unitId ? state.getUnit(cell.unitId) : null;
  if (hovUnit) {
    const bp = state.getBlueprint(hovUnit.blueprintId);
    const stackLabel = hovUnit.stackSize > 1 ? ` ×${hovUnit.stackSize}` : "";
    hoverPanel.appendChild(el("div", "border-t border-gray-800 mt-1.5 pt-1.5"));
    hoverPanel.appendChild(el("div", "font-bold text-white",
      (bp?.name ?? hovUnit.blueprintId) + stackLabel));
    hoverPanel.appendChild(el("div", `${ownerColor(hovUnit.owner)} mt-0.5`,
      `${hovUnit.owner.toUpperCase()} — ${hovUnit.hp}/${bp?.maxHp ?? "?"}HP`));

    if (bp) {
      const statsRow = el("div", "flex gap-2 mt-1 text-gray-500");
      statsRow.appendChild(el("span", "", `⚔ ${bp.combat.damageVsLand}`));
      if (bp.combat.damageVsAir > 0) statsRow.appendChild(el("span", "", `✈ ${bp.combat.damageVsAir}`));
      if (bp.combat.damageVsSea > 0) statsRow.appendChild(el("span", "", `⚓ ${bp.combat.damageVsSea}`));
      statsRow.appendChild(el("span", "ml-auto", `Mv ${bp.movement.range}`));
      hoverPanel.appendChild(statsRow);
    }

    if (hovUnit.owner === "player") {
      if (hovUnit.movementLeft === 0 && hovUnit.hasAttacked)
        hoverPanel.appendChild(el("div", "text-gray-600 mt-1 text-[10px] italic", "Spent this turn"));
      else
        hoverPanel.appendChild(el("div", "text-cyan-400 mt-1 text-[10px]", "↵ Click to select"));
    }
  }

  hoverPanel.style.opacity = "1";
}

function showEndScreen(outcome: "victory" | "defeat"): void {
  const screen = el("div",
    "absolute inset-0 flex flex-col items-center justify-center bg-black/80 pointer-events-auto z-[150]"
  );
  const label = outcome === "victory" ? "VICTORY" : "DEFEAT";
  const color = outcome === "victory" ? "text-amber-400" : "text-red-500";
  screen.appendChild(el("div", `text-6xl font-black tracking-widest uppercase ${color}`, label));
  const sub = outcome === "victory"
    ? "All enemy territory captured."
    : "All allied cities have fallen.";
  screen.appendChild(el("div", "mt-4 text-gray-400 text-sm font-mono", sub));

  const statsLine =
    `Turn ${state.turn - 1}  ·  ${stats.playerKills} enemies destroyed  ·  ` +
    `${stats.playerLosses} units lost  ·  ${stats.citiesCaptured} cities captured`;
  screen.appendChild(el("div", "mt-6 text-gray-600 text-xs font-mono tracking-wide", statsLine));

  overlay.appendChild(screen);
  btnEndTurn.disabled = true;
}

// ─── Turn Banner ─────────────────────────────────────────────────────────────

function showTurnBanner(turn: number): void {
  const banner = document.createElement("div");
  banner.style.cssText = [
    "position:fixed", "inset:0", "z-index:300",
    "display:flex", "flex-direction:column",
    "align-items:center", "justify-content:center",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity 0.25s ease",
  ].join(";");

  const bar = document.createElement("div");
  bar.style.cssText = [
    "background:rgba(0,0,0,0.72)",
    "border-top:1px solid rgba(245,158,11,0.3)",
    "border-bottom:1px solid rgba(245,158,11,0.3)",
    "padding:18px 80px",
    "display:flex", "flex-direction:column", "align-items:center", "gap:6px",
    "transform:translateY(12px)",
    "transition:transform 0.25s ease",
  ].join(";");

  const label = document.createElement("div");
  label.style.cssText = "font:900 11px/1 monospace;letter-spacing:0.35em;color:#6b7280;text-transform:uppercase";
  label.textContent = "turn begins";

  const num = document.createElement("div");
  num.style.cssText = [
    "font:900 52px/1 monospace",
    "letter-spacing:0.12em",
    "color:#f59e0b",
    "text-shadow:0 0 40px rgba(245,158,11,0.6)",
    "text-transform:uppercase",
  ].join(";");
  num.textContent = String(turn);

  bar.appendChild(label);
  bar.appendChild(num);
  banner.appendChild(bar);
  document.body.appendChild(banner);

  requestAnimationFrame(() => {
    banner.style.opacity = "1";
    bar.style.transform = "translateY(0)";
    setTimeout(() => {
      banner.style.opacity = "0";
      bar.style.transform = "translateY(-8px)";
      banner.addEventListener("transitionend", () => banner.remove(), { once: true });
    }, 1300);
  });
}

// ─── Input ────────────────────────────────────────────────────────────────────

new InputManager(
  canvas,
  sceneManager.camera,
  hexRenderer,
  (hId) => {
    currentHoveredHex = hId;
    hexRenderer.setHovered(hId);
    updateHoverPanel(hId);
    updateUnitHud(hId);

    if (selectedUnitId && hId && currentReachable.includes(hId)) {
      const unit = state.getUnit(selectedUnitId);
      const bp   = unit ? state.getBlueprint(unit.blueprintId) : undefined;
      if (unit && bp && !state.getHexById(hId)?.unitId) {
        const path = findPath(unit.hexId, hId, bp.movement.type, state);
        hexRenderer.setPathHighlight(path ?? []);
      } else {
        hexRenderer.clearPathHighlight();
      }
    } else {
      hexRenderer.clearPathHighlight();
    }
  },
  (hId) => {
    const cell = state.getHexById(hId);
    if (!cell) return;

    // ── Case 1: click on a unit ──────────────────────────────────────────────
    if (cell.unitId) {
      const unit = state.getUnit(cell.unitId);
      if (!unit) return;

      if (selectedUnitId && currentAttackable.includes(hId) && unit.owner !== "player") {
        if (pendingAttackTarget === unit.instanceId) {
          pendingAttackTarget = null;
          performAttack(selectedUnitId, unit.instanceId);
        } else {
          pendingAttackTarget = unit.instanceId;
          updateUnitHud(hId);
        }
        return;
      }

      if (unit.owner === "player") {
        if (
          selectedUnitId &&
          selectedUnitId !== unit.instanceId &&
          currentReachable.includes(hId)
        ) {
          const movingUnit = state.getUnit(selectedUnitId);
          const movingBp   = movingUnit ? state.getBlueprint(movingUnit.blueprintId) : undefined;
          const targetBp   = state.getBlueprint(unit.blueprintId);
          if (movingBp?.movement.type === "land" && targetBp?.movement.type === "land") {
            unitRenderer.animateTo(selectedUnitId, hId, state);
            state.mergeUnits(selectedUnitId, unit.instanceId);
            deselect();
            unitRenderer.syncWithState(state);
            updateResources();
            updateFog();
            return;
          }
        }

        const alreadySelected = selectedUnitId === unit.instanceId;
        const spent = unit.hasMoved && unit.hasAttacked;

        if (alreadySelected || spent) {
          deselect();
          if (cell.cityId) {
            const city = state.getCity(cell.cityId);
            if (city) {
              if (cityPanel.currentCity() === cell.cityId && cityPanel.isOpen()) cityPanel.close();
              else cityPanel.open(cell.cityId);
            }
          }
          return;
        }

        selectUnit(unit.instanceId);
        return;
      }

      deselect();
      return;
    }

    // ── Case 2: valid move destination ────────────────────────────────────────
    if (selectedUnitId && currentReachable.includes(hId)) {
      const movedId = selectedUnitId;

      if (cell.unitId) {
        const targetUnit = state.getUnit(cell.unitId);
        if (targetUnit && targetUnit.owner === "player") {
          state.mergeUnits(movedId, targetUnit.instanceId);
          deselect();
          hexRenderer.clearRangeHighlight();
          unitRenderer.syncWithState(state);
          updateResources();
          return;
        }
      }

      const movingUnit = state.getUnit(movedId);
      const movingBp   = movingUnit ? state.getBlueprint(movingUnit.blueprintId) : undefined;
      const path = movingUnit && movingBp
        ? findPath(movingUnit.hexId, hId, movingBp.movement.type, state)
        : null;
      const movementCost = path !== null ? path.length : ("all" as const);

      unitRenderer.animateTo(movedId, hId, state);
      state.moveUnit(movedId, hId, movementCost);

      hexRenderer.clearRangeHighlight();
      hexRenderer.clearPathHighlight();
      unitRenderer.setSelected(null);
      selectedUnitId      = null;
      currentReachable    = [];
      currentAttackable   = [];
      pendingAttackTarget = null;

      const destCell = state.getHexById(hId);
      if (destCell?.cityId) {
        const city = state.getCity(destCell.cityId);
        if (city && city.owner !== "player") {
          state.captureCity(destCell.cityId, "player");
          hexRenderer.updateCityMarker(hId, "player");
          stats.citiesCaptured++;
          showToast(`${city.name} captured!`, "success");
          updateResources();
        }
      }

      unitRenderer.syncWithState(state);
      updateFog();
      selectUnit(movedId);
      return;
    }

    // ── Case 3: click on city ────────────────────────────────────────────────
    if (cell.cityId) {
      const city = state.getCity(cell.cityId);
      if (!city) return;
      deselect();
      if (cityPanel.currentCity() === cell.cityId && cityPanel.isOpen()) cityPanel.close();
      else cityPanel.open(cell.cityId);
      return;
    }

    // ── Case 4: empty terrain ────────────────────────────────────────────────
    deselect();
  }
);

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    deselect();
    cityPanel.close();
  }
  if (e.key === "Enter" && !btnEndTurn.disabled) {
    btnEndTurn.click();
  }
  // Tab: cycle through idle units
  if (e.key === "Tab") {
    e.preventDefault();
    idleUnitsIndicator.click();
  }
});

// ─── End Turn ─────────────────────────────────────────────────────────────────

btnEndTurn.addEventListener("click", async () => {
  deselect();
  cityPanel.close();
  btnEndTurn.disabled = true;
  btnEndTurn.textContent = "…";

  const result = resolver.resolve();

  updateResources();
  hexRenderer.syncCityOwners(state);
  unitRenderer.syncWithState(state);
  cityPanel.refresh();
  updateFog();
  showTurnBanner(state.turn);

  btnEndTurn.disabled = false;
  btnEndTurn.textContent = "END TURN";

  if (result.outcome !== "ongoing") {
    showEndScreen(result.outcome);
  }
});

// ─── Render Loop ──────────────────────────────────────────────────────────────

updateResources();
updateFog();
sceneManager.start((dt) => {
  unitRenderer.update(dt);
});

})(); // end async IIFE
