import type { MatchSummary } from "@browserciv/shared";
import { createMatch, joinMatch, listMatches } from "../net/rest.js";

export interface LobbyResult {
  matchId: string;
  playerId: string;
  token: string;
  name: string;
}

export function renderLobby(root: HTMLElement, onPicked: (r: LobbyResult) => void, onSim?: () => void): void {
  root.innerHTML = `
    <div class="lobby">
      <h1>BrowserCiv — Lobby</h1>
      <p class="dim">Your civilization (and its colors) is auto-assigned when you join.</p>
      <div class="row">
        <label>Name <input id="name" maxlength="40" value="Player ${Math.floor(Math.random()*1000)}" /></label>
        <label>Map size
          <select id="size">
            <option value="small" selected>Small (32×20)</option>
            <option value="medium">Medium (48×32)</option>
            <option value="large">Large (64×40)</option>
          </select>
        </label>
      </div>
      <div class="row">
        <button id="create">Create match</button>
        <button id="refresh">Refresh list</button>
        ${onSim ? `<button id="sim-btn" style="margin-left:auto">🤖 Simulation</button>` : ""}
      </div>
      <h2>Open matches</h2>
      <ul id="matches"><li class="dim">Loading…</li></ul>
      <div class="error" id="err"></div>
    </div>
  `;

  const nameEl = root.querySelector<HTMLInputElement>("#name")!;
  const sizeEl = root.querySelector<HTMLSelectElement>("#size")!;
  const createBtn = root.querySelector<HTMLButtonElement>("#create")!;
  const refreshBtn = root.querySelector<HTMLButtonElement>("#refresh")!;
  const list = root.querySelector<HTMLUListElement>("#matches")!;
  const err = root.querySelector<HTMLDivElement>("#err")!;

  function setError(msg: string): void {
    err.textContent = msg;
  }

  async function refresh(): Promise<void> {
    setError("");
    try {
      const matches = await listMatches();
      renderList(matches);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function renderList(matches: MatchSummary[]): void {
    if (matches.length === 0) {
      list.innerHTML = `<li class="dim">No open matches. Create one above.</li>`;
      return;
    }
    list.innerHTML = matches
      .map(
        (m) => `
        <li>
          <code>${m.id}</code> — host <strong>${escape(m.hostName)}</strong> —
          ${m.playerCount}/${m.maxPlayers} players
          <button data-id="${m.id}" class="join">Join</button>
        </li>`,
      )
      .join("");
    list.querySelectorAll<HTMLButtonElement>("button.join").forEach((btn) => {
      btn.addEventListener("click", async () => {
        setError("");
        try {
          const res = await joinMatch(btn.dataset.id!, { name: nameEl.value });
          onPicked({
            matchId: res.match.id,
            playerId: res.credential.playerId,
            token: res.credential.token,
            name: nameEl.value,
          });
        } catch (e) {
          setError((e as Error).message);
        }
      });
    });
  }

  createBtn.addEventListener("click", async () => {
    setError("");
    try {
      const res = await createMatch({
        hostName: nameEl.value,
        mapSize: sizeEl.value as "small" | "medium" | "large",
        maxPlayers: 4,
      });
      onPicked({
        matchId: res.match.id,
        playerId: res.credential.playerId,
        token: res.credential.token,
        name: nameEl.value,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  if (onSim) {
    root.querySelector<HTMLButtonElement>("#sim-btn")?.addEventListener("click", onSim);
  }
  refreshBtn.addEventListener("click", () => void refresh());
  void refresh();
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
