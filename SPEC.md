# BrowserCiv — Full Specification

**Status:** Draft v0.1 — 2026-05-04
**Owner:** schif94@gmail.com

---

## 1. Vision

A browser-based, turn-based 4X strategy game in the lineage of Civilization V, built from day one to support **wildly asymmetric civilization "packs"** — the standard real-world civs at launch, with future expansions for fictional settings (Avatar: The Last Airbender nations, Naruto villages, Pokemon regions, etc.).

The non-negotiable design constraint: **a new civ pack should be addable as data**, not as engine changes. Flying cities, water-only cities, spirit-realm units, chakra resources — all should fall out of the same content schema.

## 2. Pillars

1. **Faithful Civ V base game.** v1 ships with real-world civs, real tech tree (with per-civ branches), eras, units that evolve over time, cities, production, gold, science, culture, combat, diplomacy, victory conditions.
2. **Asymmetric expandability.** Tile domains, unit traits, restricted resources, per-civ tech trees, and pluggable abilities are first-class. No Civ-V-specific assumptions baked into the engine.
3. **Online multiplayer from day one.** Server-authoritative; sequential turns; reconnection-tolerant.
4. **Cloud-native on AWS.** Static client on S3+CloudFront, authoritative game server on ECS Fargate, realtime via API Gateway WebSockets, persistence in DynamoDB.
5. **Deterministic.** Game logic is a pure reducer over actions. Same actions → same state. Required for replay, debugging, and cheat detection.

## 3. Scope

### In scope for v1 (the "regular game")
- 1 standard map type (Continents), procedurally generated hex map.
- 8–12 real-world civs, each with a unique unit and unique ability (Civ-V style).
- Full tech tree across Ancient → Information era, with civ-specific branches.
- Cities, citizens, tile working, production queues, buildings, wonders.
- Resources: gold (universal), strategic (iron, horses, oil, …), luxury, bonus.
- Units with movement, melee/ranged combat, era-based evolution upgrades.
- Fog of war and unit visibility.
- Diplomacy: peace, war, open borders, trade routes, **lease-unit** action.
- Victory conditions: domination, science, culture, diplomatic, time.
- 2–8 player online multiplayer with sequential turns.
- AI players (basic, not great) so single-human + AIs is playable.
- Save / resume matches.

### Deferred (post-v1)
- Religion, espionage, ideologies, world congress.
- Fan-made civ packs (Avatar/Naruto/Pokemon) — engine must support, content ships later.
- Mobile-optimized UI.
- Spectator mode and replay viewer.
- Ranked matchmaking.
- 3D rendering.

### Explicit non-goals
- Real-time play.
- Mod support that ships arbitrary code (security; we use data-driven content + a registered ability handler whitelist).

## 4. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | Shared types between client/server/content |
| Monorepo | pnpm workspaces + Turborepo | Standard, fast, type-safe cross-package |
| Client rendering | PixiJS (WebGL 2D) | Mature 2D hex rendering, broad browser support |
| Client UI | React | Menus, panels, diplomacy screens |
| Client bundler | Vite | Fast dev loop |
| Server runtime | Node.js 22 LTS | TS sharing with client |
| Server framework | Fastify + custom WS handler | Lightweight, high throughput |
| Realtime | API Gateway WebSockets → ECS | Managed scaling; no sticky sessions on the LB |
| Persistence | DynamoDB (matches, players, snapshots) + S3 (replays, content packs) | Serverless scale |
| Auth | Cognito User Pools (email + Google) | Managed |
| IaC | AWS CDK (TypeScript) | Matches stack; one-language ops |
| CI/CD | GitHub Actions | Standard |
| Schema validation | Zod | Runtime + compile-time types from one definition |
| Content pack format | JSON validated by Zod schemas | Human-editable, diffable |

## 5. Architecture

```
┌──────────────┐   WebSocket    ┌──────────────────────┐
│   Browser    │◄──────────────►│  API Gateway (WS)    │
│  (Pixi+React)│                └──────────┬───────────┘
└──────┬───────┘                           │
       │ HTTPS (static + content packs)    │ $connect / $disconnect / msg
       ▼                                   ▼
  CloudFront ── S3 (client bundle)   ECS Fargate (game server fleet)
                                          │
                                          ├──► DynamoDB  (matches, players, snapshots, action log)
                                          ├──► S3        (replays, large content packs)
                                          └──► Cognito   (auth verify)
```

### Server authority
- Client sends **intents** (`MoveUnit`, `EndTurn`, `OfferTrade`, `LeaseUnit`).
- Server validates intent against current state + active player, applies via the deterministic reducer, persists the action, broadcasts the resulting state delta to all players in the match.
- Clients never compute game truth. They render projected state and submit intents.
- A match is owned by exactly one server instance at a time. Match-to-instance routing via DynamoDB lock + sticky API Gateway connection group.

