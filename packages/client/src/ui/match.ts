import type {
  City,
  ContentPack,
  MatchView,
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
} from "@browserciv/shared";
import type { Attack } from "@browserciv/shared";
import { Application } from "pixi.js";
import { fetchContentPack } from "../net/rest.js";
import { GameClient } from "../net/ws.js";
import { MapViewer } from "../pixi/map-view.js";

type AxialCoord = Hex.AxialCoord;

export interface MatchSession {
  matchId: string;
  playerId: string;
  token: string;
  name: string;
}

export function renderMatch(root: HTMLElement, session: MatchSession, onLeave: () => void): void {
  root.innerHTML = `
    <canvas id="game-canvas"></canvas>
    <div id="hud" class="hud">
      <div class="hud-row"><strong>Match</strong> <code id="match-id">${session.matchId}</code></div>
      <div class="hud-row"><strong>You</strong> <span id="me">${escape(session.name)}</span></div>
      <div class="hud-row"><strong>Status</strong> <span id="status">connecting…</span></div>
      <div class="hud-row"><strong>Turn</strong> <span id="turn">—</span></div>
      <div class="hud-row"><strong>To act</strong> <span id="active">—</span></div>
      <div class="hud-row"><strong>Era</strong> <span id="era">—</span></div>
      <div class="hud-row"><strong>Treasury</strong> <span id="treasury">—</span></div>
      <div class="hud-row"><strong>Research</strong> <span id="research">—</span></div>
      <div class="hud-row"><strong>Resources</strong> <span id="resources">—</span></div>
      <div class="hud-row"><strong>Selected</strong> <span id="selected">—</span></div>
      <div id="improvements-row" class="hud-row hidden"><strong>Build</strong> <div id="improvements-list" class="improvements-list"></div></div>
      <div class="hud-row"><strong>Players</strong></div>
      <ul id="players"></ul>
      <div class="hud-row buttons">
        <button id="start" disabled>Start match</button>
        <button id="found" disabled>Found city</button>
        <button id="upgrade" disabled>Upgrade</button>
        <button id="fortify" disabled>Fortify</button>
        <button id="tech">Research</button>
        <button id="diplomacy">Diplomacy</button>
        <button id="end" disabled>End turn</button>
        <button id="leave">Leave</button>
      </div>
      <div class="hud-row"><strong>Log</strong></div>
      <ul id="log"></ul>
    </div>
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
    <div id="attack-picker" class="attack-picker hidden"></div>
    <div id="tile-info" class="tile-info hidden"></div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>("#game-canvas")!;
  const statusEl = root.querySelector<HTMLSpanElement>("#status")!;
  const turnEl = root.querySelector<HTMLSpanElement>("#turn")!;
  const activeEl = root.querySelector<HTMLSpanElement>("#active")!;
  const eraEl = root.querySelector<HTMLSpanElement>("#era")!;
  const treasuryEl = root.querySelector<HTMLSpanElement>("#treasury")!;
  const researchEl = root.querySelector<HTMLSpanElement>("#research")!;
  const resourcesEl = root.querySelector<HTMLSpanElement>("#resources")!;
  const selectedEl = root.querySelector<HTMLSpanElement>("#selected")!;
  const playersEl = root.querySelector<HTMLUListElement>("#players")!;
  const logEl = root.querySelector<HTMLUListElement>("#log")!;
  const startBtn = root.querySelector<HTMLButtonElement>("#start")!;
  const foundBtn = root.querySelector<HTMLButtonElement>("#found")!;
  const upgradeBtn = root.querySelector<HTMLButtonElement>("#upgrade")!;
  const fortifyBtn = root.querySelector<HTMLButtonElement>("#fortify")!;
  const techBtn = root.querySelector<HTMLButtonElement>("#tech")!;
  const endBtn = root.querySelector<HTMLButtonElement>("#end")!;
  const leaveBtn = root.querySelector<HTMLButtonElement>("#leave")!;
  const cityPanel = root.querySelector<HTMLDivElement>("#city-panel")!;
  const cpName = root.querySelector<HTMLHeadingElement>("#cp-name")!;
  const cpBody = root.querySelector<HTMLDivElement>("#cp-body")!;
  const cpClose = root.querySelector<HTMLButtonElement>("#cp-close")!;
  const techPanel = root.querySelector<HTMLDivElement>("#tech-panel")!;
  const tpBody = root.querySelector<HTMLDivElement>("#tp-body")!;
  const tpClose = root.querySelector<HTMLButtonElement>("#tp-close")!;
  const diplomacyBtn = root.querySelector<HTMLButtonElement>("#diplomacy")!;
  const diploPanel = root.querySelector<HTMLDivElement>("#diplo-panel")!;
  const dpBody = root.querySelector<HTMLDivElement>("#dp-body")!;
  const dpClose = root.querySelector<HTMLButtonElement>("#dp-close")!;
  const improvementsRow = root.querySelector<HTMLDivElement>("#improvements-row")!;
  const improvementsList = root.querySelector<HTMLDivElement>("#improvements-list")!;
  const attackPicker = root.querySelector<HTMLDivElement>("#attack-picker")!;
  const tileInfo = root.querySelector<HTMLDivElement>("#tile-info")!;

  let mapView: MapViewer | null = null;
  let latest: MatchView | null = null;
  let pack: ContentPack | null = null;
  let selectedUnitId: string | null = null;
  let selectedCityId: string | null = null;

  // Fetch content pack so the UI knows the real units/buildings/techs.
  void fetchContentPack().then((p) => {
    pack = p;
    mapView?.setPack(p);
    if (latest) renderState(latest);
  });

  const app = new Application();
  void app
    .init({ canvas, resizeTo: window, background: "#0e1116", antialias: true })
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
    onOpen: () => (statusEl.textContent = "connected"),
    onClose: () => (statusEl.textContent = "disconnected"),
    onError: (code, msg) => (statusEl.textContent = `error: ${code} — ${msg}`),
    onState: (state) => {
      latest = state as unknown as MatchView;
      renderState(latest);
    },
    onReject: (_seq, code, msg) => (statusEl.textContent = `rejected: ${code} — ${msg}`),
    onAck: () => undefined,
  });
  client.connect();

  if (import.meta.env.DEV) {
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
        updateSelectedLabel();
        updateFoundButton();
        updateUpgradeButton();
      },
    };
  }

  startBtn.addEventListener("click", () => {
    client.sendIntent({ type: "MatchStart", actorId: session.playerId });
  });
  endBtn.addEventListener("click", () => {
    selectedUnitId = null;
    closeCityPanel();
    closeTechPanel();
    client.sendIntent({ type: "EndTurn", actorId: session.playerId });
  });
  foundBtn.addEventListener("click", () => {
    if (!selectedUnitId) return;
    client.sendIntent({
      type: "FoundCity",
      actorId: session.playerId,
      unitId: selectedUnitId,
    });
    selectedUnitId = null;
  });
  upgradeBtn.addEventListener("click", () => {
    if (!selectedUnitId) return;
    client.sendIntent({
      type: "UpgradeUnit",
      actorId: session.playerId,
      unitId: selectedUnitId,
    });
  });
  fortifyBtn.addEventListener("click", () => {
    if (!selectedUnitId) return;
    client.sendIntent({
      type: "Fortify",
      actorId: session.playerId,
      unitId: selectedUnitId,
    });
  });
  techBtn.addEventListener("click", () => {
    if (techPanel.classList.contains("hidden")) openTechPanel();
    else closeTechPanel();
  });
  leaveBtn.addEventListener("click", () => {
    client.close();
    onLeave();
  });
  cpClose.addEventListener("click", () => closeCityPanel());
  tpClose.addEventListener("click", () => closeTechPanel());
  dpClose.addEventListener("click", () => closeDiploPanel());
  diplomacyBtn.addEventListener("click", () => {
    if (diploPanel.classList.contains("hidden")) openDiploPanel();
    else closeDiploPanel();
  });

  function hideAttackPicker(): void {
    attackPicker.classList.add("hidden");
    attackPicker.innerHTML = "";
  }

  function showAttackPicker(
    target: Unit,
    options: Array<{ attack: Attack; onPick: () => void }>,
  ): void {
    void target;
    attackPicker.innerHTML = `<div class="ap-title">Choose attack</div>`;
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
      attackPicker.appendChild(btn);
    }
    const cancel = document.createElement("button");
    cancel.className = "ap-cancel";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => hideAttackPicker());
    attackPicker.appendChild(cancel);
    attackPicker.classList.remove("hidden");
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

  function onUnitClick(unit: Unit): void {
    if (!latest || !latest.map) return;
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
    // Clicking an enemy unit while my own city is selected = bombard
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
      if (usable.length === 1) {
        fire(usable[0]!.id);
      } else {
        showAttackPicker(
          unit,
          usable.map((a) => ({ attack: a, onPick: () => fire(a.id) })),
        );
      }
      return;
    }
    // Clicking an enemy unit while my own is selected = attack
    if (unit.ownerId !== session.playerId) {
      if (!isMyTurn || !selectedUnitId) return;
      const me = latest.units.find((u) => u.id === selectedUnitId);
      if (!me) return;
      const dq = me.position.q - unit.position.q;
      const dr = me.position.r - unit.position.r;
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
          target: { q: unit.position.q, r: unit.position.r },
          attackId,
        });
      };
      const fireRanged = (attackId?: string): void => {
        client.sendIntent({
          type: "RangedAttack",
          actorId: session.playerId,
          unitId: selectedUnitId!,
          targetUnitId: unit.id,
          attackId,
        });
      };
      if (all.length === 0) {
        // Fallback: legacy behavior — melee if adjacent, ranged if def has range
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
        unit,
        all.map((a) => ({
          attack: a,
          onPick: () => (a.range === 1 ? fireMelee(a.id) : fireRanged(a.id)),
        })),
      );
      return;
    }
    if (!isMyTurn) return;
    selectedUnitId = unit.id;
    selectedCityId = null;
    mapView?.setSelectedCity(null);
    closeCityPanel();
    hideAttackPicker();
    updateReachable();
    updateSelectedLabel();
    updateFoundButton();
    updateUpgradeButton();
    updateImprovementsRow();
  }

  function onTileClick(coord: AxialCoord): void {
    if (!selectedUnitId || !latest) return;
    // If selected unit is a transport with cargo, clicking adjacent passable
    // land tile triggers a disembark of the first onboard unit.
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
    if (!selectedUnitId || !coord) {
      mapView.setPathPreview(null);
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit) {
      mapView.setPathPreview(null);
      return;
    }
    const def = pack.units.find((d) => (d.id as unknown as string) === unit.defId);
    if (!def) {
      mapView.setPathPreview(null);
      return;
    }
    if (unit.position.q === coord.q && unit.position.r === coord.r) {
      mapView.setPathPreview(null);
      return;
    }
    const result = computeFindPath(latest.map, unit.position, coord, pack, {
      unitTerrainCosts: def.terrain_costs as Record<string, number>,
      unitTraits: def.traits.map((t) => t as unknown as string),
    });
    if (!result) {
      mapView.setPathPreview(null);
      return;
    }
    const path: AxialCoord[] = [unit.position, ...result.steps.map((s) => s.coord)];
    mapView.setPathPreview(path, result.totalCost);
  }

  function onCityClick(city: City): void {
    if (city.ownerId !== session.playerId) return;
    selectedCityId = city.id;
    selectedUnitId = null;
    mapView?.setSelectedCity(city.id);
    mapView?.setReachable(new Map(), null);
    openCityPanel(city);
    updateSelectedLabel();
    updateFoundButton();
    updateUpgradeButton();
    updateImprovementsRow();
  }

  function updateTileInfo(coord: AxialCoord | null): void {
    if (!coord || !latest || !latest.map || !pack) {
      tileInfo.classList.add("hidden");
      return;
    }
    const tile = latest.map.tiles.find((t) => t.q === coord.q && t.r === coord.r);
    if (!tile) {
      tileInfo.classList.add("hidden");
      return;
    }
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
      const harvested = required.length === 0 || (tile.improvement !== undefined && required.includes(tile.improvement));
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
          return `<div class="ti-row"><strong>${escape(resource.name)}</strong> ${tag}</div>`;
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

  function openCityPanel(city: City): void {
    cityPanel.classList.remove("hidden");
    cpName.textContent = city.name;
    renderCityBody(city);
  }

  function closeCityPanel(): void {
    cityPanel.classList.add("hidden");
    selectedCityId = null;
    mapView?.setSelectedCity(null);
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
                const yields = def?.city_yields ?? {};
                const yieldStr = (["food", "production", "gold", "science", "culture"] as const)
                  .map((k) => (yields[k] ? `+${yields[k]}${k[0]}` : ""))
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
      client.sendIntent({
        type: "BuyProduction",
        actorId: session.playerId,
        cityId: city.id,
      });
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

    // ---------- Layout ----------
    const COL_W = 200;
    const ROW_H = 76;
    const COL_PAD_X = 24;
    const PAD_TOP = 50;
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
    // x by era index; y by stable order within era
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

    // Era column headers
    const eraHeaders = erasInOrder
      .map((era, i) => {
        const x = COL_PAD_X + i * COL_W;
        return `<div class="tech-era-header" style="left:${x}px;width:${COL_W - 16}px;">${escape(era.name)}</div>`;
      })
      .join("");

    // Tech boxes
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

    // SVG lines for prereqs
    const lineSegments: string[] = [];
    for (const tech of techsInTree) {
      const id = tech.id as unknown as string;
      const to = positions.get(id);
      if (!to) continue;
      for (const p of tech.prereqs) {
        const pid = p as unknown as string;
        const from = positions.get(pid);
        if (!from) continue;
        // From the right edge of `from` box to the left edge of `to` box.
        const x1 = from.x + (COL_W - 24);
        const y1 = from.y + (ROW_H - 12) / 2;
        const x2 = to.x;
        const y2 = to.y + (ROW_H - 12) / 2;
        const cx = (x1 + x2) / 2;
        // Curve via cubic
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
        client.sendIntent({
          type: "SetResearch",
          actorId: session.playerId,
          techId,
        });
      });
    });
  }

  function renderTechItem(_tech: Tech, _me: Player, _isMyTurn: boolean): string {
    // (legacy — no longer used; the tree layout supersedes it)
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

  function updateReachable(): void {
    if (!mapView || !latest || !latest.map || !selectedUnitId) {
      mapView?.setReachable(new Map(), null);
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit) {
      mapView.setReachable(new Map(), null);
      return;
    }
    const def = pack?.units.find((u) => (u.id as unknown as string) === unit.defId);
    if (pack && def) {
      const reach = computeReachable(latest.map, unit.position, unit.movementLeft, pack, {
        unitTerrainCosts: def.terrain_costs as Record<string, number>,
        unitTraits: def.traits.map((t) => t as unknown as string),
      });
      mapView.setReachable(reach, selectedUnitId);
      return;
    }
    // Pack not loaded yet: fall back to uniform-cost approximation.
    const fakeContent = {
      terrains: (latest.map.tiles ?? []).map((t) => ({
        id: t.terrain,
        name: t.terrain,
        base_yields: {},
        movement_cost: 1,
        impassable: false,
        passable_by_traits: [],
        domains: [],
      })),
    } as never;
    const reach = computeReachable(latest.map, unit.position, unit.movementLeft, fakeContent);
    mapView.setReachable(reach, selectedUnitId);
  }

  function updateSelectedLabel(): void {
    if (selectedCityId && latest) {
      const c = latest.cities.find((x) => x.id === selectedCityId);
      selectedEl.textContent = c ? `City: ${c.name} (pop ${c.population})` : "—";
      return;
    }
    if (!selectedUnitId || !latest) {
      selectedEl.textContent = "—";
      return;
    }
    const u = latest.units.find((x) => x.id === selectedUnitId);
    if (!u) {
      selectedEl.textContent = "—";
      return;
    }
    const name = unitName(u.defId);
    const cargo = latest.units.filter((x) => x.boardedOn === u.id);
    const cargoLabel =
      cargo.length > 0
        ? ` · cargo: ${cargo.map((c) => unitName(c.defId)).join(", ")}`
        : "";
    const boarded = u.boardedOn ? " · onboard" : "";
    selectedEl.textContent = `${name} (${u.movementLeft}/${u.movementMax} MP)${cargoLabel}${boarded}`;
  }

  function updateFoundButton(): void {
    if (!latest || latest.status !== "in_progress") {
      foundBtn.disabled = true;
      return;
    }
    const isMyTurn =
      latest.players[latest.currentPlayerIndex]?.id === session.playerId;
    if (!isMyTurn || !selectedUnitId) {
      foundBtn.disabled = true;
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit || unit.defId !== "unit.settler") {
      foundBtn.disabled = true;
      return;
    }
    const stateLike = { cities: latest.cities } as never;
    foundBtn.disabled = !canFoundCityAt(stateLike, unit.position);
  }

  function updateImprovementsRow(): void {
    if (!latest || !pack || !selectedUnitId) {
      improvementsRow.classList.add("hidden");
      return;
    }
    const isMyTurn =
      latest.players[latest.currentPlayerIndex]?.id === session.playerId;
    if (!isMyTurn) {
      improvementsRow.classList.add("hidden");
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit) {
      improvementsRow.classList.add("hidden");
      return;
    }
    const def = pack.units.find((u) => (u.id as unknown as string) === unit.defId);
    const isWorker = def?.traits.some((t) => (t as unknown as string) === "worker");
    if (!isWorker) {
      improvementsRow.classList.add("hidden");
      return;
    }
    const tile = latest.map?.tiles.find((t) => t.q === unit.position.q && t.r === unit.position.r);
    if (!tile) {
      improvementsRow.classList.add("hidden");
      return;
    }
    if (tile.improvement || tile.workInProgress) {
      improvementsRow.classList.remove("hidden");
      improvementsList.innerHTML = tile.improvement
        ? `<span class="dim">${escape(improvementName(tile.improvement))} already here</span>`
        : `<span class="dim">in progress (${tile.workInProgress!.turnsLeft} turns left)</span>`;
      return;
    }
    const me = latest.players.find((p) => p.id === session.playerId)!;
    const opts = buildableImprovementsForTile(pack, me, tile);
    if (opts.length === 0) {
      improvementsRow.classList.add("hidden");
      return;
    }
    improvementsRow.classList.remove("hidden");
    improvementsList.innerHTML = opts
      .map(
        (i) => `<button class="cp-build" data-id="${i.id}">${escape(i.name)} <span class='dim'>${i.build_turns}t</span></button>`,
      )
      .join("");
    improvementsList.querySelectorAll<HTMLButtonElement>("button.cp-build").forEach((btn) => {
      btn.addEventListener("click", () => {
        const improvementId = btn.dataset.id!;
        client.sendIntent({
          type: "BuildImprovement",
          actorId: session.playerId,
          unitId: selectedUnitId!,
          improvementId,
        });
      });
    });
  }

  function improvementName(id: string): string {
    return pack?.improvements.find((x) => (x.id as unknown as string) === id)?.name ?? id;
  }

  function updateUpgradeButton(): void {
    if (!latest || !pack || latest.status !== "in_progress") {
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = "Upgrade";
      return;
    }
    const isMyTurn = latest.players[latest.currentPlayerIndex]?.id === session.playerId;
    if (!isMyTurn || !selectedUnitId) {
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = "Upgrade";
      return;
    }
    const unit = latest.units.find((u) => u.id === selectedUnitId);
    if (!unit) {
      upgradeBtn.disabled = true;
      return;
    }
    const def = pack.units.find((u) => (u.id as unknown as string) === unit.defId);
    if (!def?.evolves_to) {
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = "Upgrade";
      return;
    }
    const newDef = pack.units.find((u) => (u.id as unknown as string) === (def.evolves_to as unknown as string));
    const me = latest.players.find((p) => p.id === session.playerId);
    if (!newDef || !me) {
      upgradeBtn.disabled = true;
      return;
    }
    const cost = def.upgrade_cost.gold ?? 0;
    const techOk =
      !newDef.prereq_tech ||
      me.researchedTechs.includes(newDef.prereq_tech as unknown as string);
    const goldOk = me.gold >= cost;
    upgradeBtn.disabled = !(techOk && goldOk);
    upgradeBtn.textContent = `Upgrade → ${newDef.name} (${cost}g)`;
  }

  function renderState(state: MatchView): void {
    turnEl.textContent = state.status === "lobby" ? "lobby" : String(state.turnNumber);
    const current = state.players[state.currentPlayerIndex];
    activeEl.textContent =
      state.status === "in_progress" && current ? current.name : "—";

    const me = state.players.find((p) => p.id === session.playerId);
    treasuryEl.textContent = me
      ? `${me.gold} gold · ${me.culture} culture`
      : "—";
    eraEl.textContent = me ? capitalize(eraName(me.era)) : "—";
    if (me) {
      const cur = me.currentTech && pack ? lookupTech(pack, me.currentTech) : null;
      researchEl.textContent = cur
        ? `${cur.name} — ${me.science}/${cur.cost}`
        : me.currentTech ?? "(none — pick one)";
    } else {
      researchEl.textContent = "—";
    }
    if (me && me.availableResources && Object.keys(me.availableResources).length > 0) {
      resourcesEl.textContent = Object.entries(me.availableResources)
        .map(([rid, n]) => `${shortResourceName(rid)}:${n}`)
        .join(" · ");
    } else {
      resourcesEl.innerHTML = "<span class='dim'>none</span>";
    }

    playersEl.innerHTML = state.players
      .map((p) => {
        const youTag = p.id === session.playerId ? " <em>(you)</em>" : "";
        const hostTag = p.id === state.hostId ? " <span class='tag'>host</span>" : "";
        const conn = p.connected ? "🟢" : "⚪";
        const turnTag =
          state.status === "in_progress" && p.id === current?.id
            ? " <span class='tag tag-active'>to act</span>"
            : "";
        const civ = p.civId ? ` <span class="civ">${escape(p.civId)}</span>` : "";
        const swatch = `<span class="swatch" style="background:${p.primary_color};border-color:${p.secondary_color}"></span>`;
        return `<li>${swatch}${conn} ${escape(p.name)}${youTag}${hostTag}${civ}${turnTag}</li>`;
      })
      .join("");

    const isHost = state.hostId === session.playerId;
    startBtn.disabled = !(isHost && state.status === "lobby" && state.players.length >= 2);
    endBtn.disabled = !(state.status === "in_progress" && current?.id === session.playerId);

    logEl.innerHTML = state.log
      .slice(-12)
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
      updateSelectedLabel();
      updateFoundButton();
      updateUpgradeButton();
    }
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
