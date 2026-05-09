import { Chart, registerables } from "chart.js";

interface PlayerSnap { id: string; cities: number; units: number; unitsByType: Record<string, number>; gold: number; goldPerTurn: number; sciencePerTurn: number; productionPerTurn: number; foodPerTurn: number; techs: number; currentTech: string | null; totalBuildings: number; totalPopulation: number; tilesOwned: number; }
export interface TurnSnap { turn: number; seenTiles: number; totalTiles: number; cumKills: number; cumCaptures: number; cumReward?: number; turnDurationMs?: number; agent: PlayerSnap; opponent: PlayerSnap | null; }

Chart.register(...registerables);

export type MetricKey =
  | "agent.cities" | "agent.units" | "agent.goldPerTurn" | "agent.sciencePerTurn"
  | "agent.productionPerTurn" | "agent.foodPerTurn" | "agent.techs"
  | "agent.totalBuildings" | "agent.totalPopulation" | "agent.tilesOwned"
  | "opp.cities" | "opp.units" | "opp.goldPerTurn" | "opp.sciencePerTurn"
  | "opp.techs" | "opp.totalPopulation" | "opp.totalBuildings"
  | "cumKills" | "cumCaptures" | "seenPct"
  | "reward" | "turnDurationMs";

export const METRIC_LABELS: Record<MetricKey, string> = {
  "reward": "Episode Reward",
  "turnDurationMs": "Turn Duration (ms)",
  "agent.cities": "Agent Cities",
  "agent.units": "Agent Units",
  "agent.goldPerTurn": "Agent Gold/Turn",
  "agent.sciencePerTurn": "Agent Science/Turn",
  "agent.productionPerTurn": "Agent Production/Turn",
  "agent.foodPerTurn": "Agent Food/Turn",
  "agent.techs": "Agent Techs",
  "agent.totalBuildings": "Agent Buildings",
  "agent.totalPopulation": "Agent Population",
  "agent.tilesOwned": "Agent Tiles Owned",
  "opp.cities": "Opp Cities",
  "opp.units": "Opp Units",
  "opp.goldPerTurn": "Opp Gold/Turn",
  "opp.sciencePerTurn": "Opp Science/Turn",
  "opp.techs": "Opp Techs",
  "opp.totalPopulation": "Opp Population",
  "opp.totalBuildings": "Opp Buildings",
  "cumKills": "Cumulative Kills",
  "cumCaptures": "Cumulative Captures",
  "seenPct": "Map Explored %",
};

export const METRIC_GROUPS: Array<{ label: string; keys: MetricKey[] }> = [
  { label: "Agent", keys: ["agent.cities","agent.units","agent.goldPerTurn","agent.sciencePerTurn","agent.productionPerTurn","agent.foodPerTurn","agent.techs","agent.totalBuildings","agent.totalPopulation","agent.tilesOwned"] },
  { label: "Opponent", keys: ["opp.cities","opp.units","opp.goldPerTurn","opp.sciencePerTurn","opp.techs","opp.totalPopulation","opp.totalBuildings"] },
  { label: "Battle", keys: ["cumKills","cumCaptures"] },
  { label: "Exploration", keys: ["seenPct"] },
  { label: "Training", keys: ["reward","turnDurationMs"] },
];

const COLORS: Record<string, string> = {
  "agent.":        "rgba(100,180,255,0.9)",
  "opp.":          "rgba(255,100,100,0.85)",
  "cum":           "rgba(255,215,0,0.9)",
  "seen":          "rgba(100,220,100,0.9)",
  "reward":        "rgba(130,210,130,0.9)",
  "turnDuration":  "rgba(255,165,80,0.9)",
};

function colorFor(key: MetricKey): string {
  for (const [prefix, color] of Object.entries(COLORS)) {
    if (key.startsWith(prefix)) return color;
  }
  return "rgba(180,180,180,0.9)";
}

