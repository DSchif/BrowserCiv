import type {
  City,
  ContentPack,
  MatchView,
  PathfindResult,
  Player,
  ProductionItem,
  Tech,
  Unit,
} from "@browserciv/shared";
import {
  buildableBuildings as buildableBuildingsFn,
  buildableImprovementsForTile,
  buildableUnits as buildableUnitsFn,
  buildableWonders as buildableWondersFn,
  canFoundCityAt,
  canResearch,
  cityResources as cityResourcesFn,
  findPath as computeFindPath,
  getCityAttacks,
  getUnitAttacks,
  Hex,
  reachable as computeReachable,
  resolveMelee,
  resolveRanged,
} from "@browserciv/shared";
import type { Attack } from "@browserciv/shared";
import { Application } from "pixi.js";
import { fetchContentPack } from "../net/rest.js";
import { GameClient } from "../net/ws.js";
import { MapViewer, preloadTerrainAssets } from "../pixi/map-view.js";

type AxialCoord = Hex.AxialCoord;

export interface MatchSession {
  matchId: string;
  playerId: string;
  token: string;
  name: string;
  spectator?: boolean;
}

export function renderMatch(
  root: HTMLElement,
  session: MatchSession,
  onLeave: () => void,
  onSpectate?: (session: MatchSession) => void,
): void {
  root.innerHTML = `
    <canvas id="game-canvas"></canvas>

    <div id="lobby-overlay" class="lobby-overlay">
      <div class="lobby-card">
        <h2>Game Lobby</h2>
        <p class="lo-subtitle">Share the match ID for others to join</p>
        <div class="lo-id-box">
          <code id="lo-match-id">${escape(session.matchId)}</code>
          <button class="lo-copy" id="lo-copy">Copy</button>
        </div>
        <ul class="lo-players" id="lo-players"></ul>
        <div class="lo-waiting" id="lo-waiting">Waiting for players…</div>
        <div class="lo-settings hidden" id="lo-settings">
          <label class="lo-setting"><input type="checkbox" id="lo-no-fog"> No fog of war</label>
          <div class="lo-bot-row">
            <select id="lo-bot-type">
              <option value="random">Random bot</option>
              <option value="greedy">Greedy bot (cities &amp; units)</option>
              <option value="passive">Passive bot (ends turn only)</option>
            </select>
            <button class="lo-add-bot" id="lo-add-bot">+ Add Bot</button>
          </div>
        </div>
        <div class="lo-actions">
          <button class="lo-start" id="lo-start" disabled>Start Match</button>
          <button class="lo-watch" id="lo-watch" disabled>Start &amp; Watch</button>
          <button class="lo-leave" id="lo-leave-lobby">Leave</button>
        </div>
      </div>
    </div>

    <div id="top-bar" class="top-bar">
      <div class="tb-left">
        <span id="status-dot" class="status-dot disconnected"></span>
        <span id="era-badge" class="era-badge">—</span>
        <code class="match-code">${escape(session.matchId)}</code>
        <button id="start" class="tb-btn tb-start hidden" disabled>Start match</button>
        ${session.spectator ? `<span class="tb-spectator-badge">Watching</span>` : ""}
      </div>
      <div class="tb-center">
        <span id="turn-label" class="tb-dim">connecting…</span>
        <span id="active-badge" class="active-badge"></span>
      </div>
      <div class="tb-right">
        <button id="science-btn" class="tb-btn tb-science" title="Open tech tree">🔬 <span id="science-rate">—</span></button>
        <button id="gold-btn" class="tb-btn tb-gold" title="Treasury">💰 <span id="gold-label">—</span></button>
        <button id="diplomacy-btn" class="tb-btn tb-diplo" title="Diplomacy">⚔</button>
        <button id="menu-btn" class="tb-btn" title="Menu">☰</button>
      </div>
    </div>

    <div id="menu-dropdown" class="menu-dropdown hidden">
      <button id="toggle-log">Show log</button>
      <div class="menu-divider"></div>
      <div id="menu-players" class="menu-players"></div>
      <div id="menu-res-section"></div>
      <div class="menu-divider"></div>
      <button id="leave" class="menu-leave">Leave match</button>
    </div>

    <div id="log-panel" class="log-panel hidden">
      <div class="log-header">Event Log</div>
      <ul id="log"></ul>
    </div>

    <div id="tile-info" class="tile-info hidden"></div>

    <div id="action-panel" class="action-panel hidden">
      <div id="ap-info" class="ap-info"></div>
      <div id="ap-actions" class="ap-actions"></div>
    </div>

    <div id="attack-picker" class="attack-picker hidden"></div>

    <button id="end" class="end-turn-btn" disabled>End Turn</button>

    <div id="city-panel" class="city-panel hidden">
      <div class="city-panel-header">
        <h2 id="cp-name">—</h2>
        <button id="cp-close">×</button>
      </div>
      <div class="city-panel-body" id="cp-body"></div>
    </div>
    <div id="tech-panel" class="city-panel hidden">
      <div class="city-panel-header">
        <h2>Tech tree</h2>
        <button id="tp-close">×</button>
      </div>
      <div class="city-panel-body" id="tp-body"></div>
    </div>
    <div id="diplo-panel" class="city-panel hidden">
      <div class="city-panel-header">
        <h2>Diplomacy</h2>
        <button id="dp-close">×</button>
      </div>
      <div class="city-panel-body" id="dp-body"></div>
    </div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>("#game-canvas")!;
  const lobbyOverlay = root.querySelector<HTMLDivElement>("#lobby-overlay")!;
  const loPlayers = root.querySelector<HTMLUListElement>("#lo-players")!;
  const loWaiting = root.querySelector<HTMLDivElement>("#lo-waiting")!;
  const loStart = root.querySelector<HTMLButtonElement>("#lo-start")!;
  const loWatch = root.querySelector<HTMLButtonElement>("#lo-watch")!;
  const loNoFog = root.querySelector<HTMLInputElement>("#lo-no-fog")!;
  const loSettings = root.querySelector<HTMLDivElement>("#lo-settings")!;
  const loBotType = root.querySelector<HTMLSelectElement>("#lo-bot-type")!;
  const loAddBot = root.querySelector<HTMLButtonElement>("#lo-add-bot")!;
  const loCopy = root.querySelector<HTMLButtonElement>("#lo-copy")!;
  const loLeaveLobby = root.querySelector<HTMLButtonElement>("#lo-leave-lobby")!;
  const statusDot = root.querySelector<HTMLSpanElement>("#status-dot")!;
  const eraBadge = root.querySelector<HTMLSpanElement>("#era-badge")!;
  const turnLabel = root.querySelector<HTMLSpanElement>("#turn-label")!;
  const activeBadge = root.querySelector<HTMLSpanElement>("#active-badge")!;
  const scienceRateEl = root.querySelector<HTMLSpanElement>("#science-rate")!;
  const goldLabelEl = root.querySelector<HTMLSpanElement>("#gold-label")!;
  const scienceBtn = root.querySelector<HTMLButtonElement>("#science-btn")!;
  const diplomacyBtn = root.querySelector<HTMLButtonElement>("#diplomacy-btn")!;
  const menuBtn = root.querySelector<HTMLButtonElement>("#menu-btn")!;
  const menuDropdown = root.querySelector<HTMLDivElement>("#menu-dropdown")!;
  const menuPlayers = root.querySelector<HTMLDivElement>("#menu-players")!;
  const menuResSection = root.querySelector<HTMLDivElement>("#menu-res-section")!;
  const toggleLogBtn = root.querySelector<HTMLButtonElement>("#toggle-log")!;
  const leaveBtn = root.querySelector<HTMLButtonElement>("#leave")!;
  const logPanel = root.querySelector<HTMLDivElement>("#log-panel")!;
  const logEl = root.querySelector<HTMLUListElement>("#log")!;
  const startBtn = root.querySelector<HTMLButtonElement>("#start")!;
  const endBtn = root.querySelector<HTMLButtonElement>("#end")!;
  const actionPanel = root.querySelector<HTMLDivElement>("#action-panel")!;
  const apInfo = root.querySelector<HTMLDivElement>("#ap-info")!;
  const apActions = root.querySelector<HTMLDivElement>("#ap-actions")!;
  const attackPickerEl = root.querySelector<HTMLDivElement>("#attack-picker")!;
  const tileInfo = root.querySelector<HTMLDivElement>("#tile-info")!;
  const cityPanel = root.querySelector<HTMLDivElement>("#city-panel")!;
  const cpName = root.querySelector<HTMLHeadingElement>("#cp-name")!;
  const cpBody = root.querySelector<HTMLDivElement>("#cp-body")!;
  const cpClose = root.querySelector<HTMLButtonElement>("#cp-close")!;
  const techPanel = root.querySelector<HTMLDivElement>("#tech-panel")!;
  const tpBody = root.querySelector<HTMLDivElement>("#tp-body")!;
  const tpClose = root.querySelector<HTMLButtonElement>("#tp-close")!;
  const diploPanel = root.querySelector<HTMLDivElement>("#diplo-panel")!;
  const dpBody = root.querySelector<HTMLDivElement>("#dp-body")!;
  const dpClose = root.querySelector<HTMLButtonElement>("#dp-close")!;

  let logVisible = false;
  let mapView: MapViewer | null = null;
  let latest: MatchView | null = null;
  let pack: ContentPack | null = null;
  let selectedUnitId: string | null = null;
  let selectedCityId: string | null = null;
  let attackMode: { attack: Attack; unitId: string; fire: (targetUnitId: string) => void } | null = null;

  void fetchContentPack().then((p) => {
    pack = p;
    mapView?.setPack(p);
    if (latest) renderState(latest);
  });

  const app = new Application();
  void app
    .init({ canvas, resizeTo: window, background: "#0e1116", antialias: true })
    .then(() => preloadTerrainAssets())
    .then(() => {
      mapView = new MapViewer(app, {
        onUnitClick: (u) => onUnitClick(u),
        onTileClick: (coord) => onTileClick(coord),
        onCityClick: (c) => onCityClick(c),
        onTileHover: (coord) => onTileHover(coord),
      });
      if (pack) mapView.setPack(pack);
      if (latest) renderState(latest);
    });

  const client = new GameClient(session.matchId, session.playerId, session.token, {
    onOpen: () => {
      statusDot.classList.remove("disconnected");
      statusDot.title = "connected";
    },
    onClose: () => {
      statusDot.classList.add("disconnected");
      statusDot.title = "disconnected";
    },
    onError: (code, msg) => {
      statusDot.classList.add("disconnected");
      statusDot.title = `error: ${code} — ${msg}`;
    },
    onState: (state) => {
      latest = state as unknown as MatchView;
      renderState(latest);
    },
    onReject: (_seq, code, msg) => {
      statusDot.title = `rejected: ${code} — ${msg}`;
    },
    onAck: () => undefined,
  });
  client.connect();

  // In spectator mode, hide all player-action UI permanently.
  if (session.spectator) {
    lobbyOverlay.classList.add("hidden");
    endBtn.classList.add("hidden");
    actionPanel.classList.add("hidden");
    root.querySelector<HTMLButtonElement>("#start")?.classList.add("hidden");
  }

  (window as unknown as { __BROWSERCIV: unknown }).__BROWSERCIV = {
    session,
    latest: () => latest,
    pack: () => pack,
    sendIntent: (intent: Parameters<typeof client.sendIntent>[0]) =>
      client.sendIntent(intent),
    selectUnit: (unitId: string) => {
      selectedUnitId = unitId;
      selectedCityId = null;
      mapView?.setSelectedCity(null);
      updateReachable();
      updateActionPanel();
    },
  };

  // ── Event listeners ──

  loStart.addEventListener("click", () => {
    client.sendIntent({ type: "MatchStart", actorId: session.playerId, noFog: loNoFog.checked });
  });
  loWatch.addEventListener("click", () => {
    loWatch.disabled = true;
    fetch(`/matches/${session.matchId}/bot-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: session.token,
        strategy: loBotType.value,
        noFog: true,
      }),
    })
      .then((r) => r.json())
      .then((body: unknown) => {
        const cred = (body as { credential: { token: string; matchId: string } }).credential;
        client.close();
        const spectatorSession: MatchSession = {
          matchId: cred.matchId,
          playerId: "",
          token: cred.token,
          name: "Spectator",
          spectator: true,
        };
        if (onSpectate) {
          onSpectate(spectatorSession);
        }
      })
      .catch((e: unknown) => {
        console.error("bot-start failed", e);
        loWatch.disabled = false;
      });
  });
  loAddBot.addEventListener("click", () => {
    loAddBot.disabled = true;
    fetch(`/matches/${session.matchId}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: loBotType.value }),
    })
      .catch((e: unknown) => console.error("add-bot failed", e))
      .finally(() => { loAddBot.disabled = false; });
  });
  loLeaveLobby.addEventListener("click", () => {
    client.close();
    onLeave();
  });
  loCopy.addEventListener("click", () => {
    void navigator.clipboard.writeText(session.matchId).then(() => {
      loCopy.textContent = "Copied!";
      setTimeout(() => { loCopy.textContent = "Copy"; }, 1500);
    });
  });

  startBtn.addEventListener("click", () => {
    client.sendIntent({ type: "MatchStart", actorId: session.playerId, noFog: loNoFog.checked });
  });

  endBtn.addEventListener("click", () => {
    selectedUnitId = null;
    selectedCityId = null;
    mapView?.setSelectedCity(null);
    mapView?.setReachable(new Map(), null);
    closeCityPanel();
    closeTechPanel();
    hideAttackPicker();
    actionPanel.classList.add("hidden");
    client.sendIntent({ type: "EndTurn", actorId: session.playerId });
  });

  scienceBtn.addEventListener("click", () => {
    if (techPanel.classList.contains("hidden")) openTechPanel();
    else closeTechPanel();
    menuDropdown.classList.add("hidden");
  });

  diplomacyBtn.addEventListener("click", () => {
    if (diploPanel.classList.contains("hidden")) openDiploPanel();
    else closeDiploPanel();
    menuDropdown.classList.add("hidden");
  });

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (
      !menuDropdown.classList.contains("hidden") &&
      !menuBtn.contains(e.target as Node) &&
      !menuDropdown.contains(e.target as Node)
    ) {
      menuDropdown.classList.add("hidden");
    }
  });

  toggleLogBtn.addEventListener("click", () => {
    logVisible = !logVisible;
    logPanel.classList.toggle("hidden", !logVisible);
    toggleLogBtn.textContent = logVisible ? "Hide log" : "Show log";
    menuDropdown.classList.add("hidden");
  });

  leaveBtn.addEventListener("click", () => {
    client.close();
    onLeave();
  });

  cpClose.addEventListener("click", () => closeCityPanel());
  tpClose.addEventListener("click", () => closeTechPanel());
  dpClose.addEventListener("click", () => closeDiploPanel());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (attackMode) { clearAttackMode(); return; }
      hideAttackPicker();
      closeCityPanel();
    }
  });

  // ── Attack mode ──

  function enterAttackMode(attack: Attack, unitId: string): void {
    if (!latest) return;
    const unit = latest.units.find((u) => u.id === unitId);
    if (!unit) return;

    const fire = (targetUnitId: string): void => {
      const target = latest?.units.find((u) => u.id === targetUnitId);
      if (!target) return;
      if (attack.range === 1) {
        client.sendIntent({
          type: "MoveUnit",
          actorId: session.playerId,
          unitId,
          target: { q: target.position.q, r: target.position.r },
          attackId: attack.id,
        });
      } else {
        client.sendIntent({
          type: "RangedAttack",
          actorId: session.playerId,
          unitId,
          targetUnitId,
          attackId: attack.id,
        });
      }
      clearAttackMode();
    };

    attackMode = { attack, unitId, fire };

    // Highlight all map tiles within attack range (not just occupied ones)
    const inRange = (latest.map?.tiles ?? [])
      .filter((t) => {
        const dist = Hex.distance(unit.position, { q: t.q, r: t.r });
        return dist >= 1 && dist <= attack.range;
      })
      .map((t) => ({ q: t.q, r: t.r }));

    mapView?.setAttackHighlight(inRange);
    mapView?.setReachable(new Map(), null); // clear movement overlay while targeting
    updateActionPanel();
  }

  function clearAttackMode(): void {
    attackMode = null;
    mapView?.setAttackHighlight([]);
    updateReachable();
    updateActionPanel();
  }

  // ── Attack picker (multi-attack chooser) ──

  function hideAttackPicker(): void {
    attackPickerEl.classList.add("hidden");
    attackPickerEl.innerHTML = "";
  }

  function showAttackPicker(
    target: Unit,
    options: Array<{ attack: Attack; onPick: () => void }>,
  ): void {
    void target;
    attackPickerEl.innerHTML = `<div class="ap-title">Choose attack</div>`;
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.className = "ap-btn";
      const types = opt.attack.types
        .map((t) => (t as unknown as string).replace(/^type\./, ""))
        .join(", ");
      btn.innerHTML = `<strong>${opt.attack.name}</strong><span>${opt.attack.damage} dmg · range ${opt.attack.range} · ${types}</span>`;
      btn.addEventListener("click", () => {
        hideAttackPicker();
        opt.onPick();
      });
      attackPickerEl.appendChild(btn);
    }
    const cancel = document.createElement("button");
    cancel.className = "ap-cancel";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => hideAttackPicker());
    attackPickerEl.appendChild(cancel);
    attackPickerEl.classList.remove("hidden");
  }

  function unitAvailableAttacks(unit: Unit, range: "melee" | "ranged"): Attack[] {
    const def = pack?.units.find((d) => (d.id as unknown as string) === unit.defId);
    if (!def) return [];
    const all = getUnitAttacks(def);
    return all.filter((a) => {
      if (range === "melee" && a.range !== 1) return false;
      if (range === "ranged" && a.range <= 1) return false;
      const cd = unit.attackCooldowns?.[a.id] ?? 0;
      if (cd > 0) return false;
      if (a.charges !== undefined) {
        const used = unit.attackChargesUsed?.[a.id] ?? 0;
        if (used >= a.charges) return false;
      }
      return true;
    });
  }

  // ── Map interaction ──

  function triggerAttackEnemy(enemy: Unit): void {
    if (!latest || !selectedUnitId) return;
    const me = latest.units.find((u) => u.id === selectedUnitId);
    if (!me) return;
    const dq = me.position.q - enemy.position.q;
    const dr = me.position.r - enemy.position.r;
    const ds = -dq - dr;
    const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
    const meleeOpts = dist <= 1 ? unitAvailableAttacks(me, "melee") : [];
    const rangedOpts = unitAvailableAttacks(me, "ranged").filter((a) => a.range >= dist);
    const all = [...meleeOpts, ...rangedOpts];

    const fireMelee = (attackId?: string): void => {
      client.sendIntent({
        type: "MoveUnit",
        actorId: session.playerId,
        unitId: selectedUnitId!,
        target: { q: enemy.position.q, r: enemy.position.r },
        attackId,
      });
    };
    const fireRanged = (attackId?: string): void => {
      client.sendIntent({
        type: "RangedAttack",
        actorId: session.playerId,
        unitId: selectedUnitId!,
        targetUnitId: enemy.id,
        attackId,
      });
    };

    if (all.length === 0) {
      const myDef = pack?.units.find((d) => (d.id as unknown as string) === me.defId);
      const range = myDef?.combat.range ?? 0;
      if (range > 0 && dist <= range) fireRanged();
      else fireMelee();
      return;
    }
    if (all.length === 1) {
      const a = all[0]!;
      if (a.range === 1) fireMelee(a.id);
      else fireRanged(a.id);
      return;
    }
    showAttackPicker(
      enemy,
      all.map((a) => ({
        attack: a,
        onPick: () => (a.range === 1 ? fireMelee(a.id) : fireRanged(a.id)),
      })),
    );
  }

  function onUnitClick(unit: Unit): void {
    if (!latest || !latest.map) return;

    // Attack mode: clicking any enemy unit fires the queued attack
    if (attackMode && unit.ownerId !== session.playerId) {
      attackMode.fire(unit.id);
      return;
    }
    if (attackMode) { clearAttackMode(); return; }

    const isMyTurn =
      latest.players[latest.currentPlayerIndex]?.id === session.playerId;

    // Clicking my own ship while a friendly land unit is selected and adjacent = board
    if (unit.ownerId === session.playerId && selectedUnitId && unit.id !== selectedUnitId && isMyTurn) {
      const me = latest.units.find((u) => u.id === selectedUnitId);
      const myDef = pack?.units.find((d) => (d.id as unknown as string) === me?.defId);
      const shipDef = pack?.units.find((d) => (d.id as unknown as string) === unit.defId);
      const cap = shipDef?.transport_capacity ?? 0;
      if (me && cap > 0 && !me.boardedOn) {
        const dq = me.position.q - unit.position.q;
        const dr = me.position.r - unit.position.r;
        const ds = -dq - dr;
        const adj = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
        const onboard = latest.units.filter((u) => u.boardedOn === unit.id).length;
        const myDomain = (myDef?.domain as unknown as string) ?? "";
        if (adj === 1 && onboard < cap && myDomain !== "ocean") {
          client.sendIntent({
            type: "BoardShip",
            actorId: session.playerId,
            unitId: selectedUnitId,
            shipId: unit.id,
          });
          return;
        }
      }
    }

    // Enemy unit + my city selected = city bombard
    if (unit.ownerId !== session.playerId && selectedCityId && isMyTurn) {
      const myCity = latest.cities.find((c) => c.id === selectedCityId);
      if (!myCity || !pack) return;
      const cityAttacks = getCityAttacks(myCity, pack, latest.turnNumber);
      const dq = myCity.position.q - unit.position.q;
      const dr = myCity.position.r - unit.position.r;
      const ds = -dq - dr;
      const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
      const usable = cityAttacks.filter((a) => a.range >= dist);
      if (usable.length === 0) return;
      const fire = (attackId: string): void => {
        client.sendIntent({
          type: "CityRangedAttack",
          actorId: session.playerId,
          cityId: selectedCityId!,
          targetUnitId: unit.id,
          attackId,
        });
      };
      if (usable.length === 1) fire(usable[0]!.id);
      else showAttackPicker(unit, usable.map((a) => ({ attack: a, onPick: () => fire(a.id) })));
      return;
    }

    // Enemy unit + my unit selected = attack
    if (unit.ownerId !== session.playerId) {
      if (!isMyTurn || !selectedUnitId) return;
      triggerAttackEnemy(unit);
      return;
    }

    if (!isMyTurn) return;
    selectedUnitId = unit.id;
    selectedCityId = null;
    mapView?.setSelectedCity(null);
    closeCityPanel();
    hideAttackPicker();
    updateReachable();
    updateActionPanel();
  }

  function onTileClick(coord: AxialCoord): void {
    if (!latest) return;

    // Attack mode: resolve against enemy on tile, or cancel
    if (attackMode) {
      const enemyOnTile = latest.units.find(
        (u) =>
          u.ownerId !== session.playerId &&
          u.position.q === coord.q &&
          u.position.r === coord.r,
      );
      if (enemyOnTile) attackMode.fire(enemyOnTile.id);
      else clearAttackMode();
      return;
    }

    const isMyTurn = latest.players[latest.currentPlayerIndex]?.id === session.playerId;

    // If a unit is selected, check for an enemy on the clicked tile first
    if (isMyTurn && selectedUnitId) {
      const enemyOnTile = latest.units.find(
        (u) =>
          u.ownerId !== session.playerId &&
          u.position.q === coord.q &&
          u.position.r === coord.r,
      );
      if (enemyOnTile) {
        triggerAttackEnemy(enemyOnTile);
        return;
      }
    }

    if (!selectedUnitId) return;

    // Transport with cargo: adjacent land tile = disembark
    const selected = latest.units.find((u) => u.id === selectedUnitId);
    if (selected && pack) {
      const cargo = latest.units.filter((u) => u.boardedOn === selected.id);
      if (cargo.length > 0) {
        const dq = selected.position.q - coord.q;
        const dr = selected.position.r - coord.r;
        const ds = -dq - dr;
        const adj = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
        if (adj === 1) {
          const tile = latest.map?.tiles.find((t) => t.q === coord.q && t.r === coord.r);
          const cargoUnit = cargo[0]!;
          const cargoDef = pack.units.find(
            (d) => (d.id as unknown as string) === cargoUnit.defId,
          );
          const tc = cargoDef?.terrain_costs as Record<string, number> | undefined;
          if (tile && tc && (tc[tile.terrain] ?? 0) > 0) {
            client.sendIntent({
              type: "Disembark",
              actorId: session.playerId,
              shipId: selected.id,
              unitId: cargoUnit.id,
              target: coord,
            });
            return;
          }
        }
      }
    }

    client.sendIntent({
      type: "MoveUnit",
      actorId: session.playerId,
      unitId: selectedUnitId,
      target: coord,
    });
  }

  function onTileHover(coord: AxialCoord | null): void {
    if (!mapView || !latest || !latest.map || !pack) return;
    updateTileInfo(coord);

    // Damage preview when targeting
    if (attackMode && coord) {
      const attacker = latest.units.find((u) => u.id === attackMode!.unitId);
      const enemy = latest.units.find(
        (u) => u.position.q === coord.q && u.position.r === coord.r && u.ownerId !== session.playerId,
      );
      if (attacker && enemy) {
        const result = attackMode.attack.range === 1
          ? resolveMelee(attacker, enemy, pack, attackMode.attack)
          : resolveRanged(attacker, enemy, pack, attackMode.attack);
        const effPct = Math.round((result.effectiveness - 1) * 100);
        const effStr = effPct === 0 ? "" : effPct > 0 ? ` +${effPct}%` : ` ${effPct}%`;
        const dmgTo = `<span style="color:#ff7b72">-${result.defenderDamage} to them</span>`;
        const dmgFrom = result.attackerDamage > 0
          ? ` <span style="color:#ffb347">-${result.attackerDamage} to you</span>`
          : "";
        tileInfo.innerHTML +=
          `<div class="ti-row" style="margin-top:4px;border-top:1px solid #444;padding-top:4px">` +
          `<strong>${escape(attackMode.attack.name)}</strong> ` +
          `<span class="dim">base ${attackMode.attack.damage}${effStr}</span>` +
          `</div>` +
          `<div class="ti-row">${dmgTo}${dmgFrom}</div>`;
        tileInfo.classList.remove("hidden");
      }
      mapView.setPathPreview(null, null, 0);
      return;
    }

    if (!selectedUnitId || !coord) {
      mapView.setPathPreview(null, null, 0);
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit) { mapView.setPathPreview(null, null, 0); return; }
    const def = pack.units.find((d) => (d.id as unknown as string) === unit.defId);
    if (!def) { mapView.setPathPreview(null, null, 0); return; }
    if (unit.position.q === coord.q && unit.position.r === coord.r) {
      mapView.setPathPreview(null, null, 0);
      return;
    }

    // Only pathfind through explored (visible + seen) tiles — not truly unknown territory
    const filteredMap = {
      ...latest.map,
      tiles: latest.map.tiles.filter((t) => t.visibility !== "unseen"),
    };

    const result = computeFindPath(filteredMap, unit.position, coord, pack, {
      unitTerrainCosts: def.terrain_costs as Record<string, number>,
      unitTraits: def.traits.map((t) => t as unknown as string),
    });

    mapView.setPathPreview(result, unit.position, unit.movementLeft);
  }

  function onCityClick(city: City): void {
    if (city.ownerId !== session.playerId) return;
    selectedCityId = city.id;
    selectedUnitId = null;
    mapView?.setSelectedCity(city.id);
    mapView?.setReachable(new Map(), null);
    openCityPanel(city);
    updateActionPanel();
  }

  // ── Tile info ──

  function updateTileInfo(coord: AxialCoord | null): void {
    if (!coord || !latest || !latest.map || !pack) {
      tileInfo.classList.add("hidden");
      return;
    }
    const tile = latest.map.tiles.find((t) => t.q === coord.q && t.r === coord.r);
    if (!tile) { tileInfo.classList.add("hidden"); return; }
    const terrain = pack.terrains.find((t) => (t.id as unknown as string) === tile.terrain);
    const resource = tile.resource
      ? pack.resources.find((r) => (r.id as unknown as string) === tile.resource)
      : undefined;
    const improvement = tile.improvement
      ? pack.improvements.find((i) => (i.id as unknown as string) === tile.improvement)
      : undefined;
    const yieldsObj: Record<string, number> = { ...(terrain?.base_yields ?? {}) };
    if (improvement) {
      for (const [k, v] of Object.entries(improvement.yield_bonus ?? {})) {
        yieldsObj[k] = (yieldsObj[k] ?? 0) + (v as number);
      }
    }
    if (resource) {
      const required = (resource.harvested_by ?? []).map((i) => i as unknown as string);
      const harvested =
        required.length === 0 ||
        (tile.improvement !== undefined && required.includes(tile.improvement));
      if (harvested) {
        for (const [k, v] of Object.entries(resource.yields ?? {})) {
          yieldsObj[k] = (yieldsObj[k] ?? 0) + (v as number);
        }
      }
    }
    const yieldStr = Object.entries(yieldsObj)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `<span class="ti-y ${k}">${v} ${k.charAt(0).toUpperCase()}</span>`)
      .join(" ");
    const ownerCity = latest.cities.find((c) =>
      c.ownedTiles.includes(`${coord.q},${coord.r}`),
    );
    const ownerLine = ownerCity
      ? `<div class="ti-row dim">${escape(ownerCity.name)}</div>`
      : "";
    const resLine = resource
      ? (() => {
          const required = (resource.harvested_by ?? []).map((i) => i as unknown as string);
          const harvested =
            required.length === 0 ||
            (tile.improvement !== undefined && required.includes(tile.improvement));
          const tag = harvested
            ? '<span class="ti-tag ok">harvested</span>'
            : '<span class="ti-tag warn">needs improvement</span>';
          return `<div class="ti-row"><strong>${escape(resource.name)}</strong>${tag}</div>`;
        })()
      : "";
    const impLine = improvement
      ? `<div class="ti-row dim">${escape(improvement.name)}</div>`
      : "";
    tileInfo.innerHTML =
      `<div class="ti-row"><strong>${escape(terrain?.name ?? tile.terrain)}</strong> <span class="dim">(${coord.q},${coord.r})</span></div>` +
      resLine +
      impLine +
      (yieldStr ? `<div class="ti-row">${yieldStr}</div>` : "") +
      ownerLine;
    tileInfo.classList.remove("hidden");
  }

  // ── Panel open/close ──

  function openCityPanel(city: City): void {
    cityPanel.classList.remove("hidden");
    cpName.textContent = city.name;
    renderCityBody(city);
  }
  function closeCityPanel(): void {
    cityPanel.classList.add("hidden");
    selectedCityId = null;
    mapView?.setSelectedCity(null);
    updateActionPanel();
  }
  function openTechPanel(): void {
    techPanel.classList.remove("hidden");
    renderTechBody();
  }
  function closeTechPanel(): void {
    techPanel.classList.add("hidden");
  }
  function openDiploPanel(): void {
    diploPanel.classList.remove("hidden");
    renderDiploBody();
  }
  function closeDiploPanel(): void {
    diploPanel.classList.add("hidden");
  }

  // ── Action panel ──

  function updateActionPanel(): void {
    if (!latest) { actionPanel.classList.add("hidden"); return; }
    const isMyTurn = latest.players[latest.currentPlayerIndex]?.id === session.playerId;
    const inProgress = latest.status === "in_progress";

    // Attack mode banner
    if (attackMode) {
      const rangeLabel = attackMode.attack.range === 1 ? "adjacent enemy" : `enemy within ${attackMode.attack.range} tiles`;
      apInfo.innerHTML = `<span class="ap-unit-name" style="color:#ff6060">🎯 Targeting: ${escape(attackMode.attack.name)}</span>`;
      apActions.innerHTML = `
        <span class="ap-hint">Click a red-highlighted ${rangeLabel} to strike</span>
        <button id="ap-cancel-attack" style="background:#3a1010;border-color:#f85149;color:#ff7b72">Cancel (Esc)</button>
      `;
      apActions.querySelector("#ap-cancel-attack")?.addEventListener("click", () => clearAttackMode());
      actionPanel.classList.remove("hidden");
      return;
    }

    // Unit selected
    if (selectedUnitId) {
      const unit = latest.units.find((u) => u.id === selectedUnitId);
      if (!unit) { actionPanel.classList.add("hidden"); return; }

      const name = unitName(unit.defId);
      const mpPct = unit.movementMax > 0 ? unit.movementLeft / unit.movementMax : 0;
      const mpClass = mpPct === 1 ? "mp-full" : mpPct > 0 ? "mp-low" : "mp-none";
      const cargo = latest.units.filter((u) => u.boardedOn === unit.id);
      const cargoStr = cargo.length > 0
        ? ` · cargo: ${cargo.map((c) => unitName(c.defId)).join(", ")}`
        : "";
      const boardedStr = unit.boardedOn ? " · onboard" : "";

      apInfo.innerHTML = `
        <span class="ap-unit-name">${escape(name)}</span>
        <span class="ap-stat ${mpClass}">${unit.movementLeft}/${unit.movementMax} MP</span>
        <span class="ap-stat">${unit.hp}/${unit.hpMax} HP</span>
        ${cargoStr ? `<span class="ap-stat">${escape(cargoStr)}</span>` : ""}
        ${boardedStr ? `<span class="ap-stat">onboard ship</span>` : ""}
      `;

      const def = pack?.units.find((d) => (d.id as unknown as string) === unit.defId);
      const me = latest.players.find((p) => p.id === session.playerId);
      const buttons: string[] = [];

      if (inProgress && isMyTurn) {
        // Found city — settler only
        if (unit.defId === "unit.settler") {
          const stateLike = { cities: latest.cities } as never;
          const canFound = canFoundCityAt(stateLike, unit.position);
          buttons.push(`<button id="ap-found" class="ap-primary" ${canFound ? "" : "disabled"}>Found City</button>`);
        }

        // Upgrade
        if (def?.evolves_to && me && pack) {
          const newDef = pack.units.find(
            (u) => (u.id as unknown as string) === (def.evolves_to as unknown as string),
          );
          if (newDef) {
            const cost = def.upgrade_cost.gold ?? 0;
            const techOk =
              !newDef.prereq_tech ||
              me.researchedTechs.includes(newDef.prereq_tech as unknown as string);
            const goldOk = me.gold >= cost;
            buttons.push(
              `<button id="ap-upgrade" class="ap-yellow" ${techOk && goldOk ? "" : "disabled"}>Upgrade → ${escape(newDef.name)} (${cost}g)</button>`,
            );
          }
        }

        // Available attack buttons
        if (def && pack) {
          const allAttacks = getUnitAttacks(def);
          for (const atk of allAttacks) {
            const cd = unit.attackCooldowns?.[atk.id] ?? 0;
            const used = atk.charges !== undefined ? (unit.attackChargesUsed?.[atk.id] ?? 0) : 0;
            const exhausted = cd > 0 || (atk.charges !== undefined && used >= atk.charges);
            const rangeLabel = atk.range === 1 ? "adj" : `r${atk.range}`;
            if (exhausted) {
              buttons.push(`<button class="ap-attack-btn" disabled>⚔ ${escape(atk.name)} — used</button>`);
            } else {
              buttons.push(`<button class="ap-attack-btn" data-attack-id="${atk.id}">⚔ ${escape(atk.name)} <span style="opacity:.65">${atk.damage}dmg ${rangeLabel}</span></button>`);
            }
          }
        }

        // Fortify
        buttons.push(`<button id="ap-fortify">Fortify</button>`);

        // Worker improvements
        const isWorker = def?.traits.some((t) => (t as unknown as string) === "worker");
        if (isWorker && pack && me) {
          const tile = latest.map?.tiles.find(
            (t) => t.q === unit.position.q && t.r === unit.position.r,
          );
          if (tile) {
            if (tile.improvement) {
              buttons.push(`<span class="ap-hint">${escape(improvementName(tile.improvement))} built</span>`);
            } else if (tile.workInProgress) {
              buttons.push(`<span class="ap-hint">building (${tile.workInProgress.turnsLeft}t left)</span>`);
            } else {
              const opts = buildableImprovementsForTile(pack, me, tile);
              for (const imp of opts) {
                buttons.push(
                  `<button data-imp="${imp.id}" class="ap-imp">${escape(imp.name)} <span style="opacity:.65">${imp.build_turns}t</span></button>`,
                );
              }
            }
          }
        }
      } else if (inProgress && !isMyTurn) {
        buttons.push(`<span class="ap-hint">waiting for your turn</span>`);
      }

      apActions.innerHTML = buttons.join("");

      apActions.querySelector<HTMLButtonElement>("#ap-found")?.addEventListener("click", () => {
        client.sendIntent({
          type: "FoundCity",
          actorId: session.playerId,
          unitId: selectedUnitId!,
        });
        selectedUnitId = null;
        updateActionPanel();
      });
      apActions.querySelector<HTMLButtonElement>("#ap-upgrade")?.addEventListener("click", () => {
        client.sendIntent({ type: "UpgradeUnit", actorId: session.playerId, unitId: selectedUnitId! });
      });
      apActions.querySelector<HTMLButtonElement>("#ap-fortify")?.addEventListener("click", () => {
        client.sendIntent({ type: "Fortify", actorId: session.playerId, unitId: selectedUnitId! });
      });
      apActions.querySelectorAll<HTMLButtonElement>("button[data-imp]").forEach((btn) => {
        btn.addEventListener("click", () => {
          client.sendIntent({
            type: "BuildImprovement",
            actorId: session.playerId,
            unitId: selectedUnitId!,
            improvementId: btn.dataset.imp!,
          });
        });
      });
      apActions.querySelectorAll<HTMLButtonElement>(".ap-attack-btn[data-attack-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (!def || !pack) return;
          const atk = getUnitAttacks(def).find((a) => a.id === btn.dataset.attackId);
          if (atk) enterAttackMode(atk, selectedUnitId!);
        });
      });

      actionPanel.classList.remove("hidden");
      return;
    }

    // City selected — show hint for bombard
    if (selectedCityId) {
      const city = latest.cities.find((c) => c.id === selectedCityId);
      if (!city) { actionPanel.classList.add("hidden"); return; }
      const yields = city.perTurnYields;
      const yieldStr = (["food", "production", "gold", "science", "culture"] as const)
        .map((k) => (yields[k] ? `+${yields[k]}${k[0]!.toUpperCase()}` : ""))
        .filter(Boolean)
        .join(" ");
      apInfo.innerHTML = `
        <span class="ap-unit-name">📍 ${escape(city.name)}</span>
        <span class="ap-stat">${city.population} pop · HP ${city.hp}/${city.hpMax}</span>
        ${yieldStr ? `<span class="ap-stat">${yieldStr}/t</span>` : ""}
      `;
      const canBombard = !city.hasFiredThisTurn && isMyTurn && inProgress;
      apActions.innerHTML = canBombard
        ? `<span class="ap-hint">Bombard: click an enemy unit within range</span>`
        : city.hasFiredThisTurn
          ? `<span class="ap-hint" style="color:#6e7681">Bombard used this turn</span>`
          : "";
      actionPanel.classList.remove("hidden");
      return;
    }

    actionPanel.classList.add("hidden");
  }

  // ── Diplo / city / tech panel renderers ──

  function renderDiploBody(): void {
    if (!latest) return;
    const me = latest.players.find((p) => p.id === session.playerId);
    if (!me) return;
    const others = latest.players.filter((p) => p.id !== session.playerId);
    if (others.length === 0) {
      dpBody.innerHTML = "<div class='cp-row dim'>No other players.</div>";
      return;
    }
    const dipKey = (a: string, b: string) => [a, b].sort().join(":");
    const rows = others.map((other) => {
      const at = (latest!.diplomacy?.[dipKey(me.id, other.id)] ?? "peace");
      const isWar = at === "war";
      const swatch = `<span class="swatch" style="background:${other.primary_color};border-color:${other.secondary_color}"></span>`;
      const stateTag = isWar
        ? "<span class='tag' style='background:#f85149;color:#fff'>WAR</span>"
        : "<span class='tag' style='background:#2ea043;color:#fff'>PEACE</span>";
      const btn = isWar
        ? `<button class='cp-clear' data-act='peace' data-id='${other.id}'>Make peace</button>`
        : `<button class='cp-build' data-act='war' data-id='${other.id}'>Declare war</button>`;
      return `<div class='cp-row'>${swatch} ${escape(other.name)} ${stateTag} ${btn}</div>`;
    });
    dpBody.innerHTML = rows.join("");
    dpBody.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        const targetPlayerId = btn.dataset.id!;
        if (act === "war")
          client.sendIntent({ type: "DeclareWar", actorId: session.playerId, targetPlayerId });
        else
          client.sendIntent({ type: "MakePeace", actorId: session.playerId, targetPlayerId });
      });
    });
  }

  function renderCityBody(city: City): void {
    if (!latest) return;
    const me = latest.players.find((p) => p.id === session.playerId);
    if (!me) return;
    const item = city.productionItem;
    const itemLabel = item ? labelFor(item) : "(nothing)";
    const yields = city.perTurnYields;
    const yieldLine = (["food", "production", "gold", "science", "culture"] as const)
      .map((k) => {
        const v = yields[k] ?? 0;
        const sign = v > 0 ? "+" : "";
        return `<span class="yield">${k.slice(0, 1).toUpperCase()}: ${sign}${v}</span>`;
      })
      .join(" ");

    const isMyTurn =
      latest?.players[latest.currentPlayerIndex]?.id === session.playerId;

    const units = pack ? buildableUnitsFn(pack, me) : [];
    const cityRes =
      pack && latest?.map ? cityResourcesFn(latest.map, city, pack) : new Set<string>();
    const buildings = pack
      ? buildableBuildingsFn(pack, me, city.buildings, cityRes)
      : [];

    const renderUnitBtn = (u: typeof units[number]) => {
      const id = u.id as unknown as string;
      const cost = u.cost.production ?? 0;
      const isCurrent =
        item?.kind === "unit" && item.defId === id ? " current" : "";
      const need = u.cost.resources ?? {};
      const lacking = Object.entries(need).filter(
        ([rid, n]) => (me!.availableResources[rid] ?? 0) < n,
      );
      const resTag = Object.keys(need).length
        ? ` <span class='${lacking.length ? "lacking" : "dim"}'>(${Object.entries(need).map(([rid, n]) => `${n} ${shortResourceName(rid)}`).join(", ")})</span>`
        : "";
      const disabled = !isMyTurn || lacking.length > 0;
      return `<button class="cp-build${isCurrent}" data-kind="unit" data-id="${id}" ${disabled ? "disabled" : ""}>${escape(u.name)} <span class='dim'>${cost}p</span>${resTag}</button>`;
    };
    const renderBuildingBtn = (b: typeof buildings[number]) => {
      const id = b.id as unknown as string;
      const cost = b.cost.production ?? 0;
      const isCurrent =
        item?.kind === "building" && item.defId === id ? " current" : "";
      return `<button class="cp-build${isCurrent}" data-kind="building" data-id="${id}" ${isMyTurn ? "" : "disabled"}>${escape(b.name)} <span class='dim'>${cost}p</span></button>`;
    };

    const itemCost = item && pack ? productionCostOf(item, pack) : null;
    const accLine = item
      ? `${city.production}${itemCost !== null ? `/${itemCost}` : ""} accumulated`
      : "";

    const hpLine = `<span class="dim">HP ${city.hp}/${city.hpMax}</span>`;
    const bombardLine = !city.hasFiredThisTurn && isMyTurn
      ? `<div class="cp-row"><strong>Bombard</strong> <span class="bombard-ready">ready — click an enemy unit within 2 hexes</span></div>`
      : city.hasFiredThisTurn
        ? `<div class="cp-row"><strong>Bombard</strong> <span class="dim">used this turn</span></div>`
        : "";

    cpBody.innerHTML = `
      <div class="cp-row"><strong>Pop</strong> ${city.population} <span class="dim">(food ${city.food}/${city.foodToGrow})</span> · ${hpLine}</div>
      <div class="cp-row"><strong>Yields</strong> ${yieldLine}</div>
      <div class="cp-row"><strong>Worked</strong> ${city.workedTiles.length} tiles</div>
      ${bombardLine}
      <div class="cp-row"><strong>Buildings</strong> ${
        city.buildings.length === 0
          ? "<span class='dim'>none</span>"
          : city.buildings
              .map((b) => {
                const def = pack?.buildings.find((x) => (x.id as unknown as string) === b);
                const byields = def?.city_yields ?? {};
                const yieldStr = (["food", "production", "gold", "science", "culture"] as const)
                  .map((k) => (byields[k] ? `+${byields[k]}${k[0]}` : ""))
                  .filter(Boolean)
                  .join(" ");
                return `<span class='built-building'>${escape(buildingName(b))}${yieldStr ? ` <span class='dim'>${yieldStr}</span>` : ""}</span>`;
              })
              .join(" · ")
      }</div>
      <div class="cp-row"><strong>Building</strong> ${escape(itemLabel)}${item ? ` <span class="dim">(${accLine})</span>` : ""}</div>
      ${item && item.kind !== "wonder" && itemCost !== null ? `<div class="cp-row"><button id="cp-buy" class="cp-buy" ${isMyTurn ? "" : "disabled"}>Buy now (${(itemCost - city.production) * 4} gold)</button></div>` : ""}
      <div class="cp-row"><strong>Queue (units)</strong></div>
      <div class="cp-grid">${units.map(renderUnitBtn).join("") || "<span class='dim'>nothing buildable yet — research a tech</span>"}</div>
      <div class="cp-row"><strong>Queue (buildings)</strong></div>
      <div class="cp-grid">${buildings.map(renderBuildingBtn).join("") || "<span class='dim'>nothing buildable yet</span>"}</div>
      ${(() => {
        const wonders = pack ? buildableWondersFn(pack, me, latest!.wondersBuilt ?? {}) : [];
        if (wonders.length === 0) return "";
        return `<div class="cp-row"><strong>Queue (wonders)</strong></div><div class="cp-grid">${wonders
          .map((w) => {
            const isCurrent = item?.kind === "wonder" && item.defId === (w.id as unknown as string) ? " current" : "";
            return `<button class="cp-build${isCurrent}" data-kind="wonder" data-id="${w.id}" ${isMyTurn ? "" : "disabled"}>${escape(w.name)} <span class='dim'>${w.cost.production ?? 0}p</span></button>`;
          })
          .join("")}</div>`;
      })()}
      <div class="cp-row">
        <button id="cp-clear" class="cp-clear" ${isMyTurn ? "" : "disabled"}>Clear production</button>
      </div>
    `;

    cpBody.querySelectorAll<HTMLButtonElement>("button.cp-build").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.kind as "unit" | "building" | "wonder";
        const defId = btn.dataset.id!;
        const productionItem: ProductionItem = { kind, defId } as ProductionItem;
        client.sendIntent({
          type: "SetCityProduction",
          actorId: session.playerId,
          cityId: city.id,
          item: productionItem,
        });
      });
    });
    cpBody.querySelector<HTMLButtonElement>("#cp-buy")?.addEventListener("click", () => {
      client.sendIntent({ type: "BuyProduction", actorId: session.playerId, cityId: city.id });
    });
    cpBody.querySelector<HTMLButtonElement>("#cp-clear")?.addEventListener("click", () => {
      client.sendIntent({
        type: "SetCityProduction",
        actorId: session.playerId,
        cityId: city.id,
        item: null,
      });
    });
  }

  function renderTechBody(): void {
    if (!pack || !latest) {
      tpBody.innerHTML = "<div class='cp-row dim'>loading content pack…</div>";
      return;
    }
    const me = latest.players.find((p) => p.id === session.playerId);
    if (!me) return;
    const isMyTurn = latest.players[latest.currentPlayerIndex]?.id === session.playerId;

    const treeId = me.civId
      ? pack.civilizations.find((c) => (c.id as unknown as string) === me.civId)?.tech_tree_id
      : null;
    const techsInTree = pack.techs.filter((t) => t.tree_id === treeId);
    const erasInOrder = [...pack.eras].sort((a, b) => a.order - b.order);

    const COL_W = 200, ROW_H = 76, COL_PAD_X = 24, PAD_TOP = 50;
    const eraIndex = new Map<string, number>(
      erasInOrder.map((e, i) => [e.id as unknown as string, i]),
    );
    const techsByEra = new Map<string, Tech[]>();
    for (const tech of techsInTree) {
      const eId = tech.era as unknown as string;
      const arr = techsByEra.get(eId) ?? [];
      arr.push(tech);
      techsByEra.set(eId, arr);
    }
    const positions = new Map<string, { x: number; y: number }>();
    let maxRow = 0;
    for (const [eId, list] of techsByEra) {
      const colIdx = eraIndex.get(eId) ?? 0;
      list.forEach((tech, i) => {
        positions.set(tech.id as unknown as string, {
          x: COL_PAD_X + colIdx * COL_W,
          y: PAD_TOP + i * ROW_H,
        });
        if (i + 1 > maxRow) maxRow = i + 1;
      });
    }
    const TOTAL_W = COL_PAD_X * 2 + erasInOrder.length * COL_W;
    const TOTAL_H = PAD_TOP + maxRow * ROW_H + 16;

    const eraHeaders = erasInOrder
      .map((era, i) => {
        const x = COL_PAD_X + i * COL_W;
        return `<div class="tech-era-header" style="left:${x}px;width:${COL_W - 16}px;">${escape(era.name)}</div>`;
      })
      .join("");

    const techBoxes = techsInTree
      .map((tech) => {
        const id = tech.id as unknown as string;
        const pos = positions.get(id)!;
        const researched = me.researchedTechs.includes(id);
        const current = me.currentTech === id;
        const r = canResearch(me, tech, pack!);
        const status = researched ? "researched" : current ? "current" : r.ok ? "available" : "locked";
        const disabled = !isMyTurn || researched || current || !r.ok;
        const unlocks = describeUnlocks(tech);
        const progress =
          current && tech.cost > 0
            ? `<div class="tech-progress-bar"><div class="tech-progress-fill" style="width:${Math.min(100, (me.science / tech.cost) * 100)}%"></div></div>`
            : "";
        return `<button class="tech-box tech-${status}" data-id="${id}" ${disabled ? "disabled" : ""} style="left:${pos.x}px;top:${pos.y}px;width:${COL_W - 24}px;height:${ROW_H - 12}px;">
          <div class="tech-box-name">${escape(tech.name)}</div>
          <div class="tech-box-cost">${current ? `${me.science}/${tech.cost}` : `${tech.cost}s`}</div>
          ${unlocks ? `<div class="tech-box-unlocks">${unlocks}</div>` : ""}
          ${progress}
        </button>`;
      })
      .join("");

    const lineSegments: string[] = [];
    for (const tech of techsInTree) {
      const id = tech.id as unknown as string;
      const to = positions.get(id);
      if (!to) continue;
      for (const p of tech.prereqs) {
        const pid = p as unknown as string;
        const from = positions.get(pid);
        if (!from) continue;
        const x1 = from.x + (COL_W - 24);
        const y1 = from.y + (ROW_H - 12) / 2;
        const x2 = to.x;
        const y2 = to.y + (ROW_H - 12) / 2;
        const cx = (x1 + x2) / 2;
        lineSegments.push(
          `<path d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}" />`,
        );
      }
    }

    const cur = me.currentTech ? lookupTech(pack, me.currentTech) : null;
    const head = cur
      ? `<div class="cp-row"><strong>Current</strong> ${escape(cur.name)} — ${me.science}/${cur.cost}</div>`
      : `<div class="cp-row"><strong>Current</strong> <span class="dim">(none — pick one)</span></div>`;

    tpBody.innerHTML = `
      ${head}
      <div class="tech-tree-scroll">
        <div class="tech-tree-canvas" style="width:${TOTAL_W}px;height:${TOTAL_H}px;">
          <svg class="tech-tree-svg" width="${TOTAL_W}" height="${TOTAL_H}" xmlns="http://www.w3.org/2000/svg">
            ${lineSegments.join("")}
          </svg>
          ${eraHeaders}
          ${techBoxes}
        </div>
      </div>
    `;

    tpBody.querySelectorAll<HTMLButtonElement>("button.tech-box").forEach((btn) => {
      btn.addEventListener("click", () => {
        const techId = btn.dataset.id!;
        client.sendIntent({ type: "SetResearch", actorId: session.playerId, techId });
      });
    });
  }

  // ── Helpers ──

  function renderTechItem(_tech: Tech, _me: Player, _isMyTurn: boolean): string {
    return "";
  }

  function describeUnlocks(tech: Tech): string {
    const u = tech.unlocks;
    const parts: string[] = [];
    if (u.units.length > 0)
      parts.push(u.units.map((id) => unitName(id as unknown as string)).join(", "));
    if (u.buildings.length > 0)
      parts.push(u.buildings.map((id) => buildingName(id as unknown as string)).join(", "));
    if (u.resources_visible.length > 0)
      parts.push(`resource: ${u.resources_visible.map((id) => id as unknown as string).join(", ")}`);
    return parts.join("; ");
  }

  function lookupTech(p: ContentPack, id: string): Tech | undefined {
    return p.techs.find((t) => (t.id as unknown as string) === id);
  }
  function unitName(id: string): string {
    return pack?.units.find((u) => (u.id as unknown as string) === id)?.name ?? id;
  }
  function buildingName(id: string): string {
    return pack?.buildings.find((b) => (b.id as unknown as string) === id)?.name ?? id;
  }
  function techName(id: string): string {
    return pack?.techs.find((t) => (t.id as unknown as string) === id)?.name ?? id;
  }
  function improvementName(id: string): string {
    return pack?.improvements.find((x) => (x.id as unknown as string) === id)?.name ?? id;
  }
  function shortResourceName(id: string): string {
    if (!pack) return id;
    const r = pack.resources.find((x) => (x.id as unknown as string) === id);
    return r?.name ?? id.replace(/^resource\./, "");
  }
  function eraName(eraId: string): string {
    if (!pack) return eraId;
    const e = pack.eras.find((x) => (x.id as unknown as string) === eraId);
    return e?.name ?? eraId;
  }
  function labelFor(item: ProductionItem): string {
    if (item.kind === "unit") return unitName(item.defId);
    return buildingName(item.defId);
  }
  function productionCostOf(item: ProductionItem, p: ContentPack): number | null {
    if (item.kind === "unit") {
      const def = p.units.find((u) => (u.id as unknown as string) === item.defId);
      return def?.cost.production ?? null;
    }
    const def = p.buildings.find((b) => (b.id as unknown as string) === item.defId);
    return def?.cost.production ?? null;
  }

  // ── Reachable overlay ──

  function updateReachable(): void {
    if (!mapView || !latest || !latest.map || !selectedUnitId) {
      mapView?.setReachable(new Map(), null);
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit) { mapView.setReachable(new Map(), null); return; }
    const def = pack?.units.find((u) => (u.id as unknown as string) === unit.defId);
    if (pack && def) {
      const reach = computeReachable(latest.map, unit.position, unit.movementLeft, pack, {
        unitTerrainCosts: def.terrain_costs as Record<string, number>,
        unitTraits: def.traits.map((t) => t as unknown as string),
      });
      mapView.setReachable(reach, selectedUnitId);
      return;
    }
    const fakeContent = {
      terrains: (latest.map.tiles ?? []).map((t) => ({
        id: t.terrain, name: t.terrain, base_yields: {}, movement_cost: 1,
        impassable: false, passable_by_traits: [], domains: [],
      })),
    } as never;
    const reach = computeReachable(latest.map, unit.position, unit.movementLeft, fakeContent);
    mapView.setReachable(reach, selectedUnitId);
  }

  // ── State render ──

  function renderState(state: MatchView): void {
    // Lobby overlay: show during lobby, hide once in-progress
    if (state.status === "lobby") {
      lobbyOverlay.classList.remove("hidden");
      const isHost = state.hostId === session.playerId;
      loStart.disabled = !isHost || state.players.length < 2;
      loWatch.disabled = !isHost || state.players.length < 2;
      loSettings.classList.toggle("hidden", !isHost);
      loWaiting.textContent = state.players.length < 2
        ? "Waiting for players to join…"
        : isHost ? "Ready — start when everyone is in." : "Waiting for host to start…";
      loPlayers.innerHTML = state.players.map((p) => {
        const you = p.id === session.playerId ? `<span class="lo-you">(you)</span>` : "";
        const host = p.id === state.hostId ? `<span class="lo-host-tag">host</span>` : "";
        const conn = p.connected ? "🟢" : "⚪";
        return `<li><span class="swatch" style="background:${p.primary_color}"></span>${conn} ${escape(p.name)} ${you}${host}</li>`;
      }).join("");
    } else {
      lobbyOverlay.classList.add("hidden");
    }

    turnLabel.textContent = state.status === "lobby"
      ? `Lobby · ${state.players.length} player${state.players.length !== 1 ? "s" : ""}`
      : `Turn ${state.turnNumber}`;

    const current = state.players[state.currentPlayerIndex];
    if (state.status === "in_progress" && current) {
      const isMe = current.id === session.playerId;
      activeBadge.textContent = isMe ? "Your turn" : `${current.name} to act`;
      activeBadge.className = isMe ? "your-turn-badge" : "active-badge";
    } else {
      activeBadge.textContent = "";
      activeBadge.className = "active-badge";
    }

    const me = state.players.find((p) => p.id === session.playerId);
    eraBadge.textContent = me ? capitalize(eraName(me.era)) : "—";

    // Science per turn
    const sciPt = state.cities
      .filter((c) => c.ownerId === session.playerId)
      .reduce((s, c) => s + (c.perTurnYields.science ?? 0), 0);
    const cur = me?.currentTech && pack ? lookupTech(pack, me.currentTech) : null;
    scienceRateEl.textContent = cur
      ? `${cur.name} (${me?.science ?? 0}/${cur.cost}) +${sciPt}/t`
      : `+${sciPt}/t`;

    // Gold
    const goldPt = state.cities
      .filter((c) => c.ownerId === session.playerId)
      .reduce((s, c) => s + (c.perTurnYields.gold ?? 0), 0);
    goldLabelEl.textContent = me
      ? `${me.gold}g (${goldPt >= 0 ? "+" : ""}${goldPt}/t)`
      : "—";

    // Start button: lobby host only
    const isHost = state.hostId === session.playerId;
    const canStart = isHost && state.status === "lobby";
    startBtn.classList.toggle("hidden", !canStart);
    startBtn.disabled = !canStart || state.players.length < 2;

    endBtn.disabled = !(state.status === "in_progress" && current?.id === session.playerId);

    // Menu: player list + resources
    menuPlayers.innerHTML = state.players
      .map((p) => {
        const you = p.id === session.playerId ? " (you)" : "";
        const conn = p.connected ? "🟢" : "⚪";
        const turnTag = state.status === "in_progress" && p.id === current?.id
          ? " <span class='tag tag-active'>acting</span>" : "";
        return `<div class="menu-player-row"><span class="swatch" style="background:${p.primary_color}"></span>${conn} ${escape(p.name)}${you}${turnTag}</div>`;
      })
      .join("");

    if (me && me.availableResources && Object.keys(me.availableResources).length > 0) {
      const resStr = Object.entries(me.availableResources)
        .map(([rid, n]) => `${shortResourceName(rid)}×${n}`)
        .join(" · ");
      menuResSection.innerHTML = `<div class="menu-res">Resources: ${resStr}</div>`;
    } else {
      menuResSection.innerHTML = "";
    }

    logEl.innerHTML = state.log
      .slice(-15)
      .map((l) => `<li><code>T${l.turn}</code> ${escape(l.text)}</li>`)
      .join("");

    if (selectedUnitId && !state.units.some((u) => u.id === selectedUnitId)) {
      selectedUnitId = null;
    }
    if (selectedCityId) {
      const c = state.cities.find((c) => c.id === selectedCityId);
      if (!c) {
        closeCityPanel();
      } else if (!cityPanel.classList.contains("hidden")) {
        renderCityBody(c);
      }
    }
    if (!techPanel.classList.contains("hidden")) renderTechBody();
    if (!diploPanel.classList.contains("hidden")) renderDiploBody();

    if (mapView) {
      mapView.render(state);
      updateReachable();
      updateActionPanel();
    }
  }

  void renderTechItem; // suppress unused warning
  void techName;       // suppress unused warning
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
