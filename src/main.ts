import "./style.css";
import { GameState } from "./engine/GameState";
import { TurnResolver } from "./engine/TurnResolver";
import type { TurnEvent } from "./engine/types";
import type { Owner } from "./engine/types";
import { getReachable, getAttackableTargets, findPath } from "./engine/Pathfinder";
import { hexId, parseHexId, getHexesInRange } from "./engine/HexUtils";
import { resolveCombatPair } from "./engine/CombatResolver";
import type { CombatEvent } from "./engine/CombatResolver";
import { SceneManager } from "./renderer/SceneManager";
import { HexRenderer } from "./renderer/HexRenderer";
import { UnitRenderer } from "./renderer/UnitRenderer";
import { InputManager } from "./renderer/InputManager";
import { ModelLoader } from "./renderer/ModelLoader";
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
// Persist seed in URL without reloading so the map is shareable
if (!urlSeed) {
  const u = new URL(location.href);
  u.searchParams.set("seed", String(seed));
  history.replaceState(null, "", u);
}

// ─── Game State ───────────────────────────────────────────────────────────────

const state    = new GameState(seed);
const resolver = new TurnResolver(state);

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

const cityPanel = new CityPanel(state, (cityId) => {
  updateResources();
  const city = state.getCity(cityId);
  if (city) hexRenderer.updateCityBuildings(city.hexId, city.buildings);
});

// ─── Selection State ──────────────────────────────────────────────────────────

let selectedUnitId:   string | null = null;
let currentReachable: string[]      = [];
let currentAttackable: string[]     = [];

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
}

function selectUnit(instanceId: string): void {
  const unit = state.getUnit(instanceId);
  if (!unit || unit.owner !== "player") return;
  if (unit.hasMoved && unit.hasAttacked) return;

  const bp = state.getBlueprint(unit.blueprintId);
  if (!bp) return;

  const reachable  = unit.hasMoved    ? [] : getReachable(unit.hexId, bp.movement.range, bp.movement.type, state);
  const attackable = unit.hasAttacked ? [] : getAttackableTargets(instanceId, state);

  if (reachable.length === 0 && attackable.length === 0) { deselect(); return; }

  selectedUnitId    = instanceId;
  currentReachable  = reachable;
  currentAttackable = attackable;
  hexRenderer.setRangeHighlight(currentReachable, currentAttackable);
  unitRenderer.setSelected(instanceId);
}

function deselect(): void {
  selectedUnitId    = null;
  currentReachable  = [];
  currentAttackable = [];
  hexRenderer.clearRangeHighlight();
  hexRenderer.clearPathHighlight();
  unitRenderer.setSelected(null);
}

// ─── Combat ───────────────────────────────────────────────────────────────────

