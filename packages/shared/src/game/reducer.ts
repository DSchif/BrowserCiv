import { distance, key as hexKey, neighbors as neighborsOf } from "../hex.js";
import type { ContentPack, Terrain, UnitDef } from "../schemas/index.js";
import type { Action } from "./actions.js";
import { entryCost } from "./path.js";
import { canResearch, computeEra, defaultEra, lookupTech } from "./tech.js";
import { checkResourceCost, recomputeAllResources } from "./resources.js";
import {
  cityDefenseStrength,
  getCityAttacks,
  diplomacyKey,
  effectivenessMultiplier,
  getUnitAttacks,
  getUnitTypes,
  resolveCityAttack,
  resolveMelee,
  resolveRanged,
} from "./combat.js";
import { checkVictory } from "./victory.js";
import {
  CITY_RADIUS,
  FOOD_TO_GROW_BASE,
  applyHealing,
  applyWonderEmpireYields,
  buildableBuildings,
  cityResources,
  buildableUnits,
  canFoundCityAt,
  nextCityName,
  processPlayerTurn,
  recomputeAllCities,
} from "./city.js";
import { generateMap, pickStartingPositions } from "./map-gen.js";
import { findPath } from "./path.js";
import * as Rng from "./rng.js";
import type { City, MatchState, Player, ProductionItem, Unit } from "./state.js";
import { cityTerritory } from "./territory.js";
import { rememberVisible, rememberVisibleAll } from "./visibility.js";

export class GameRuleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameRuleError";
  }
}

