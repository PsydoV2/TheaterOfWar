import type { GameState } from "../engine/GameState";
import type { City, BuildingKey, UnitBlueprint } from "../engine/types";
import { el, btn } from "./dom";

// ─── Building metadata (static) ───────────────────────────────────────────────

interface BuildingInfo {
  icon: string;
  label: string;
  description: string;
  maxLevel: number;
  upgradeCosts: number[];
}

const BUILDING_INFO: Record<BuildingKey, BuildingInfo> = {
  factory:   { icon: "⚙️",  label: "Factory",   description: "Production +50⚙/lv/turn",       maxLevel: 3, upgradeCosts: [100, 200, 300] },
  barracks:  { icon: "🪖",  label: "Barracks",  description: "Unlocks infantry & APC units",   maxLevel: 3, upgradeCosts: [80,  160, 240] },
  warehouse: { icon: "📦",  label: "Warehouse", description: "Credit cap +250$/lv",            maxLevel: 3, upgradeCosts: [120, 240, 360] },
  airport:   { icon: "✈️",  label: "Airport",   description: "Unlocks fighters & bombers",     maxLevel: 1, upgradeCosts: [200] },
  harbor:    { icon: "⚓",  label: "Harbor",    description: "Unlocks naval units",            maxLevel: 1, upgradeCosts: [200] },
  turret:    { icon: "🛡️",  label: "Turret",    description: "Auto-fires at enemies each turn", maxLevel: 3, upgradeCosts: [90,  180, 270] },
  market:    { icon: "💰",  label: "Market",    description: "Income +25$/lv/turn",            maxLevel: 3, upgradeCosts: [150, 300, 450] },
};

const BUILDING_KEYS = Object.keys(BUILDING_INFO) as BuildingKey[];

// ─── CityPanel ────────────────────────────────────────────────────────────────

export class CityPanel {
  private readonly container: HTMLElement;
  private readonly body: HTMLElement;
  private currentCityId: string | null = null;