function performAttack(attackerId: string, defenderId: string): void {
  const attacker = state.getUnit(attackerId);
  if (!attacker || attacker.hasAttacked) return;

  // Charge animation plays first (async), combat resolves immediately
  unitRenderer.playAttackAnimation(attackerId, defenderId);

  const evt = resolveCombatPair(attackerId, defenderId, state);
  if (!evt) return;

  const attackerSurvived = !evt.aDestroyed;
  if (attackerSurvived) state.getUnit(attackerId)!.hasAttacked = true;

  appendCombatLog(evt);
  unitRenderer.syncWithState(state);

  // Hit-shake for survivors that took damage
  if (!evt.aDestroyed && evt.aDamage > 0) unitRenderer.shakeUnit(attackerId);
  if (!evt.bDestroyed && evt.bDamage > 0) unitRenderer.shakeUnit(defenderId);

  if (attackerSurvived) selectUnit(attackerId);
  else deselect();
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

// Resource bar with per-turn stats
const resourceBar = el("div", "flex gap-5 text-xs font-mono items-center");
const creditsEl   = el("div", "text-blue-300");
const productionEl = el("div", "text-amber-300");
const unitsEl     = el("div", "text-green-400");
resourceBar.appendChild(creditsEl);
resourceBar.appendChild(productionEl);
resourceBar.appendChild(unitsEl);

topBar.appendChild(titleBlock);
topBar.appendChild(resourceBar);
overlay.appendChild(topBar);

// ─── End Turn HUD — standalone fixed, outside overlay stacking context ────────
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

endTurnHud.appendChild(turnLabel);
endTurnHud.appendChild(btnEndTurn);
document.body.appendChild(endTurnHud);

// Hover/selection info panel (bottom-left)
const hoverPanel = el("div",
  "absolute bottom-4 left-4 bg-black/75 border border-gray-700 rounded p-3 " +
  "text-xs font-mono text-gray-300 min-w-48 transition-opacity duration-150"
);
hoverPanel.style.opacity = "0";
overlay.appendChild(hoverPanel);

// Event log (bottom-right)
const logPanel = el("div",
  "absolute bottom-4 right-4 w-96 max-h-52 overflow-y-auto " +
  "bg-black/70 border border-gray-800 rounded p-3 text-xs font-mono space-y-0.5 " +
  "pointer-events-auto"
);
overlay.appendChild(logPanel);

// Control hint
overlay.appendChild(
  el("div",
    "absolute top-14 left-5 text-gray-600 text-xs font-mono pointer-events-none",
    "Click city → manage  ·  Click unit → move/attack  ·  Drag → pan  ·  Scroll → zoom"
  )
);

// ─── UI Update Helpers ────────────────────────────────────────────────────────

function ownerColor(owner: Owner | "world"): string {
  if (owner === "player") return "text-blue-400";
  if (owner === "enemy")  return "text-red-400";
  return "text-gray-400";
}

function catIcon(cat: TurnEvent["category"]): string {
  switch (cat) {
    case "income":     return "💰";
    case "production": return "⚙️";
    case "turret":     return "🛡️";
    case "combat":     return "⚔️";
    case "ai":         return "🤖";
    case "system":     return "🔔";
  }
}

function updateResources(): void {
  const pr = state.playerResources;

  // Per-turn income
  const playerCities   = state.getCitiesBy("player");
  const incomePerTurn  = playerCities.length * 30
    + playerCities.reduce((s, c) => s + c.buildings.marketLevel * 25, 0);

  // Per-turn production (sum of factoryLevel × 50 for each player city with a queue)
  const prodPerTurn    = playerCities.reduce((sum, c) => sum + c.buildings.factoryLevel * 50, 0);

  // Unit count
  const unitCount      = state.getUnitsBy("player").length;

  creditsEl.textContent    = `💰 ${pr.credits}/${pr.maxCredits}$ (+${incomePerTurn}/turn)`;
  productionEl.textContent = `⚙️ ${prodPerTurn}/turn`;
  unitsEl.textContent      = `🪖 ${unitCount} units`;
  turnLabel.textContent    = `Turn ${state.turn}`;
}

const MAX_LOG_TURNS = 5;
const logSections: HTMLElement[][] = [];

function appendLog(events: TurnEvent[], turnNum: number): void {
  const section: HTMLElement[] = [];

  const header = el("div", "border-t border-gray-800 pt-1 mt-1 text-gray-500 uppercase tracking-widest", `── T${turnNum} ──`);
  logPanel.appendChild(header);
  section.push(header);

  for (const ev of events) {
    const row = el("div", `flex gap-1.5 ${ownerColor(ev.owner)}`);
    row.appendChild(document.createTextNode(catIcon(ev.category) + " " + ev.message));
    logPanel.appendChild(row);
    section.push(row);
  }

  logSections.push(section);
  if (logSections.length > MAX_LOG_TURNS) {
    for (const node of logSections.shift()!) node.remove();
  }

  logPanel.scrollTop = logPanel.scrollHeight;
}

function appendCombatLog(evt: CombatEvent): void {
  const row  = el("div", "flex gap-1.5 text-orange-400");
  const line =
    `⚔️ ${evt.aName} vs ${evt.bName}: ` +
    `-${evt.aDamage}HP / -${evt.bDamage}HP` +
    (evt.bDestroyed ? "  [enemy destroyed]" : "") +
    (evt.aDestroyed ? "  [unit lost!]" : "");
  row.appendChild(document.createTextNode(line));
  logPanel.appendChild(row);
  logPanel.scrollTop = logPanel.scrollHeight;
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

// ─── Hover panel ──────────────────────────────────────────────────────────────

function updateHoverPanel(hexId: string | null): void {
  if (!hexId) { hoverPanel.style.opacity = "0"; return; }
  const cell = state.getHexById(hexId);
  if (!cell) return;

  hoverPanel.replaceChildren();
  hoverPanel.appendChild(el("div", "text-gray-500 mb-1", `Hex (${cell.q}, ${cell.r})`));
  hoverPanel.appendChild(el("div", "text-white capitalize", `Terrain: ${cell.terrain}`));

  if (cell.cityId) {
    const city = state.getCity(cell.cityId);
    if (city) {
      hoverPanel.appendChild(el("div", "mt-1 text-gray-600", "───"));
      hoverPanel.appendChild(el("div", "font-bold text-white", city.name));
      const ol = el("div", "");
      ol.appendChild(document.createTextNode("Owner: "));
      ol.appendChild(el("span", ownerColor(city.owner), city.owner.toUpperCase()));
      hoverPanel.appendChild(ol);

      // Income contribution
      if (city.owner !== "neutral") {
        hoverPanel.appendChild(
          el("div", "text-xs text-yellow-600 mt-0.5", `+30$/turn  ⚙️+${city.buildings.factoryLevel * 50}/turn`)
        );
      }

      const q = city.productionQueue[0];
      if (q) {
        const bp = state.getBlueprint(q.blueprintId);
        if (bp) {
          const pct = Math.round((q.progressPoints / bp.cost.productionNeeded) * 100);
          hoverPanel.appendChild(
            el("div", "text-yellow-400 mt-0.5",
              `⚙️ ${bp.name} — ${pct}% (${q.progressPoints}/${bp.cost.productionNeeded}pt)`)
          );
        }
      }
      if (city.owner === "player")
        hoverPanel.appendChild(el("div", "mt-1.5 text-blue-500", "↵ Click to manage"));
    }
  }

  if (cell.unitId) {
    const unit = state.getUnit(cell.unitId);
    if (unit) {
      const bp = state.getBlueprint(unit.blueprintId);
      hoverPanel.appendChild(el("div", "mt-1 text-gray-600", "───"));
      hoverPanel.appendChild(el("div", "font-bold text-white", bp?.name ?? unit.blueprintId));
      hoverPanel.appendChild(
        el("div", ownerColor(unit.owner), `${unit.owner.toUpperCase()} — ${unit.hp}/${bp?.maxHp ?? "?"}HP`)
      );

      if (bp) {
        const statsRow = el("div", "flex gap-2 mt-1 text-xs text-gray-500");
        statsRow.appendChild(el("span", "", `🗡 ${bp.combat.damageVsLand}`));
        if (bp.combat.damageVsAir > 0) statsRow.appendChild(el("span", "", `✈ ${bp.combat.damageVsAir}`));
        if (bp.combat.damageVsSea > 0) statsRow.appendChild(el("span", "", `⚓ ${bp.combat.damageVsSea}`));
        statsRow.appendChild(el("span", "ml-auto", `Rng ${bp.combat.range}`));
        statsRow.appendChild(el("span", "", `Mv ${bp.movement.range}`));
        hoverPanel.appendChild(statsRow);
      }

      if (unit.owner === "player") {
        if (unit.hasMoved && unit.hasAttacked)
          hoverPanel.appendChild(el("div", "mt-1 text-gray-500 italic", "Spent this turn"));
        else if (unit.hasMoved)
          hoverPanel.appendChild(el("div", "mt-1 text-yellow-600", "Moved — can still attack"));
        else if (unit.hasAttacked)
          hoverPanel.appendChild(el("div", "mt-1 text-yellow-600", "Attacked — can still move"));
        else
          hoverPanel.appendChild(el("div", "mt-1 text-cyan-400", "↵ Click to select & move"));
      }

      if (selectedUnitId === unit.instanceId)
        hoverPanel.appendChild(el("div", "mt-1 text-yellow-400 font-bold", "● SELECTED"));
    }
  }

  if (selectedUnitId && currentReachable.includes(hexId) && !cell.unitId)
    hoverPanel.appendChild(el("div", "mt-1.5 text-cyan-300 font-bold", "→ Click to move here"));

  if (selectedUnitId && currentAttackable.includes(hexId) && cell.unitId)
    hoverPanel.appendChild(el("div", "mt-1.5 text-red-400 font-bold", "⚔ Click to attack"));

  hoverPanel.style.opacity = "1";
}

// ─── Input ────────────────────────────────────────────────────────────────────

new InputManager(
  canvas,
  sceneManager.camera,
  hexRenderer,
  (hexId) => {
    hexRenderer.setHovered(hexId);
    updateHoverPanel(hexId);

    // Path preview: show movement path when hovering a reachable hex
    if (selectedUnitId && hexId && currentReachable.includes(hexId)) {
      const unit = state.getUnit(selectedUnitId);
      const bp   = unit ? state.getBlueprint(unit.blueprintId) : undefined;
      if (unit && bp && !state.getHexById(hexId)?.unitId) {
        const path = findPath(unit.hexId, hexId, bp.movement.type, state);
        hexRenderer.setPathHighlight(path ?? []);
      } else {
        hexRenderer.clearPathHighlight();
      }
    } else {
      hexRenderer.clearPathHighlight();
    }
  },
  (hexId) => {
    const cell = state.getHexById(hexId);
    if (!cell) return;

    // ── Case 1: click on a unit ──────────────────────────────────────────────
    if (cell.unitId) {
      const unit = state.getUnit(cell.unitId);
      if (!unit) return;

      if (selectedUnitId && currentAttackable.includes(hexId) && unit.owner !== "player") {
        performAttack(selectedUnitId, unit.instanceId);
        return;
      }

      if (unit.owner === "player") {
        // Merge: selected unit moves onto this friendly land unit
        if (
          selectedUnitId &&
          selectedUnitId !== unit.instanceId &&
          currentReachable.includes(hexId)
        ) {
          const movingUnit = state.getUnit(selectedUnitId);
          const movingBp   = movingUnit ? state.getBlueprint(movingUnit.blueprintId) : undefined;
          const targetBp   = state.getBlueprint(unit.blueprintId);
          if (movingBp?.movement.type === "land" && targetBp?.movement.type === "land") {
            unitRenderer.animateTo(selectedUnitId, hexId, state);
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
    if (selectedUnitId && currentReachable.includes(hexId)) {
      const movedId = selectedUnitId;

      // Stack/merge: destination occupied by a friendly land unit
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

      unitRenderer.animateTo(movedId, hexId, state);
      state.moveUnit(movedId, hexId);

      hexRenderer.clearRangeHighlight();
      unitRenderer.setSelected(null);
      selectedUnitId    = null;
      currentReachable  = [];
      currentAttackable = [];

      const destCell = state.getHexById(hexId);
      if (destCell?.cityId) {
        const city = state.getCity(destCell.cityId);
        if (city && city.owner !== "player") {
          state.captureCity(destCell.cityId, "player");
          hexRenderer.updateCityMarker(hexId, "player");
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
});

// ─── End Turn ─────────────────────────────────────────────────────────────────

btnEndTurn.addEventListener("click", async () => {
  deselect();
  cityPanel.close();
  btnEndTurn.disabled = true;
  btnEndTurn.textContent = "…";

  const result = resolver.resolve();

  appendLog(result.events, result.turn);
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
