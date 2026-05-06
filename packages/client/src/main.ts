import { renderLobby, type LobbyResult } from "./ui/lobby.js";
import { renderMatch } from "./ui/match.js";

const root = document.getElementById("app-root") as HTMLElement;

function showLobby(): void {
  renderLobby(root, (res: LobbyResult) => {
    showMatch(res);
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

showLobby();
