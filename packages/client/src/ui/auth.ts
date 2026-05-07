export interface AuthSession {
  token: string;
  username: string;
  isGuest: boolean;
}

const TOKEN_KEY = "browserciv_token";
const USERNAME_KEY = "browserciv_username";

export function loadSession(): AuthSession | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const username = localStorage.getItem(USERNAME_KEY);
  if (!token || !username) return null;
  // Check JWT expiry without a library: decode the payload (middle segment).
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!)) as { exp?: number };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      clearSession();
      return null;
    }
  } catch {
    clearSession();
    return null;
  }
  return { token, username, isGuest: false };
}

export function saveSession(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USERNAME_KEY, username);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export function renderAuth(
  root: HTMLElement,
  onAuth: (session: AuthSession) => void,
): void {
  root.innerHTML = `
    <div class="lobby auth-page">
      <h1>BrowserCiv</h1>

      <div class="auth-tabs">
        <button class="auth-tab active" data-tab="login">Sign In</button>
        <button class="auth-tab" data-tab="register">Create Account</button>
      </div>

      <div id="tab-login" class="auth-form">
        <label>Email<input id="login-email" type="email" placeholder="you@example.com" /></label>
        <label>Password<input id="login-password" type="password" placeholder="••••••" /></label>
        <div class="error" id="login-err"></div>
        <button id="login-submit" class="btn-primary">Sign In</button>
      </div>

      <div id="tab-register" class="auth-form" style="display:none">
        <label>Username<input id="reg-username" maxlength="40" placeholder="CivilizationBuilder" /></label>
        <label>Email<input id="reg-email" type="email" placeholder="you@example.com" /></label>
        <label>Password<input id="reg-password" type="password" placeholder="6+ characters" /></label>
        <div class="error" id="reg-err"></div>
        <button id="reg-submit" class="btn-primary">Create Account</button>
      </div>

      <div class="auth-divider"><span>or</span></div>

      <button id="guest-btn" class="btn-secondary">▶ Play as Guest (vs Bot only)</button>
      <p class="dim" style="font-size:11px;margin-top:6px">
        Guests can try a single-player match. Sign in to play multiplayer or run simulations.
      </p>
    </div>
  `;

  // Tab switching
  const tabs = root.querySelectorAll<HTMLButtonElement>(".auth-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      root.querySelectorAll<HTMLDivElement>(".auth-form").forEach((f) => {
        (f as HTMLElement).style.display = "none";
      });
      const target = root.querySelector<HTMLDivElement>(`#tab-${tab.dataset.tab}`);
      if (target) target.style.display = "flex";
    });
  });

  // Sign In
  root.querySelector<HTMLButtonElement>("#login-submit")!.addEventListener("click", async () => {
    const email = root.querySelector<HTMLInputElement>("#login-email")!.value.trim();
    const password = root.querySelector<HTMLInputElement>("#login-password")!.value;
    const err = root.querySelector<HTMLDivElement>("#login-err")!;
    err.textContent = "";
    try {
      const res = await fetch("/account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { token?: string; username?: string; error?: string };
      if (!res.ok) {
        err.textContent = data.error === "INVALID_CREDENTIALS"
          ? "Incorrect email or password."
          : (data.error ?? "Login failed.");
        return;
      }
      saveSession(data.token!, data.username!);
      onAuth({ token: data.token!, username: data.username!, isGuest: false });
    } catch {
      err.textContent = "Network error — is the server running?";
    }
  });

  // Register
  root.querySelector<HTMLButtonElement>("#reg-submit")!.addEventListener("click", async () => {
    const username = root.querySelector<HTMLInputElement>("#reg-username")!.value.trim();
    const email = root.querySelector<HTMLInputElement>("#reg-email")!.value.trim();
    const password = root.querySelector<HTMLInputElement>("#reg-password")!.value;
    const err = root.querySelector<HTMLDivElement>("#reg-err")!;
    err.textContent = "";
    try {
      const res = await fetch("/account/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      });
      const data = (await res.json()) as { token?: string; username?: string; error?: string };
      if (!res.ok) {
        err.textContent =
          data.error === "EMAIL_TAKEN" ? "Email already in use." :
          data.error === "INVALID_EMAIL" ? "Enter a valid email address." :
          data.error === "PASSWORD_TOO_SHORT" ? "Password must be at least 6 characters." :
          data.error === "INVALID_USERNAME" ? "Username must be at least 2 characters." :
          (data.error ?? "Registration failed.");
        return;
      }
      saveSession(data.token!, data.username!);
      onAuth({ token: data.token!, username: data.username!, isGuest: false });
    } catch {
      err.textContent = "Network error — is the server running?";
    }
  });

  // Guest
  root.querySelector<HTMLButtonElement>("#guest-btn")!.addEventListener("click", () => {
    onAuth({ token: "", username: "Guest", isGuest: true });
  });

  // Allow Enter key to submit on focused form
  root.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const form = input.closest<HTMLDivElement>(".auth-form");
      form?.querySelector<HTMLButtonElement>("button")?.click();
    });
  });
}
