# Ashwake — Architecture & Module Contracts

Three.js r185 + Vite. Vanilla ES modules, no framework, no build-time assets.
All geometry and textures are generated procedurally at runtime.

## Runtime shape

`main.js` builds a single `Game` context and registers **systems**. A system is
a plain object:

```js
{
  name: 'terrain',
  init(game) {},            // once, after all systems constructed
  fixedUpdate(dt, game) {}, // 60 Hz, dt is always 1/60 — simulation only
  update(dt, game) {},      // once per frame, variable dt — rendering/lerp only
  dispose() {},
}
```

Simulation runs on a **fixed 60 Hz accumulator**; rendering interpolates. Never
put gameplay logic in `update()`, and never touch `THREE` transforms you expect
to be authoritative in `fixedUpdate()` — write to entity state, read it in
`update()`.

## The `game` context (src/core/game.js)

| Field | Type | Notes |
|---|---|---|
| `game.scene` `.camera` `.renderer` | THREE | |
| `game.bus` | EventBus | `on(evt, fn) -> off`, `once`, `emit(evt, payload)` |
| `game.seed` | number | world seed; everything deterministic derives from it |
| `game.time` | `{ elapsed, dayFraction, day, isNight }` | `dayFraction` in [0,1) |
| `game.world` | World | terrain/biome/resource queries |
| `game.player` | Player | |
| `game.entities` | EntityRegistry | all damageables |
| `game.items` `.craft` `.build` `.progress` `.combat` `.ui` `.audio` | systems | |
| `game.get(name)` | fn | fetch a registered system |

## Hard interfaces — do not change these signatures

```js
// World (src/world/world.js)
world.heightAt(x, z) -> number            // terrain surface Y, water is y=0
world.normalAt(x, z) -> THREE.Vector3
world.biomeAt(x, z) -> BiomeId            // string, see src/data/biomes.js
world.isWater(x, z) -> boolean
world.sampleGround(x, z) -> { y, normal, biome, slope }
world.resources.near(pos, radius) -> ResourceNode[]
world.resources.damage(node, amount, tool) -> { destroyed, drops: ItemStack[] }

// ResourceNode: { id, kind, position: Vector3, hp, maxHp, tool, tier, chunkKey }

// EntityRegistry (src/core/entities.js)
entities.add(e) / .remove(e) / .near(pos, radius, filter?) -> Entity[]
// Entity (anything damageable) must expose:
//   { id, faction: 'player'|'beast'|'greyfolk'|'undead'|'warden',
//     position: Vector3, radius: number, hp, maxHp, stagger, maxStagger,
//     takeHit(hit) -> HitResult, isDead }

// Combat (src/systems/combat.js)
combat.swing({ attacker, weapon, kind: 'light'|'heavy'|'thrust' })
combat.applyHit(target, hit)
// Hit: { amount, type: 'slash'|'pierce'|'blunt'|'fire'|'frost'|'poison'|'spirit',
//        stagger, knockback, source, crit }

// Player (src/entities/player.js)
player.stats -> { hp, maxHp, stam, maxStam, eitr, maxEitr }
player.spendStamina(n) -> boolean         // false if insufficient
player.damage(hit) / player.heal(n)

// Inventory (src/systems/inventory.js)
inv.add(itemId, count) -> number          // returns count actually added
inv.remove(itemId, count) -> boolean
inv.count(itemId) -> number
inv.slots -> (ItemStack|null)[]           // 32 slots; 0..7 are the hotbar
inv.equipped -> ItemDef|null

// Progression (src/systems/progression.js)
progress.gainXp(skillId, amount)
progress.level(skillId) -> number         // 0..100
progress.has(nodeId) -> boolean           // Vow-Tree node unlocked
progress.oathmarks -> number
```

## Event vocabulary

`player:spawned` `player:died` `player:damaged` `player:levelup`
`entity:killed` `item:gained` `craft:completed` `build:placed`
`resource:harvested` `biome:discovered` `warden:defeated` `time:dawn`
`time:dusk` `ui:toggle` `save:write` `save:load`

## File ownership (one owner per file — agents must not cross)

```
src/core/      game.js loop.js events.js entities.js math.js input.js   [ORCHESTRATOR]
src/data/      items.js recipes.js weapons.js enemies.js biomes.js
               vowtree.js skills.js                                     [ORCHESTRATOR]
src/world/     noise.js terrain.js chunks.js biomes.js resources.js
               sky.js water.js vegetation.js                            [AGENT: world]
src/entities/  player.js camera.js enemy.js ai.js wardens.js spawner.js [AGENT: entities]
src/systems/   combat.js inventory.js crafting.js building.js
               progression.js survival.js save.js audio.js              [AGENT: systems]
src/ui/        hud.js panels.js vowtree.js ui.css                       [AGENT: ui]
```

## Conventions

- Units are metres. Player is 1.8 m tall, walks at 4 m/s, sprints at 7 m/s.
- Water plane is `y = 0`. Terrain spans about −24 … +90 m.
- Chunks are 32 m square, 2 m vertex spacing, loaded in a radius of 6.
- One material per prop type, reused; props render via `InstancedMesh` per chunk.
- No `console.log` in shipped paths; use `game.debug(...)`.
- Every module exports a factory `createX(game)` returning a system object.

## System registry — exact factory names `main.js` imports

Registration order matters (later systems may read earlier ones in `init`):

| Order | Module | Factory | `system.name` |
|---|---|---|---|
| 1 | `world/world.js` | `createWorld(game)` | `world` |
| 2 | `world/sky.js` | `createSky(game)` | `sky` |
| 3 | `systems/inventory.js` | `createInventory(game)` | `inventory` |
| 4 | `systems/progression.js` | `createProgression(game)` | `progression` |
| 5 | `entities/player.js` | `createPlayer(game)` | `player` |
| 6 | `entities/camera.js` | `createCameraRig(game)` | `cameraRig` |
| 7 | `systems/combat.js` | `createCombat(game)` | `combat` |
| 8 | `systems/survival.js` | `createSurvival(game)` | `survival` |
| 9 | `entities/spawner.js` | `createSpawner(game)` | `spawner` |
| 10 | `systems/crafting.js` | `createCrafting(game)` | `crafting` |
| 11 | `systems/building.js` | `createBuilding(game)` | `building` |
| 12 | `systems/audio.js` | `createAudio(game)` | `audio` |
| 13 | `ui/hud.js` | `createHud(game)` | `hud` |
| 14 | `ui/panels.js` | `createPanels(game)` | `panels` |
| 15 | `systems/save.js` | `createSave(game)` | `save` |

Every factory must return an object usable even if its dependencies are
missing — a half-built game should still boot. Guard cross-system reads
(`game.world?.heightAt`) during `init`.

### Save contract
Each system may expose `serialize()` and `hydrate(data)`. `createSave` walks the
registry, collects `{ [system.name]: system.serialize() }`, and writes one
versioned blob to `localStorage['ashwake.save.v1']`. Autosave every 30 s and on
`beforeunload`.
