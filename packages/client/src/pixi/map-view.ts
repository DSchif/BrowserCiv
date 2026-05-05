import type { City, ContentPack, MapView, MatchView, Player, Unit } from "@browserciv/shared";
import { Hex } from "@browserciv/shared";
import { Application, Container, Graphics, Text } from "pixi.js";

type AxialCoord = Hex.AxialCoord;

const HEX_SIZE = 28;

const TERRAIN_COLOR: Record<string, number> = {
  grassland: 0x4a8b3a,
  plains: 0x9aa83a,
  hills: 0x8b6b3a,
  forest: 0x2f6b3a,
  jungle: 0x186b30,
  desert: 0xd9b06a,
  tundra: 0x7a8a6a,
  snow: 0xe6eef3,
  coast: 0x3a8bbf,
  ocean: 0x2c5b8f,
  deep_ocean: 0x163763,
  mountain: 0x6e6e6e,
};

const UNIT_GLYPH: Record<string, string> = {
  "unit.warrior": "⚔",
  "unit.swordsman": "⚔",
  "unit.longswordsman": "⚔",
  "unit.musketman": "⚔",
  "unit.rifleman": "⚔",
  "unit.great_war_infantry": "⚔",
  "unit.infantry": "⚔",
  "unit.mech_infantry": "⚔",
  "unit.spearman": "↑",
  "unit.pikeman": "↑",
  "unit.lancer": "↑",
  "unit.archer": "→",
  "unit.composite_bowman": "→",
  "unit.crossbowman": "→",
  "unit.chariot_archer": "♞",
  "unit.horseman": "♞",
  "unit.knight": "♞",
  "unit.cavalry": "♞",
  "unit.modern_armor": "♞",
  "unit.catapult": "△",
  "unit.trebuchet": "△",
  "unit.cannon": "△",
  "unit.artillery": "△",
  "unit.trireme": "⛵",
  "unit.galleass": "⛵",
  "unit.caravel": "⛵",
  "unit.frigate": "⛵",
  "unit.ironclad": "⛵",
  "unit.battleship": "⛵",
  "unit.gdr": "★",
  "unit.settler": "⌂",
  "unit.worker": "⛏",
};

const IMPROVEMENT_GLYPH: Record<string, string> = {
  "improvement.farm": "▦",
  "improvement.mine": "⛏",
  "improvement.lumber_mill": "⚒",
  "improvement.trading_post": "$",
  "improvement.pasture": "♘",
  "improvement.quarry": "▣",
};

const RESOURCE_GLYPH: Record<string, string> = {
  "resource.wheat": "🌾",
  "resource.iron": "⛓",
  "resource.gold": "◇",
  "resource.horses": "♞",
  "resource.stone": "▲",
  "resource.coal": "■",
};

export interface MapViewCallbacks {
  onTileClick?: (coord: AxialCoord, ctrl: boolean) => void;
  onUnitClick?: (unit: Unit) => void;
  onCityClick?: (city: City) => void;
  onTileHover?: (coord: AxialCoord | null) => void;
}

const VERTS: Array<[number, number]> = (() => {
  const v: Array<[number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i + 30) * Math.PI) / 180;
    v.push([Math.cos(a), Math.sin(a)]);
  }
  return v;
})();

export class MapViewer {
  app: Application;
  world = new Container();
  hexLayer = new Container();
  resourceLayer = new Container();
  territoryLayer = new Container();
  borderLayer = new Container();
  workLayer = new Container();
  overlayLayer = new Container();
  pathLayer = new Container();
  cityLayer = new Container();
  unitLayer = new Container();

  private callbacks: MapViewCallbacks;
  reachable: Map<string, number> = new Map();
  selectedUnitId: string | null = null;
  selectedCityId: string | null = null;
  pack: ContentPack | null = null;
  /** Centered once on the viewer's starting hex; subsequent renders preserve pan/zoom. */
  private hasCentered = false;
  private mapBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

  constructor(app: Application, callbacks: MapViewCallbacks = {}) {
    this.app = app;
    this.callbacks = callbacks;
    app.stage.addChild(this.world);
    this.world.addChild(this.hexLayer);
    this.world.addChild(this.resourceLayer);
    this.world.addChild(this.territoryLayer);
    this.world.addChild(this.borderLayer);
    this.world.addChild(this.workLayer);
    this.world.addChild(this.overlayLayer);
    this.world.addChild(this.pathLayer);
    this.world.addChild(this.cityLayer);
    this.world.addChild(this.unitLayer);
    this.installPanZoom();
  }

