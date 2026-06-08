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

- **`types.ts`** — all shared interfaces and enums. Single source of truth for `HexCell`, `City`, `MilitaryUnit`, `UnitBlueprint`, `TurnResult`, `IGameState`, etc. Edit here first when adding new data shapes.
- **`GameState.ts`** — single source of truth for runtime state. Holds `hexMap`, `cities`, `units`, `unitBlueprints`, `playerResources`, `enemyResources`. All mutations go through its methods — never modify its maps directly. Key mutating methods: `moveUnit`, `mergeUnits`, `spawnUnit`, `removeUnit`, `queueProduction`, `cancelProduction`, `upgradeBuilding`, `captureCity`, `recalcMaxCredits`.
- **`TurnResolver.ts`** — executes one full turn in order: (1) income both owners, (2) production queue advancement both owners, (3) turret defensive fire, (4) enemy AI, (5) reset unit flags, (6) victory/defeat check. Income = `cities × 30$ + marketLevel × 25$/turn`, capped by warehouse storage. Returns `TurnResult` with event log.
- **`EnemyAI.ts`** — stateless function `runEnemyAI(state)` called by `TurnResolver`. Enemy queues production by `PRODUCTION_PRIORITY`, then each unit attacks before moving (beneficial for artillery), moves toward nearest player unit/city, and captures cities en route.
- **`CombatResolver.ts`** — simultaneous combat (both units take damage at once). Indirect-fire units (`combat.range > 1`, `specialTrait: "indirect_fire"`) cannot counterattack.
- **`Pathfinder.ts`** — `getReachable()` (BFS) for movement highlights; `findPath()` (A*) for actual movement paths; `getAttackableTargets()` returns enemy hex IDs in combat range (indirect units have minimum range 2). Occupied hexes block passing through; friendly land units allow stopping (triggers merge).
- **`HexUtils.ts`** — all hex math. Axial coordinates (q/r). `hexId(q, r)` → `"q_r"` string used as the map key everywhere.
- **`MapGenerator.ts`** — static 37-cell radius-3 map with terrain overrides and 7 pre-placed cities.

### Renderer (`src/renderer/`) — Three.js, reads GameState but never writes it

- **`SceneManager.ts`** — orthographic camera at isometric angle, OrbitControls pan+zoom only, shadow-mapped directional light.
- **`HexRenderer.ts`** — creates/manages hex cell meshes. Hover and range overlays are separate mesh layers. Shared geometries across all instances.
- **`UnitRenderer.ts`** — `syncWithState()` diffs current meshes against game state, creating/removing as needed. `animateTo()` queues slide animations. Call `update(dt)` every frame.
- **`ModelLoader.ts`** — GLTF/GLB loader with a cache. `preload(paths[])` loads all assets upfront; `clone(path, scaleFactor)` returns a deep-cloned, normalized `THREE.Object3D`. Models are auto-normalized: max horizontal dimension = 1 unit, base at Y = 0.
- **`InputManager.ts`** — raycasting mouse → hex. Fires `onHover` and `onClick` callbacks with the hit `hexId`.
- **`constants.ts`** — `hexToWorld(q, r)` for flat-top layout, `HEX_SIZE = 1.2`, terrain colors, owner colors.

### UI (`src/ui/`)

- **`CityPanel.ts`** — slide-in panel for building upgrades and production queue. Call `refresh()` after any state mutation that should be reflected in an open panel.
- **`dom.ts`** — `el(tag, classes, text?)` shorthand for creating Tailwind-styled DOM elements.

### Wiring (`src/main.ts`)

Orchestrates all three layers. Holds client-side interaction state (`selectedUnitId`, `currentReachable`) that has no place in GameState. The game loop calls `unitRenderer.update(dt)` for animations; all other rendering is event-driven.

## Key Data Contracts

- **Hex IDs**: always `"q_r"` strings (from `hexId()`), never raw `{q, r}` objects passed across layers.
- **Unit blueprints** (`src/data/units.json`): loaded into `GameState.unitBlueprints`. Roster: `infantry_basic`, `infantry_elite`, `tank_medium`, `tank_heavy`, `artillery`, `apc`, `fighter_jet`, `bomber`, `destroyer`, `submarine`, `ballistic_nuke`. Stats live there — don't hardcode values in engine logic.
- **Production**: FIFO queue per city. `TurnResolver` advances only `queue[0]` per turn by `factoryLevel × 50` points. A unit spawns when `progressPoints >= cost.productionNeeded`; if the city hex is occupied the item re-queues at full progress to retry next turn.
- **Combat damage lookup**: use the defender's `movement.type` to pick `damageVsLand/Air/Sea`.
- **Buildings**: `factory`/`barracks`/`warehouse`/`turret`/`market` are levels 0–3; `airport`/`harbor` are binary (0–1). Harbor requires a coastal city (neighbor hex with `terrain === "water"`).
- **Resource cap**: `maxCredits = 500 + warehouseLevel × 250` per owner, recalculated on city capture or warehouse upgrade.
- **Victory/defeat**: player wins when all enemy cities are captured; player loses when all player cities are captured.

## TypeScript Config

Strict mode with `noUnusedLocals`, `noUnusedParameters`, and `noFallthroughCasesInSwitch` — all enforced at build time. Target ES2020, module ESNext.