### Determinism
- All randomness flows from a seeded PRNG persisted with the match. Combat rolls, map gen, AI decisions all draw from it.
- Match state = `(seed, ordered action log)`. Snapshots are an optimization, not source of truth.

## 6. Domain Model — Content Pack Schemas

This is the most important section. **Adding a civ = writing JSON that conforms to these schemas.** Engine code does not change.

### 6.1 ContentPack
```ts
{
  id: string,                         // "core-realworld", "avatar-nations"
  name: string,
  version: semver,
  depends_on: ContentPackId[],        // packs can extend others
  civilizations: Civilization[],
  units: Unit[],
  buildings: Building[],
  wonders: Wonder[],
  techs: Tech[],
  eras: Era[],
  resources: Resource[],
  terrains: Terrain[],
  domains: Domain[],
  traits: Trait[],
  abilities: AbilityRef[],            // references to registered handlers
  diplomacy_actions: DiplomacyAction[],
  victory_conditions: VictoryCondition[]
}
```

### 6.2 Domain
A domain is the "kind of space" a thing exists in. Critical for asymmetric civs.
```ts
{
  id: "land" | "ocean" | "coast" | "air" | "spirit" | string,
  layer: number,                  // z-order on the hex; multiple domains can coexist on a tile
  default_passable_by_traits: TraitId[]
}
```
A flying city literally just sits on a tile whose `air` domain is active and is built by a unit with the `air-mobile` trait.

### 6.3 Trait
Tags on units, civs, tiles, and resources. Drive everything.
```ts
{ id: "airbender" | "amphibious" | "mounted" | ..., display_name, description }
```

### 6.4 Civilization
```ts
{
  id, name, leader_name, color,
  content_pack: ContentPackId,
  home_domain: DomainId,                    // "land" for Romans, "air" for Air Nomads
  starting_units: UnitId[],
  starting_techs: TechId[],
  tech_tree_id: TechTreeId,                 // can be shared or unique
  unique_units: UnitId[],
  unique_buildings: BuildingId[],
  traits: TraitId[],                        // civ-wide traits
  abilities: AbilityRef[],                  // civ-wide passive/active abilities
  resource_access: {
    can_use: ResourceId[] | "all",
    can_harvest: ResourceId[] | "all"       // computed from unit traits at runtime if omitted
  }
}
```

### 6.5 Unit
```ts
{
  id, name,
  domain: DomainId,                         // primary domain it occupies
  passable_domains: DomainId[],             // "amphibious" units list both
  movement: number,
  movement_rules: { ignores_terrain_cost?: TerrainId[], ... },
  combat: { strength, ranged_strength?, range? },
  cost: { production: number, resource_cost?: { [resourceId]: number } },
  prereq_tech: TechId | null,
  era_required: EraId,
  evolves_to: UnitId | null,                // upgrade path through eras
  upgrade_cost: { gold: number },
  traits: TraitId[],                        // "harvester", "airbender", "mounted"
  harvest_traits: TraitId[],                // resources tagged with these can be harvested by this unit
  abilities: AbilityRef[]
}
```

### 6.6 Resource
```ts
{
  id, name, category: "bonus" | "luxury" | "strategic" | "special",
  yields: { food?, production?, gold?, science?, culture? },
  harvestable_by_traits: TraitId[],         // empty = anyone with a worker
  usable_by_civs: CivId[] | "all" | { has_trait: TraitId },
  appears_on_terrains: TerrainId[],
  appears_in_domains: DomainId[]
}
```
Example: `cloud-iron` resource → `harvestable_by_traits: ["airbender"]`, `usable_by_civs: "all"`. Only Air Nomad civs can harvest it, but anyone can use it once acquired (via trade, or via the lease-unit mechanic).

### 6.7 Tech
```ts
{
  id, name, era: EraId, cost: number,
  prereqs: TechId[],
  unlocks: { units?: UnitId[], buildings?: BuildingId[], abilities?: AbilityRef[], resources_visible?: ResourceId[] },
  tree_id: TechTreeId
}
```
Per-civ trees implemented as: civs reference a `tech_tree_id`. Trees can be **entirely separate**, and ultimately will be — fictional packs (Avatar, Naruto, Pokemon) get their own complete tech trees with no shared techs with the real-world tree. The schema supports separate trees natively; v1 may use a shared spine across the real-world civs for balance reasons, but the engine treats the tree as a per-civ choice with no assumption of overlap.

### 6.8 Era
```ts
{ id, name, order: number, unlocked_by_techs: TechId[] }
```
Era determines which units/buildings are constructible and triggers unit evolution prompts when a civ transitions.

