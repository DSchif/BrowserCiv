import { Application } from "pixi.js";
import type { MatchState } from "@browserciv/shared";
import { MapViewer, preloadTerrainAssets } from "../pixi/map-view.js";
import { GameClient } from "../net/ws.js";
import { fetchContentPack } from "../net/rest.js";
import type { ContentPack } from "@browserciv/shared";
import { Chart } from "chart.js";
import { GraphPanel, openGraphModal, type GraphDef, type TurnSnap } from "./sim-graphs.js";

interface PlayerSnap { id: string; cities: number; units: number; unitsByType: Record<string, number>; gold: number; goldPerTurn: number; sciencePerTurn: number; productionPerTurn: number; foodPerTurn: number; techs: number; currentTech: string | null; totalBuildings: number; totalPopulation: number; tilesOwned: number; }
interface EpisodeDump { episode: number; agentId: string; opponentId: string; outcome: string; totalReward: number; totalKills: number; totalCaptures: number; turns: TurnSnap[]; }

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentFile { name: string; episodes: number; }
interface RunMeta {
  runId: string; agentFile: string | null; strategy: string; mapSize: string;
  totalEpisodes: number; completedEpisodes: number; startTime: string; endTime?: string;
  summary?: { wins: number; losses: number; draws: number; totalKills: number; totalCaptures: number; avgReward: number; };
}
interface EpRecord { episode: number; outcome: string; reward: number; turns: number; kills: number; captures: number; managerEpsilon?: number; tacticalEpsilon?: number; }
interface StatusEvent { state: string; episode: number; totalEpisodes: number; turn: number; maxTurns: number; spectatorToken: string | null; matchId: string | null; runId: string | null; agentPlayerId: string | null; gameServerUrl: string | null; }

interface GoalWeightDef {
  id: string; label: string; enabled: boolean;
  signal: string; weight: number;
}

const DEFAULT_GOALS: GoalWeightDef[] = [
  { id: "explore", label: "Explore",  enabled: true,  signal: "tiles_discovered_delta", weight: 0.3 },
  { id: "expand",  label: "Expand",   enabled: false, signal: "cities_owned_delta",      weight: 5.0 },
  { id: "attack",  label: "Attack",   enabled: true,  signal: "enemy_units_killed",       weight: 5.0 },
  { id: "defend",  label: "Defend",   enabled: false, signal: "turn_survived",             weight: 0.5 },
  { id: "develop", label: "Develop",  enabled: false, signal: "improvement_built",          weight: 1.0 },
  { id: "tech",    label: "Tech",     enabled: false, signal: "tech_researched",            weight: 5.0 },
  { id: "economy", label: "Economy",  enabled: false, signal: "gold_delta",                  weight: 1.0 },
];

// ── Sim API helpers ───────────────────────────────────────────────────────────

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("browserciv_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function simFetch(path: string, opts?: RequestInit): Promise<Response> {
  const hasBody = opts?.body != null;
  return fetch(path, {
    ...opts,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...authHeader(),
      ...(opts?.headers ?? {}),
    },
  });
}

interface ActiveSession {
  id: string; state: string; episode: number; totalEpisodes: number;
  turn: number; maxTurns: number; spectatorToken: string | null;
  matchId: string | null; runId: string | null; episodeLog: EpRecord[];
  agentPlayerId: string | null;
  displayInfo: { agentType: string; agentFile: string | null; agentZipKey: string | null; saveFile: string | null; opponentType: string; opponentFile: string | null; mapSize: string; } | null;
}

async function getActiveSessions(): Promise<ActiveSession[]> {
  const r = await simFetch("/sim/active");
  return r.ok ? (r.json() as Promise<ActiveSession[]>) : [];
}

async function getAgents(): Promise<AgentFile[]> {
  const r = await simFetch("/agents");
  return r.ok ? (r.json() as Promise<AgentFile[]>) : [];
}

interface S3AgentEntry { key: string; name: string; entrypoint: string; }
async function getS3Agents(): Promise<S3AgentEntry[]> {
  const r = await simFetch("/agents/s3");
  return r.ok ? (r.json() as Promise<S3AgentEntry[]>) : [];
}

async function getRuns(): Promise<RunMeta[]> {
  const r = await simFetch("/runs");
  return r.ok ? (r.json() as Promise<RunMeta[]>) : [];
}

async function getRunEpisodes(runId: string): Promise<string[]> {
  const r = await simFetch(`/runs/${encodeURIComponent(runId)}/episodes`);
  return r.ok ? (r.json() as Promise<string[]>) : [];
}