  constructor(
    private readonly state: GameState,
    private readonly onUpdate: (cityId: string) => void,
    private readonly onError: (msg: string) => void = () => {},
  ) {
    this.container = el("div",
      "fixed top-0 right-0 h-full w-80 bg-gray-950 border-l border-gray-700 " +
      "shadow-2xl transition-transform duration-300 translate-x-full z-50 " +
      "flex flex-col overflow-hidden"
    );
    this.container.style.pointerEvents = "none";
    document.body.appendChild(this.container);

    this.body = el("div", "flex-1 overflow-y-auto");
    this.container.appendChild(this.body);

    this.container.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("canvas")) {
        this.close();
      }
    });
  }

  open(cityId: string): void {
    this.currentCityId = cityId;
    this.render();
    this.container.classList.remove("translate-x-full");
    this.container.style.pointerEvents = "auto";
  }

  close(): void {
    this.currentCityId = null;
    this.container.classList.add("translate-x-full");
    this.container.style.pointerEvents = "none";
  }

  isOpen(): boolean {
    return this.currentCityId !== null;
  }

  currentCity(): string | null {
    return this.currentCityId;
  }

  refresh(): void {
    if (this.currentCityId) this.render();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.currentCityId) return;
    const city = this.state.getCity(this.currentCityId);
    if (!city) return;

    this.body.replaceChildren(
      this.renderHeader(city),
      this.renderBuildings(city),
      this.renderQueue(city),
      this.renderAvailableUnits(city),
    );
  }

  private renderHeader(city: City): HTMLElement {
    const ownerColor = city.owner === "player" ? "text-blue-400" : "text-red-400";

    const header = el("div", "p-4 border-b border-gray-800 flex items-start justify-between");
    const left = el("div", "");
    left.appendChild(el("h2", "text-base font-bold text-white", city.name));

    const ownerBadge = el("span",
      `text-xs uppercase font-mono px-1.5 py-0.5 rounded border ${ownerColor} border-current`,
      city.owner
    );
    left.appendChild(ownerBadge);
    header.appendChild(left);

    const closeBtn = el("button",
      "text-gray-500 hover:text-white transition-colors text-lg leading-none cursor-pointer",
      "✕"
    );
    closeBtn.addEventListener("click", () => this.close());
    header.appendChild(closeBtn);

    return header;
  }

  private renderBuildings(city: City): HTMLElement {
    const section = el("div", "p-4 border-b border-gray-800");
    section.appendChild(el("h3", "text-xs text-gray-500 uppercase tracking-widest mb-3", "Buildings"));

    const credits = this.state.resources(city.owner).credits;
    const isPlayer = city.owner === "player";

    for (const key of BUILDING_KEYS) {
      const info = BUILDING_INFO[key];
      const levelKey = `${key}Level` as keyof typeof city.buildings;
      const currentLevel = city.buildings[levelKey] as number;
      const atMax = currentLevel >= info.maxLevel;
      const upgradeCost = atMax ? 0 : info.upgradeCosts[currentLevel]!;
      const canAfford = credits >= upgradeCost;

      const row = el("div", "flex items-center justify-between py-1.5 gap-2");

      // Label group with description below
      const labelGroup = el("div", "flex items-center gap-2 min-w-0 flex-1");
      labelGroup.appendChild(el("span", "text-base leading-none flex-shrink-0", info.icon));
      const labelCol = el("div", "flex flex-col");
      labelCol.appendChild(el("span", "text-sm text-gray-300", info.label));
      labelCol.appendChild(el("span", "text-[10px] text-gray-600 leading-tight", info.description));
      labelGroup.appendChild(labelCol);

      const rightGroup = el("div", "flex items-center gap-2 flex-shrink-0");

      // Level pips
      const pips = el("div", "flex gap-0.5");
      for (let i = 0; i < info.maxLevel; i++) {
        pips.appendChild(el("div",
          `w-2.5 h-2.5 rounded-sm ${i < currentLevel ? "bg-amber-400" : "bg-gray-700"}`
        ));
      }
      rightGroup.appendChild(pips);

      const isLocked = key === "harbor" && currentLevel === 0 && !this.state.isCityCoastal(city.id);

      if (isPlayer) {
        if (isLocked) {
          rightGroup.appendChild(el("span", "text-xs text-gray-600 w-16 text-right italic", "inland"));
        } else if (atMax) {
          rightGroup.appendChild(el("span", "text-xs text-gray-600 w-14 text-right", "MAX"));
        } else {
          const upgradeBtn = btn(canAfford ? "secondary" : "ghost", `${upgradeCost}$`);
          upgradeBtn.classList.add("w-14", "text-right");
          if (canAfford) {
            upgradeBtn.addEventListener("click", () => {
              const err = this.state.upgradeBuilding(city.id, key);
              if (err) this.onError(err);
              else { this.onUpdate(city.id); this.render(); }
            });
          } else {
            upgradeBtn.disabled = true;
          }
          rightGroup.appendChild(upgradeBtn);
        }
      }

      row.appendChild(labelGroup);
      row.appendChild(rightGroup);
      section.appendChild(row);
    }

    return section;
  }

  private renderQueue(city: City): HTMLElement {
    const section = el("div", "p-4 border-b border-gray-800");
    section.appendChild(el("h3", "text-xs text-gray-500 uppercase tracking-widest mb-3", "Production Queue"));

    if (city.productionQueue.length === 0) {
      section.appendChild(el("p", "text-gray-600 text-xs italic", "Queue is empty"));
      return section;
    }

    city.productionQueue.forEach((item, idx) => {
      const bp = this.state.getBlueprint(item.blueprintId);
      if (!bp) return;

      const isActive = idx === 0;
      const pct = Math.min(100, Math.round((item.progressPoints / bp.cost.productionNeeded) * 100));

      const row = el("div", "mb-2");
      const rowHeader = el("div", "flex items-center justify-between mb-1");
      rowHeader.appendChild(
        el("span", `text-xs ${isActive ? "text-white" : "text-gray-400"}`, bp.name)
      );

      const rightGroup = el("div", "flex items-center gap-2");
      if (isActive) {
        rightGroup.appendChild(el("span", "text-xs text-amber-400 font-mono", `${pct}%`));
      } else {
        rightGroup.appendChild(el("span", "text-xs text-gray-600", "queued"));
      }

      if (city.owner === "player") {
        const cancelBtn = btn("danger", "✕");
        cancelBtn.addEventListener("click", () => {
          this.state.cancelProduction(city.id, idx);
          this.onUpdate(city.id);
          this.render();
        });
        rightGroup.appendChild(cancelBtn);
      }

      rowHeader.appendChild(rightGroup);
      row.appendChild(rowHeader);

      if (isActive) {
        const barBg = el("div", "h-1.5 bg-gray-800 rounded-full overflow-hidden");
        const barFill = el("div", "h-full bg-amber-500 rounded-full transition-all");
        barFill.style.width = `${pct}%`;
        barBg.appendChild(barFill);
        row.appendChild(barBg);
      }

      section.appendChild(row);
    });

    return section;
  }

  private renderAvailableUnits(city: City): HTMLElement {
    const section = el("div", "p-4");
    section.appendChild(el("h3", "text-xs text-gray-500 uppercase tracking-widest mb-3", "Available Units"));

    const credits = this.state.resources(city.owner).credits;
    const isPlayer = city.owner === "player";
    const available = this.getAvailableBlueprints(city);

    if (available.length === 0) {
      section.appendChild(el("p", "text-gray-600 text-xs italic", "No units available — upgrade buildings"));
      return section;
    }

    for (const bp of available) {
      section.appendChild(this.renderUnitCard(bp, city, credits, isPlayer));
    }

    return section;
  }

  private renderUnitCard(bp: UnitBlueprint, city: City, credits: number, isPlayer: boolean): HTMLElement {
    const canAfford = credits >= bp.cost.credits;
    const card = el("div", "bg-gray-900 border border-gray-800 rounded p-2.5 mb-2");

    // Name + prereq + cost row
    const nameRow = el("div", "flex items-start justify-between mb-1");
    const nameCol = el("div", "flex flex-col");
    nameCol.appendChild(el("span", "text-sm font-medium text-white", bp.name));
    nameCol.appendChild(
      el("span", "text-[10px] text-gray-600 leading-tight",
        `Req: ${bp.requiredBuilding} lv${bp.requiredBuildingLevel}`)
    );
    nameRow.appendChild(nameCol);
    nameRow.appendChild(
      el("span", `text-xs font-mono ${canAfford ? "text-amber-400" : "text-gray-500"}`,
        `${bp.cost.credits}$ · ${bp.cost.productionNeeded}⚙`)
    );
    card.appendChild(nameRow);

    // Stats row
    const statsRow = el("div", "flex gap-2 text-xs text-gray-500 mb-2");
    statsRow.appendChild(el("span", "", `🗡 ${bp.combat.damageVsLand}`));
    if (bp.combat.damageVsAir > 0)  statsRow.appendChild(el("span", "", `✈ ${bp.combat.damageVsAir}`));
    if (bp.combat.damageVsSea > 0)  statsRow.appendChild(el("span", "", `⚓ ${bp.combat.damageVsSea}`));
    statsRow.appendChild(el("span", "ml-auto", `HP ${bp.maxHp}`));
    statsRow.appendChild(el("span", "", `Mv ${bp.movement.range}`));
    card.appendChild(statsRow);

    // Traits
    if (bp.specialTraits.length > 0) {
      const traitsRow = el("div", "flex flex-wrap gap-1 mb-2");
      for (const t of bp.specialTraits) {
        traitsRow.appendChild(
          el("span", "text-xs bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded", t.replace(/_/g, " "))
        );
      }
      card.appendChild(traitsRow);
    }

    if (isPlayer) {
      const queueBtn = btn(canAfford ? "primary" : "ghost", canAfford ? "QUEUE UNIT" : `Need ${bp.cost.credits - credits}$ more`);
      queueBtn.classList.add("w-full", "py-1");
      if (canAfford) {
        queueBtn.addEventListener("click", () => {
          const err = this.state.queueProduction(city.id, bp.id);
          if (err) this.onError(err);
          else { this.onUpdate(city.id); this.render(); }
        });
      } else {
        queueBtn.disabled = true;
      }
      card.appendChild(queueBtn);
    }

    return card;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private getAvailableBlueprints(city: City): UnitBlueprint[] {
    const result: UnitBlueprint[] = [];
    for (const bp of this.state.unitBlueprints.values()) {
      const levelKey = `${bp.requiredBuilding}Level` as keyof typeof city.buildings;
      const cityLevel = city.buildings[levelKey] as number;
      if (cityLevel >= bp.requiredBuildingLevel) {
        result.push(bp);
      }
    }
    return result;
  }
}
