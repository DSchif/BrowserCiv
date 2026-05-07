import { renderLobby, type LobbyResult } from "./ui/lobby.js";
import { renderMatch } from "./ui/match.js";
import { renderSim } from "./ui/sim.js";

const root = document.getElementById("app-root") as HTMLElement;

function showLobby(): void {
  renderLobby(root, (res: LobbyResult) => {
    showMatch(res);
  }, () => {
    import("./ui/sim.js").then(({ renderSim }) => renderSim(root, () => showLobby())).catch(console.error);
  });
}

function showMatch(res: LobbyResult): void {
  renderMatch(
    root,
    {
      matchId: res.matchId,
      playerId: res.playerId,
      token: res.token,
      name: res.name,
    },
    () => showLobby(),
    (spectatorSession) => showSpectator(spectatorSession),
  );
}

function showSpectator(session: import("./ui/match.js").MatchSession): void {
  renderMatch(root, session, () => showLobby());
}

// Allow direct spectator entry via ?spectateMatch=ID&token=TOKEN[&agentId=ID]
const params = new URLSearchParams(window.location.search);
const directMatchId = params.get("spectateMatch");
const directToken = params.get("token");
const directAgentId = params.get("agentId") ?? undefined;
const simMode = params.get("sim");

if (simMode !== null) {
  renderSim(root, () => showLobby());
} else if (directMatchId && directToken) {
  renderMatch(
    root,
    { matchId: directMatchId, playerId: "", token: directToken, name: "Spectator", spectator: true, agentId: directAgentId },
    () => showLobby(),
  );
} else {
  showLobby();
}
