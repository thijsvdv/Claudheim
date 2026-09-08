# ASHWAKE — Design Bible

> *"You died with the words still in your mouth. The island is what's left of them."*

## 1. Premise

Vardhólm is the tenth realm: a drowned island where the Allfather files his
oathbreakers. It is not a punishment so much as a filing error — you died
mid-vow, so Valhalla will not take you and Hel has no claim. You wake on a
black beach with a cold ember in your chest and no memory of what you swore.

The island *is* the broken oath, made into land. Five **Wardens** each hold a
shard of it. Take all five, stand at the Ashwake at the island's heart, and
speak the vow whole — then the door opens.

The twist the player earns rather than is told: the Wardens are previous
oathbreakers who reached the Ashwake and chose to stay. The last boss is a
mirror. The ending is a choice, not a victory.

## 2. Tone

Cold, quiet, and a little funerary. Long stretches of wind and birdsong broken
by something crashing through the treeline. The land is beautiful and does not
care about you. Violence is short, expensive, and usually a mistake.

No text tutorials. The world teaches: a corpse holds a stone axe, a runestone
holds a recipe, a scorched clearing holds a lesson about the Blackwood.

## 3. The Death Loop

Death is the core verb. You cannot truly die — you re-forge at your bound
**Ember** (respawn hearth). But you drop your **Oathmarks** (skill currency) as
a grave-wisp at the place you fell, and your active skill XP takes a hit. The
wisp keeps for one in-game day, then the island eats it.

This is the tension: every trip out is a bet on how far you can push before the
walk home gets too long.

## 4. Progression: Two Currencies

Valheim levels skills by use; RPGs let you spend points. Ashwake does both, and
they mean different things.

- **Proficiency (passive, earned by use).** Swinging an axe raises Axes.
  Proficiency is *muscle memory* — it lowers stamina cost, raises damage a
  little, and unlocks moveset extensions (a third combo swing at 25, a running
  attack at 50). You cannot allocate it. It decays 10% on death.
- **Oathmarks (active, spent deliberately).** Won from Wardens, runestones, and
  first-discovery of a biome. Spent on the **Vow-Tree**. Dropped on death and
  recoverable from your grave-wisp.

### The Vow-Tree — three branches

An oath in the sagas has three parts: what you will do, what you will keep,
what you call to witness.

- **IRON — what you will do.** Aggression. Stagger damage, riposte on parry,
  bleed, rage-on-low-health, weapon-specific capstones.
- **ROOT — what you will keep.** Endurance and craft. Carry weight, gathering
  yield, build integrity, cooking potency, taming, stamina regen.
- **RIME — what you call to witness.** Runes. A third equipment slot casting
  frost, ember, and seidr at the cost of **Eitr** (a blue bar that only exists
  once you take the first Rime node — magic is opt-in, and visibly changes your
  HUD).

Branches are not exclusive, but capstones cost enough that a run commits.

## 5. Biomes (difficulty ring, roughly outward from spawn)

| Biome | Feel | Gates on | Yields |
|---|---|---|---|
| **Fjaldmark** (Meadows) | Golden, safe, birdsong | — | Wood, flint, berries, boar |
| **Myrkvid** (Blackwood) | Dense, dark, always dusk | Nothing, but it bites | Core wood, copper, tin, resin |
| **The Mire** (Swamp) | Waist-deep water, no sun | Poison resist | Iron, guts, root fibre |
| **Frostreach** (Mountains) | Whiteout, cold damage | Cold resist | Silver, obsidian, wolf pelt |
| **The Ashwake** (centre) | Ash falls like snow, no wind | All five shards | Endgame |

Biomes are placed by a deterministic ring + noise mask, so a seed is a world.

## 6. The Wardens

1. **The Hollow Stag** — Fjaldmark. An elk skeleton wearing its own antlers
   like a crown. Charges, calls lightning. *Shard grants: Run — sprint costs less.*
2. **Mother Bramble** — Myrkvid. A witch grown into a stump; roots erupt from
   the arena floor. *Shard grants: Sight — ore veins glow through terrain.*
3. **The Drowned Jarl** — The Mire. Waterlogged king who drags you under.
   *Shard grants: Breath — poison immunity.*
4. **Rimehowl** — Frostreach. A wolf made of weather. *Shard grants: Warmth — cold immunity.*
5. **The Oathbreaker** — The Ashwake. You, one loop earlier, with your build.
   *Grants: the ending.*

## 7. Combat Design

Stamina is the real health bar. Three-button melee:

- **Light** — fast, chains to 3 (4 with proficiency), low stagger.
- **Heavy** — windup, high stagger, breaks blocks.
- **Block / Parry** — hold to block (stamina cost scales with hit); a ~180ms
  window on press is a **parry**: zero stamina, doubles the target's stagger
  meter, opens a **riposte**.

Every enemy has a **stagger meter** that drains over time. Filling it drops
them to a knee for 2s and criticals land. This makes heavy weapons meaningful
against armour and makes parrying the skill ceiling.

Weapon classes have real identity, not stat differences:
- **Sword** — fast, thrust finisher, best DPS, poor vs armour.
- **Axe** — arc that cleaves multiple targets, chops trees.
- **Mace** — slow, enormous stagger, ignores armour, breaks stone.
- **Spear** — reach, thrust from behind a shield, throwable.
- **Bow** — draw-hold with stamina drain, headshot multiplier.
- **Runes** (Rime only) — Eitr cost, no stamina, but a long cast you must protect.

## 8. Survival Layer

Hunger is not a punishment timer. Food does not tick down toward death — it
grants **stacking timed buffs** (up to 3 foods at once) that raise max HP and
stamina. An unfed player is weak, not dying. Cooked food lasts longer than raw.

Shelter, warmth, and rest give a **Rested** buff (regen + XP rate), which is the
game's real reason to build a house.

## 9. Building

Snap-grid structural building with a **load-bearing integrity** system: pieces
far from the ground colour-shift toward red and eventually collapse. Wood
burns; stone does not. A **Workbench** enables crafting in a radius; a
**Hearth** binds your Ember (respawn) and grants Rested.

## 10. What ships in the vertical slice

Fjaldmark + Myrkvid fully playable, The Hollow Stag fightable, all three
Vow-Tree branches present with tier-1 and tier-2 nodes, four weapon classes,
building, cooking, day/night, save/load. The Mire and Frostreach generate and
are enterable but sparse.
