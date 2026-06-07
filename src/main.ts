import "./style.css";
import { GameState } from "./engine/GameState";
import { TurnResolver } from "./engine/TurnResolver";
import type { TurnEvent, TurnResult } from "./engine/types";
import type { Owner } from "./engine/types";
import { getReachable, getAttackableTargets } from "./engine/Pathfinder";
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

// ─── Game State ───────────────────────────────────────────────────────────────

const state    = new GameState();
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

const cityPanel = new CityPanel(state, () => updateResources());

// ─── Selection State ──────────────────────────────────────────────────────────

let selectedUnitId:   string | null = null;
let currentReachable: string[]      = [];
let currentAttackable: string[]     = [];

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
  unitRenderer.setSelected(null);
}

// ─── Combat ───────────────────────────────────────────────────────────────────

function performAttack(attackerId: string, defenderId: string): void {
  const attacker = state.getUnit(attackerId);
  if (!attacker || attacker.hasAttacked) return;

  const evt = resolveCombatPair(attackerId, defenderId, state);
  if (!evt) return;

  const attackerSurvived = !evt.aDestroyed;
  if (attackerSurvived) state.getUnit(attackerId)!.hasAttacked = true;

  appendCombatLog(evt);
  unitRenderer.syncWithState(state);

  if (attackerSurvived) selectUnit(attackerId);
  else deselect();
}

// ─── UI Overlay ───────────────────────────────────────────────────────────────

const overlay = el("div", "fixed inset-0 pointer-events-none");
document.body.appendChild(overlay);

// ── Top bar (z-[100] so it's always above city panel z-50) ───────────────────
const topBar = el("div",
  "absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-3 " +
  "bg-gradient-to-b from-black/80 to-transparent pointer-events-none z-[100]"
);

const titleBlock = el("div", "");
titleBlock.appendChild(el("h1", "text-xl font-bold tracking-widest text-amber-400 uppercase", "Theater of War"));

// Resource bar with per-turn stats
const resourceBar = el("div", "flex gap-5 text-xs font-mono items-center");
const creditsEl   = el("div", "text-blue-300");
const productionEl = el("div", "text-amber-300");
const unitsEl     = el("div", "text-green-400");
resourceBar.appendChild(creditsEl);
resourceBar.appendChild(productionEl);
resourceBar.appendChild(unitsEl);

// End Turn button — always visible, high z-index
const rightBar   = el("div", "flex items-center gap-4 pointer-events-auto");
const turnLabel  = el("span", "text-gray-400 text-xs font-mono");
const btnEndTurn = el("button",
  "bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-bold " +
  "py-2 px-6 rounded transition-colors text-sm tracking-wide",
  "END TURN"
);
rightBar.appendChild(turnLabel);
rightBar.appendChild(btnEndTurn);

topBar.appendChild(titleBlock);
topBar.appendChild(resourceBar);
topBar.appendChild(rightBar);
overlay.appendChild(topBar);

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
  const incomePerTurn  = playerCities.length * 30;

  // Per-turn production (sum of factoryLevel × 50 for each player city with a queue)
  const prodPerTurn    = playerCities.reduce((sum, c) => sum + c.buildings.factoryLevel * 50, 0);

  // Unit count
  const unitCount      = state.getUnitsBy("player").length;

  creditsEl.textContent    = `💰 ${pr.credits}/${pr.maxCredits}$ (+${incomePerTurn}/turn)`;
  productionEl.textContent = `⚙️ ${prodPerTurn}/turn`;
  unitsEl.textContent      = `🪖 ${unitCount} units`;
  turnLabel.textContent    = `Turn ${state.turn}`;
}