function extractValue(snap: TurnSnap, key: MetricKey): number {
  if (key === "seenPct") return snap.totalTiles > 0 ? snap.seenTiles / snap.totalTiles * 100 : 0;
  if (key === "cumKills") return snap.cumKills;
  if (key === "cumCaptures") return snap.cumCaptures;
  if (key === "reward") return snap.cumReward ?? 0;
  if (key === "turnDurationMs") return snap.turnDurationMs ?? 0;
  const [owner, field] = key.split(".");
  const player = owner === "agent" ? snap.agent : snap.opponent;
  if (!player) return 0;
  return (player as unknown as Record<string, number>)[field ?? ""] ?? 0;
}

export interface GraphDef {
  id: string;
  title: string;
  metrics: MetricKey[];
}

interface GraphEntry {
  def: GraphDef;
  chart: Chart;
  canvas: HTMLCanvasElement;
  wrapper: HTMLElement;
}

export class GraphPanel {
  private container: HTMLElement;
  private graphs: GraphEntry[] = [];
  private onEdit: (id: string) => void;
  private onRemove: (id: string) => void;

  constructor(
    container: HTMLElement,
    callbacks: { onEdit: (id: string) => void; onRemove: (id: string) => void },
  ) {
    this.container = container;
    this.onEdit = callbacks.onEdit;
    this.onRemove = callbacks.onRemove;
  }

  addGraph(def: GraphDef): void {
    const wrapper = document.createElement("div");
    wrapper.className = "sim-graph-widget";
    wrapper.dataset.graphId = def.id;

    const header = document.createElement("div");
    header.className = "sgw-header";
    header.innerHTML = `
      <span class="sgw-title">${def.title}</span>
      <button class="sgw-btn sgw-edit" title="Edit">✎</button>
      <button class="sgw-btn sgw-remove" title="Remove">×</button>
    `;
    header.querySelector(".sgw-edit")!.addEventListener("click", () => this.onEdit(def.id));
    header.querySelector(".sgw-remove")!.addEventListener("click", () => this.removeGraph(def.id));

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "sgw-canvas-wrap";
    const canvas = document.createElement("canvas");
    canvasWrap.appendChild(canvas);

    wrapper.appendChild(header);
    wrapper.appendChild(canvasWrap);
    this.container.appendChild(wrapper);

    const datasets = def.metrics.map((key) => ({
      label: METRIC_LABELS[key],
      data: [] as number[],
      borderColor: colorFor(key),
      backgroundColor: "transparent",
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
    }));

    const chart = new Chart(canvas, {
      type: "line",
      data: { labels: [], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            labels: { color: "#8b949e", boxWidth: 10, font: { size: 10 } },
          },
        },
        scales: {
          x: {
            ticks: { color: "#8b949e", maxTicksLimit: 6, font: { size: 9 } },
            grid: { color: "#21262d" },
          },
          y: {
            ticks: { color: "#8b949e", font: { size: 9 } },
            grid: { color: "#21262d" },
          },
        },
      },
    });

    canvasWrap.style.height = "140px";
    this.graphs.push({ def, chart, canvas, wrapper });
  }

  editGraph(id: string, newDef: GraphDef): void {
    const entry = this.graphs.find((g) => g.def.id === id);
    if (!entry) return;
    // Destroy and rebuild in same position
    const idx = this.graphs.indexOf(entry);
    const nextSibling = entry.wrapper.nextSibling;
    entry.chart.destroy();
    entry.wrapper.remove();
    this.graphs.splice(idx, 1);

    // Temporarily insert at correct position
    const placeholder = document.createElement("div");
    if (nextSibling) {
      this.container.insertBefore(placeholder, nextSibling);
    } else {
      this.container.appendChild(placeholder);
    }
    this.addGraph(newDef);
    const newEntry = this.graphs[this.graphs.length - 1]!;
    placeholder.replaceWith(newEntry.wrapper);
    this.graphs.splice(this.graphs.indexOf(newEntry), 1);
    this.graphs.splice(idx, 0, newEntry);
  }

  removeGraph(id: string): void {
    const idx = this.graphs.findIndex((g) => g.def.id === id);
    if (idx === -1) return;
    const entry = this.graphs[idx]!;
    entry.chart.destroy();
    entry.wrapper.remove();
    this.graphs.splice(idx, 1);
  }

  push(snap: TurnSnap): void {
    for (const entry of this.graphs) {
      const chart = entry.chart;
      (chart.data.labels as number[]).push(snap.turn);
      for (let i = 0; i < entry.def.metrics.length; i++) {
        const key = entry.def.metrics[i]!;
        (chart.data.datasets[i]!.data as number[]).push(extractValue(snap, key));
      }
      chart.update("none");
    }
  }

  /** Load a full episode's worth of snaps at once (for history view) */
  loadSnaps(snaps: TurnSnap[]): void {
    for (const entry of this.graphs) {
      const labels: number[] = [];
      const seriesData: number[][] = entry.def.metrics.map(() => []);
      for (const snap of snaps) {
        labels.push(snap.turn);
        for (let i = 0; i < entry.def.metrics.length; i++) {
          seriesData[i]!.push(extractValue(snap, entry.def.metrics[i]!));
        }
      }
      entry.chart.data.labels = labels;
      for (let i = 0; i < entry.def.metrics.length; i++) {
        entry.chart.data.datasets[i]!.data = seriesData[i]!;
      }
      entry.chart.update("none");
    }
  }

  clear(): void {
    for (const entry of this.graphs) {
      entry.chart.data.labels = [];
      for (const ds of entry.chart.data.datasets) { ds.data = []; }
      entry.chart.update("none");
    }
  }

  get count(): number { return this.graphs.length; }

  getIds(): string[] { return this.graphs.map((g) => g.def.id); }

  getDef(id: string): GraphDef | undefined {
    return this.graphs.find((g) => g.def.id === id)?.def;
  }
}