  /** Center the world on a given axial coord (or near-as-possible). */
  centerOn(coord: AxialCoord): void {
    const p = Hex.axialToPixel(coord, HEX_SIZE);
    const z = this.world.scale.x;
    this.world.x = window.innerWidth / 2 - p.x * z;
    this.world.y = window.innerHeight / 2 - p.y * z;
  }

  private installPanZoom(): void {
    const canvas = this.app.canvas as HTMLCanvasElement;

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    let panning = false;
    let panLastX = 0;
    let panLastY = 0;

    canvas.addEventListener("pointerdown", (e) => {
      // Right-click or middle-click drag to pan.
      if (e.button === 2 || e.button === 1) {
        panning = true;
        panLastX = e.clientX;
        panLastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!panning) return;
      const dx = e.clientX - panLastX;
      const dy = e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      this.world.x += dx;
      this.world.y += dy;
    });
    const stopPan = (e: PointerEvent) => {
      if (panning) {
        panning = false;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {}
      }
    };
    canvas.addEventListener("pointerup", stopPan);
    canvas.addEventListener("pointercancel", stopPan);
    canvas.addEventListener("pointerleave", stopPan);

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.zoomAt(localX, localY, factor);
      },
      { passive: false },
    );
  }

  private zoomAt(localX: number, localY: number, factor: number): void {
    const oldZ = this.world.scale.x;
    const newZ = clamp(oldZ * factor, 0.25, 4);
    if (newZ === oldZ) return;
    const wx = (localX - this.world.x) / oldZ;
    const wy = (localY - this.world.y) / oldZ;
    this.world.scale.set(newZ);
    this.world.x = localX - wx * newZ;
    this.world.y = localY - wy * newZ;
  }

  render(view: MatchView): void {
    if (view.map) {
      this.renderMap(view.map);
      this.renderResources(view.map);
      this.computeMapBounds(view.map);
      if (!this.hasCentered) {
        const me = view.players.find((p) => p.id === view.viewerId);
        if (me?.startingHex) {
          const initialZ =
            view.map.width > 50 ? 0.6 : view.map.width > 35 ? 0.85 : 1;
          this.world.scale.set(initialZ);
          this.centerOn(me.startingHex);
          this.hasCentered = true;
        }
      }
    }
    this.renderTerritory(view);
    this.renderWorkedTiles(view);
    this.renderCities(view);
    this.renderUnits(view.units, view.viewerId, view.players);
    this.renderPendingPaths(view);
    this.renderOverlay();
  }

  private renderPendingPaths(view: MatchView): void {
    // Faded trails for any of viewer's units that have queued waypoints.
    for (const u of view.units) {
      if (u.ownerId !== view.viewerId) continue;
      if (!u.pendingPath || u.pendingPath.length === 0) continue;
      const start = Hex.axialToPixel(u.position, HEX_SIZE);
      const line = new Graphics();
      let prev: { x: number; y: number } = start;
      for (const c of u.pendingPath) {
        const p = Hex.axialToPixel(c, HEX_SIZE);
        line.moveTo(prev.x, prev.y);
        line.lineTo(p.x, p.y);
        prev = p;
      }
      line.stroke({ color: 0xfff200, width: 2, alpha: 0.35 });
      line.eventMode = "none";
      this.unitLayer.addChild(line);
      for (const c of u.pendingPath) {
        const p = Hex.axialToPixel(c, HEX_SIZE);
        const dot = new Graphics()
          .circle(0, 0, 3)
          .fill({ color: 0xfff200, alpha: 0.45 });
        dot.x = p.x;
        dot.y = p.y;
        dot.eventMode = "none";
        this.unitLayer.addChild(dot);
      }
    }
  }

  private renderResources(map: MapView): void {
    this.resourceLayer.removeChildren();
    for (const tile of map.tiles) {
      if (tile.visibility === "unseen") continue;
      const { x, y } = Hex.axialToPixel({ q: tile.q, r: tile.r }, HEX_SIZE);
      const dim = tile.visibility === "seen" ? 0.55 : 1;

      // Resource icon (top-left)
      if (tile.resource) {
        const glyph = RESOURCE_GLYPH[tile.resource] ?? "?";
        const t = new Text({
          text: glyph,
          style: {
            fontSize: 14,
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "system-ui",
          },
        });
        t.anchor.set(0.5);
        t.x = x - HEX_SIZE * 0.55;
        t.y = y - HEX_SIZE * 0.55;
        t.alpha = dim;
        t.eventMode = "none";
        this.resourceLayer.addChild(t);
      }

      // Improvement icon (top-right)
      if (tile.improvement) {
        const glyph = IMPROVEMENT_GLYPH[tile.improvement] ?? "?";
        const t = new Text({
          text: glyph,
          style: {
            fontSize: 14,
            fill: 0xfff200,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "system-ui",
            fontWeight: "bold",
          },
        });
        t.anchor.set(0.5);
        t.x = x + HEX_SIZE * 0.55;
        t.y = y - HEX_SIZE * 0.55;
        t.alpha = dim;
        t.eventMode = "none";
        this.resourceLayer.addChild(t);
      }

      // Work-in-progress turns counter (centered top)
      if (tile.workInProgress) {
        const wip = new Text({
          text: `🛠${tile.workInProgress.turnsLeft}`,
          style: {
            fontSize: 11,
            fill: 0xfff200,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "system-ui",
            fontWeight: "bold",
          },
        });
        wip.anchor.set(0.5);
        wip.x = x;
        wip.y = y - HEX_SIZE * 0.55;
        wip.eventMode = "none";
        this.resourceLayer.addChild(wip);
      }
    }
  }

  private computeMapBounds(map: MapView): void {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of map.tiles) {
      const { x, y } = Hex.axialToPixel({ q: t.q, r: t.r }, HEX_SIZE);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.mapBounds = { minX, maxX, minY, maxY };
  }

  setReachable(reachable: Map<string, number>, selectedUnitId: string | null): void {
    this.reachable = reachable;
    this.selectedUnitId = selectedUnitId;
    this.renderOverlay();
  }

  /** Set a path to preview (list of axial coords from unit's current pos to target). */
  setPathPreview(path: AxialCoord[] | null, totalCost: number = 0): void {
    this.pathLayer.removeChildren();
    if (!path || path.length === 0) return;
    // Draw colored dots at each step + a connecting line.
    const line = new Graphics();
    let prev: { x: number; y: number } | null = null;
    for (const c of path) {
      const { x, y } = Hex.axialToPixel(c, HEX_SIZE);
      if (prev) {
        line.moveTo(prev.x, prev.y);
        line.lineTo(x, y);
      }
      prev = { x, y };
    }
    line.stroke({ color: 0xfff200, width: 3, alpha: 0.85 });
    line.eventMode = "none";
    this.pathLayer.addChild(line);

    for (const c of path) {
      const { x, y } = Hex.axialToPixel(c, HEX_SIZE);
      const dot = new Graphics()
        .circle(0, 0, 5)
        .fill({ color: 0xfff200, alpha: 0.9 })
        .stroke({ color: 0x000000, width: 1, alpha: 0.7 });
      dot.x = x;
      dot.y = y;
      dot.eventMode = "none";
      this.pathLayer.addChild(dot);
    }

    // Cost label at endpoint.
    const last = path[path.length - 1]!;
    const { x: lx, y: ly } = Hex.axialToPixel(last, HEX_SIZE);
    const label = new Text({
      text: `${totalCost} MP`,
      style: {
        fontSize: 11,
        fill: 0xfff200,
        stroke: { color: 0x000000, width: 2 },
        fontFamily: "monospace",
        fontWeight: "bold",
      },
    });
    label.anchor.set(0.5);
    label.x = lx;
    label.y = ly + HEX_SIZE * 0.4;
    label.eventMode = "none";
    this.pathLayer.addChild(label);
  }

  setSelectedCity(cityId: string | null): void {
    this.selectedCityId = cityId;
  }

  setPack(pack: ContentPack): void {
    this.pack = pack;
  }

  private renderMap(map: MapView): void {
    this.hexLayer.removeChildren();
    for (const tile of map.tiles) {
      const { x, y } = Hex.axialToPixel({ q: tile.q, r: tile.r }, HEX_SIZE);
      const baseColor = TERRAIN_COLOR[tile.terrain] ?? 0x444444;
      let alpha = 0.92;
      let fill = baseColor;
      if (tile.visibility === "unseen") {
        fill = 0x0a0d12;
        alpha = 0.95;
      } else if (tile.visibility === "seen") {
        fill = darken(baseColor, 0.45);
        alpha = 0.65;
      }
      const hex = drawHexFill(HEX_SIZE - 1, fill, alpha);
      hex.x = x;
      hex.y = y;
      hex.eventMode = "static";
      hex.cursor = "pointer";
      const coord: AxialCoord = { q: tile.q, r: tile.r };
      hex.on("pointertap", (e) => {
        this.callbacks.onTileClick?.(coord, e.ctrlKey || e.metaKey);
      });
      hex.on("pointerover", () => this.callbacks.onTileHover?.(coord));
      hex.on("pointerout", () => this.callbacks.onTileHover?.(null));
      this.hexLayer.addChild(hex);
    }
  }

  private renderTerritory(view: MatchView): void {
    this.territoryLayer.removeChildren();
    this.borderLayer.removeChildren();
    if (!view.map) return;

    const playerById = new Map<string, Player>(view.players.map((p) => [p.id, p]));

    // Build per-player territory from tileOwnership embedded in tile.ownerCityId.
    const cityById = new Map(view.cities.map((c) => [c.id, c]));
    const visibleKeys = new Set(
      view.map.tiles
        .filter((t) => t.visibility !== "unseen")
        .map((t) => Hex.key({ q: t.q, r: t.r })),
    );

    const ownedByPlayer = new Map<string, Set<string>>();
    for (const tile of view.map.tiles) {
      if (!tile.ownerCityId) continue;
      const k = Hex.key({ q: tile.q, r: tile.r });
      if (!visibleKeys.has(k)) continue;
      const city = cityById.get(tile.ownerCityId);
      if (!city) continue;
      let s = ownedByPlayer.get(city.ownerId);
      if (!s) {
        s = new Set();
        ownedByPlayer.set(city.ownerId, s);
      }
      s.add(k);
    }

    // Faded primary fill on owned tiles.
    for (const [ownerId, owned] of ownedByPlayer) {
      const player = playerById.get(ownerId);
      if (!player) continue;
      const primary = parseColor(player.primary_color);
      for (const k of owned) {
        const [qStr, rStr] = k.split(",");
        const c = { q: parseInt(qStr!, 10), r: parseInt(rStr!, 10) };
        const { x, y } = Hex.axialToPixel(c, HEX_SIZE);
        const overlay = drawHexFill(HEX_SIZE - 1, primary, 0.28);
        overlay.x = x;
        overlay.y = y;
        overlay.eventMode = "none";
        this.territoryLayer.addChild(overlay);
      }
    }

    // Hex-edge borders in secondary color.
    for (const [ownerId, owned] of ownedByPlayer) {
      const player = playerById.get(ownerId);
      if (!player) continue;
      const secondary = parseColor(player.secondary_color);
      const g = new Graphics();
      for (const k of owned) {
        const [qStr, rStr] = k.split(",");
        const coord = { q: parseInt(qStr!, 10), r: parseInt(rStr!, 10) };
        const { x, y } = Hex.axialToPixel(coord, HEX_SIZE);
        // NEIGHBORS array order [E, NE, NW, W, SW, SE] vs hex vertex order
        // (vert 0 at math angle 30°, going CCW → 30,90,150,210,270,330).
        // Edge `e` lies between vert `e` and `e+1`. With pointy-top hexes and
        // y-down rendering, neighbor index i crosses edge (5 - i) % 6.
        for (let i = 0; i < 6; i++) {
          const nb = Hex.neighbors(coord)[i]!;
          if (owned.has(Hex.key(nb))) continue;
          const edge = (5 - i + 6) % 6;
          const v0 = VERTS[edge]!;
          const v1 = VERTS[(edge + 1) % 6]!;
          const rr = HEX_SIZE - 1;
          g.moveTo(x + v0[0] * rr, y + v0[1] * rr);
          g.lineTo(x + v1[0] * rr, y + v1[1] * rr);
        }
      }
      g.stroke({ color: secondary, width: 3, alpha: 0.95 });
      g.eventMode = "none";
      this.borderLayer.addChild(g);
    }
  }

  private renderWorkedTiles(view: MatchView): void {
    this.workLayer.removeChildren();
    if (!this.pack || !view.map) return;
    const tilesByKey = new Map(view.map.tiles.map((t) => [Hex.key({ q: t.q, r: t.r }), t]));
    const terrainsById = new Map(this.pack.terrains.map((t) => [t.id as unknown as string, t]));
    const impById = new Map(this.pack.improvements.map((i) => [i.id as unknown as string, i]));

    for (const c of view.cities) {
      if (c.ownerId !== view.viewerId) continue;
      for (const k of c.workedTiles) {
        const [qStr, rStr] = k.split(",");
        const coord = { q: parseInt(qStr!, 10), r: parseInt(rStr!, 10) };
        const { x, y } = Hex.axialToPixel(coord, HEX_SIZE);
        const dot = new Graphics().circle(0, 0, 4).fill({ color: 0xffffff, alpha: 0.7 });
        dot.x = x;
        dot.y = y - HEX_SIZE * 0.7;
        dot.eventMode = "none";
        this.workLayer.addChild(dot);
      }
      // Show yields on every tile this city owns (including workable + center).
      for (const k of c.ownedTiles) {
        const tile = tilesByKey.get(k);
        if (!tile || tile.visibility === "unseen") continue;
        const terrain = terrainsById.get(tile.terrain);
        const base = terrain?.base_yields ?? {};
        const imp = tile.improvement ? impById.get(tile.improvement) : undefined;
        const yields = {
          food: (base.food ?? 0) + (imp?.yield_bonus.food ?? 0),
          production: (base.production ?? 0) + (imp?.yield_bonus.production ?? 0),
          gold: (base.gold ?? 0) + (imp?.yield_bonus.gold ?? 0),
          science: (base.science ?? 0) + (imp?.yield_bonus.science ?? 0),
          culture: (base.culture ?? 0) + (imp?.yield_bonus.culture ?? 0),
        };
        const parts: Array<{ label: string; color: number }> = [];
        if (yields.food) parts.push({ label: `${yields.food}F`, color: 0x6ee27a });
        if (yields.production) parts.push({ label: `${yields.production}P`, color: 0xe7a04a });
        if (yields.gold) parts.push({ label: `${yields.gold}G`, color: 0xf0d040 });
        if (yields.science) parts.push({ label: `${yields.science}S`, color: 0x79c0ff });
        if (yields.culture) parts.push({ label: `${yields.culture}C`, color: 0xc684f7 });
        if (parts.length === 0) continue;
        const { x, y } = Hex.axialToPixel({ q: tile.q, r: tile.r }, HEX_SIZE);
        const text = parts.map((p) => p.label).join(" ");
        const t = new Text({
          text,
          style: {
            fontSize: 9,
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "monospace",
          },
        });
        t.anchor.set(0.5);
        t.x = x;
        t.y = y + HEX_SIZE * 0.55;
        t.eventMode = "none";
        this.workLayer.addChild(t);
      }
    }
  }

  private renderCities(view: MatchView): void {
    this.cityLayer.removeChildren();
    const playerById = new Map(view.players.map((p) => [p.id, p]));
    for (const c of view.cities) {
      const owner = playerById.get(c.ownerId);
      if (!owner) continue;
      const { x, y } = Hex.axialToPixel(c.position, HEX_SIZE);
      const primary = parseColor(owner.primary_color);
      const secondary = parseColor(owner.secondary_color);
      const isSelected = c.id === this.selectedCityId;

      // Castle silhouette drawn directly on the city hex.
      const cs = HEX_SIZE * 0.45;
      const castle = new Graphics();
      // base wall
      castle.rect(-cs, -cs * 0.05, cs * 2, cs * 0.6);
      // left tower
      castle.rect(-cs - 2, -cs * 0.5, cs * 0.55, cs * 1.05);
      // right tower
      castle.rect(cs - cs * 0.55 + 2, -cs * 0.5, cs * 0.55, cs * 1.05);
      // central keep
      castle.rect(-cs * 0.4, -cs * 0.7, cs * 0.8, cs * 1.25);
      // crenellations on top of central keep
      castle.rect(-cs * 0.4, -cs * 0.85, cs * 0.25, cs * 0.18);
      castle.rect(cs * 0.15, -cs * 0.85, cs * 0.25, cs * 0.18);
      castle.fill({ color: primary, alpha: 0.98 }).stroke({
        color: isSelected ? 0xfff200 : secondary,
        width: isSelected ? 3 : 2,
      });
      castle.x = x;
      castle.y = y;
      castle.eventMode = "static";
      castle.cursor = "pointer";
      castle.on("pointertap", () => this.callbacks.onCityClick?.(c));
      this.cityLayer.addChild(castle);

      // Selection ring around the entire hex
      if (isSelected) {
        const ring = new Graphics();
        const points: number[] = [];
        for (const [vx, vy] of VERTS)
          points.push((HEX_SIZE - 4) * vx, (HEX_SIZE - 4) * vy);
        ring.poly(points).stroke({ color: 0xfff200, width: 3, alpha: 0.95 });
        ring.x = x;
        ring.y = y;
        ring.eventMode = "none";
        this.cityLayer.addChild(ring);
      }

      // Name plate above the hex (kept for readability of name + pop + production).
      const plateW = HEX_SIZE * 2.0;
      const isOwn = c.ownerId === view.viewerId;
      const showBuilding = isOwn && !!c.productionItem;
      const plateH = showBuilding ? 30 : 18;
      const plate = new Graphics()
        .roundRect(-plateW / 2, -plateH / 2, plateW, plateH, 4)
        .fill({ color: primary, alpha: 0.95 })
        .stroke({ color: secondary, width: 2 });
      plate.x = x;
      plate.y = y - HEX_SIZE * 1.05;
      plate.eventMode = "static";
      plate.cursor = "pointer";
      plate.on("pointertap", () => this.callbacks.onCityClick?.(c));
      this.cityLayer.addChild(plate);

      const nameLabel = new Text({
        text: `${c.name} · ${c.population}`,
        style: {
          fontSize: 11,
          fill: secondary,
          fontFamily: "system-ui",
          fontWeight: "bold",
        },
      });
      nameLabel.anchor.set(0.5);
      nameLabel.x = x;
      nameLabel.y = y - HEX_SIZE * 1.05 + (showBuilding ? -7 : 0);
      nameLabel.eventMode = "none";
      this.cityLayer.addChild(nameLabel);

      // What is this city building?
      if (showBuilding && c.productionItem) {
        const item = c.productionItem;
        const itemName = this.lookupItemName(item);
        const cost = this.lookupItemCost(item);
        const ppt = c.perTurnYields.production ?? 0;
        const remaining = cost !== null ? Math.max(0, cost - c.production) : 0;
        const turnsLeft = ppt > 0 && cost !== null ? Math.ceil(remaining / ppt) : null;
        const turnsLabel = turnsLeft !== null ? ` ${turnsLeft}t` : "";
        const buildLabel = new Text({
          text: `→ ${itemName}${turnsLabel}`,
          style: {
            fontSize: 10,
            fill: secondary,
            fontFamily: "system-ui",
          },
        });
        buildLabel.anchor.set(0.5);
        buildLabel.x = x;
        buildLabel.y = y - HEX_SIZE * 1.05 + 6;
        buildLabel.eventMode = "none";
        this.cityLayer.addChild(buildLabel);

        // Accurate progress bar based on real cost.
        if (cost !== null && cost > 0) {
          const bar = new Graphics();
          const barW = plateW - 8;
          const barH = 3;
          bar.rect(-barW / 2, 0, barW, barH).fill({ color: 0x000000, alpha: 0.6 });
          const pct = Math.min(1, c.production / cost);
          bar.rect(-barW / 2, 0, barW * pct, barH).fill({ color: 0xffd700, alpha: 0.95 });
          bar.x = x;
          bar.y = y - HEX_SIZE * 1.05 + plateH / 2 - 5;
          bar.eventMode = "none";
          this.cityLayer.addChild(bar);
        }
      }
    }
  }

  private lookupItemName(item: { kind: "unit" | "building" | "wonder"; defId: string }): string {
    if (!this.pack) return item.defId;
    if (item.kind === "unit")
      return this.pack.units.find((u) => (u.id as unknown as string) === item.defId)?.name ?? item.defId;
    if (item.kind === "building")
      return this.pack.buildings.find((b) => (b.id as unknown as string) === item.defId)?.name ?? item.defId;
    return this.pack.wonders.find((w) => (w.id as unknown as string) === item.defId)?.name ?? item.defId;
  }

  private lookupItemCost(item: { kind: "unit" | "building" | "wonder"; defId: string }): number | null {
    if (!this.pack) return null;
    if (item.kind === "unit")
      return this.pack.units.find((u) => (u.id as unknown as string) === item.defId)?.cost.production ?? null;
    if (item.kind === "building")
      return this.pack.buildings.find((b) => (b.id as unknown as string) === item.defId)?.cost.production ?? null;
    return this.pack.wonders.find((w) => (w.id as unknown as string) === item.defId)?.cost.production ?? null;
  }

  private renderUnits(units: Unit[], viewerId: string, players: Player[]): void {
    this.unitLayer.removeChildren();
    const playerById = new Map(players.map((p) => [p.id, p]));
    for (const u of units) {
      const owner = playerById.get(u.ownerId);
      if (!owner) continue;
      const { x, y } = Hex.axialToPixel(u.position, HEX_SIZE);
      const glyph = UNIT_GLYPH[u.defId] ?? "?";
      const isMine = u.ownerId === viewerId;
      const isSelected = u.id === this.selectedUnitId;
      const primary = parseColor(owner.primary_color);
      const secondary = parseColor(owner.secondary_color);

      const bg = new Graphics()
        .circle(0, 0, HEX_SIZE * 0.55)
        .fill({ color: primary, alpha: 0.95 })
        .stroke({
          color: isSelected ? 0xfff200 : secondary,
          width: isSelected ? 4 : 2,
          alpha: 1,
        });
      bg.x = x;
      bg.y = y;
      bg.eventMode = "static";
      bg.cursor = "pointer";
      bg.on("pointertap", () => this.callbacks.onUnitClick?.(u));
      this.unitLayer.addChild(bg);

      const label = new Text({
        text: glyph,
        style: {
          fontSize: 20,
          fill: secondary,
          fontFamily: "system-ui",
          fontWeight: "bold",
        },
      });
      label.anchor.set(0.5);
      label.x = x;
      label.y = y;
      this.unitLayer.addChild(label);

      if (isMine) {
        const mp = new Text({
          text: `${u.movementLeft}/${u.movementMax}`,
          style: {
            fontSize: 9,
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "monospace",
          },
        });
        mp.anchor.set(0.5);
        mp.x = x;
        mp.y = y + HEX_SIZE * 0.65;
        this.unitLayer.addChild(mp);
      }
    }
  }

  private renderOverlay(): void {
    this.overlayLayer.removeChildren();
    if (this.reachable.size === 0) return;
    for (const [k, cost] of this.reachable.entries()) {
      const [qStr, rStr] = k.split(",");
      const coord = { q: parseInt(qStr!, 10), r: parseInt(rStr!, 10) };
      const { x, y } = Hex.axialToPixel(coord, HEX_SIZE);
      const ring = drawHexFill(HEX_SIZE - 3, 0xfff200, 0.18);
      ring.x = x;
      ring.y = y;
      this.overlayLayer.addChild(ring);
      const t = new Text({
        text: String(cost),
        style: { fontSize: 9, fill: 0xfff200, fontFamily: "monospace" },
      });
      t.anchor.set(0.5);
      t.x = x;
      t.y = y - HEX_SIZE + 8;
      this.overlayLayer.addChild(t);
    }
  }
}

function drawHexFill(size: number, fill: number, alpha = 0.92): Graphics {
  const g = new Graphics();
  const points: number[] = [];
  for (const [vx, vy] of VERTS) points.push(size * vx, size * vy);
  g.poly(points)
    .fill({ color: fill, alpha })
    .stroke({ color: 0x0e1116, width: 1, alpha: 0.5 });
  return g;
}

function parseColor(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function darken(color: number, factor: number): number {
  const r = Math.floor(((color >> 16) & 0xff) * (1 - factor));
  const g = Math.floor(((color >> 8) & 0xff) * (1 - factor));
  const b = Math.floor((color & 0xff) * (1 - factor));
  return (r << 16) | (g << 8) | b;
}
