# Ashwake

A Norse survival-RPG in the Valheim lineage — procedural island, chopping and
mining, crafting, base building, stamina-driven melee, and a skill tree built
around an oath you can't remember making.

Read `docs/VISION.md` for the design bible and `docs/ARCHITECTURE.md` for the
module contracts.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Options via query string:

- `?seed=vardholm` — any word or number; the seed fully determines the island.
- `?debug` — verbose logging and `window.__ashwake` diagnostics.

## Controls

| | |
|---|---|
| `W A S D` | move |
| `Shift` | sprint (stamina) |
| `Space` | jump |
| `Mouse` | look — click the canvas to capture the pointer |
| `LMB` | light attack (chains into a combo) |
| `RMB` | heavy attack — slow, huge stagger |
| `F` | block; tap on impact to **parry** |
| `E` | interact / harvest |
| `Q` | cast equipped rune (needs the Rime branch) |
| `1`–`8` | hotbar |
| `I` / `Tab` | inventory |
| `C` | crafting |
| `V` | **Vow-Tree** |
| `M` | map |
| `R` | rotate build piece |
| `Esc` | close panel |

## The loop

Chop wood, knap flint, kill a boar, cook it, build a workbench, build a roof
over a campfire to get **Rested**, then push into Myrkvid for copper. Dying
costs you your unspent **Oathmarks** — they drop as a grave-wisp where you fell
and the island eats them after a day, so the walk back is the real gameplay.

Two progression currencies, deliberately different:

- **Proficiency** rises by use (swinging an axe levels Axes) and can't be
  allocated. It lowers stamina cost and extends movesets.
- **Oathmarks** come from Wardens and discoveries and are spent by hand on the
  Vow-Tree: **Iron** (aggression), **Root** (endurance and craft), **Rime**
  (runic magic, which is opt-in and adds an Eitr bar to your HUD).

## Status

Vertical slice. Fjaldmark and Myrkvid are the fully populated biomes; the Mire
and Frostreach generate and are enterable but sparse. The Hollow Stag is the
implemented Warden.

## Layout

```
src/core/      game context, fixed-timestep loop, event bus, input
src/data/      all balance and content tables — items, weapons, recipes,
               enemies, biomes, skills, the Vow-Tree
src/world/     terrain, chunking, biomes, resources, sky, water
src/entities/  player, camera rig, enemies, AI, wardens, spawn director
src/systems/   combat, inventory, crafting, building, progression, survival,
               save, audio
src/ui/        HUD, panels, Vow-Tree screen
```

Simulation runs at a fixed 60 Hz; rendering interpolates. Gameplay logic belongs
in `fixedUpdate`, never in `update`.

No art assets — every mesh, material, and sound is generated at runtime.
