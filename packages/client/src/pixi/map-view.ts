import type { City, ContentPack, MapView, MatchView, PathfindResult, Player, Unit } from "@browserciv/shared";
import { Hex } from "@browserciv/shared";
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";

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

// Terrains that have sprite assets. Others fall back to TERRAIN_COLOR fills.
const TERRAIN_SPRITE: Record<string, string> = {
  grassland:  "/assets/hex-grass-land.png",
  hills:      "/assets/hex-grass-hill.png",
  forest:     "/assets/hex-forest-land.png",
  desert:     "/assets/hex-desert-land.png",
  jungle:     "/assets/hex-jungle-land.png",
  mountain:   "/assets/hex-mountain.png",
  coast:      "/assets/hex-water.png",
  ocean:      "/assets/hex-water.png",
  deep_ocean: "/assets/hex-deep-water.png",
};

// Flat-top → pointy-top rotation + scale to fit HEX_SIZE
const SPRITE_ROTATION = 0;
const SPRITE_SCALE = (HEX_SIZE * 2) / 256;

export async function preloadTerrainAssets(): Promise<void> {
  await Assets.load(Object.values(TERRAIN_SPRITE));
}

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
  private pendingPathLayer = new Container();

  private callbacks: MapViewCallbacks;
  reachable: Map<string, number> = new Map();
  selectedUnitId: string | null = null;
  selectedCityId: string | null = null;
  private attackHighlightCoords: AxialCoord[] = [];
  pack: ContentPack | null = null;
  /** Centered once on the viewer's starting hex; subsequent renders preserve pan/zoom. */
  private hasCentered = false;
  private mapBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

  // ── Render caches ───────────────────────────────────────────────────────────
  /** Tile visibility fingerprint — if unchanged, skip hex/resource re-render. */
  private lastVisKey = "";
  /** Territory ownership fingerprint — if unchanged, skip territory re-render. */
  private lastTerritoryKey = "";
  /** Cached unit containers keyed by unit ID. */
  private unitNodes = new Map<string, Container>();
  /** State key per unit — skip rebuild if unit hasn't changed. */
  private unitNodeKeys = new Map<string, string>();
  /** Cached city containers keyed by city ID. */
  private cityNodes = new Map<string, Container>();
  /** State key per city — skip rebuild if city hasn't changed. */
  private cityNodeKeys = new Map<string, string>();

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
    this.world.addChild(this.pendingPathLayer);
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
    let panStartX = 0;
    let panStartY = 0;
    let panLastX = 0;
    let panLastY = 0;
    let panPointerId = -1;
    const PAN_THRESHOLD = 5;

    canvas.addEventListener("pointerdown", (e) => {
      // Left, middle, or right button all pan; left-click taps still reach PIXI
      // sprites because we defer capture until the pointer actually moves (threshold).
      panStartX = e.clientX;
      panStartY = e.clientY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      panPointerId = e.pointerId;
      if (e.button === 2 || e.button === 1) {
        // Middle/right: activate immediately (no conflict with selection).
        panning = true;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== panPointerId) return;
      const movedX = e.clientX - panStartX;
      const movedY = e.clientY - panStartY;
      // Activate left-button panning once the pointer has moved past the threshold.
      if (!panning && e.buttons === 1 && (Math.abs(movedX) > PAN_THRESHOLD || Math.abs(movedY) > PAN_THRESHOLD)) {
        panning = true;
        try { canvas.setPointerCapture(e.pointerId); } catch {}
      }
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
      panPointerId = -1;
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
      // Compute visibility key once; pass rebuild flag to both static layers.
      const visKey = view.map.tiles.map((t) => t.visibility[0]).join("");
      const visChanged = visKey !== this.lastVisKey || this.hexLayer.children.length === 0;
      if (visChanged) this.lastVisKey = visKey;

      this.renderMap(view.map, visChanged);
      this.renderResources(view.map, visChanged);
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
    this.pendingPathLayer.removeChildren();
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
      this.pendingPathLayer.addChild(line);
      for (const c of u.pendingPath) {
        const p = Hex.axialToPixel(c, HEX_SIZE);
        const dot = new Graphics()
          .circle(0, 0, 3)
          .fill({ color: 0xfff200, alpha: 0.45 });
        dot.x = p.x;
        dot.y = p.y;
        dot.eventMode = "none";
        this.pendingPathLayer.addChild(dot);
      }
    }
  }

  private renderResources(map: MapView, forceRebuild: boolean): void {
    if (!forceRebuild) return;
    this.resourceLayer.removeChildren();
    for (const tile of map.tiles) {
      if (tile.visibility === "unseen") continue;
      const { x, y } = Hex.axialToPixel({ q: tile.q, r: tile.r }, HEX_SIZE);
      const dim = tile.visibility === "seen" ? 0.55 : 1;

      // Resource icon (center of tile)
      if (tile.resource) {
        const glyph = RESOURCE_GLYPH[tile.resource] ?? "?";
        const t = new Text({
          text: glyph,
          style: {
            fontSize: 16,
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "system-ui",
          },
        });
        t.anchor.set(0.5);
        t.x = x;
        t.y = y;
        t.alpha = dim;
        t.eventMode = "none";
        this.resourceLayer.addChild(t);
      }

      // Improvement icon (bottom-right of tile)
      if (tile.improvement) {
        const glyph = IMPROVEMENT_GLYPH[tile.improvement] ?? "?";
        const t = new Text({
          text: glyph,
          style: {
            fontSize: 13,
            fill: 0xfff200,
            stroke: { color: 0x000000, width: 2 },
            fontFamily: "system-ui",
            fontWeight: "bold",
          },
        });
        t.anchor.set(0.5);
        t.x = x + HEX_SIZE * 0.48;
        t.y = y + HEX_SIZE * 0.42;
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
    if (this.mapBounds) return; // tile positions never change — compute once
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

  /**
   * Preview a movement path. Steps within movementLeft are white (reachable this turn);
   * steps beyond are yellow (future turns). Pass null to clear.
   */
  setPathPreview(
    result: PathfindResult | null,
    startCoord: AxialCoord | null,
    movementLeft: number,
  ): void {
    this.pathLayer.removeChildren();
    if (!result || !startCoord || result.steps.length === 0) return;

    // Build full path: start (cost 0) + each step with its cumulative cost.
    const path: Array<{ coord: AxialCoord; costSoFar: number }> = [
      { coord: startCoord, costSoFar: 0 },
      ...result.steps,
    ];

    // Draw segment by segment so each can be white or yellow.
    for (let i = 1; i < path.length; i++) {
      const thisTurn = path[i]!.costSoFar <= movementLeft;
      const color = thisTurn ? 0xffffff : 0xfff200;
      const p0 = Hex.axialToPixel(path[i - 1]!.coord, HEX_SIZE);
      const p1 = Hex.axialToPixel(path[i]!.coord, HEX_SIZE);
      const seg = new Graphics();
      seg.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
      seg.stroke({ color, width: 3, alpha: 0.85 });
      seg.eventMode = "none";
      this.pathLayer.addChild(seg);

      const dot = new Graphics()
        .circle(0, 0, 5)
        .fill({ color, alpha: 0.9 })
        .stroke({ color: 0x000000, width: 1, alpha: 0.5 });
      dot.x = p1.x;
      dot.y = p1.y;
      dot.eventMode = "none";
      this.pathLayer.addChild(dot);
    }
  }

  setAttackHighlight(coords: AxialCoord[]): void {
    this.attackHighlightCoords = coords;
    this.renderOverlay();
  }

  setSelectedCity(cityId: string | null): void {
    this.selectedCityId = cityId;
  }

  setPack(pack: ContentPack): void {
    this.pack = pack;
  }

  /** Force all cached layers to rebuild on the next render (e.g. when switching viewAs). */
  clearLayerCaches(): void {
    this.lastVisKey = "";
    this.lastTerritoryKey = "";
    this.mapBounds = null;
    // Clear unit/city node caches
    for (const node of this.unitNodes.values()) this.unitLayer.removeChild(node);
    this.unitNodes.clear();
    this.unitNodeKeys.clear();
    for (const node of this.cityNodes.values()) this.cityLayer.removeChild(node);
    this.cityNodes.clear();
    this.cityNodeKeys.clear();
  }

  private renderMap(map: MapView, forceRebuild: boolean): void {
    if (!forceRebuild) return;
    this.hexLayer.removeChildren();
    for (const tile of map.tiles) {
      const { x, y } = Hex.axialToPixel({ q: tile.q, r: tile.r }, HEX_SIZE);
      const coord: AxialCoord = { q: tile.q, r: tile.r };
      const spritePath = tile.visibility !== "unseen" ? TERRAIN_SPRITE[tile.terrain] : undefined;
      const texture = spritePath ? (Assets.get(spritePath) as Texture | undefined) : undefined;

      if (texture) {
        const s = new Sprite(texture);
        s.anchor.set(0.5);
        s.scale.set(SPRITE_SCALE);
        s.rotation = SPRITE_ROTATION;
        s.x = x;
        s.y = y;
        if (tile.visibility === "seen") s.tint = 0x505050;
        s.eventMode = "static";
        s.cursor = "pointer";
        s.on("pointertap", (e) => this.callbacks.onTileClick?.(coord, e.ctrlKey || e.metaKey));
        s.on("pointerover", () => this.callbacks.onTileHover?.(coord));
        s.on("pointerout", () => this.callbacks.onTileHover?.(null));
        this.hexLayer.addChild(s);
      } else {
        const baseColor = TERRAIN_COLOR[tile.terrain] ?? 0x444444;
        let alpha = 0.92;
        let fill = baseColor;
        if (tile.visibility === "unseen") {
          fill = 0x1e2840;  // dark slate — clearly distinct from canvas background
          alpha = 0.9;
        } else if (tile.visibility === "seen") {
          fill = darken(baseColor, 0.45);
          alpha = 0.65;
        }
        const hex = drawHexFill(HEX_SIZE - 1, fill, alpha);
        hex.x = x;
        hex.y = y;
        hex.eventMode = "static";
        hex.cursor = "pointer";
        hex.on("pointertap", (e) => this.callbacks.onTileClick?.(coord, e.ctrlKey || e.metaKey));
        hex.on("pointerover", () => this.callbacks.onTileHover?.(coord));
        hex.on("pointerout", () => this.callbacks.onTileHover?.(null));
        this.hexLayer.addChild(hex);
      }
    }
  }

  private renderTerritory(view: MatchView): void {
    if (!view.map) return;
    // Re-render only when city ownership/tile assignment changes.
    const tKey = view.cities.map((c) => `${c.id}:${c.ownerId}:${c.ownedTiles.length}`).join("|");
    if (tKey === this.lastTerritoryKey && this.territoryLayer.children.length > 0) return;
    this.lastTerritoryKey = tKey;

    this.territoryLayer.removeChildren();
    this.borderLayer.removeChildren();

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
    const playerById = new Map(view.players.map((p) => [p.id, p]));
    const activeCityIds = new Set(view.cities.map((c) => c.id));

    // Remove cities that no longer exist.
    for (const [id, node] of this.cityNodes) {
      if (!activeCityIds.has(id)) {
        this.cityLayer.removeChild(node);
        this.cityNodes.delete(id);
        this.cityNodeKeys.delete(id);
      }
    }

    for (const c of view.cities) {
      const owner = playerById.get(c.ownerId);
      if (!owner) continue;
      const isSelected = c.id === this.selectedCityId;
      const prodKey = c.productionItem ? `${c.productionItem.defId}:${c.production}` : "";
      const stateKey = `${c.ownerId}|${c.name}|${c.population}|${isSelected}|${prodKey}`;
      if (this.cityNodes.has(c.id) && this.cityNodeKeys.get(c.id) === stateKey) continue;

      const old = this.cityNodes.get(c.id);
      if (old) this.cityLayer.removeChild(old);

      const node = this.buildCityNode(c, view, owner, isSelected);
      this.cityNodes.set(c.id, node);
      this.cityNodeKeys.set(c.id, stateKey);
      this.cityLayer.addChild(node);
    }
  }

  private buildCityNode(
    c: import("@browserciv/shared").City,
    view: MatchView,
    owner: Player,
    isSelected: boolean,
  ): Container {
    const { x, y } = Hex.axialToPixel(c.position, HEX_SIZE);
    const primary = parseColor(owner.primary_color);
    const secondary = parseColor(owner.secondary_color);

    const node = new Container();
    node.x = x;
    node.y = y;

    // Castle silhouette
    const cs = HEX_SIZE * 0.45;
    const castle = new Graphics();
    castle.rect(-cs, -cs * 0.05, cs * 2, cs * 0.6);
    castle.rect(-cs - 2, -cs * 0.5, cs * 0.55, cs * 1.05);
    castle.rect(cs - cs * 0.55 + 2, -cs * 0.5, cs * 0.55, cs * 1.05);
    castle.rect(-cs * 0.4, -cs * 0.7, cs * 0.8, cs * 1.25);
    castle.rect(-cs * 0.4, -cs * 0.85, cs * 0.25, cs * 0.18);
    castle.rect(cs * 0.15, -cs * 0.85, cs * 0.25, cs * 0.18);
    castle.fill({ color: primary, alpha: 0.98 }).stroke({ color: isSelected ? 0xfff200 : secondary, width: isSelected ? 3 : 2 });
    castle.eventMode = "static";
    castle.cursor = "pointer";
    castle.on("pointertap", () => this.callbacks.onCityClick?.(c));
    node.addChild(castle);

    if (isSelected) {
      const ring = new Graphics();
      const points: number[] = [];
      for (const [vx, vy] of VERTS) points.push((HEX_SIZE - 4) * vx, (HEX_SIZE - 4) * vy);
      ring.poly(points).stroke({ color: 0xfff200, width: 3, alpha: 0.95 });
      ring.eventMode = "none";
      node.addChild(ring);
    }

    // Name plate
    const plateW = HEX_SIZE * 2.0;
    const isOwn = c.ownerId === view.viewerId;
    const showBuilding = isOwn && !!c.productionItem;
    const plateH = showBuilding ? 30 : 18;
    const plate = new Graphics()
      .roundRect(-plateW / 2, -plateH / 2, plateW, plateH, 4)
      .fill({ color: primary, alpha: 0.95 })
      .stroke({ color: secondary, width: 2 });
    plate.y = -HEX_SIZE * 1.05;
    plate.eventMode = "static";
    plate.cursor = "pointer";
    plate.on("pointertap", () => this.callbacks.onCityClick?.(c));
    node.addChild(plate);

    const nameLabel = new Text({
      text: `${c.name} · ${c.population}`,
      style: { fontSize: 11, fill: secondary, fontFamily: "system-ui", fontWeight: "bold" },
    });
    nameLabel.anchor.set(0.5);
    nameLabel.y = -HEX_SIZE * 1.05 + (showBuilding ? -7 : 0);
    nameLabel.eventMode = "none";
    node.addChild(nameLabel);

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
        style: { fontSize: 10, fill: secondary, fontFamily: "system-ui" },
      });
      buildLabel.anchor.set(0.5);
      buildLabel.y = -HEX_SIZE * 1.05 + 6;
      buildLabel.eventMode = "none";
      node.addChild(buildLabel);

      if (cost !== null && cost > 0) {
        const bar = new Graphics();
        const barW = plateW - 8;
        const barH = 3;
        bar.rect(-barW / 2, 0, barW, barH).fill({ color: 0x000000, alpha: 0.6 });
        const pct = Math.min(1, c.production / cost);
        bar.rect(-barW / 2, 0, barW * pct, barH).fill({ color: 0xffd700, alpha: 0.95 });
        bar.y = -HEX_SIZE * 1.05 + plateH / 2 - 5;
        bar.eventMode = "none";
        node.addChild(bar);
      }
    }

    if (c.hp < c.hpMax) {
      const barW = HEX_SIZE * 1.6;
      const pct = Math.max(0, c.hp / c.hpMax);
      const barColor = pct > 0.6 ? 0x2ea043 : pct > 0.3 ? 0xd29922 : 0xf85149;
      const bar = new Graphics();
      bar.rect(-barW / 2, 0, barW, 5).fill({ color: 0x1a0000, alpha: 0.9 });
      bar.rect(-barW / 2, 0, barW * pct, 5).fill({ color: barColor, alpha: 1 });
      bar.y = HEX_SIZE * 0.55;
      bar.eventMode = "none";
      node.addChild(bar);
    }

    return node;
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
    const playerById = new Map(players.map((p) => [p.id, p]));
    const activeIds = new Set(units.map((u) => u.id));

    // Remove units that no longer exist.
    for (const [id, node] of this.unitNodes) {
      if (!activeIds.has(id)) {
        this.unitLayer.removeChild(node);
        this.unitNodes.delete(id);
        this.unitNodeKeys.delete(id);
      }
    }

    for (const u of units) {
      const owner = playerById.get(u.ownerId);
      if (!owner) continue;
      const { x, y } = Hex.axialToPixel(u.position, HEX_SIZE);
      const isMine = u.ownerId === viewerId;
      const isSelected = u.id === this.selectedUnitId;

      // Build a cheap state key — only rebuild the container when something visible changed.
      const stateKey = `${x},${y}|${u.hp}/${u.hpMax}|${u.movementLeft}|${isSelected}|${owner.primary_color}`;

      if (this.unitNodes.has(u.id) && this.unitNodeKeys.get(u.id) === stateKey) {
        continue; // nothing changed, keep existing container
      }

      // Remove old container (if any) before replacing.
      const old = this.unitNodes.get(u.id);
      if (old) this.unitLayer.removeChild(old);

      const node = this.buildUnitNode(u, x, y, isMine, isSelected, owner);
      this.unitNodes.set(u.id, node);
      this.unitNodeKeys.set(u.id, stateKey);
      this.unitLayer.addChild(node);
    }
  }

  private buildUnitNode(
    u: Unit, x: number, y: number,
    isMine: boolean, isSelected: boolean,
    owner: Player,
  ): Container {
    const glyph = UNIT_GLYPH[u.defId] ?? "?";
    const primary = parseColor(owner.primary_color);
    const secondary = parseColor(owner.secondary_color);

    const node = new Container();
    node.x = x;
    node.y = y;

    const bg = new Graphics()
      .circle(0, 0, HEX_SIZE * 0.55)
      .fill({ color: primary, alpha: 0.95 })
      .stroke({ color: isSelected ? 0xfff200 : secondary, width: isSelected ? 4 : 2 });
    bg.eventMode = "static";
    bg.cursor = "pointer";
    bg.on("pointertap", () => this.callbacks.onUnitClick?.(u));
    bg.on("pointerover", () => this.callbacks.onTileHover?.(u.position));
    bg.on("pointerout", () => this.callbacks.onTileHover?.(null));
    node.addChild(bg);

    const label = new Text({
      text: glyph,
      style: { fontSize: 20, fill: secondary, fontFamily: "system-ui", fontWeight: "bold" },
    });
    label.anchor.set(0.5);
    label.eventMode = "none";
    node.addChild(label);

    if (isMine) {
      const mp = new Text({
        text: `${u.movementLeft}/${u.movementMax}`,
        style: { fontSize: 9, fill: 0xffffff, stroke: { color: 0x000000, width: 2 }, fontFamily: "monospace" },
      });
      mp.anchor.set(0.5);
      mp.y = HEX_SIZE * 0.65;
      mp.eventMode = "none";
      node.addChild(mp);
    }

    if (u.hp < u.hpMax) {
      const barW = HEX_SIZE * 1.1;
      const pct = Math.max(0, u.hp / u.hpMax);
      const barColor = pct > 0.6 ? 0x2ea043 : pct > 0.3 ? 0xd29922 : 0xf85149;
      const bar = new Graphics();
      bar.rect(-barW / 2, 0, barW, 4).fill({ color: 0x1a0000, alpha: 0.9 });
      bar.rect(-barW / 2, 0, barW * pct, 4).fill({ color: barColor, alpha: 1 });
      bar.y = -HEX_SIZE * 0.72;
      bar.eventMode = "none";
      node.addChild(bar);
    }

    return node;
  }

  private renderOverlay(): void {
    this.overlayLayer.removeChildren();

    // Reachable highlight (white, subtle) — skip when in attack mode
    if (this.attackHighlightCoords.length === 0) {
      for (const [k] of this.reachable.entries()) {
        const [qStr, rStr] = k.split(",");
        const coord = { q: parseInt(qStr!, 10), r: parseInt(rStr!, 10) };
        const { x, y } = Hex.axialToPixel(coord, HEX_SIZE);
        const ring = drawHexFill(HEX_SIZE - 3, 0xffffff, 0.13);
        ring.x = x;
        ring.y = y;
        ring.eventMode = "none";
        this.overlayLayer.addChild(ring);
      }
    }

    // Attack target highlights (red)
    for (const coord of this.attackHighlightCoords) {
      const { x, y } = Hex.axialToPixel(coord, HEX_SIZE);
      const fill = drawHexFill(HEX_SIZE - 2, 0xff2020, 0.30);
      fill.x = x;
      fill.y = y;
      fill.eventMode = "none";
      this.overlayLayer.addChild(fill);

      const border = new Graphics();
      const pts: number[] = [];
      for (const [vx, vy] of VERTS) pts.push((HEX_SIZE - 2) * vx, (HEX_SIZE - 2) * vy);
      border.poly(pts).stroke({ color: 0xff4040, width: 2.5, alpha: 0.95 });
      border.x = x;
      border.y = y;
      border.eventMode = "none";
      this.overlayLayer.addChild(border);
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
