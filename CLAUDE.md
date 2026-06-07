# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Vite dev server (localhost:5173)
npm run build     # tsc + vite bundle (type-check first)
npm run preview   # Serve production build locally
```

No test framework is configured yet.

## Architecture

**Theater of War** is a browser-based hex-grid military strategy game. The codebase is split into three strictly separated layers:

### Engine (`src/engine/`) — pure game logic, no DOM/Three.js

- **`GameState.ts`** — single source of truth. Holds `hexMap`, `cities`, `units`, `unitBlueprints`. All mutations go through its methods (`moveUnit`, `queueProduction`, `upgradeBuilding`, `spawnUnit`). Never modify its maps directly.
- **`TurnResolver.ts`** — executes an end-turn sequence: income → production queue progress → turret damage → reset unit flags. Returns a `TurnResult` with an event log array.
- **`CombatResolver.ts`** — simultaneous combat (both units take damage at once). Indirect-fire units (range > 1) cannot counterattack.
- **`Pathfinder.ts`** — `getReachable()` (BFS) for movement highlights; `findPath()` (A*) for actual movement paths. Occupied hexes block both stopping and passing.
- **`HexUtils.ts`** — all hex math. Axial coordinates (q/r). `hexId(q, r)` → `"q_r"` string used as the key everywhere.
- **`MapGenerator.ts`** — defines the static 37-cell radius-3 map with terrain overrides and 7 pre-placed cities.

### Renderer (`src/renderer/`) — Three.js, reads GameState but never writes it

- **`SceneManager.ts`** — orthographic camera at isometric angle, OrbitControls pan+zoom only, shadow-mapped directional light.
- **`HexRenderer.ts`** — creates/manages hex cell meshes. Hover and range overlays are separate mesh layers. Shared geometries across all instances.
- **`UnitRenderer.ts`** — `syncWithState()` diffs current meshes against game state, creating/removing as needed. `animateTo()` queues slide animations. Call `update(dt)` every frame.
- **`InputManager.ts`** — raycasting mouse → hex. Fires `onHover` and `onClick` callbacks with the hit `hexId`.
- **`constants.ts`** — `hexToWorld(q, r)` for flat-top layout, `HEX_SIZE = 1.2`, terrain colors, owner colors.

### UI (`src/ui/`)

- **`CityPanel.ts`** — slide-in panel for building upgrades and production queue. Call `refresh()` after any state mutation that should be reflected in an open panel.
- **`dom.ts`** — `el(tag, classes, text?)` shorthand for creating Tailwind-styled DOM elements.

### Wiring (`src/main.ts`)

Orchestrates all three layers. Holds client-side interaction state (`selectedUnitId`, `currentReachable`) that has no place in GameState. The game loop calls `unitRenderer.update(dt)` for animations; all other rendering is event-driven.

## Key Data Contracts

- **Hex IDs**: always `"q_r"` strings (from `hexId()`), never raw `{q, r}` objects passed across layers.
- **Unit blueprints**: loaded from `src/data/units.json` into `GameState.unitBlueprints`. Stats live there — don't hardcode unit values in engine logic.
- **Production**: a FIFO queue per city. `TurnResolver` advances only `queue[0]` per turn, adding `factoryLevel × 50` production points. A unit spawns when `progressPoints >= cost.productionNeeded`.
- **Combat damage lookup**: `unit.combat.damageVsLand/Air/Sea` — use the defender's `movement.type` to pick the right field.

## TypeScript Config

Strict mode with `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch` — all enforced at build time. Target ES2020, module ESNext.