### 6.9 Tile / Terrain
```ts
Terrain { id, base_yields, movement_cost, passable_by_traits: TraitId[] }
Tile    { coord: Hex, terrain: TerrainId, domain_state: { [DomainId]: { feature?, resource?, improvement? } } }
```
A single hex can have multiple active domains stacked (a coast tile has both `coast` and `air`; a unit's domain decides which it occupies).

### 6.10 AbilityRef
```ts
{ handler_id: string, params: object }
```
Handlers are **registered in server code under a whitelist** (`abilities/registry.ts`). Content packs reference handlers by ID and pass params. This is the seam between data-driven content and code — adding a fundamentally new mechanic means adding a handler; everything else is data.

Standard handlers v1 ships with:
- `damage_on_attack`, `heal_in_friendly_territory`, `bonus_vs_trait`, `extra_movement_in_terrain`, `produce_yield_per_turn`, `transform_terrain`, `lease_unit_grant_harvest`, etc.

### 6.11 DiplomacyAction
```ts
{ id, name, requires_state, effects: AbilityRef[] }
```
v1 ships: `DeclareWar`, `MakePeace`, `OpenBorders`, `TradeResource`, `TradeGold`, `LeaseUnit`.

#### LeaseUnit (the asymmetry-bridging mechanic)
- Originator selects one of their units that has a `harvest_traits` set the recipient lacks.
- Specifies duration (turns) and price (gold/resource/per-turn yield share).
- On accept: control of the unit transfers to recipient. Originator retains ownership.
- During lease: recipient can move the unit, harvest with it, but **cannot** disband it; if it dies, recipient pays a penalty.
- On expiry: control returns to originator. If still on recipient's territory, it pathfinds home.
- If recipient declares war on originator during lease: unit immediately reverts and is moved to nearest friendly tile. (Open question: should it be capturable instead? Decision deferred.)

### 6.12 VictoryCondition
```ts
{ id, name, check: AbilityRef }   // handler returns boolean against game state
```

## 7. Game Systems — v1 Behavior

| System | v1 Behavior |
|---|---|
| Map gen | Hex grid, configurable size (Duel/Small/Standard/Large), Continents only. Seeded. |
| Turns | Sequential. Active player gets a turn timer (default 120s, configurable per match). On timeout: auto-end-turn. |
| Movement | Pathfinding A* over hexes, weighted by terrain cost and unit `passable_domains`. |
| Combat | Civ V style: strength + terrain mods + flanking + ranged. Deterministic given seed. |
| Cities | Found with Settler. Produce one item at a time. Citizens auto-assign to tiles unless manually set. |
| Production | Hammers from worked tiles + buildings. Buy with gold. |
| Yields | food, production, gold, science, culture (universal). Faith/tourism deferred. |
| Tech | Science accumulates → spend on next tech. Prereq DAG enforced. Civ uses its civ-assigned tech tree. |
| Eras | Auto-advance when X% of civ's era's techs are researched. Triggers evolution offer for eligible units. |
| Unit evolution | At era transition (or Barracks-style upgrade), unit can spend gold to become its `evolves_to`. |
| Resources | Visible only after the prereq tech (`resources_visible`). Worked by improvements built by units with the right `harvest_traits`. |
| Diplomacy | Player-to-player and player-to-AI panel. Action list filtered by state (e.g. can't lease unit during war). |
| Victory | Checked at end of every turn. First to satisfy any condition wins (or score win at time limit). |

## 8. Multiplayer Model

- **Match lifecycle:** `lobby → in_progress → finished`. Lobby supports invite codes and public listing.
- **Player join:** authenticate via Cognito → list active matches / create / join lobby.
- **Connection:** WebSocket via API Gateway. On `$connect`, server validates JWT, looks up match assignment, joins WS connection group.
- **Action submission:** client sends `{type: "MoveUnit", payload: {...}, matchId, actionSeq}`. Server validates active player, applies, persists action #N, broadcasts state delta with `actionSeq`.
- **Reconnection:** client reconnects → requests state at last known `actionSeq` → server replays/sends snapshot + missed actions.
- **Disconnect during your turn:** 60s grace; then AI takes minimal end-turn action; then turn passes.
- **Anti-cheat:** all rules enforced server-side; client is purely a renderer + intent submitter. PRNG is server-only.

## 9. AWS Infrastructure (CDK)

Stacks:
1. `BrowserCivNetworkStack` — VPC, subnets, security groups.
2. `BrowserCivAuthStack` — Cognito user pool + identity pool + Google federation.
3. `BrowserCivDataStack` — DynamoDB tables (`Matches`, `Players`, `Snapshots`, `ActionLog`), S3 buckets (`replays`, `content-packs`).
4. `BrowserCivApiStack` — API Gateway WebSocket API + HTTP API for REST endpoints (lobby list, profile).
5. `BrowserCivGameStack` — ECS Fargate service running game server, ALB or direct API Gateway integration, autoscaling on match count.
6. `BrowserCivClientStack` — S3 bucket + CloudFront distribution for the client bundle.
7. `BrowserCivObservabilityStack` — CloudWatch dashboards, alarms, X-Ray.

DynamoDB table sketches:
- `Matches` — PK: `matchId`, attrs: `state`, `players`, `seed`, `currentTurn`, `lastActionSeq`, `serverInstanceId` (lock).
- `ActionLog` — PK: `matchId`, SK: `actionSeq`. Stream feeds replay export to S3.
- `Snapshots` — PK: `matchId`, SK: `actionSeq` (sparse — every Nth action).

Auth flow for deployment: assume admin role → CDK bootstraps account → CDK provisions a deploy role with least-privilege scoped to these stacks → subsequent CI deploys assume that role only.

## 10. Content Pack & Modding Story

- v1 ships one pack: `core-realworld`.
- Pack format: a directory with `pack.json` + `civilizations/`, `units/`, … as individual JSON files (better diffs than one mega-file).
- Loaded server-side at match start; clients receive the pack manifest and fetch from CloudFront.
- Pack validation: Zod schemas + cross-reference checker (every `prereq_tech` exists, every `harvest_traits` is declared, no orphan handlers).
- Future mod path: official packs first (Avatar, Naruto, Pokemon — built in-house). Community packs are a Phase 8+ topic and require sandboxing of any custom handler logic — **not** in scope for v1.

## 11. Phased Roadmap

| Phase | Deliverable |
|---|---|
| 0 | Monorepo skeleton, Zod schemas for all content types, validator CLI, CDK skeleton (synth-only), CI green, "hello hex" Pixi renderer that loads a static map |
| 1 | Authoritative server, lobby + match creation, multiplayer "empty match" — players see each other on a map, end turn cycles |
| 2 | Units, movement, fog of war, basic terrain |
| 3 | Cities, citizens, production, gold, buildings |
| 4 | Tech tree (shared spine + civ branches), eras, unit evolution |
| 5 | Resources (incl. civ-restricted), worker improvements, lease-unit diplomacy |
| 6 | Combat (melee + ranged), unit traits affecting combat, war/peace |
| 7 | AI players (rule-based), victory conditions, save/resume |
| 8 | Polish, balance, real AWS deploy with downscoped role, closed beta |
| 9+ | Avatar pack as the first proof of expandability |

## 12. Open Questions

1. **Lease-unit during war:** revert to owner, or capturable? (currently: revert.)
2. **Per-civ tech trees:** fully separate vs shared spine + branches? **Decided: must support fully separate trees** — fictional packs will ship their own complete trees. Real-world civs in v1 may share a spine, but engine never assumes overlap.
3. **Map size cap for v1:** what's playable performance-wise on a free-tier-ish Fargate task? Needs load test.
4. **Hex coordinate system:** axial vs cube. (Recommendation: axial for storage, cube for math; standard pattern.)
5. **Replay format:** raw action log (small, requires server replay) vs periodic snapshot (large, client-replayable). (Recommendation: action log + every-50-turn snapshot.)
6. **Trait conflicts across packs:** if pack A defines trait `airbender` and pack B does too, do they merge? (Recommendation: trait IDs are pack-namespaced; cross-pack trait equivalence is explicit via aliases.)
7. **Handler whitelist vs sandboxed scripting:** v1 is whitelist-only. Long-term mod story may need a sandbox (QuickJS/Wasm). Decision deferred.

## 13. Risks

- **Scope.** This is a large project. Phase 0–7 is ~6–12 months of focused work for one developer. Mitigation: phase gates, playable milestones each phase.
- **AI quality.** Civ-quality AI is hard. v1 ships rule-based "good enough for filler." Acceptable for human-vs-human focus.
- **Determinism leaks.** Any `Date.now()`, `Math.random()`, or unsorted-iteration in game logic breaks replay/multiplayer. Mitigation: lint rule banning these in `packages/server/src/game/`; only use `Rng.next()` from the seeded source.
- **AWS cost on idle.** Fargate has a per-task minimum cost. Mitigation: scale-to-zero with one warm task; matches cluster onto fewer tasks; consider Lambda for AI-only matches.
- **Content schema churn.** Schema changes invalidate saved games. Mitigation: schema versioning + migration functions per content type from day one.

## 14. Glossary

- **Pack** — a content bundle (real-world, Avatar, etc.). Self-contained set of civs/units/etc.
- **Domain** — a layer of space on a tile (land, air, ocean, spirit). Units occupy one; tiles host many.
- **Trait** — a tag. Drives ability targeting, terrain passability, harvest eligibility.
- **Handler** — a registered server-side function referenced by content. The whitelist seam between data and code.
- **Lease** — temporary control transfer of a unit to another player, ownership unchanged.
