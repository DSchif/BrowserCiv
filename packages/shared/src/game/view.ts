import { key as hexKey } from "../hex.js";
import type { ContentPack } from "../schemas/index.js";
import type {
  City,
  MapView,
  MatchState,
  MatchView,
  TileVisibility,
} from "./state.js";
import { visibleResourcesFor } from "./resources.js";
import { currentlyVisibleFor } from "./visibility.js";

/** Per-player view. Server runs this per recipient before broadcasting. */
export function buildView(
  state: MatchState,
  viewerId: string,
  content?: ContentPack,
): MatchView {
  const visible = currentlyVisibleFor(state, viewerId);
  const seen = new Set(state.seenTiles[viewerId] ?? []);
  const viewer = state.players.find((p) => p.id === viewerId);
  const visibleResources = viewer && content ? visibleResourcesFor(viewer, content) : null;

  let map: MapView | null = null;
  if (state.map) {
    map = {
      width: state.map.width,
      height: state.map.height,
      tiles: state.map.tiles.map((t) => {
        const k = hexKey({ q: t.q, r: t.r });
        let visibility: TileVisibility = "unseen";
        if (visible.has(k)) visibility = "visible";
        else if (seen.has(k)) visibility = "seen";
        const ownerCityId = state.tileOwnership[k];
        // Hide resource icons for resources not yet visible to this player,
        // and on tiles the player has never seen.
        const showResource =
          t.resource &&
          visibility !== "unseen" &&
          (!visibleResources || visibleResources.has(t.resource));
        const tile: import("./state.js").TileView = {
          ...t,
          visibility,
        };
        if (ownerCityId) tile.ownerCityId = ownerCityId;
        if (showResource && t.resource) tile.resource = t.resource;
        else delete tile.resource;
        // Improvement only visible if tile is visible (not unseen).
        if (visibility === "unseen") delete tile.improvement;
        // Hide work-in-progress for opponent tiles
        if (visibility === "unseen") delete tile.workInProgress;
        return tile;
      }),
    };
  }

  // Own units always; opponents' only on currently-visible hexes.
  const units = state.units.filter((u) => {
    if (u.ownerId === viewerId) return true;
    return visible.has(hexKey(u.position));
  });

  // Cities: own cities always (with full info); opponents' only if their
  // center hex is currently visible OR ever-seen — once you've seen a city,
  // you remember it exists (but not its production etc; for Phase 3 we still
  // ship the whole struct, we'll redact opponent city internals in Phase 6).
  const cities = state.cities
    .filter((c) => {
      if (c.ownerId === viewerId) return true;
      const k = hexKey(c.position);
      return visible.has(k) || seen.has(k);
    })
    .map((c): City =>
      c.ownerId === viewerId
        ? c
        : {
            ...c,
            // Redact internals the opponent shouldn't see
            food: 0,
            foodToGrow: 0,
            production: 0,
            productionItem: null,
            workedTiles: [],
            perTurnYields: {},
          },
    );

  return {
    id: state.id,
    status: state.status,
    hostId: state.hostId,
    contentPackId: state.contentPackId,
    viewerId,
    players: state.players,
    currentPlayerIndex: state.currentPlayerIndex,
    turnNumber: state.turnNumber,
    map,
    units,
    cities,
    diplomacy: state.diplomacy ?? {},
    wondersBuilt: state.wondersBuilt ?? {},
    actionSeq: state.actionSeq,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    log: state.log,
  };
}
