import "./style.css";
import { GameState } from "./engine/GameState";
import { TurnResolver } from "./engine/TurnResolver";
import type { TurnEvent } from "./engine/types";
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

let selectedUnitId:     string | null = null;
let currentReachable:   string[]      = [];
let currentAttackable:  string[]      = [];
let pendingAttackTarget: string | null = null;

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
}

function deselect(): void {
  selectedUnitId      = null;
  currentReachable    = [];
  currentAttackable   = [];
  pendingAttackTarget = null;
  hexRenderer.clearRangeHighlight();
  hexRenderer.clearPathHighlight();
  unitRenderer.setSelected(null);
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

  appendCombatLog(evt);
  unitRenderer.syncWithState(state);

  if (!evt.aDestroyed && evt.aDamage > 0) unitRenderer.shakeUnit(attackerId);
  if (!evt.bDestroyed && evt.bDamage > 0) unitRenderer.shakeUnit(defenderId);

  updateMinimap();

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
  `pointer-events:none;opacity:0.9;`;
document.body.appendChild(minimapCanvas);

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

  // Selected unit indicator
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
  "absolute bottom-4 right-4 w-96 max-h-64 overflow-y-auto " +
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

  const playerCities   = state.getCitiesBy("player");
  const incomePerTurn  = playerCities.length * 30
    + playerCities.reduce((s, c) => s + c.buildings.marketLevel * 25, 0);
  const prodPerTurn    = playerCities.reduce((sum, c) => sum + c.buildings.factoryLevel * 50, 0);
  const unitCount      = state.getUnitsBy("player").length;

  creditsEl.textContent    = `💰 ${pr.credits}/${pr.maxCredits}$ (+${incomePerTurn}/turn)`;
  productionEl.textContent = `⚙️ ${prodPerTurn}/turn`;
  unitsEl.textContent      = `🪖 ${unitCount} units`;
  turnLabel.textContent    = `Turn ${state.turn}`;
}

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
  // Keep last 20 turns in log
  if (logSections.length > 20) {
    for (const node of logSections.shift()!) node.remove();
  }

  logPanel.scrollTop = logPanel.scrollHeight;
}

