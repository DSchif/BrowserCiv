interface AdminUser {
  userId: string;
  username: string;
  isAdmin?: boolean;
  createdAt: string;
}

interface AdminMatch {
  id: string;
  status: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  mapSize: string;
  createdAt: string;
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("browserciv_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeader(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function renderAdmin(root: HTMLElement, onBack: () => void): void {
  root.innerHTML = `
    <div class="admin-page">
      <div class="admin-header">
        <h1>Admin</h1>
        <button id="admin-back" class="btn-link">← Back to lobby</button>
      </div>
      <div class="admin-tabs">
        <button class="admin-tab active" data-tab="matches">Matches</button>
        <button class="admin-tab" data-tab="users">Users</button>
      </div>
      <div id="admin-err" class="error" style="margin:8px 0"></div>
      <div id="admin-tab-matches" class="admin-tab-panel">
        <div class="dim" style="padding:12px 0">Loading…</div>
      </div>
      <div id="admin-tab-users" class="admin-tab-panel" style="display:none">
        <div class="dim" style="padding:12px 0">Loading…</div>
      </div>
    </div>
  `;

  root.querySelector("#admin-back")!.addEventListener("click", onBack);

  const tabs = root.querySelectorAll<HTMLButtonElement>(".admin-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      root.querySelectorAll<HTMLDivElement>(".admin-tab-panel").forEach((p) => {
        p.style.display = "none";
      });
      root.querySelector<HTMLDivElement>(`#admin-tab-${tab.dataset.tab}`)!.style.display = "";
    });
  });

  void loadMatches();
  void loadUsers();

  const errEl = root.querySelector<HTMLDivElement>("#admin-err")!;
  function setErr(msg: string): void { errEl.textContent = msg; }

  async function loadMatches(): Promise<void> {
    const panel = root.querySelector<HTMLDivElement>("#admin-tab-matches")!;
    try {
      const { matches } = await apiFetch<{ matches: AdminMatch[] }>("/admin/matches");
      if (matches.length === 0) {
        panel.innerHTML = `<p class="dim">No active matches.</p>`;
        return;
      }
      panel.innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th>ID</th><th>Status</th><th>Host</th><th>Players</th><th>Map</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>
            ${matches.map((m) => `
              <tr>
                <td><code>${m.id}</code></td>
                <td><span class="admin-status-${m.status}">${m.status}</span></td>
                <td>${escapeHtml(m.hostName)}</td>
                <td>${m.playerCount}/${m.maxPlayers}</td>
                <td>${m.mapSize}</td>
                <td class="dim">${new Date(m.createdAt).toLocaleString()}</td>
                <td><button class="admin-del-match btn-danger" data-id="${m.id}">Delete</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      `;
      panel.querySelectorAll<HTMLButtonElement>(".admin-del-match").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(`Delete match ${btn.dataset.id}?`)) return;
          try {
            await apiFetch(`/admin/matches/${btn.dataset.id}`, { method: "DELETE" });
            void loadMatches();
          } catch (e) { setErr((e as Error).message); }
        });
      });
    } catch (e) {
      panel.innerHTML = `<p class="error">${(e as Error).message}</p>`;
    }
  }

  async function loadUsers(): Promise<void> {
    const panel = root.querySelector<HTMLDivElement>("#admin-tab-users")!;
    try {
      const { users } = await apiFetch<{ users: AdminUser[] }>("/admin/users");
      panel.innerHTML = `
        <table class="admin-table">
          <thead><tr>
            <th>Username</th><th>Admin</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td>${escapeHtml(u.username)}</td>
                <td>${u.isAdmin ? '<span class="admin-badge">Admin</span>' : '<span class="dim">—</span>'}</td>
                <td class="dim">${new Date(u.createdAt).toLocaleString()}</td>
                <td>
                  <button class="admin-toggle-admin" data-username="${escapeHtml(u.username)}" data-current="${u.isAdmin ? "1" : "0"}">
                    ${u.isAdmin ? "Revoke admin" : "Make admin"}
                  </button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      `;
      panel.querySelectorAll<HTMLButtonElement>(".admin-toggle-admin").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const username = btn.dataset.username!;
          const newVal = btn.dataset.current !== "1";
          try {
            await apiFetch(`/admin/users/${encodeURIComponent(username)}/set-admin`, {
              method: "POST",
              body: JSON.stringify({ isAdmin: newVal }),
            });
            void loadUsers();
          } catch (e) { setErr((e as Error).message); }
        });
      });
    } catch (e) {
      panel.innerHTML = `<p class="error">${(e as Error).message}</p>`;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