// ── Graph-add/edit modal ──────────────────────────────────────────────────────

export function openGraphModal(
  existing: GraphDef | null,
  onConfirm: (def: GraphDef) => void,
): void {
  const backdrop = document.createElement("div");
  backdrop.className = "sim-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "sim-modal";

  const title = existing ? "Edit Graph" : "Add Graph";
  const selectedKeys = new Set<MetricKey>(existing?.metrics ?? []);

  const groupsHtml = METRIC_GROUPS.map(
    (g) => `
    <div class="sim-metric-label">${g.label}</div>
    <div class="sim-metric-grid">
      ${g.keys
        .map(
          (k) => `
        <label>
          <input type="checkbox" name="metric" value="${k}" ${selectedKeys.has(k) ? "checked" : ""}>
          ${METRIC_LABELS[k]}
        </label>
      `,
        )
        .join("")}
    </div>`,
  ).join("");

  modal.innerHTML = `
    <h3>${title}</h3>
    <input type="text" id="graph-title-input" placeholder="Graph title" value="${existing?.title ?? ""}">
    ${groupsHtml}
    <div class="sim-modal-footer">
      <button class="btn-cancel">Cancel</button>
      <button class="btn-primary">Confirm</button>
    </div>
  `;

  modal.querySelector(".btn-cancel")!.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

  modal.querySelector(".btn-primary")!.addEventListener("click", () => {
    const titleInput = modal.querySelector<HTMLInputElement>("#graph-title-input")!;
    const checked = [...modal.querySelectorAll<HTMLInputElement>('input[name="metric"]:checked')];
    if (checked.length === 0) return;
    const def: GraphDef = {
      id: existing?.id ?? `graph-${Date.now()}`,
      title: titleInput.value.trim() || checked.map((c) => METRIC_LABELS[c.value as MetricKey] ?? c.value).join(", "),
      metrics: checked.map((c) => c.value as MetricKey),
    };
    backdrop.remove();
    onConfirm(def);
  });

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modal.querySelector<HTMLInputElement>("#graph-title-input")!.focus();
}
