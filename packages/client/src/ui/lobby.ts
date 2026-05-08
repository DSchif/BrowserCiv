import type { MatchSummary } from "@browserciv/shared";
import { createMatch, createSoloMatch, joinMatch, listMatches } from "../net/rest.js";
import { clearSession } from "./auth.js";

export interface LobbyResult {
  matchId: string;
  playerId: string;
  token: string;
  name: string;
}

export function renderLobby(
  root: HTMLElement,
  onPicked: (r: LobbyResult) => void,
  opts: { isGuest?: boolean; username?: string; isAdmin?: boolean; onSim?: () => void; onAdmin?: () => void; onSignOut?: () => void } = {},
): void {
  const { isGuest = false, username = "", isAdmin = false, onSim, onAdmin, onSignOut } = opts;

  if (isGuest) {
    renderGuestLobby(root, onPicked);
    return;
  }

  root.innerHTML = `
    <div class="lobby">
      <div class="lobby-header">
        <h1>BrowserCiv</h1>
        <div class="lobby-user">
          <span class="dim">Signed in as <strong>${escapeHtml(username)}</strong></span>
          ${isAdmin ? `<button id="admin-btn" class="btn-link">Admin</button>` : ""}
          <button id="sign-out" class="btn-link">Sign out</button>
        </div>
      </div>
      <p class="dim">Your civilization (and its colors) is auto-assigned when you join.</p>
      <div class="row">
        <label>Name <input id="name" maxlength="40" value="${escapeHtml(username)}" /></label>
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

  function setError(msg: string): void { err.textContent = msg; }

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
          <code>${m.id}</code> — host <strong>${escapeHtml(m.hostName)}</strong>${m.createdByAccount ? ` <span class="dim">(${escapeHtml(m.createdByAccount)})</span>` : ""} —
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
          onPicked({ matchId: res.match.id, playerId: res.credential.playerId, token: res.credential.token, name: nameEl.value });
        } catch (e) {
          setError((e as Error).message);
        }
      });
    });
  }

  createBtn.addEventListener("click", async () => {
    setError("");
    try {
      const res = await createMatch({ hostName: nameEl.value, mapSize: sizeEl.value as "small" | "medium" | "large", maxPlayers: 4 });
      onPicked({ matchId: res.match.id, playerId: res.credential.playerId, token: res.credential.token, name: nameEl.value });
    } catch (e) {
      setError((e as Error).message);
    }
  });

  if (onSim) root.querySelector<HTMLButtonElement>("#sim-btn")?.addEventListener("click", onSim);
  if (onAdmin) root.querySelector<HTMLButtonElement>("#admin-btn")?.addEventListener("click", onAdmin);

  root.querySelector<HTMLButtonElement>("#sign-out")?.addEventListener("click", () => {
    clearSession();
    onSignOut?.();
  });

  refreshBtn.addEventListener("click", () => void refresh());
  void refresh();
}

function renderGuestLobby(root: HTMLElement, onPicked: (r: LobbyResult) => void): void {
  root.innerHTML = `
    <div class="lobby">
      <h1>BrowserCiv — Guest</h1>
      <p class="dim">Playing as guest. You can try a single-player match against a bot.</p>
      <p class="dim">
        <a href="#" id="sign-in-link">Sign in or create an account</a>
        to play multiplayer or run simulations.
      </p>
      <div class="row" style="margin-top:24px">
        <label>Your name <input id="name" maxlength="40" value="Guest ${Math.floor(Math.random() * 1000)}" /></label>
        <label>Map size
          <select id="size">
            <option value="small" selected>Small (32×20)</option>
            <option value="medium">Medium (48×32)</option>
            <option value="large">Large (64×40)</option>
          </select>
        </label>
        <label>Opponent
          <select id="strategy">
            <option value="greedy">Greedy bot</option>
            <option value="random">Random bot</option>
            <option value="passive">Passive bot</option>
          </select>
        </label>
      </div>
      <div class="row">
        <button id="play-solo" class="btn-primary">▶ Play vs Bot</button>
      </div>
      <div class="error" id="err"></div>
    </div>
  `;

  const nameEl = root.querySelector<HTMLInputElement>("#name")!;
  const sizeEl = root.querySelector<HTMLSelectElement>("#size")!;
  const strategyEl = root.querySelector<HTMLSelectElement>("#strategy")!;
  const err = root.querySelector<HTMLDivElement>("#err")!;

  root.querySelector<HTMLButtonElement>("#play-solo")!.addEventListener("click", async () => {
    err.textContent = "";
    try {
      const res = await createSoloMatch({
        playerName: nameEl.value.trim() || "Guest",
        mapSize: sizeEl.value as "small" | "medium" | "large",
        strategy: strategyEl.value,
      });
      onPicked({ matchId: res.match.id, playerId: res.credential.playerId, token: res.credential.token, name: nameEl.value });
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  });

  root.querySelector<HTMLAnchorElement>("#sign-in-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    // Reload to hit the auth gate again (user will be shown login page)
    window.location.reload();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