export function reduce(
  prev: MatchState | null,
  action: Action,
  content: ContentPack,
): MatchState {
  if (action.type === "MatchCreate") {
    if (prev !== null)
      throw new GameRuleError("ALREADY_EXISTS", "match already exists");
    const civ = lookupCiv(content, action.hostCivId);
    if (!civ)
      throw new GameRuleError("NO_SUCH_CIV", `civ ${action.hostCivId} not in pack`);
    return {
      id: action.matchId,
      seed: action.seed,
      rng: Rng.rng(action.seed),
      status: "lobby",
      hostId: action.hostId,
      contentPackId: action.contentPackId,
      players: [
        {
          id: action.hostId,
          name: action.hostName,
          primary_color: civ.primary_color,
          secondary_color: civ.secondary_color,
          civId: action.hostCivId,
          connected: false,
          startingHex: null,
          gold: 0,
          science: 0,
          culture: 0,
          researchedTechs: civ.starting_techs.map((t) => t as unknown as string),
          currentTech: null,
          era: defaultEra(content),
          availableResources: {},
        },
      ],
      currentPlayerIndex: 0,
      turnNumber: 0,
      map: null,
      units: [],
      cities: [],
      tileOwnership: {},
      seenTiles: {},
      actionSeq: 1,
      createdAt: action.createdAt,
      startedAt: null,
      log: [
        { turn: 0, actionSeq: 1, text: `Match created by ${action.hostName}` },
      ],
      nextUnitId: 1,
      nextCityId: 1,
      cityCounters: {},
      mapSize: action.mapSize,
      diplomacy: {},
      wondersBuilt: {},
    };
  }

  if (prev === null)
    throw new GameRuleError("NOT_FOUND", "match does not exist");

  const seq = prev.actionSeq + 1;

  switch (action.type) {
    case "PlayerJoin": {
      if (prev.status !== "lobby")
        throw new GameRuleError("BAD_STATE", "match is not accepting joins");
      if (prev.players.some((p) => p.id === action.playerId))
        throw new GameRuleError("ALREADY_JOINED", "player already in match");
      if (prev.players.some((p) => p.civId === action.civId))
        throw new GameRuleError("CIV_TAKEN", "civilization already taken");
      const civ = lookupCiv(content, action.civId);
      if (!civ)
        throw new GameRuleError("NO_SUCH_CIV", `civ ${action.civId} not in pack`);
      const newPlayer: Player = {
        id: action.playerId,
        name: action.name,
        primary_color: civ.primary_color,
        secondary_color: civ.secondary_color,
        civId: action.civId,
        connected: false,
        startingHex: null,
        gold: 0,
        science: 0,
        culture: 0,
        researchedTechs: civ.starting_techs.map((t) => t as unknown as string),
        currentTech: null,
        era: computeEra(
          {
            researchedTechs: civ.starting_techs.map((t) => t as unknown as string),
            era: defaultEra(content),
          } as Player,
          content,
        ),
        availableResources: {},
      };
      return {
        ...prev,
        actionSeq: seq,
        players: [...prev.players, newPlayer],
        log: appendLog(prev, seq, `${action.name} joined the lobby`),
      };
    }

    case "PlayerLeave": {
      if (prev.status === "in_progress")
        throw new GameRuleError(
          "BAD_STATE",
          "leaving in-progress matches is not yet supported",
        );
      const leaver = prev.players.find((p) => p.id === action.playerId);
      if (!leaver) throw new GameRuleError("NOT_FOUND", "no such player");
      const remaining = prev.players.filter((p) => p.id !== action.playerId);
      if (remaining.length === 0)
        return { ...prev, status: "finished", players: remaining, actionSeq: seq };
      const newHostId = leaver.id === prev.hostId ? remaining[0]!.id : prev.hostId;
      return {
        ...prev,
        actionSeq: seq,
        players: remaining,
        hostId: newHostId,
        log: appendLog(prev, seq, `${leaver.name} left the lobby`),
      };
    }

    case "SetConnected": {
      const idx = prev.players.findIndex((p) => p.id === action.playerId);
      if (idx === -1) throw new GameRuleError("NOT_FOUND", "no such player");
      const players = prev.players.slice();
      players[idx] = { ...players[idx]!, connected: action.connected };
      return { ...prev, actionSeq: seq, players };
    }

    case "MatchStart": {
      if (prev.status !== "lobby")
        throw new GameRuleError("BAD_STATE", "match already started");
      if (action.actorId !== prev.hostId)
        throw new GameRuleError("NOT_HOST", "only host may start the match");
      if (prev.players.length < 2)
        throw new GameRuleError("TOO_FEW_PLAYERS", "need at least 2 players");

      const gen = generateMap(prev.rng, prev.mapSize, content);

      // Required-units = union of every starting civ's starting_units. A
      // chosen hex must be enterable by all of them so they can spawn there.
      const requiredUnits = (() => {
        const seen = new Set<string>();
        const arr: import("../schemas/index.js").UnitDef[] = [];
        for (const p of prev.players) {
          if (!p.civId) continue;
          const civ = content.civilizations.find((c) => (c.id as unknown as string) === p.civId);
          if (!civ) continue;
          for (const uid of civ.starting_units) {
            const id = uid as unknown as string;
            if (seen.has(id)) continue;
            const def = content.units.find((u) => (u.id as unknown as string) === id);
            if (def) {
              arr.push(def);
              seen.add(id);
            }
          }
        }
        return arr;
      })();

      const starts = pickStartingPositions(
        gen.rngState,
        gen.map,
        prev.players.length,
        content,
        requiredUnits,
      );

      const players = prev.players.map((p, i) => ({
        ...p,
        startingHex: starts.positions[i] ?? null,
      }));

      let nextUnitId = prev.nextUnitId;
      const units: Unit[] = [];
      const tilesByKey = new Map(
        gen.map.tiles.map((t) => [hexKey({ q: t.q, r: t.r }), t]),
      );
      const terrainsById = new Map(
        content.terrains.map((t) => [t.id as unknown as string, t]),
      );
      for (const p of players) {
        if (!p.startingHex || !p.civId) continue;
        const civ = content.civilizations.find((c) => (c.id as unknown as string) === p.civId);
        if (!civ) continue;
        const occupied = new Set<string>();
        for (let i = 0; i < civ.starting_units.length; i++) {
          const defId = civ.starting_units[i] as unknown as string;
          const def = content.units.find((u) => (u.id as unknown as string) === defId);
          if (!def) continue;

          // Place each unit on the starting hex if free; else first free
          // enterable neighbor; else fall back to the starting hex anyway.
          const start = p.startingHex!;
          const candidates: import("../hex.js").AxialCoord[] = [
            start,
            ...neighborsOf(start),
          ];
          let placement = start;
          for (const c of candidates) {
            const k = hexKey(c);
            if (occupied.has(k)) continue;
            const tile = tilesByKey.get(k);
            if (!tile) continue;
            const terrain = terrainsById.get(tile.terrain);
            if (!terrain) continue;
            const cost = entryCostFor(def, terrain);
            if (cost === null) continue;
            placement = c;
            break;
          }
          occupied.add(hexKey(placement));

          units.push({
            id: `u${nextUnitId++}`,
            ownerId: p.id,
            defId,
            position: { ...placement },
            movementMax: def.movement,
            movementLeft: def.movement,
            hp: 100,
            hpMax: 100,
          });
        }
      }

      const next: MatchState = {
        ...prev,
        actionSeq: seq,
        status: "in_progress",
        rng: starts.rngState,
        map: gen.map,
        players,
        currentPlayerIndex: 0,
        turnNumber: 1,
        startedAt: action.startedAt,
        units,
        nextUnitId,
        log: appendLog(prev, seq, `Match started — turn 1, ${players[0]!.name} to act`),
      };
      return rememberVisibleAll(next);
    }

    case "EndTurn": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (!current) throw new GameRuleError("NO_CURRENT", "no current player");
      if (action.actorId !== current.id)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");

      const nextIndex = (prev.currentPlayerIndex + 1) % prev.players.length;
      const nextTurn =
        nextIndex === 0 ? prev.turnNumber + 1 : prev.turnNumber;
      const nextPlayer = prev.players[nextIndex]!;

      // Refresh movement for the player whose turn is about to start.
      const refreshed = prev.units.map((u) =>
        u.ownerId === nextPlayer.id ? { ...u, movementLeft: u.movementMax } : u,
      );

      // Process incoming player's economy.
      let s: MatchState = {
        ...prev,
        actionSeq: seq,
        currentPlayerIndex: nextIndex,
        turnNumber: nextTurn,
        units: refreshed,
        log: appendLog(
          prev,
          seq,
          `${current.name} ended turn — turn ${nextTurn}, ${nextPlayer.name} to act`,
        ),
      };
      const turnResult = processPlayerTurn(s, nextPlayer.id, content);
      s = turnResult.state;
      for (const text of turnResult.logs) {
        s = { ...s, log: appendLog(s, s.actionSeq, text) };
      }
      // Recompute yields after population/buildings may have changed.
      s = recomputeAllCities(s, content);
      // Sight may have changed due to new units/buildings — refresh memory.
      s = rememberVisibleAll(s);
      // Victory check at end of turn cycle.
      const win = checkVictory(s, content);
      if (win) {
        const winnerName = win.winnerId
          ? s.players.find((p: Player) => p.id === win.winnerId)?.name ?? "(unknown)"
          : "(no winner)";
        s = {
          ...s,
          status: "finished",
          winnerId: win.winnerId ?? null,
          victoryReason: win.reason,
          log: appendLog(s, s.actionSeq, `Match finished — ${winnerName} won by ${win.reason}`),
        };
      }
      return s;
    }

    case "MoveUnit": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      if (!prev.map) throw new GameRuleError("BAD_STATE", "no map");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");

      const unitIdx = prev.units.findIndex((u) => u.id === action.unitId);
      if (unitIdx === -1) throw new GameRuleError("NOT_FOUND", "no such unit");
      const unit = prev.units[unitIdx]!;
      if (unit.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "you do not control that unit");

      if (
        unit.position.q === action.target.q &&
        unit.position.r === action.target.r
      ) {
        return prev;
      }

      // Detect what's on the target hex.
      const occupant = prev.units.find(
        (u) =>
          u.id !== unit.id &&
          u.position.q === action.target.q &&
          u.position.r === action.target.r,
      );
      const cityOnTarget = prev.cities.find(
        (c) => c.position.q === action.target.q && c.position.r === action.target.r,
      );

      // Friendly occupant blocks (you can't trample your own).
      if (occupant && occupant.ownerId === action.actorId) {
        throw new GameRuleError("OCCUPIED", "your own unit is on that hex");
      }
      // Friendly city → blocked (no garrison mechanic yet).
      if (cityOnTarget && cityOnTarget.ownerId === action.actorId) {
        throw new GameRuleError("OCCUPIED", "your own city is on that hex");
      }
      // Enemy city with a defender on top → fall through to enemy-occupant path
      // (the unit check above already takes care of it). Enemy city with no
      // defender → resolve as a city attack.
      if (cityOnTarget && cityOnTarget.ownerId !== action.actorId && !occupant) {
        const dipKey = diplomacyKey(action.actorId, cityOnTarget.ownerId);
        if (prev.diplomacy[dipKey] !== "war") {
          prev = { ...prev, diplomacy: { ...prev.diplomacy, [dipKey]: "war" as const } };
        }
        if (
          Math.abs(unit.position.q - action.target.q) +
            Math.abs(unit.position.r - action.target.r) +
            Math.abs(
              -unit.position.q - unit.position.r - (-action.target.q - action.target.r),
            ) >
          2
        ) {
          throw new GameRuleError("NOT_ADJACENT", "must be adjacent to attack city");
        }
        if (unit.movementLeft <= 0) {
          throw new GameRuleError("NO_MOVES", "no movement left to attack");
        }

        const aDef = unitDef(content, unit.defId);
        // Compute defense from buildings + era proxy (turn).
        const defStr = cityDefenseStrength(cityOnTarget, content, prev.turnNumber);
        const result = resolveCityAttack(unit, cityOnTarget.hp, cityOnTarget.hpMax, defStr, content);

        // Apply damage to attacker.
        let newUnits = prev.units.map((u) =>
          u.id === unit.id
            ? { ...u, hp: Math.max(0, u.hp - result.attackerDamage), movementLeft: 0, fortified: false, attackedThisTurn: true }
            : u,
        );
        if (result.attackerKilled) newUnits = newUnits.filter((u) => u.id !== unit.id);

        // Apply damage to city + capture if killed.
        let newCities = prev.cities.slice();
        const idx = newCities.findIndex((c) => c.id === cityOnTarget.id);
        if (result.defenderKilled) {
          // Capture: transfer ownership, halve HP, reset production + culture.
          const captured: City = {
            ...cityOnTarget,
            ownerId: action.actorId,
            hp: Math.floor(cityOnTarget.hpMax / 2),
            productionItem: null,
            production: 0,
            cultureAccumulated: 0,
          };
          newCities[idx] = captured;
          // Update tileOwnership: tiles previously owned by this city now belong to attacker.
          // tileOwnership is keyed by hexKey → cityId. CityId stays; just owner of city changed.
          // No change to tileOwnership necessary (cityId still owns those hexes).
          // Move attacker onto the captured city tile (if survived).
          if (!result.attackerKilled) {
            newUnits = newUnits.map((u) =>
              u.id === unit.id ? { ...u, position: { ...action.target } } : u,
            );
          }
        } else {
          newCities[idx] = { ...cityOnTarget, hp: Math.max(0, cityOnTarget.hp - result.cityDamage) };
        }

        const summary =
          `${aDef?.name ?? unit.defId} attacked ${cityOnTarget.name} — ${result.cityDamage} city dmg, ${result.attackerDamage} attacker dmg` +
          (result.defenderKilled ? ` · ${cityOnTarget.name} captured!` : "") +
          (result.attackerKilled ? " · attacker killed" : "");

        let s: MatchState = {
          ...prev,
          actionSeq: seq,
          units: newUnits,
          cities: newCities,
          log: appendLog(prev, seq, summary),
        };
        s = recomputeAllCities(s, content);
        s = recomputeAllResources(s, content);
        return rememberVisible(s, action.actorId);
      }
      // Enemy city WITH defender unit: fall through to enemy-occupant attack
      // path below (unit takes the hit, not the city — same as Civ V).


      // Enemy occupant → this is an attack. Auto-declare war (Civ V style).
      if (occupant && occupant.ownerId !== action.actorId) {
        const dipKey = diplomacyKey(action.actorId, occupant.ownerId);
        if (prev.diplomacy[dipKey] !== "war") {
          prev = { ...prev, diplomacy: { ...prev.diplomacy, [dipKey]: "war" as const } };
        }
        // Attacker must be adjacent (cost ≤ 1 in unit's terrain table on the target tile).
        if (Math.abs(unit.position.q - action.target.q) + Math.abs(unit.position.r - action.target.r) + Math.abs((-unit.position.q - unit.position.r) - (-action.target.q - action.target.r)) > 2) {
          // If not adjacent, force the unit to walk closer first.
          throw new GameRuleError("NOT_ADJACENT", "melee target must be adjacent");
        }
        if (unit.movementLeft <= 0) {
          throw new GameRuleError("NO_MOVES", "no movement left to attack");
        }
        // Resolve melee combat with optional specific attack id.
        const aDef = unitDef(content, unit.defId);
        let chosen: import("./combat.js").Attack | undefined;
        if (action.attackId && aDef) {
          chosen = getUnitAttacks(aDef).find((a) => a.id === action.attackId);
          if (!chosen)
            throw new GameRuleError("NO_SUCH_ATTACK", "attackId not on unit");
          if (chosen.range > 1)
            throw new GameRuleError("NOT_MELEE", "attack is not melee");
          const cd = unit.attackCooldowns?.[chosen.id] ?? 0;
          if (cd > 0)
            throw new GameRuleError("COOLDOWN", `attack on cooldown for ${cd} more turn(s)`);
          if (chosen.charges !== undefined) {
            const used = unit.attackChargesUsed?.[chosen.id] ?? 0;
            if (used >= chosen.charges)
              throw new GameRuleError("NO_CHARGES", "attack has no charges left");
          }
        }
        const result = resolveMelee(unit, occupant, content, chosen);
        const attackerName = aDef?.name ?? unit.defId;
        const defenderName = unitDef(content, occupant.defId)?.name ?? occupant.defId;

        let newUnits = prev.units.map((u) => {
          if (u.id === unit.id) {
            const hp = Math.max(0, u.hp - result.attackerDamage);
            const next: typeof u = {
              ...u,
              hp,
              movementLeft: 0,
              fortified: false,
              attackedThisTurn: true,
            };
            if (chosen) {
              if (chosen.cooldown > 0) {
                next.attackCooldowns = { ...(u.attackCooldowns ?? {}), [chosen.id]: chosen.cooldown };
              }
              if (chosen.charges !== undefined) {
                const used = (u.attackChargesUsed?.[chosen.id] ?? 0) + 1;
                next.attackChargesUsed = { ...(u.attackChargesUsed ?? {}), [chosen.id]: used };
              }
            }
            return next;
          }
          if (u.id === occupant.id) {
            const hp = Math.max(0, u.hp - result.defenderDamage);
            return { ...u, hp };
          }
          return u;
        });
        if (result.attackerKilled) newUnits = newUnits.filter((u) => u.id !== unit.id);
        if (result.defenderKilled) newUnits = newUnits.filter((u) => u.id !== occupant.id);

        // If defender died and attacker survived, attacker advances onto the tile.
        if (result.defenderKilled && !result.attackerKilled) {
          newUnits = newUnits.map((u) =>
            u.id === unit.id ? { ...u, position: { ...action.target } } : u,
          );
        }

        const summary =
          `${attackerName} attacked ${defenderName} — ` +
          `${result.attackerDamage}/${result.defenderDamage} dmg` +
          `${result.attackerKilled ? " · attacker killed" : ""}` +
          `${result.defenderKilled ? " · defender killed" : ""}`;

        let s: MatchState = {
          ...prev,
          actionSeq: seq,
          units: syncCargo(newUnits),
          log: appendLog(prev, seq, summary),
        };
        s = recomputeAllResources(s, content);
        return rememberVisible(s, action.actorId);
      }

      // Pure movement (no enemy on target). Long paths are split:
      // walk as far as MP allows this turn; queue the remainder as pendingPath.
      const def = unitDef(content, unit.defId);
      const traits = def?.traits.map((t) => t as unknown as string) ?? [];
      const path = findPath(prev.map, unit.position, action.target, content, {
        unitTraits: traits,
        unitTerrainCosts: def?.terrain_costs as Record<string, number> | undefined,
      });
      if (!path) throw new GameRuleError("NO_PATH", "no path to target");

      // Find furthest reachable step within current MP.
      let lastReachableIdx = -1;
      for (let i = 0; i < path.steps.length; i++) {
        if (path.steps[i]!.costSoFar <= unit.movementLeft) lastReachableIdx = i;
        else break;
      }

      const newUnits = prev.units.slice();
      let logText: string;
      if (lastReachableIdx === -1) {
        // Can't move any tile this turn — queue the whole path.
        newUnits[unitIdx] = {
          ...unit,
          fortified: false,
          pendingPath: path.steps.map((s) => s.coord),
        };
        logText = `${current.name} queued a path for ${def?.name ?? unit.defId} (${path.steps.length} hexes)`;
      } else {
        const reachedStep = path.steps[lastReachableIdx]!;
        const remaining = path.steps.slice(lastReachableIdx + 1).map((s) => s.coord);
        const next: Unit = {
          ...unit,
          position: { ...reachedStep.coord },
          movementLeft: unit.movementLeft - reachedStep.costSoFar,
          fortified: false,
        };
        if (remaining.length > 0) next.pendingPath = remaining;
        else delete next.pendingPath;
        newUnits[unitIdx] = next;
        logText =
          remaining.length > 0
            ? `${current.name} began walking a ${def?.name ?? unit.defId} (${remaining.length} hexes remaining)`
            : `${current.name} moved a ${def?.name ?? unit.defId} to (${action.target.q},${action.target.r})`;
      }

      const moved: MatchState = {
        ...prev,
        actionSeq: seq,
        units: syncCargo(newUnits),
        log: appendLog(prev, seq, logText),
      };
      return rememberVisible(moved, action.actorId);
    }

    case "DeclareWar": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      if (action.actorId === action.targetPlayerId)
        throw new GameRuleError("SELF", "cannot declare war on yourself");
      const target = prev.players.find((p) => p.id === action.targetPlayerId);
      if (!target) throw new GameRuleError("NOT_FOUND", "no such player");
      const k = diplomacyKey(action.actorId, action.targetPlayerId);
      const dip = { ...prev.diplomacy, [k]: "war" as const };
      const actor = prev.players.find((p) => p.id === action.actorId)!;
      return {
        ...prev,
        actionSeq: seq,
        diplomacy: dip,
        log: appendLog(prev, seq, `${actor.name} declared war on ${target.name}`),
      };
    }

    case "MakePeace": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const target = prev.players.find((p) => p.id === action.targetPlayerId);
      if (!target) throw new GameRuleError("NOT_FOUND", "no such player");
      const k = diplomacyKey(action.actorId, action.targetPlayerId);
      const dip = { ...prev.diplomacy };
      delete dip[k];
      const actor = prev.players.find((p) => p.id === action.actorId)!;
      return {
        ...prev,
        actionSeq: seq,
        diplomacy: dip,
        log: appendLog(prev, seq, `${actor.name} made peace with ${target.name}`),
      };
    }

    case "RangedAttack": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      if (!prev.map) throw new GameRuleError("BAD_STATE", "no map");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");

      const attackerIdx = prev.units.findIndex((u) => u.id === action.unitId);
      if (attackerIdx === -1) throw new GameRuleError("NOT_FOUND", "no such unit");
      const attacker = prev.units[attackerIdx]!;
      if (attacker.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "not your unit");
      if (attacker.movementLeft <= 0)
        throw new GameRuleError("NO_MOVES", "no moves left");

      const target = prev.units.find((u) => u.id === action.targetUnitId);
      if (!target) throw new GameRuleError("NOT_FOUND", "no such target");
      if (target.ownerId === action.actorId)
        throw new GameRuleError("SELF", "cannot attack own unit");

      const dipKey = diplomacyKey(action.actorId, target.ownerId);
      if (prev.diplomacy[dipKey] !== "war") {
        prev = { ...prev, diplomacy: { ...prev.diplomacy, [dipKey]: "war" as const } };
      }

      const def = unitDef(content, attacker.defId);
      // Resolve which attack to use.
      let chosenRanged: import("./combat.js").Attack | undefined;
      const allAttacks = def ? getUnitAttacks(def) : [];
      if (action.attackId) {
        chosenRanged = allAttacks.find((a) => a.id === action.attackId);
        if (!chosenRanged)
          throw new GameRuleError("NO_SUCH_ATTACK", "attackId not on unit");
        if (chosenRanged.range <= 1)
          throw new GameRuleError("NOT_RANGED", "attack is not ranged");
        const cd = attacker.attackCooldowns?.[chosenRanged.id] ?? 0;
        if (cd > 0)
          throw new GameRuleError("COOLDOWN", `attack on cooldown for ${cd} more turn(s)`);
        if (chosenRanged.charges !== undefined) {
          const used = attacker.attackChargesUsed?.[chosenRanged.id] ?? 0;
          if (used >= chosenRanged.charges)
            throw new GameRuleError("NO_CHARGES", "attack has no charges left");
        }
      } else {
        chosenRanged = allAttacks.find((a) => a.range > 1);
      }
      const range = chosenRanged?.range ?? def?.combat.range ?? 0;
      if (range <= 1)
        throw new GameRuleError("NOT_RANGED", "unit has no ranged attack");
      const dq = attacker.position.q - target.position.q;
      const dr = attacker.position.r - target.position.r;
      const ds = -dq - dr;
      const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
      if (dist > range)
        throw new GameRuleError("OUT_OF_RANGE", `target is ${dist} away, range is ${range}`);

      const result = resolveRanged(attacker, target, content, chosenRanged);
      let newUnits = prev.units.map((u) => {
        if (u.id === attacker.id) {
          const next: typeof u = {
            ...u,
            movementLeft: 0,
            attackedThisTurn: true,
            fortified: false,
          };
          if (chosenRanged) {
            if (chosenRanged.cooldown > 0) {
              next.attackCooldowns = { ...(u.attackCooldowns ?? {}), [chosenRanged.id]: chosenRanged.cooldown };
            }
            if (chosenRanged.charges !== undefined) {
              const used = (u.attackChargesUsed?.[chosenRanged.id] ?? 0) + 1;
              next.attackChargesUsed = { ...(u.attackChargesUsed ?? {}), [chosenRanged.id]: used };
            }
          }
          return next;
        }
        if (u.id === target.id) return { ...u, hp: Math.max(0, u.hp - result.defenderDamage) };
        return u;
      });
      if (result.defenderKilled) newUnits = newUnits.filter((u) => u.id !== target.id);

      const attackerName = def?.name ?? attacker.defId;
      const defenderName = unitDef(content, target.defId)?.name ?? target.defId;
      const summary =
        `${attackerName} ranged-attacked ${defenderName} — ${result.defenderDamage} dmg` +
        `${result.defenderKilled ? " · target killed" : ""}`;
      let s: MatchState = {
        ...prev,
        actionSeq: seq,
        units: syncCargo(newUnits),
        log: appendLog(prev, seq, summary),
      };
      s = recomputeAllResources(s, content);
      return s;
    }

    case "BuildImprovement": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      if (!prev.map) throw new GameRuleError("BAD_STATE", "no map");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");
      const worker = prev.units.find((u) => u.id === action.unitId);
      if (!worker) throw new GameRuleError("NOT_FOUND", "no such unit");
      if (worker.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "not your unit");
      const def = unitDef(content, worker.defId);
      const isWorker = def?.traits.some((t) => (t as unknown as string) === "worker");
      if (!isWorker)
        throw new GameRuleError("NOT_A_WORKER", "only workers can build improvements");

      const tileIdx = prev.map.tiles.findIndex(
        (t) => t.q === worker.position.q && t.r === worker.position.r,
      );
      if (tileIdx === -1) throw new GameRuleError("OFF_MAP", "off map");
      const tile = prev.map.tiles[tileIdx]!;
      if (tile.improvement)
        throw new GameRuleError("HAS_IMPROVEMENT", "tile already has an improvement");
      if (tile.workInProgress)
        throw new GameRuleError("WIP", "improvement already in progress here");

      const imp = content.improvements.find(
        (i) => (i.id as unknown as string) === action.improvementId,
      );
      if (!imp) throw new GameRuleError("NOT_FOUND", "no such improvement");
      const compatTerrains = imp.terrain_compat.map((t) => t as unknown as string);
      if (compatTerrains.length > 0 && !compatTerrains.includes(tile.terrain))
        throw new GameRuleError(
          "INCOMPATIBLE_TERRAIN",
          `${imp.name} cannot be built on ${tile.terrain}`,
        );
      if (
        imp.prereq_tech &&
        !current!.researchedTechs.includes(imp.prereq_tech as unknown as string)
      )
        throw new GameRuleError("MISSING_TECH", "prereq tech not researched");

      const newTiles = prev.map.tiles.slice();
      newTiles[tileIdx] = {
        ...tile,
        workInProgress: {
          unitId: worker.id,
          improvementId: action.improvementId,
          turnsLeft: imp.build_turns,
        },
      };
      const newUnits = prev.units.map((u) =>
        u.id === worker.id ? { ...u, movementLeft: 0 } : u,
      );
      return {
        ...prev,
        actionSeq: seq,
        map: { ...prev.map, tiles: newTiles },
        units: newUnits,
        log: appendLog(
          prev,
          seq,
          `${current!.name} began building ${imp.name} at (${tile.q},${tile.r}) — ${imp.build_turns} turns`,
        ),
      };
    }

    case "FoundCity": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      if (!prev.map) throw new GameRuleError("BAD_STATE", "no map");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");

      const unitIdx = prev.units.findIndex((u) => u.id === action.unitId);
      if (unitIdx === -1) throw new GameRuleError("NOT_FOUND", "no such unit");
      const unit = prev.units[unitIdx]!;
      if (unit.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "not your unit");

      const def = unitDef(content, unit.defId);
      const isSettler = def?.traits.some((t) => (t as unknown as string) === "settler");
      if (!isSettler)
        throw new GameRuleError("NOT_A_SETTLER", "only settlers can found cities");

      if (!canFoundCityAt(prev, unit.position))
        throw new GameRuleError(
          "TOO_CLOSE",
          "another city is too close to found here",
        );

      const tile = prev.map.tiles.find(
        (t) => t.q === unit.position.q && t.r === unit.position.r,
      );
      if (!tile) throw new GameRuleError("OFF_MAP", "off map");
      const terrain = content.terrains.find((t) => (t.id as unknown as string) === tile.terrain);
      if (terrain?.impassable)
        throw new GameRuleError("IMPASSABLE", "cannot found on impassable terrain");

      const cityId = `c${prev.nextCityId}`;
      const cityName = nextCityName(prev, content, action.actorId);
      const initialFootprint = cityTerritory(prev.map, unit.position);
      const newCity: City = {
        id: cityId,
        ownerId: action.actorId,
        name: cityName,
        position: { ...unit.position },
        population: 1,
        food: 0,
        foodToGrow: FOOD_TO_GROW_BASE + 6,
        production: 0,
        productionItem: null,
        buildings: [],
        wonders: [],
        workedTiles: [],
        ownedTiles: initialFootprint,
        perTurnYields: {},
        hp: 200,
        hpMax: 200,
        foundedTurn: prev.turnNumber,
        cultureAccumulated: 0,
        cultureToExpand: 10,
      };

      // Drop the settler. Phase 3: settler is consumed.
      const newUnits = prev.units.slice();
      newUnits.splice(unitIdx, 1);

      // Update tileOwnership: this city now owns its footprint (tiles not
      // already owned by someone else).
      const newOwnership: Record<string, string> = { ...prev.tileOwnership };
      for (const k of cityTerritory(prev.map, newCity.position)) {
        if (!newOwnership[k]) newOwnership[k] = cityId;
      }

      const cityCounter = (prev.cityCounters[action.actorId] ?? 0) + 1;
      const cityCounters = {
        ...prev.cityCounters,
        [action.actorId]: cityCounter,
      };

      let s: MatchState = {
        ...prev,
        actionSeq: seq,
        units: newUnits,
        cities: [...prev.cities, newCity],
        nextCityId: prev.nextCityId + 1,
        cityCounters,
        tileOwnership: newOwnership,
        log: appendLog(
          prev,
          seq,
          `${current.name} founded ${cityName} at (${newCity.position.q},${newCity.position.r})`,
        ),
      };
      s = recomputeAllCities(s, content);
      return rememberVisible(s, action.actorId);
    }

    case "SetCityProduction": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");

      const cityIdx = prev.cities.findIndex((c) => c.id === action.cityId);
      if (cityIdx === -1) throw new GameRuleError("NOT_FOUND", "no such city");
      const city = prev.cities[cityIdx]!;
      if (city.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_CITY", "not your city");

      if (action.item !== null) {
        const me = prev.players[prev.currentPlayerIndex]!;
        if (action.item.kind === "unit") {
          const def = content.units.find(
            (u) => (u.id as unknown as string) === action.item!.defId,
          );
          if (!def) throw new GameRuleError("NOT_FOUND", "unit not in pack");
          const ok = buildableUnits(content, me).some(
            (u) => (u.id as unknown as string) === action.item!.defId,
          );
          if (!ok)
            throw new GameRuleError("NOT_BUILDABLE", "unit not buildable (missing tech?)");
          const resCheck = checkResourceCost(me, def.cost.resources);
          if (!resCheck.ok)
            throw new GameRuleError("MISSING_RESOURCE", `need ${resCheck.missing.join(", ")}`);
        } else if (action.item.kind === "building") {
          const cityRes = prev.map ? cityResources(prev.map, city, content) : new Set<string>();
          const ok = buildableBuildings(content, me, city.buildings, cityRes).some(
            (b) => (b.id as unknown as string) === action.item!.defId,
          );
          if (!ok)
            throw new GameRuleError(
              "NOT_BUILDABLE",
              "building not buildable or already built (missing tech / resource?)",
            );
        } else {
          // Wonder
          const def = content.wonders.find(
            (w) => (w.id as unknown as string) === action.item!.defId,
          );
          if (!def) throw new GameRuleError("NOT_FOUND", "wonder not in pack");
          if (def.prereq_tech && !me.researchedTechs.includes(def.prereq_tech as unknown as string))
            throw new GameRuleError("NOT_BUILDABLE", "wonder prereq tech missing");
          if (prev.wondersBuilt[action.item.defId])
            throw new GameRuleError("WONDER_TAKEN", "wonder already built by someone");
        }
      }

      const newCities = prev.cities.slice();
      const sameItem =
        city.productionItem &&
        action.item &&
        city.productionItem.kind === action.item.kind &&
        city.productionItem.defId === action.item.defId;
      newCities[cityIdx] = {
        ...city,
        productionItem: action.item,
        production: sameItem ? city.production : 0,
      };
      const itemLabel = action.item
        ? `${action.item.kind}:${action.item.defId}`
        : "(none)";
      return {
        ...prev,
        actionSeq: seq,
        cities: newCities,
        log: appendLog(prev, seq, `${city.name} now producing ${itemLabel}`),
      };
    }

    case "Fortify": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");
      const idx = prev.units.findIndex((u) => u.id === action.unitId);
      if (idx === -1) throw new GameRuleError("NOT_FOUND", "no such unit");
      const unit = prev.units[idx]!;
      if (unit.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "not your unit");
      const newUnits = prev.units.slice();
      newUnits[idx] = { ...unit, fortified: true, movementLeft: 0 };
      const def = unitDef(content, unit.defId);
      return {
        ...prev,
        actionSeq: seq,
        units: newUnits,
        log: appendLog(prev, seq, `${current!.name} fortified ${def?.name ?? unit.defId}`),
      };
    }

    case "BuyProduction": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");
      const cityIdx = prev.cities.findIndex((c) => c.id === action.cityId);
      if (cityIdx === -1) throw new GameRuleError("NOT_FOUND", "no such city");
      const city = prev.cities[cityIdx]!;
      if (city.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_CITY", "not your city");
      const item = city.productionItem;
      if (!item) throw new GameRuleError("NO_PRODUCTION", "no production item set");
      if (item.kind === "wonder")
        throw new GameRuleError("CANNOT_BUY_WONDER", "wonders can't be purchased with gold");
      let cost: number | null = null;
      if (item.kind === "unit") {
        const def = content.units.find((u) => (u.id as unknown as string) === item.defId);
        cost = def?.cost.production ?? null;
      } else {
        const def = content.buildings.find((b) => (b.id as unknown as string) === item.defId);
        cost = def?.cost.production ?? null;
      }
      if (cost === null) throw new GameRuleError("BAD_ITEM", "production cost unknown");
      const remaining = Math.max(0, cost - city.production);
      const goldCost = remaining * 4;
      const playerIdx = prev.players.findIndex((p) => p.id === action.actorId);
      const player = prev.players[playerIdx]!;
      if (player.gold < goldCost)
        throw new GameRuleError("NEED_GOLD", `costs ${goldCost} gold (you have ${player.gold})`);

      // Apply: deduct gold, fast-forward production to cost-1 so next turn tick completes it.
      // Actually let's complete instantly here.
      const newCities = prev.cities.slice();
      let newUnits = prev.units.slice();
      let nextUnitId = prev.nextUnitId;
      const newCity = { ...city, production: 0, productionItem: null as ProductionItem | null };
      let logText = "";
      if (item.kind === "unit") {
        const def = content.units.find((u) => (u.id as unknown as string) === item.defId);
        if (def) {
          const occupied = (q: number, r: number) =>
            newUnits.some((u) => u.position.q === q && u.position.r === r);
          let pos = city.position;
          if (occupied(pos.q, pos.r)) {
            const free = neighborsOf(city.position).find((n) => !occupied(n.q, n.r));
            if (free) pos = free;
          }
          newUnits = newUnits.concat({
            id: `u${nextUnitId++}`,
            ownerId: action.actorId,
            defId: item.defId,
            position: { ...pos },
            movementMax: def.movement,
            movementLeft: 0,
            hp: 100,
            hpMax: 100,
          });
          logText = `${city.name} purchased ${def.name} for ${goldCost} gold`;
        }
      } else {
        const def = content.buildings.find((b) => (b.id as unknown as string) === item.defId);
        newCity.buildings = [...city.buildings, item.defId];
        logText = `${city.name} purchased ${def?.name ?? item.defId} for ${goldCost} gold`;
      }
      newCities[cityIdx] = newCity;
      const newPlayers = prev.players.slice();
      newPlayers[playerIdx] = { ...player, gold: player.gold - goldCost };

      let s: import("./state.js").MatchState = {
        ...prev,
        actionSeq: seq,
        cities: newCities,
        units: newUnits,
        nextUnitId,
        players: newPlayers,
        log: appendLog(prev, seq, logText),
      };
      s = recomputeAllCities(s, content);
      s = recomputeAllResources(s, content);
      return s;
    }

    case "CityRangedAttack": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");
      const cityIdx = prev.cities.findIndex((c) => c.id === action.cityId);
      if (cityIdx === -1) throw new GameRuleError("NOT_FOUND", "no such city");
      const city = prev.cities[cityIdx]!;
      if (city.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_CITY", "not your city");
      if (city.hasFiredThisTurn)
        throw new GameRuleError("ALREADY_FIRED", "city already fired this turn");
      const target = prev.units.find((u) => u.id === action.targetUnitId);
      if (!target) throw new GameRuleError("NOT_FOUND", "no such target");
      if (target.ownerId === action.actorId)
        throw new GameRuleError("SELF", "cannot attack own unit");
      const dipKey = diplomacyKey(action.actorId, target.ownerId);
      if (prev.diplomacy[dipKey] !== "war")
        throw new GameRuleError("NOT_AT_WAR", "must declare war first");
      const available = getCityAttacks(city, content, prev.turnNumber);
      const chosen = action.attackId
        ? available.find((a) => a.id === action.attackId)
        : available[0];
      if (!chosen)
        throw new GameRuleError("NOT_FOUND", `attack ${action.attackId ?? "(default)"} not available`);
      const dq = city.position.q - target.position.q;
      const dr = city.position.r - target.position.r;
      const ds = -dq - dr;
      const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
      if (dist > chosen.range)
        throw new GameRuleError("OUT_OF_RANGE", `target is ${dist} away, range is ${chosen.range}`);

      const cityStr = cityDefenseStrength(city, content, prev.turnNumber);
      const targetDef = unitDef(content, target.defId);
      const targetTypes = targetDef ? getUnitTypes(targetDef) : [];
      const mult = effectivenessMultiplier(chosen.types, targetTypes, content);
      const aPower = chosen.damage * (city.hp / city.hpMax);
      const dPower = (targetDef?.combat.strength ?? 8) * (target.hp / target.hpMax);
      const ratio = aPower / Math.max(0.5, dPower);
      const damage = Math.max(5, Math.round(22 * Math.pow(ratio, 0.5) * mult));
      const dmgApplied = Math.min(target.hp, damage);
      const killed = target.hp - dmgApplied <= 0;

      let newUnits = prev.units.map((u) =>
        u.id === target.id ? { ...u, hp: Math.max(0, u.hp - dmgApplied) } : u,
      );
      if (killed) newUnits = newUnits.filter((u) => u.id !== target.id);
      const newCities = prev.cities.slice();
      newCities[cityIdx] = { ...city, hasFiredThisTurn: true };

      const tName = targetDef?.name ?? target.defId;
      const summary = `${city.name} ${chosen.name.toLowerCase()} ${tName} — ${dmgApplied} dmg${killed ? " · killed" : ""}`;

      let s: MatchState = {
        ...prev,
        actionSeq: seq,
        units: syncCargo(newUnits),
        cities: newCities,
        log: appendLog(prev, seq, summary),
      };
      s = recomputeAllResources(s, content);
      return s;
    }

    case "SetResearch": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const playerIdx = prev.players.findIndex((p) => p.id === action.actorId);
      if (playerIdx === -1) throw new GameRuleError("NOT_FOUND", "no such player");
      const player = prev.players[playerIdx]!;

      let newCurrent: string | null = null;
      if (action.techId !== null) {
        const tech = lookupTech(content, action.techId);
        if (!tech) throw new GameRuleError("NOT_FOUND", "unknown tech");
        const r = canResearch(player, tech, content);
        if (!r.ok) throw new GameRuleError(r.reason ?? "CANNOT_RESEARCH", r.reason ?? "cannot research");
        newCurrent = action.techId;
      }

      const players = prev.players.slice();
      players[playerIdx] = { ...player, currentTech: newCurrent };
      const techName =
        newCurrent !== null
          ? lookupTech(content, newCurrent)?.name ?? newCurrent
          : "(none)";
      return {
        ...prev,
        actionSeq: seq,
        players,
        log: appendLog(prev, seq, `${player.name} researching ${techName}`),
      };
    }

    case "BoardShip": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");
      const unit = prev.units.find((u) => u.id === action.unitId);
      const ship = prev.units.find((u) => u.id === action.shipId);
      if (!unit || !ship) throw new GameRuleError("NOT_FOUND", "unit or ship missing");
      if (unit.ownerId !== action.actorId || ship.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "must own both units");
      if (unit.boardedOn) throw new GameRuleError("ALREADY_BOARDED", "unit already on a ship");
      const shipDef = unitDef(content, ship.defId);
      const cap = shipDef?.transport_capacity ?? 0;
      if (cap <= 0) throw new GameRuleError("NO_CAPACITY", "ship has no transport capacity");
      const onboard = prev.units.filter((u) => u.boardedOn === ship.id).length;
      if (onboard >= cap) throw new GameRuleError("NO_CAPACITY", "ship is full");
      const dq = unit.position.q - ship.position.q;
      const dr = unit.position.r - ship.position.r;
      const ds = -dq - dr;
      const adj = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
      if (adj > 1) throw new GameRuleError("OUT_OF_RANGE", "must be adjacent to ship");
      const newUnits = prev.units.map((u) =>
        u.id === unit.id
          ? { ...u, boardedOn: ship.id, position: { ...ship.position }, movementLeft: 0 }
          : u,
      );
      const uname = unitDef(content, unit.defId)?.name ?? unit.defId;
      const sname = shipDef?.name ?? ship.defId;
      return {
        ...prev,
        actionSeq: seq,
        units: newUnits,
        log: appendLog(prev, seq, `${uname} boarded ${sname}`),
      };
    }

    case "Disembark": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");
      const ship = prev.units.find((u) => u.id === action.shipId);
      const unit = prev.units.find((u) => u.id === action.unitId);
      if (!ship || !unit) throw new GameRuleError("NOT_FOUND", "unit or ship missing");
      if (ship.ownerId !== action.actorId || unit.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "must own both units");
      if (unit.boardedOn !== ship.id)
        throw new GameRuleError("NOT_BOARDED", "unit is not on that ship");
      const dq = ship.position.q - action.target.q;
      const dr = ship.position.r - action.target.r;
      const ds = -dq - dr;
      const adj = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
      if (adj > 1) throw new GameRuleError("OUT_OF_RANGE", "target must be adjacent to ship");
      if (!prev.map) throw new GameRuleError("BAD_STATE", "no map");
      const tile = prev.map.tiles.find(
        (t) => t.q === action.target.q && t.r === action.target.r,
      );
      if (!tile) throw new GameRuleError("NOT_FOUND", "no such tile");
      const terrain = content.terrains.find((t) => (t.id as unknown as string) === tile.terrain);
      if (!terrain) throw new GameRuleError("NOT_FOUND", "unknown terrain");
      const def = unitDef(content, unit.defId);
      if (!def) throw new GameRuleError("NOT_FOUND", "unit def missing");
      const cost = entryCostFor(def, terrain);
      if (cost === null)
        throw new GameRuleError("IMPASSABLE", "unit cannot enter that terrain");
      const occupied = prev.units.some(
        (u) =>
          !u.boardedOn &&
          u.id !== unit.id &&
          u.position.q === action.target.q &&
          u.position.r === action.target.r,
      );
      if (occupied) throw new GameRuleError("OCCUPIED", "tile is occupied");
      const newUnits = prev.units.map((u) =>
        u.id === unit.id
          ? { ...u, boardedOn: undefined, position: { ...action.target }, movementLeft: 0 }
          : u,
      );
      const uname = def.name;
      return {
        ...prev,
        actionSeq: seq,
        units: newUnits,
        log: appendLog(prev, seq, `${uname} disembarked`),
      };
    }

    case "UpgradeUnit": {
      if (prev.status !== "in_progress")
        throw new GameRuleError("BAD_STATE", "match not in progress");
      const current = prev.players[prev.currentPlayerIndex];
      if (current?.id !== action.actorId)
        throw new GameRuleError("NOT_YOUR_TURN", "not your turn");

      const unitIdx = prev.units.findIndex((u) => u.id === action.unitId);
      if (unitIdx === -1) throw new GameRuleError("NOT_FOUND", "no such unit");
      const unit = prev.units[unitIdx]!;
      if (unit.ownerId !== action.actorId)
        throw new GameRuleError("NOT_YOUR_UNIT", "you do not control that unit");

      const def = unitDef(content, unit.defId);
      if (!def?.evolves_to)
        throw new GameRuleError("NO_EVOLUTION", "this unit has no upgrade path");
      const newDef = unitDef(content, def.evolves_to as unknown as string);
      if (!newDef) throw new GameRuleError("NOT_FOUND", "upgrade target missing");
      if (
        newDef.prereq_tech &&
        !current.researchedTechs.includes(newDef.prereq_tech as unknown as string)
      )
        throw new GameRuleError(
          "MISSING_TECH",
          "upgrade target's prereq tech not researched",
        );
      const cost = def.upgrade_cost.gold ?? 0;
      if (current.gold < cost)
        throw new GameRuleError("NEED_GOLD", `upgrade costs ${cost} gold`);

      const newUnits = prev.units.slice();
      newUnits[unitIdx] = {
        ...unit,
        defId: newDef.id as unknown as string,
        movementMax: newDef.movement,
        movementLeft: 0, // upgraded — no move this turn
        hp: 100,
        hpMax: 100,
      };
      const players = prev.players.slice();
      players[prev.currentPlayerIndex] = { ...current, gold: current.gold - cost };

      return {
        ...prev,
        actionSeq: seq,
        units: newUnits,
        players,
        log: appendLog(
          prev,
          seq,
          `${current.name} upgraded ${def.name} → ${newDef.name} (-${cost} gold)`,
        ),
      };
    }
  }
}