function appendLog(events: TurnEvent[], turnNum: number): void {
  logPanel.appendChild(
    el("div", "border-t border-gray-800 pt-1 mt-1 text-gray-500 uppercase tracking-widest",
      `── T${turnNum} ──`)
  );
  for (const ev of events) {
    const row = el("div", `flex gap-1.5 ${ownerColor(ev.owner)}`);
    row.appendChild(document.createTextNode(catIcon(ev.category) + " " + ev.message));
    logPanel.appendChild(row);
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
  btnEndTurn.classList.add("opacity-40", "cursor-not-allowed");
}

// ─── Turn Summary Modal ───────────────────────────────────────────────────────

function showTurnSummaryModal(result: TurnResult): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = el("div",
      "fixed inset-0 z-[200] flex items-center justify-center bg-black/65 pointer-events-auto"
    );

    const panel = el("div",
      "bg-gray-950 border border-gray-700 rounded-lg shadow-2xl w-[520px] max-h-[80vh] " +
      "flex flex-col overflow-hidden"
    );

    // Header
    const header = el("div",
      "flex items-center justify-between px-5 py-4 border-b border-gray-800 flex-shrink-0"
    );
    header.appendChild(
      el("h2", "text-base font-bold tracking-widest text-amber-400 uppercase",
        `Turn ${result.turn} — What Happened`)
    );
    const closeBtn = el("button",
      "text-gray-500 hover:text-white transition-colors text-xl leading-none",
      "✕"
    );
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Body
    const body = el("div", "flex-1 overflow-y-auto p-5 space-y-5");

    const playerIncomeEvts = result.events.filter(
      (e) => e.category === "income" && e.owner === "player"
    );
    const playerProdEvts = result.events.filter(
      (e) => e.category === "production" && e.owner === "player"
    );
    const enemyEvts = result.events.filter(
      (e) => e.owner === "enemy" && (e.category === "ai" || e.category === "combat")
    );
    const turretEvts = result.events.filter((e) => e.category === "turret");
    const combatEvts = result.events.filter(
      (e) => e.category === "combat" && e.owner !== "enemy"
    );

    if (playerIncomeEvts.length > 0 || playerProdEvts.length > 0) {
      body.appendChild(buildSection("💰 Allied Economy", "text-blue-400",
        [...playerIncomeEvts, ...playerProdEvts]));
    }

    if (enemyEvts.length > 0) {
      body.appendChild(buildSection("🤖 Enemy Activity", "text-red-400", enemyEvts));
    }

    if (combatEvts.length > 0) {
      body.appendChild(buildSection("⚔️ Combat Results", "text-orange-400", combatEvts));
    }

    if (turretEvts.length > 0) {
      body.appendChild(buildSection("🛡️ Turret Fire", "text-yellow-500", turretEvts));
    }

    if (
      playerIncomeEvts.length === 0 && playerProdEvts.length === 0 &&
      enemyEvts.length === 0 && combatEvts.length === 0 && turretEvts.length === 0
    ) {
      body.appendChild(el("p", "text-gray-600 text-sm italic", "A quiet turn."));
    }

    panel.appendChild(body);

    // Footer
    const footer = el("div", "flex justify-end px-5 py-4 border-t border-gray-800 flex-shrink-0");
    const continueBtn = el("button",
      "bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-bold " +
      "py-2 px-8 rounded transition-colors text-sm tracking-wide",
      "CONTINUE →"
    );
    footer.appendChild(continueBtn);
    panel.appendChild(footer);

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const dismiss = (): void => {
      backdrop.remove();
      resolve();
    };
    closeBtn.addEventListener("click", dismiss);
    continueBtn.addEventListener("click", dismiss);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) dismiss(); });
  });
}

function buildSection(title: string, titleClass: string, events: TurnEvent[]): HTMLElement {
  const section = el("div", "");
  section.appendChild(el("h3", `text-xs font-bold uppercase tracking-widest mb-2 ${titleClass}`, title));
  for (const ev of events) {
    const row = el("div", "text-xs font-mono text-gray-300 py-0.5 leading-relaxed");
    row.appendChild(document.createTextNode(ev.message));
    section.appendChild(row);
  }
  return section;
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
        if (selectedUnitId === unit.instanceId) deselect();
        else selectUnit(unit.instanceId);
        return;
      }

      deselect();
      return;
    }

    // ── Case 2: valid move destination ────────────────────────────────────────
    if (selectedUnitId && currentReachable.includes(hexId)) {
      const movedId = selectedUnitId;

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

// ─── End Turn ─────────────────────────────────────────────────────────────────

btnEndTurn.addEventListener("click", async () => {
  deselect();
  cityPanel.close();
  btnEndTurn.disabled = true;
  btnEndTurn.textContent = "…";

  const result = resolver.resolve();

  // Sync 3D view immediately (background updates while modal is shown)
  appendLog(result.events, result.turn);
  updateResources();
  hexRenderer.syncCityOwners(state);
  unitRenderer.syncWithState(state);
  cityPanel.refresh();

  // Show the turn summary modal
  await showTurnSummaryModal(result);

  btnEndTurn.disabled = false;
  btnEndTurn.textContent = "END TURN";

  if (result.outcome !== "ongoing") {
    showEndScreen(result.outcome);
  }
});

// ─── Render Loop ──────────────────────────────────────────────────────────────

updateResources();
sceneManager.start((dt) => {
  unitRenderer.update(dt);
});

})(); // end async IIFE
