import { loadSession, renderAuth, type AuthSession } from "./ui/auth.js";
import { renderLobby, type LobbyResult } from "./ui/lobby.js";
import { renderMatch } from "./ui/match.js";
import { renderAdmin } from "./ui/admin.js";

const root = document.getElementById("app-root") as HTMLElement;

function showAuth(): void {
  renderAuth(root, (session: AuthSession) => showLobby(session));
}

function showLobby(session?: AuthSession): void {
  const s = session ?? loadSession();
  if (!s) {
    showAuth();
    return;
  }

  renderLobby(root, (res: LobbyResult) => showMatch(res), {
    isGuest: s.isGuest,
    username: s.username,
    isAdmin: s.isAdmin,
    onSim: s.isGuest
      ? undefined
      : () => {
          import("./ui/sim.js")
            .then(({ renderSim }) => renderSim(root, () => showLobby()))
            .catch(console.error);
        },
    onAdmin: s.isAdmin
      ? () => renderAdmin(root, () => showLobby())
      : undefined,
    onSignOut: () => showAuth(),
  });
}

function showMatch(res: LobbyResult): void {
  renderMatch(
    root,
    { matchId: res.matchId, playerId: res.playerId, token: res.token, name: res.name },
    () => showLobby(),
    (spectatorSession) => showSpectator(spectatorSession),
  );
}

function showSpectator(session: import("./ui/match.js").MatchSession): void {
  renderMatch(root, session, () => showLobby());
}

// Direct spectator entry via ?spectateMatch=ID&token=TOKEN[&agentId=ID]
const params = new URLSearchParams(window.location.search);
const directMatchId = params.get("spectateMatch");
const directToken = params.get("token");
const directAgentId = params.get("agentId") ?? undefined;
const simMode = params.get("sim");

if (params.get("admin") !== null) {
  const s = loadSession();
  if (!s || s.isGuest || !s.isAdmin) {
    showAuth();
  } else {
    renderAdmin(root, () => showLobby());
  }
} else if (simMode !== null) {
  // Sim requires an authenticated (non-guest) session
  const s = loadSession();
  if (!s || s.isGuest) {
    showAuth();
  } else {
    import("./ui/sim.js")
      .then(({ renderSim }) => renderSim(root, () => showLobby()))
      .catch(console.error);
  }
} else if (directMatchId && directToken) {
  renderMatch(
    root,
    { matchId: directMatchId, playerId: "", token: directToken, name: "Spectator", spectator: true, agentId: directAgentId },
    () => showLobby(),
  );
} else {
  showLobby();
}