function appendCombatLog(evt: CombatEvent): void {
  if (evt.bDestroyed) stats.playerKills++;
  if (evt.aDestroyed) stats.playerLosses++;

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

  // Stats row
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

// ─── Hover panel ──────────────────────────────────────────────────────────────

function updateHoverPanel(hId: string | null): void {
  if (!hId) { hoverPanel.style.opacity = "0"; return; }
  const cell = state.getHexById(hId);
  if (!cell) return;

  const hoveredUnit = cell.unitId ? state.getUnit(cell.unitId) : undefined;

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

  if (hoveredUnit) {
    const bp = state.getBlueprint(hoveredUnit.blueprintId);
    const stackLabel = hoveredUnit.stackSize > 1 ? ` ×${hoveredUnit.stackSize}` : "";
    hoverPanel.appendChild(el("div", "mt-1 text-gray-600", "───"));
    hoverPanel.appendChild(el("div", "font-bold text-white", (bp?.name ?? hoveredUnit.blueprintId) + stackLabel));
    hoverPanel.appendChild(
      el("div", ownerColor(hoveredUnit.owner), `${hoveredUnit.owner.toUpperCase()} — ${hoveredUnit.hp}/${bp?.maxHp ?? "?"}HP`)
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

    if (hoveredUnit.owner === "player") {
      const noMoves = hoveredUnit.movementLeft === 0;
      if (noMoves && hoveredUnit.hasAttacked)
        hoverPanel.appendChild(el("div", "mt-1 text-gray-500 italic", "Spent this turn"));
      else if (noMoves)
        hoverPanel.appendChild(el("div", "mt-1 text-yellow-600", "Moved — can still attack"));
      else if (hoveredUnit.hasAttacked)
        hoverPanel.appendChild(el("div", "mt-1 text-yellow-600", "Attacked — can still move"));
      else if (hoveredUnit.hasMoved) {
        const mv = hoveredUnit.movementLeft;
        hoverPanel.appendChild(el("div", "mt-1 text-cyan-400", `↵ Select — ${mv} move${mv === 1 ? "" : "s"} left`));
      } else
        hoverPanel.appendChild(el("div", "mt-1 text-cyan-400", "↵ Click to select & move"));
    }

    if (selectedUnitId === hoveredUnit.instanceId)
      hoverPanel.appendChild(el("div", "mt-1 text-yellow-400 font-bold", "● SELECTED"));
  }

  if (selectedUnitId && currentReachable.includes(hId) && !cell.unitId)
    hoverPanel.appendChild(el("div", "mt-1.5 text-cyan-300 font-bold", "→ Click to move here"));

  // ── Attack section: damage preview + confirmation ─────────────────────────
  if (selectedUnitId && currentAttackable.includes(hId) && hoveredUnit && hoveredUnit.owner !== "player") {
    const preview = previewCombat(selectedUnitId, hoveredUnit.instanceId, state);
    if (preview) {
      const pvBox = el("div", "mt-2 bg-gray-900/80 border border-gray-700 rounded p-1.5 text-xs space-y-0.5");
      pvBox.appendChild(el("div", "text-gray-500 uppercase tracking-wider text-[10px] mb-1", "Combat Preview"));
      pvBox.appendChild(
        el("div", `${preview.defenderDestroyed ? "text-green-400" : "text-emerald-400"}`,
          `→ Deal ${preview.attackerDeals} dmg  (enemy: ${preview.defenderHpAfter}HP left)`)
      );
      if (preview.defenderDestroyed)
        pvBox.appendChild(el("div", "text-green-300 font-bold", "✓ Enemy destroyed!"));
      if (preview.defenderCounters > 0) {
        pvBox.appendChild(
          el("div", `${preview.attackerDestroyed ? "text-red-500 font-bold" : "text-orange-400"}`,
            `← Counter ${preview.defenderCounters} dmg  (you: ${preview.attackerHpAfter}HP left)`)
        );
      }
      if (preview.attackerDestroyed)
        pvBox.appendChild(el("div", "text-red-400 font-bold", "⚠ You will be destroyed!"));
      hoverPanel.appendChild(pvBox);
    }

    if (pendingAttackTarget === hoveredUnit.instanceId) {
      hoverPanel.appendChild(el("div", "mt-1.5 text-red-400 font-bold", "⚔ CONFIRM? Click again to attack"));
      hoverPanel.appendChild(el("div", "text-gray-600 text-[10px]", "Esc to cancel"));
    } else {
      hoverPanel.appendChild(el("div", "mt-1.5 text-orange-400 font-bold", "⚔ Click to initiate attack"));
    }
  }

  hoverPanel.style.opacity = "1";
}

// ─── Input ────────────────────────────────────────────────────────────────────

new InputManager(
  canvas,
  sceneManager.camera,
  hexRenderer,
  (hId) => {
    hexRenderer.setHovered(hId);
    updateHoverPanel(hId);

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
        // Two-click attack confirmation
        if (pendingAttackTarget === unit.instanceId) {
          pendingAttackTarget = null;
          performAttack(selectedUnitId, unit.instanceId);
        } else {
          pendingAttackTarget = unit.instanceId;
          updateHoverPanel(hId);
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
      unitRenderer.setSelected(null);
      selectedUnitId    = null;
      currentReachable  = [];
      currentAttackable = [];
      pendingAttackTarget = null;

      const destCell = state.getHexById(hId);
      if (destCell?.cityId) {
        const city = state.getCity(destCell.cityId);
        if (city && city.owner !== "player") {
          state.captureCity(destCell.cityId, "player");
          hexRenderer.updateCityMarker(hId, "player");
          stats.citiesCaptured++;
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