async function getRunEpisode(runId: string, idx: number): Promise<EpisodeDump | null> {
  const r = await simFetch(`/runs/${encodeURIComponent(runId)}/episode/${idx}`);
  return r.ok ? (r.json() as Promise<EpisodeDump>) : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function renderSim(root: HTMLElement, onBack: () => void): void {
  type Phase = "setup" | "running" | "results" | "history";
  let phase: Phase = "setup";

  let simId: string | null = null;
  let sseSource: EventSource | null = null;
  let setupPollId: ReturnType<typeof setInterval> | null = null;
  let gameClient: GameClient | null = null;
  let pixiApp: Application | null = null;
  let mapViewer: MapViewer | null = null;
  let graphPanel: GraphPanel | null = null;
  let pack: ContentPack | null = null;

  let currentStatus: StatusEvent | null = null;
  let episodeLog: EpRecord[] = [];
  let goals: GoalWeightDef[] = DEFAULT_GOALS.map((g) => ({ ...g }));

  const PYTORCH_REWARD_DEFS: Array<{ key: string; label: string; default: number }> = [
    { key: "REWARD_WIN",  label: "Win",               default:  10.0  },
    { key: "REWARD_LOSE", label: "Loss",               default: -10.0  },
    { key: "REWARD_KILL", label: "Kill unit",          default:   1.0  },
    { key: "REWARD_CITY", label: "Capture / found city", default: 2.0  },
    { key: "REWARD_TECH", label: "Research tech",      default:   0.5  },
    { key: "REWARD_UNIT", label: "Train unit",         default:   0.3  },
    { key: "REWARD_TURN", label: "Per turn (penalty)", default:  -0.01 },
  ];
  let pytorchRewards: Record<string, number> = Object.fromEntries(
    PYTORCH_REWARD_DEFS.map((d) => [d.key, d.default]),
  );

  const OBS_CONFIG_FLAGS: Array<{ key: string; label: string; default: boolean }> = [
    { key: "use_my_units",           label: "My units",                    default: true  },
    { key: "use_unit_combat_stats",  label: "Unit combat stats",           default: true  },
    { key: "use_unit_status",        label: "Unit status (fortified etc)", default: true  },
    { key: "use_enemy_units",        label: "Enemy units",                 default: true  },
    { key: "use_enemy_combat_stats", label: "Enemy combat stats",          default: true  },
    { key: "use_my_cities",          label: "My cities",                   default: true  },
    { key: "use_city_buildings",     label: "City buildings (27 feats)",   default: false },
    { key: "use_tech_multihot",      label: "Tech multi-hot (74 bits)",    default: true  },
    { key: "use_global_cnn",         label: "Map CNN (32×32 grid)",        default: false },
  ];
  let obsConfig: Record<string, boolean> = Object.fromEntries(
    OBS_CONFIG_FLAGS.map((f) => [f.key, f.default]),
  );

  let latestMatchState: unknown = null;
  let renderRafId: number | null = null;

  // ── Active-sim table (setup page) ───────────────────────────────────────────

  function stopSetupPoll(): void {
    if (setupPollId !== null) { clearInterval(setupPollId); setupPollId = null; }
  }

  async function refreshActiveSims(): Promise<void> {
    const container = root.querySelector<HTMLElement>("#active-sims");
    if (!container) return; // no longer on setup page
    const sessions = await getActiveSessions().catch(() => [] as ActiveSession[]);

    if (sessions.length === 0) {
      container.innerHTML = "";
      return;
    }

    const rows = sessions.map((s) => {
      const info = s.displayInfo;
      const zipName = (key: string | null) => key ? key.replace(/^agents\//, "").replace(/\.zip$/, "") : null;
      const agentLabel = !info ? "—"
        : info.agentType === "pytorch"
          ? `EC2 ${zipName(info.agentZipKey) ?? "ppo"}`
          : info.agentType === "hybrid"
            ? `Hybrid ${zipName(info.agentZipKey) ?? "hybrid"}`
            : info.agentType === "hier"
              ? `RL ${info.agentFile ? `(${info.agentFile})` : "(fresh)"}`
              : info.agentType;
      const oppLabel = !info ? "—"
        : info.opponentType === "hier"
          ? `RL ${info.opponentFile ? `(${info.opponentFile})` : "(fresh)"}`
          : info.opponentType;
      const mapLabel = info?.mapSize ?? "—";
      const isPaused = s.state === "paused";
      const isRunning = s.state === "running";
      const stateClass = isRunning ? "running" : isPaused ? "paused" : "done";

      return `
        <tr data-sid="${s.id}">
          <td><span class="sim-state-label ${stateClass}">${s.state.toUpperCase()}</span></td>
          <td>${s.episode}/${s.totalEpisodes}</td>
          <td>${s.turn}/${s.maxTurns}</td>
          <td>${agentLabel}</td>
          <td>${oppLabel}</td>
          <td>${mapLabel}</td>
          <td class="sim-active-actions">
            ${isRunning ? `<button class="sim-ctrl-btn asim-pause" title="Pause">⏸</button>` : ""}
            ${isPaused ? `<button class="sim-ctrl-btn asim-resume" title="Resume">▶</button>` : ""}
            ${isPaused ? `<button class="sim-ctrl-btn asim-step"   title="Step one turn">⏭</button>` : ""}
            <button class="sim-ctrl-btn asim-stop"    title="Stop">⏹</button>
            <button class="sim-ctrl-btn asim-watch"   title="Watch">👁 Watch</button>
          </td>
        </tr>`;
    }).join("");

    container.innerHTML = `
      <div class="sim-active-section">
        <div class="sim-active-header">Active Simulations</div>
        <table class="sim-active-table">
          <thead><tr>
            <th>State</th><th>Episode</th><th>Turn</th>
            <th>Agent</th><th>Opponent</th><th>Map</th><th>Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    // Wire per-row buttons
    for (const s of sessions) {
      const row = container.querySelector<HTMLElement>(`tr[data-sid="${s.id}"]`);
      if (!row) continue;

      row.querySelector(".asim-pause")?.addEventListener("click", () => {
        void simFetch(`/sim/${s.id}/pause`, { method: "POST" });
      });
      row.querySelector(".asim-resume")?.addEventListener("click", () => {
        void simFetch(`/sim/${s.id}/resume`, { method: "POST", body: JSON.stringify({ speed: "fast" }) });
      });
      row.querySelector(".asim-step")?.addEventListener("click", () => {
        void simFetch(`/sim/${s.id}/step`, { method: "POST" });
      });
      row.querySelector(".asim-stop")?.addEventListener("click", () => {
        if (!confirm("Stop this simulation?")) return;
        void simFetch(`/sim/${s.id}`, { method: "DELETE" }).then(() => refreshActiveSims());
      });
      row.querySelector(".asim-watch")?.addEventListener("click", () => {
        stopSetupPoll();
        simId = s.id;
        episodeLog = s.episodeLog ?? [];
        phase = "running";
        renderRunner();
      });
    }
  }

  // ── Phase: Setup ────────────────────────────────────────────────────────────

  function renderSetup(): void {
    void (async () => {
      const [agents, s3Agents] = await Promise.all([
        getAgents().catch(() => [] as AgentFile[]),
        getS3Agents().catch(() => [] as S3AgentEntry[]),
      ]);
      const agentOptions = agents.map((a) => `<option value="${a.name}">${a.name} (${a.episodes} eps)</option>`).join("");
      const s3AgentOptions = s3Agents.length
        ? s3Agents.map((a) => `<option value="${a.key}" data-entrypoint="${a.entrypoint}">${a.name}</option>`).join("")
        : `<option value="agents/ppo-v1.zip">ppo-v1 (default)</option>`;

      root.innerHTML = `
        <div class="sim-page">
          <div class="sim-nav">
            <h1>BrowserCiv — Simulation</h1>
            <button class="sim-nav-btn" id="btn-history">📊 Past Runs</button>
            <button class="sim-nav-btn" id="btn-back" style="margin-left:auto">← Lobby</button>
          </div>

          <div id="active-sims"></div>

          <div class="sim-slots">
            <!-- Agent slot -->
            <div class="sim-slot">
              <h3>Agent (Player 1)</h3>
              <label>Type
                <select id="agent-type">
                  <option value="pytorch">PyTorch PPO (EC2 spot)</option>
                  <option value="hybrid">Hybrid RL (EC2 spot)</option>
                  <option value="hier">Hierarchical RL (in-process)</option>
                  <option value="greedy">Greedy</option>
                  <option value="random">Random</option>
                  <option value="passive">Passive</option>
                </select>
              </label>
              <div id="pytorch-opts">
                <label>Agent package
                  <select id="s3-agent-key">
                    ${s3AgentOptions}
                  </select>
                </label>
                <div class="sim-goals">
                  <div class="sim-goals-title" id="pytorch-rewards-toggle">▸ Reward Weights</div>
                  <div id="pytorch-rewards-body" style="display:none">
                    ${PYTORCH_REWARD_DEFS.map((d) => `
                      <div class="sim-goal-row">
                        <span class="goal-name">${d.label}</span>
                        <input type="number" class="goal-w pytorch-reward-input" data-key="${d.key}"
                               value="${pytorchRewards[d.key]}" step="0.1">
                      </div>`).join("")}
                  </div>
                </div>
              </div>
              <div id="hybrid-opts" style="display:none">
                <label>Agent package
                  <select id="hybrid-s3-agent-key">
                    ${s3AgentOptions}
                  </select>
                </label>
                <div class="sim-goals">
                  <div class="sim-goals-title" id="hybrid-rewards-toggle">▸ Reward Weights</div>
                  <div id="hybrid-rewards-body" style="display:none">
                    ${PYTORCH_REWARD_DEFS.map((d) => `
                      <div class="sim-goal-row">
                        <span class="goal-name">${d.label}</span>
                        <input type="number" class="goal-w hybrid-reward-input" data-key="${d.key}"
                               value="${pytorchRewards[d.key]}" step="0.1">
                      </div>`).join("")}
                  </div>
                </div>
                <div class="sim-goals">
                  <div class="sim-goals-title" id="obs-config-toggle">▸ Observation Features</div>
                  <div id="obs-config-body" style="display:none">
                    ${OBS_CONFIG_FLAGS.map((f) => `
                      <div class="sim-goal-row">
                        <input type="checkbox" class="obs-flag-input" data-key="${f.key}"
                               ${obsConfig[f.key] ? "checked" : ""}>
                        <span class="goal-name">${f.label}</span>
                      </div>`).join("")}
                  </div>
                </div>
              </div>
              <div id="hier-opts">
                <label>Agent file
                  <div class="sim-agent-file">
                    <select id="agent-file">
                      <option value="">— Start fresh —</option>
                      ${agentOptions}
                    </select>
                  </div>
                </label>
                <label>Save weights to
                  <input type="text" id="agent-save" placeholder="e.g. agent2.json" value="agent2.json">
                </label>
                <div class="sim-goals" id="goal-config">
                  <div class="sim-goals-title" id="goals-toggle">▸ Goals &amp; Rewards</div>
                  <div id="goals-body" style="display:none"></div>
                </div>
              </div>
            </div>

            <!-- Opponent slot -->
            <div class="sim-slot">
              <h3>Opponent (Player 2)</h3>
              <label>Type
                <select id="opp-type">
                  <option value="greedy" selected>Greedy</option>
                  <option value="random">Random</option>
                  <option value="passive">Passive</option>
                  <option value="hier">Hierarchical RL</option>
                </select>
              </label>
              <div id="opp-hier-opts" style="display:none">
                <label>Agent file
                  <div class="sim-agent-file">
                    <select id="opp-file">
                      <option value="">— Start fresh —</option>
                      ${agentOptions}
                    </select>
                  </div>
                </label>
                <label>Save weights to
                  <input type="text" id="opp-save" placeholder="e.g. opponent.json" value="">
                </label>
              </div>
            </div>
          </div>

          <div class="sim-settings-row">
            <label>Map size
              <select id="map-size">
                <option value="small" selected>Small (32×20)</option>
                <option value="medium">Medium (48×32)</option>
                <option value="large">Large (64×40)</option>
              </select>
            </label>
            <label>Episodes
              <input type="number" id="episodes" value="20" min="1" max="9999">
            </label>
            <label>Max turns
              <input type="number" id="max-turns" value="500" min="50" max="9999">
            </label>
            <label title="Delay between agent actions (0 = max speed, use 0.3–1s to see the map update)">Step delay (s)
              <input type="number" id="step-delay" value="0.3" min="0" max="5" step="0.1">
            </label>
          </div>

          <button class="sim-start-btn" id="start-sim">▶ Start Simulation</button>
          <div class="lobby" style="margin-top:8px"><div class="error" id="sim-err"></div></div>
        </div>
      `;

      // Populate goal rows
      renderGoalRows();

      root.querySelector("#btn-back")!.addEventListener("click", () => { stopSetupPoll(); cleanup(); onBack(); });
      root.querySelector("#btn-history")!.addEventListener("click", () => { stopSetupPoll(); renderHistory(); });

      // Start polling active sessions every 2s
      stopSetupPoll();
      void refreshActiveSims();
      setupPollId = setInterval(() => { void refreshActiveSims(); }, 2000);
      root.querySelector("#goals-toggle")!.addEventListener("click", () => {
        const body = root.querySelector<HTMLElement>("#goals-body")!;
        const toggle = root.querySelector("#goals-toggle")!;
        const visible = body.style.display !== "none";
        body.style.display = visible ? "none" : "block";
        toggle.textContent = (visible ? "▸" : "▾") + " Goals & Rewards";
      });
      root.querySelector("#pytorch-rewards-toggle")!.addEventListener("click", () => {
        const body = root.querySelector<HTMLElement>("#pytorch-rewards-body")!;
        const toggle = root.querySelector("#pytorch-rewards-toggle")!;
        const visible = body.style.display !== "none";
        body.style.display = visible ? "none" : "block";
        toggle.textContent = (visible ? "▸" : "▾") + " Reward Weights";
      });
      root.querySelectorAll<HTMLInputElement>(".pytorch-reward-input").forEach((el) => {
        el.addEventListener("input", () => {
          pytorchRewards[el.dataset.key!] = parseFloat(el.value) || 0;
        });
      });
      root.querySelector("#agent-type")!.addEventListener("change", () => {
        const t = (root.querySelector<HTMLSelectElement>("#agent-type"))!.value;
        root.querySelector<HTMLElement>("#pytorch-opts")!.style.display = t === "pytorch" ? "" : "none";
        root.querySelector<HTMLElement>("#hybrid-opts")!.style.display  = t === "hybrid"  ? "" : "none";
        root.querySelector<HTMLElement>("#hier-opts")!.style.display    = t === "hier"    ? "" : "none";
      });
      // Initialise visibility for default selection (pytorch)
      root.querySelector<HTMLElement>("#hier-opts")!.style.display = "none";

      // Hybrid reward weights toggle
      root.querySelector("#hybrid-rewards-toggle")!.addEventListener("click", () => {
        const body = root.querySelector<HTMLElement>("#hybrid-rewards-body")!;
        const visible = body.style.display !== "none";
        body.style.display = visible ? "none" : "block";
        root.querySelector("#hybrid-rewards-toggle")!.textContent = (visible ? "▸" : "▾") + " Reward Weights";
      });
      root.querySelectorAll<HTMLInputElement>(".hybrid-reward-input").forEach((el) => {
        el.addEventListener("input", () => { pytorchRewards[el.dataset.key!] = parseFloat(el.value) || 0; });
      });

      // ObsConfig flags toggle + checkboxes
      root.querySelector("#obs-config-toggle")!.addEventListener("click", () => {
        const body = root.querySelector<HTMLElement>("#obs-config-body")!;
        const visible = body.style.display !== "none";
        body.style.display = visible ? "none" : "block";
        root.querySelector("#obs-config-toggle")!.textContent = (visible ? "▸" : "▾") + " Observation Features";
      });
      root.querySelectorAll<HTMLInputElement>(".obs-flag-input").forEach((el) => {
        el.addEventListener("change", () => { obsConfig[el.dataset.key!] = el.checked; });
      });
      root.querySelector("#opp-type")!.addEventListener("change", () => {
        const t = (root.querySelector<HTMLSelectElement>("#opp-type"))!.value;
        const oppHierOpts = root.querySelector<HTMLElement>("#opp-hier-opts")!;
        oppHierOpts.style.display = t === "hier" ? "" : "none";
      });
      root.querySelector("#start-sim")!.addEventListener("click", () => { stopSetupPoll(); void startSim(); });
    })();
  }

  function renderGoalRows(): void {
    const body = root.querySelector<HTMLElement>("#goals-body");
    if (!body) return;
    body.innerHTML = goals.map((g, i) => `
      <div class="sim-goal-row">
        <input type="checkbox" data-goal="${i}" class="goal-en" ${g.enabled ? "checked" : ""}>
        <span class="goal-name">${g.label}</span>
        <div class="goal-reward">
          <span>${g.signal.replace(/_delta$/, "")}</span>
          <span>×</span>
          <input type="number" class="goal-w" data-goal="${i}" value="${g.weight}" step="0.1" min="0" max="100">
        </div>
      </div>
    `).join("");

    body.querySelectorAll<HTMLInputElement>(".goal-en").forEach((el) => {
      el.addEventListener("change", () => {
        goals[parseInt(el.dataset.goal!)]!.enabled = el.checked;
      });
    });
    body.querySelectorAll<HTMLInputElement>(".goal-w").forEach((el) => {
      el.addEventListener("input", () => {
        goals[parseInt(el.dataset.goal!)]!.weight = parseFloat(el.value) || 0;
      });
    });
  }

  async function startSim(): Promise<void> {
    const agentType = (root.querySelector<HTMLSelectElement>("#agent-type"))!.value as "hier" | "greedy" | "random" | "passive" | "pytorch" | "hybrid";
    const agentFile = agentType === "hier" ? (root.querySelector<HTMLSelectElement>("#agent-file"))!.value || undefined : undefined;
    const saveFile = agentType === "hier" ? ((root.querySelector<HTMLInputElement>("#agent-save"))!.value.trim() || undefined) : undefined;

    // pytorch uses #s3-agent-key, hybrid uses #hybrid-s3-agent-key
    const s3AgentSel = agentType === "hybrid"
      ? root.querySelector<HTMLSelectElement>("#hybrid-s3-agent-key")
      : root.querySelector<HTMLSelectElement>("#s3-agent-key");
    const agentZipKey = (agentType === "pytorch" || agentType === "hybrid") ? (s3AgentSel?.value || "agents/ppo-v1.zip") : undefined;
    const entrypoint  = (agentType === "pytorch" || agentType === "hybrid") ? (s3AgentSel?.selectedOptions[0]?.dataset.entrypoint || "main.py") : undefined;

    const oppType = (root.querySelector<HTMLSelectElement>("#opp-type"))!.value as "hier" | "greedy" | "random" | "passive";
    const oppFile = oppType === "hier" ? (root.querySelector<HTMLSelectElement>("#opp-file"))!.value || undefined : undefined;
    const oppSave = oppType === "hier" ? ((root.querySelector<HTMLInputElement>("#opp-save"))!.value.trim() || undefined) : undefined;
    const mapSize = (root.querySelector<HTMLSelectElement>("#map-size"))!.value as "small" | "medium" | "large";
    const episodes = parseInt((root.querySelector<HTMLInputElement>("#episodes"))!.value, 10);
    const maxTurns = parseInt((root.querySelector<HTMLInputElement>("#max-turns"))!.value, 10);
    const stepDelayMs = Math.round(parseFloat((root.querySelector<HTMLInputElement>("#step-delay"))!.value) * 1000) || 0;

    // Build agent config from goals
    const agentConfig    = agentType === "hier"    ? buildAgentConfig()    : undefined;
    const rewardWeights  = (agentType === "pytorch" || agentType === "hybrid") ? { ...pytorchRewards } : undefined;
    const agentObsConfig = agentType === "hybrid"  ? { ...obsConfig }      : undefined;

    const body = {
      agentSlot: { type: agentType, agentFile, agentConfig, saveFile, agentZipKey, entrypoint, rewardWeights, obsConfig: agentObsConfig },
      opponentSlot: { type: oppType, agentFile: oppFile, saveFile: oppSave },
      mapSize, episodes, maxTurns, stepDelayMs,
    };

    const r = await simFetch("/sim", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      const errEl = root.querySelector<HTMLElement>("#sim-err");
      if (errEl) errEl.textContent = `Failed to create simulation: ${r.status}`;
      return;
    }
    const { simId: id } = (await r.json()) as { simId: string };
    simId = id;

    // Start it
    await simFetch(`/sim/${id}/start`, { method: "POST" });

    episodeLog = [];
    phase = "running";
    renderRunner();
  }

  function buildAgentConfig(): object {
    const enabledGoals = goals.filter((g) => g.enabled);
    return {
      manager: { network: { hidden: [32, 16] }, training: { lr: 0.001, epsilon: 1.0, epsilon_decay: 0.9, epsilon_min: 0.1, gamma: 0.95 }, goal_horizon: 5 },
      tactical: { network: { hidden: [64, 32] }, training: { lr: 0.001, epsilon: 1.0, epsilon_decay: 0.999, epsilon_min: 0.05, gamma: 0.95 } },
      goals: goals.map((g) => ({
        id: g.id, label: g.label, enabled: g.enabled,
        rewards: g.enabled ? [{ signal: g.signal, weight: g.weight }] : [],
      })),
      global_rewards: [{ signal: "win", weight: 100 }, { signal: "lose", weight: -100 }],
      features: {
        state: { base_features: true, enemy_units_visible_count: true, enemy_cities_visible_count: true, at_war: true, era_index: true, turns_since_last_city: true, total_production_rate: true, avg_city_hp_fraction: true },
        intent: {
          MoveUnit: { enabled: true, unseen_neighbors_count: true, terrain_cost: true, has_resource: true, is_melee_attack: true, num_friendlies_adjacent: true, num_enemies_adjacent: true, unit_hp_fraction: true, unit_movement_fraction: true },
          RangedAttack: { enabled: true, target_hp_fraction: true, target_unit_strength: true, friendly_units_in_range: true },
          FoundCity: { enabled: true, tile_yield_score: true, dist_to_nearest_city: true, resources_in_radius: true },
          SetResearch: { enabled: true, tech_era_index: true, tech_unlocks_unit_count: true, tech_unlocks_building_count: true },
          SetCityProduction: { enabled: true, is_unit: true, is_building: true, is_wonder: true, item_cost: true, city_production_per_turn: true },
          DeclareWar: { enabled: true, enemy_relative_strength: true, enemy_city_count: true },
          MakePeace: { enabled: true, enemy_relative_strength: true, enemy_city_count: true },
          EndTurn: { enabled: true }, Other: { enabled: true },
        },
      },
    };
  }

  // ── Phase: Runner ───────────────────────────────────────────────────────────

  function renderRunner(): void {
    root.innerHTML = `
      <div class="sim-runner-root">
        <div class="sim-topbar" id="sim-topbar">
          <span class="sim-episode-badge" id="ep-badge">Ep 0/0</span>
          <span class="sim-turn-label" id="turn-label">Turn 0/500</span>
          <span class="sim-state-label running" id="state-label">RUNNING</span>
          <div class="sim-topbar-sep"></div>
          <button class="sim-ctrl-btn" id="btn-pause" title="Pause">⏸ Pause</button>
          <button class="sim-ctrl-btn" id="btn-slow" title="1s per turn">▶ 1s/turn</button>
          <button class="sim-ctrl-btn active" id="btn-fast" title="Max speed">⏩ Fast</button>
          <button class="sim-ctrl-btn" id="btn-step" disabled title="Advance one turn (while paused)">⏭ Step</button>
          <div class="sim-topbar-sep"></div>
          <select class="sim-view-select" id="view-as-select">
            <option value="">👁 View All</option>
          </select>
          <span class="sim-reward-label" id="reward-label">Reward: <span>0.0</span></span>
          <button class="sim-ctrl-btn" id="btn-results" style="margin-left:auto">Results</button>
          <button class="sim-ctrl-btn" id="btn-back-to-setup" title="Stop and go back to setup">← Setup</button>
        </div>
        <div class="sim-body">
          <div class="sim-map-area" id="sim-map-area"></div>
          <div class="sim-log-panel" id="sim-log-panel">
            <div class="sim-log-header">Log</div>
            <div class="sim-log-entries" id="sim-log-entries"></div>
          </div>
          <div class="sim-graph-panel">
            <div class="sim-graph-header">
              <span>Metrics</span>
              <button class="sim-add-graph-btn" id="add-graph-btn">+ Add Graph</button>
            </div>
            <div class="sim-graph-list" id="graph-list"></div>
          </div>
        </div>
      </div>
    `;

    // Wire controls
    root.querySelector("#btn-pause")!.addEventListener("click", () => {
      if (!simId) return;
      void simFetch(`/sim/${simId}/pause`, { method: "POST" });
    });
    root.querySelector("#btn-slow")!.addEventListener("click", () => {
      if (!simId) return;
      void simFetch(`/sim/${simId}/resume`, { method: "POST", body: JSON.stringify({ speed: "slow" }) });
      setActiveSpeedBtn("slow");
    });
    root.querySelector("#btn-fast")!.addEventListener("click", () => {
      if (!simId) return;
      void simFetch(`/sim/${simId}/resume`, { method: "POST", body: JSON.stringify({ speed: "fast" }) });
      setActiveSpeedBtn("fast");
    });
    root.querySelector("#btn-step")!.addEventListener("click", () => {
      if (!simId) return;
      void simFetch(`/sim/${simId}/step`, { method: "POST" });
    });
    root.querySelector("#btn-results")!.addEventListener("click", () => renderResults());
    root.querySelector("#btn-back-to-setup")!.addEventListener("click", () => {
      if (simId) void simFetch(`/sim/${simId}`, { method: "DELETE" });
      cleanup();
      phase = "setup";
      renderSetup();
    });
    root.querySelector<HTMLSelectElement>("#view-as-select")!.addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value;
      if (currentStatus?.spectatorToken && currentStatus.matchId) {
        connectSpectator(currentStatus.matchId, currentStatus.spectatorToken, val, currentStatus.gameServerUrl ?? undefined);
      }
    });
    root.querySelector("#add-graph-btn")!.addEventListener("click", () => {
      openGraphModal(null, (def) => {
        graphPanel?.addGraph(def);
      });
    });

    // Set up graph panel
    const graphList = root.querySelector<HTMLElement>("#graph-list")!;
    graphPanel = new GraphPanel(graphList, {
      onEdit: (id) => {
        const def = graphPanel?.getDef(id);
        openGraphModal(def ?? null, (newDef) => { graphPanel?.editGraph(id, newDef); });
      },
      onRemove: (id) => { graphPanel?.removeGraph(id); },
    });

    // Default graphs
    graphPanel.addGraph({ id: "g-cities", title: "Cities", metrics: ["agent.cities", "opp.cities"] });
    graphPanel.addGraph({ id: "g-units", title: "Units", metrics: ["agent.units", "opp.units"] });
    graphPanel.addGraph({ id: "g-kills", title: "Kills & Captures", metrics: ["cumKills", "cumCaptures"] });

    // Init map
    initMap();

    // Connect SSE
    if (simId) connectSSE(simId);
  }

  function setActiveSpeedBtn(speed: "slow" | "fast"): void {
    root.querySelector("#btn-slow")?.classList.toggle("active", speed === "slow");
    root.querySelector("#btn-fast")?.classList.toggle("active", speed === "fast");
  }

  function updateTopBar(status: StatusEvent): void {
    currentStatus = status;

    const epBadge = root.querySelector("#ep-badge");
    const turnLabel = root.querySelector("#turn-label");
    const stateLabel = root.querySelector<HTMLElement>("#state-label");
    const stepBtn = root.querySelector<HTMLButtonElement>("#btn-step");

    if (epBadge) epBadge.textContent = `Ep ${status.episode}/${status.totalEpisodes}`;
    if (turnLabel) turnLabel.textContent = `Turn ${status.turn}/${status.maxTurns}`;

    if (stateLabel) {
      stateLabel.textContent = status.state.toUpperCase();
      stateLabel.className = `sim-state-label ${status.state === "running" ? "running" : status.state === "paused" ? "paused" : "done"}`;
    }
    if (stepBtn) stepBtn.disabled = status.state !== "paused";

    // Update view selector with player IDs once we know the match
    if (status.spectatorToken) {
      const sel = root.querySelector<HTMLSelectElement>("#view-as-select");
      if (sel && sel.options.length === 1) {
        // Will be populated when we receive game state
      }
    }
  }

  function updateViewSelector(state: MatchState): void {
    const sel = root.querySelector<HTMLSelectElement>("#view-as-select");
    if (!sel || sel.options.length > 1) return;
    for (const p of (state as unknown as { players: Array<{ id: string; name: string }> }).players) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `👤 ${p.name}`;
      sel.appendChild(opt);
    }
  }

  // ── Map initialization ────────────────────────────────────────────────────

  function renderLatestState(): void {
    if (!mapViewer || !pack || !latestMatchState) return;
    mapViewer.setPack(pack);
    mapViewer.render(latestMatchState as Parameters<typeof mapViewer.render>[0]);
  }

  function scheduleRender(): void {
    if (renderRafId !== null) return;
    renderRafId = requestAnimationFrame(() => {
      renderRafId = null;
      renderLatestState();
    });
  }

  function initMap(): void {
    const container = root.querySelector<HTMLElement>("#sim-map-area");
    if (!container) return;

    const canvas = document.createElement("canvas");
    container.appendChild(canvas);

    const app = new Application();
    pixiApp = app;

    void app
      .init({ canvas, resizeTo: container, background: "#0e1116", antialias: true })
      .then(() => preloadTerrainAssets())
      .then(() => {
        mapViewer = new MapViewer(app, {
          onTileHover: () => { /* could add tile info panel */ },
        });
        void fetchContentPack().then((p) => {
          pack = p as typeof pack;
          scheduleRender();
        });
        // If state already arrived while we were initializing, render now
        scheduleRender();
      });
  }

  // ── Spectator WS connection ──────────────────────────────────────────────

  let cumulativeReward = 0;

  function connectSpectator(matchId: string, token: string, asPlayer = "", serverUrl?: string): void {
    if (mapViewer) mapViewer.clearLayerCaches();
    gameClient?.close();
    let retries = 0;
    const tryConnect = (): void => {
      gameClient = new GameClient(matchId, "", token, {
        onOpen: () => { retries = 0; },
        onClose: () => {
          // Reconnect while this matchId is still active (episode still in progress).
          if (retries < 5 && currentStatus?.matchId === matchId) {
            retries++;
            setTimeout(tryConnect, 1000 * retries);
          }
        },
        onState: (state) => {
          latestMatchState = state;
          updateViewSelector(state);
          scheduleRender();
        },
      }, asPlayer || undefined, serverUrl);
      gameClient.connect();
    };
    tryConnect();
  }

  // ── SSE connection ─────────────────────────────────────────────────────────

  function connectSSE(id: string): void {
    sseSource?.close();
    sseSource = new EventSource(`/sim/${id}/events`);

    sseSource.addEventListener("status", (e) => {
      const data = JSON.parse(e.data) as StatusEvent;
      const prevMatchId = currentStatus?.matchId ?? null;
      updateTopBar(data);
      if (data.spectatorToken && data.matchId) {
        const changed = data.matchId !== prevMatchId;
        if (changed) {
          latestMatchState = null;
          mapViewer?.clearLayerCaches();
          connectSpectator(data.matchId, data.spectatorToken, "", data.gameServerUrl ?? undefined);
          graphPanel?.clear();
        }
      }
    });

    sseSource.addEventListener("log", (e) => {
      const { message, ts } = JSON.parse(e.data) as { message: string; ts: string };
      const logEntries = root.querySelector<HTMLElement>("#sim-log-entries");
      if (!logEntries) return;
      const time = new Date(ts).toLocaleTimeString();
      const line = document.createElement("div");
      line.className = `sim-log-line${message.startsWith("ERROR") ? " sim-log-error" : ""}`;
      line.textContent = `${time}  ${message}`;
      logEntries.appendChild(line);
      logEntries.scrollTop = logEntries.scrollHeight;
    });

    sseSource.addEventListener("snapshot", (e) => {
      const data = JSON.parse(e.data) as { turn: number; snap?: TurnSnap };
      const turnLabel = root.querySelector("#turn-label");
      if (turnLabel) turnLabel.textContent = `Turn ${data.turn}/${currentStatus?.maxTurns ?? "—"}`;
      // Push graph data from agent's snap (server-computed); spectator WS is for map only
      if (data.snap && graphPanel) graphPanel.push(data.snap);
    });

    sseSource.addEventListener("episode", (e) => {
      const ep = JSON.parse(e.data) as EpRecord;
      episodeLog.push(ep);
      cumulativeReward += ep.reward;
      const rewardEl = root.querySelector("#reward-label span");
      if (rewardEl) rewardEl.textContent = cumulativeReward.toFixed(1);
    });

    sseSource.addEventListener("done", (e: MessageEvent) => {
      sseSource?.close();
      // PyTorch path: per-episode records arrive in the done payload (no episode events during training)
      if (episodeLog.length === 0 && e.data) {
        try {
          const payload = JSON.parse(e.data) as { summary?: EpRecord[] };
          if (payload.summary?.length) episodeLog = [...payload.summary] as EpRecord[];
        } catch { /**/ }
      }
      renderResults();
    });
  }

  // ── Phase: Results ──────────────────────────────────────────────────────────

  function renderResults(): void {
    cleanup();
    phase = "results";

    const wins   = episodeLog.filter((r) => r.outcome === "WON").length;
    const losses = episodeLog.filter((r) => r.outcome === "LOST").length;
    const draws  = episodeLog.length - wins - losses;
    const totalKills    = episodeLog.reduce((s, r) => s + r.kills, 0);
    const totalCaptures = episodeLog.reduce((s, r) => s + r.captures, 0);
    const avgReward     = episodeLog.length > 0 ? (episodeLog.reduce((s, r) => s + r.reward, 0) / episodeLog.length) : 0;
    const hasEpsilon    = episodeLog.some((r) => r.tacticalEpsilon != null);

    const rows = episodeLog.map((r) => {
      const cls = r.outcome === "WON" ? "outcome-won" : r.outcome === "LOST" ? "outcome-lost" : "outcome-draw";
      return `<tr>
        <td>${r.episode}</td>
        <td class="${cls}">${r.outcome}</td>
        <td>${r.reward.toFixed(1)}</td>
        <td>${r.turns}</td>
        <td>${r.kills}</td>
        <td>${r.captures}</td>
        ${hasEpsilon ? `<td>${r.tacticalEpsilon != null ? r.tacticalEpsilon.toFixed(3) : "—"}</td>` : ""}
      </tr>`;
    }).join("");

    root.innerHTML = `
      <div class="sim-page">
        <div class="sim-nav">
          <h1>Simulation Results</h1>
          <button class="sim-nav-btn" id="btn-new-sim">▶ New Simulation</button>
          <button class="sim-nav-btn" id="btn-history-r">📊 Past Runs</button>
          <button class="sim-nav-btn" id="btn-back-r" style="margin-left:auto">← Lobby</button>
        </div>

        <div class="sim-summary-stats">
          <div class="sim-summary-stat"><span class="label">Wins</span><span class="value outcome-won">${wins}</span></div>
          <div class="sim-summary-stat"><span class="label">Losses</span><span class="value outcome-lost">${losses}</span></div>
          <div class="sim-summary-stat"><span class="label">Draws</span><span class="value outcome-draw">${draws}</span></div>
          <div class="sim-summary-stat"><span class="label">Total Kills</span><span class="value">${totalKills}</span></div>
          <div class="sim-summary-stat"><span class="label">City Captures</span><span class="value">${totalCaptures}</span></div>
          <div class="sim-summary-stat"><span class="label">Avg Reward</span><span class="value">${avgReward.toFixed(1)}</span></div>
        </div>

        <div class="sim-results-charts" id="results-charts"></div>

        <table class="sim-results-table">
          <thead><tr>
            <th>Ep</th><th>Outcome</th><th>Reward</th><th>Turns</th><th>Kills</th><th>Captures</th>
            ${hasEpsilon ? "<th>ε Tactical</th>" : ""}
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    root.querySelector("#btn-new-sim")!.addEventListener("click", () => { phase = "setup"; renderSetup(); });
    root.querySelector("#btn-history-r")!.addEventListener("click", () => renderHistory());
    root.querySelector("#btn-back-r")!.addEventListener("click", () => { cleanup(); onBack(); });

    buildResultsCharts(root.querySelector<HTMLElement>("#results-charts")!);
  }

  function buildResultsCharts(container: HTMLElement): void {
    if (episodeLog.length === 0) return;
    const labels = episodeLog.map((r) => r.episode);
    const hasEpsilon = episodeLog.some((r) => r.tacticalEpsilon != null);

    const chartDefs: Array<{ title: string; datasets: Array<{ label: string; data: number[]; color: string }> }> = [
      {
        title: "Reward per Episode",
        datasets: [{ label: "Reward", data: episodeLog.map((r) => r.reward), color: "rgba(100,180,255,0.9)" }],
      },
      {
        title: "Kills & Captures per Episode",
        datasets: [
          { label: "Kills",    data: episodeLog.map((r) => r.kills),    color: "rgba(255,100,100,0.9)" },
          { label: "Captures", data: episodeLog.map((r) => r.captures), color: "rgba(255,215,0,0.9)"   },
        ],
      },
      {
        title: "Turns per Episode",
        datasets: [{ label: "Turns", data: episodeLog.map((r) => r.turns), color: "rgba(100,220,100,0.9)" }],
      },
    ];

    if (hasEpsilon) {
      chartDefs.push({
        title: "Epsilon Decay",
        datasets: [
          { label: "Tactical ε", data: episodeLog.map((r) => r.tacticalEpsilon ?? 0), color: "rgba(200,130,255,0.9)" },
          { label: "Manager ε",  data: episodeLog.map((r) => r.managerEpsilon ?? 0),  color: "rgba(255,165,80,0.9)"  },
        ],
      });
    }

    // Rolling win rate (window=5)
    const winRateData = episodeLog.map((_, i) => {
      const window = episodeLog.slice(Math.max(0, i - 4), i + 1);
      return window.filter((r) => r.outcome === "WON").length / window.length * 100;
    });
    chartDefs.push({
      title: "Rolling Win Rate % (last 5 eps)",
      datasets: [{ label: "Win Rate %", data: winRateData, color: "rgba(46,160,67,0.9)" }],
    });

    container.style.display = "grid";
    container.style.gridTemplateColumns = "repeat(auto-fill, minmax(340px, 1fr))";
    container.style.gap = "12px";
    container.style.margin = "16px 0";

    for (const def of chartDefs) {
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "background:#0e1116;border:1px solid #30363d;border-radius:6px;padding:10px;";
      const title = document.createElement("div");
      title.style.cssText = "font-size:11px;color:#8b949e;margin-bottom:6px;";
      title.textContent = def.title;
      const canvasWrap = document.createElement("div");
      canvasWrap.style.height = "150px";
      const canvas = document.createElement("canvas");
      canvasWrap.appendChild(canvas);
      wrapper.appendChild(title);
      wrapper.appendChild(canvasWrap);
      container.appendChild(wrapper);

      new Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: def.datasets.map((ds) => ({
            label: ds.label,
            data: ds.data,
            borderColor: ds.color,
            backgroundColor: "transparent",
            borderWidth: 1.5,
            pointRadius: episodeLog.length > 50 ? 0 : 2,
            tension: 0.3,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { labels: { color: "#8b949e", boxWidth: 10, font: { size: 9 } } } },
          scales: {
            x: { ticks: { color: "#8b949e", maxTicksLimit: 8, font: { size: 9 } }, grid: { color: "#21262d" } },
            y: { ticks: { color: "#8b949e", font: { size: 9 } }, grid: { color: "#21262d" } },
          },
        },
      });
    }
  }

  // ── Phase: History ──────────────────────────────────────────────────────────

  function renderHistory(): void {
    cleanup();
    phase = "history";

    void (async () => {
      const runs = await getRuns().catch(() => [] as RunMeta[]);

      // Group by agentFile
      const groups = new Map<string, RunMeta[]>();
      for (const run of runs) {
        const key = run.agentFile ?? "(unnamed)";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(run);
      }

      let groupsHtml = "";
      if (runs.length === 0) {
        groupsHtml = `<p class="lobby" style="text-align:center;color:#8b949e">No past runs found. Start a simulation to generate data.</p>`;
      } else {
        for (const [agentFile, agentRuns] of groups) {
          const totalEps = agentRuns.reduce((s, r) => s + r.completedEpisodes, 0);
          const rows = agentRuns.map((r) => {
            const date = new Date(r.startTime).toLocaleString();
            const wins = r.summary?.wins ?? "—";
            const avgR = r.summary ? r.summary.avgReward.toFixed(1) : "—";
            return `<tr data-run-id="${r.runId}" class="history-run-row">
              <td>${date}</td>
              <td>${r.completedEpisodes}</td>
              <td>${r.strategy}</td>
              <td>${r.mapSize}</td>
              <td>${wins}</td>
              <td>${avgR}</td>
            </tr>`;
          }).join("");

          groupsHtml += `
            <div class="sim-agent-group">
              <h3>🤖 ${agentFile} <span style="color:#8b949e;font-size:11px;font-weight:400">(${totalEps} total episodes across ${agentRuns.length} runs)</span></h3>
              <button class="sim-nav-btn view-agent-runs" data-agent="${agentFile}">View All Runs Together</button>
              <table class="sim-history-table" style="margin-top:8px">
                <thead><tr><th>Date</th><th>Episodes</th><th>Strategy</th><th>Map</th><th>Wins</th><th>Avg Reward</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `;
        }
      }

      root.innerHTML = `
        <div class="sim-page">
          <div class="sim-nav">
            <h1>Past Runs</h1>
            <button class="sim-nav-btn" id="btn-new-sim-h">▶ New Simulation</button>
            <button class="sim-nav-btn" id="btn-back-h" style="margin-left:auto">← Lobby</button>
          </div>
          <div id="history-groups">${groupsHtml}</div>
        </div>
      `;

      root.querySelector("#btn-new-sim-h")!.addEventListener("click", () => { phase = "setup"; renderSetup(); });
      root.querySelector("#btn-back-h")!.addEventListener("click", () => { cleanup(); onBack(); });

      // Click individual run row
      root.querySelectorAll<HTMLElement>(".history-run-row").forEach((row) => {
        row.addEventListener("click", () => void showHistoryViewer([row.dataset.runId!]));
      });

      // Click "view all runs together" for an agent
      root.querySelectorAll<HTMLElement>(".view-agent-runs").forEach((btn) => {
        btn.addEventListener("click", () => {
          const agentFile = btn.dataset.agent!;
          const agentRunIds = (groups.get(agentFile) ?? []).map((r) => r.runId);
          void showHistoryViewer(agentRunIds);
        });
      });
    })();
  }

  async function showHistoryViewer(runIds: string[]): Promise<void> {
    // Collect all episodes from the selected runs in order
    const allSnaps: TurnSnap[] = [];
    const allEps: EpisodeDump[] = [];

    for (const runId of runIds) {
      const files = await getRunEpisodes(runId);
      for (let i = 0; i < files.length; i++) {
        const ep = await getRunEpisode(runId, i);
        if (ep) {
          allEps.push(ep);
          allSnaps.push(...ep.turns);
        }
      }
    }

    if (allEps.length === 0) return;

    root.innerHTML = `
      <div class="sim-page">
        <div class="sim-nav">
          <h1>History Viewer — ${allEps.length} episodes</h1>
          <span style="color:#8b949e;font-size:12px">Runs: ${runIds.join(", ")}</span>
          <button class="sim-nav-btn" id="btn-back-viewer" style="margin-left:auto">← Back</button>
        </div>
        <div style="display:flex;gap:16px;align-items:flex-start">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              <button class="sim-ctrl-btn" id="hvprev">‹ Prev</button>
              <span id="hv-ep-label" style="font-size:13px"></span>
              <button class="sim-ctrl-btn" id="hvnext">Next ›</button>
              <input type="range" id="hv-slider" min="0" max="${allEps.length - 1}" value="0" style="flex:1;accent-color:#388bfd">
            </div>
            <div id="hv-summary" style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin-bottom:12px"></div>
            <table class="sim-results-table" id="hv-table">
              <thead><tr><th>Ep</th><th>Outcome</th><th>Reward</th><th>Turns</th><th>Kills</th><th>Captures</th></tr></thead>
              <tbody>${allEps.map((ep) => {
                const cls = ep.outcome === "WON" ? "outcome-won" : ep.outcome === "LOST" ? "outcome-lost" : "outcome-draw";
                return `<tr><td>${ep.episode}</td><td class="${cls}">${ep.outcome}</td><td>${ep.totalReward.toFixed(1)}</td><td>${ep.turns.length}</td><td>${ep.totalKills}</td><td>${ep.totalCaptures}</td></tr>`;
              }).join("")}</tbody>
            </table>
          </div>
          <div style="width:300px;flex-shrink:0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <span style="font-size:11px;color:#8b949e;text-transform:uppercase">Metrics</span>
              <button class="sim-add-graph-btn" id="hv-add-graph">+ Add Graph</button>
            </div>
            <div id="hv-graph-list"></div>
          </div>
        </div>
      </div>
    `;

    root.querySelector("#btn-back-viewer")!.addEventListener("click", () => renderHistory());

    const hvGraphList = root.querySelector<HTMLElement>("#hv-graph-list")!;
    const hvPanel = new GraphPanel(hvGraphList, {
      onEdit: (id) => {
        const def = hvPanel.getDef(id);
        openGraphModal(def ?? null, (newDef) => {
          hvPanel.editGraph(id, newDef);
          hvPanel.loadSnaps(allEps[currentEpIdx]?.turns ?? []);
        });
      },
      onRemove: (id) => hvPanel.removeGraph(id),
    });
    hvPanel.addGraph({ id: "h-cities", title: "Cities", metrics: ["agent.cities", "opp.cities"] });
    hvPanel.addGraph({ id: "h-kills", title: "Kills & Captures", metrics: ["cumKills", "cumCaptures"] });

    root.querySelector("#hv-add-graph")!.addEventListener("click", () => {
      openGraphModal(null, (def) => {
        hvPanel.addGraph(def);
        hvPanel.loadSnaps(allEps[currentEpIdx]?.turns ?? []);
      });
    });

    let currentEpIdx = 0;

    function goTo(idx: number): void {
      currentEpIdx = Math.max(0, Math.min(allEps.length - 1, idx));
      const ep = allEps[currentEpIdx]!;
      const slider = root.querySelector<HTMLInputElement>("#hv-slider")!;
      slider.value = String(currentEpIdx);
      const label = root.querySelector("#hv-ep-label")!;
      label.textContent = `Episode ${ep.episode} / ${allEps.length}  ·  ${ep.outcome}  ·  Reward ${ep.totalReward.toFixed(1)}`;
      root.querySelector<HTMLButtonElement>("#hvprev")!.disabled = currentEpIdx === 0;
      root.querySelector<HTMLButtonElement>("#hvnext")!.disabled = currentEpIdx === allEps.length - 1;
      hvPanel.loadSnaps(ep.turns);

      const summaryEl = root.querySelector("#hv-summary")!;
      summaryEl.innerHTML = `
        <span style="color:#7ee787">Kills: ${ep.totalKills}</span>
        <span style="color:#ffd700">Captures: ${ep.totalCaptures}</span>
        <span>Turns: ${ep.turns.length}</span>
        <span>Agent: ${ep.agentId.slice(0,8)}</span>
      `;
    }

    root.querySelector("#hvprev")!.addEventListener("click", () => goTo(currentEpIdx - 1));
    root.querySelector("#hvnext")!.addEventListener("click", () => goTo(currentEpIdx + 1));
    root.querySelector<HTMLInputElement>("#hv-slider")!.addEventListener("input", (e) => goTo(parseInt((e.target as HTMLInputElement).value, 10)));

    goTo(0);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  function cleanup(): void {
    stopSetupPoll();
    sseSource?.close(); sseSource = null;
    gameClient?.close(); gameClient = null;
    if (renderRafId !== null) { cancelAnimationFrame(renderRafId); renderRafId = null; }
    if (pixiApp) { try { pixiApp.destroy(); } catch { /**/ } pixiApp = null; }
    mapViewer = null;
    graphPanel = null;
    latestMatchState = null;
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  renderSetup();
}