function appendLog(prev: MatchState, seq: number, text: string): MatchState["log"] {
  const entry = { turn: prev.turnNumber, actionSeq: seq, text };
  const next = [...prev.log, entry];
  return next.length > 200 ? next.slice(next.length - 200) : next;
}

function unitDef(content: ContentPack, defId: string): UnitDef | undefined {
  return content.units.find((u) => (u.id as unknown as string) === defId);
}

/**
 * Snap cargo unit positions to their ship and drop cargo whose ship is gone.
 * Should be called any time the units array is mutated.
 */
function syncCargo(units: Unit[]): Unit[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  return units
    .filter((u) => !u.boardedOn || byId.has(u.boardedOn))
    .map((u) => {
      if (!u.boardedOn) return u;
      const ship = byId.get(u.boardedOn)!;
      if (u.position.q === ship.position.q && u.position.r === ship.position.r) return u;
      return { ...u, position: { ...ship.position } };
    });
}

function entryCostFor(def: UnitDef, terrain: Terrain): number | null {
  return entryCost(terrain, {
    unitTerrainCosts: def.terrain_costs as Record<string, number> | undefined,
    unitTraits: def.traits.map((t) => t as unknown as string),
  });
}

function lookupCiv(content: ContentPack, civId: string) {
  return content.civilizations.find((c) => (c.id as unknown as string) === civId);
}

export function pickAvailableCiv(
  state: MatchState,
  content: ContentPack,
): string | null {
  const taken = new Set(state.players.map((p) => p.civId).filter(Boolean));
  for (const c of content.civilizations) {
    const id = c.id as unknown as string;
    if (!taken.has(id)) return id;
  }
  return null;
}

// Re-exports for downstream consumers wanting the Phase-3 helpers
export { CITY_RADIUS, distance, hexKey };
