let users = [];
let complianceUsers = [];
let accounts = [];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, type = "") {
  const el = document.getElementById("statusMessage");
  el.textContent = message || "";
  el.className = `status-message ${type}`.trim();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await res.json().catch(() => ({
    ok: false,
    error: "Respuesta no válida."
  }));

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }

  return data;
}

function mergeMembers() {
  const map = new Map();

  for (const user of users) {
    map.set(user.user_id, {
      user_id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      total: user.total || 0
    });
  }

  for (const user of complianceUsers) {
    if (!map.has(user.user_id)) {
      map.set(user.user_id, {
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
        total: user.week_count || 0
      });
    }
  }

  return [...map.values()].sort((a, b) =>
    (a.display_name || a.username || "").localeCompare(b.display_name || b.username || "")
  );
}

function fillMemberSelect() {
  const select = document.getElementById("memberSelect");
  select.innerHTML = `<option value="">Selecciona usuario</option>`;

  for (const user of mergeMembers()) {
    const option = document.createElement("option");
    option.value = user.user_id;
    option.textContent = `${user.display_name || user.username || user.user_id} · ${user.user_id}`;
    select.appendChild(option);
  }
}

function renderAccounts() {
  const box = document.getElementById("accountsList");

  if (!accounts.length) {
    box.innerHTML = `<div class="empty-box">No hay cuentas creadas todavía.</div>`;
    return;
  }

  box.innerHTML = "";

  for (const account of accounts) {
    const div = document.createElement("div");
    div.className = "review-item";

    div.innerHTML = `
      <div>
        <strong>${escapeHtml(account.display_name || account.discord_username || account.discord_user_id)}</strong>
        <span>ID: ${escapeHtml(account.discord_user_id)} · Usuario web: ${escapeHtml(account.web_username || "sin cuenta")}</span>
      </div>

      <div class="review-actions">
        <span class="badge ${Number(account.active) === 1 ? "badge-ok" : ""}">
          ${Number(account.active) === 1 ? "Activo" : "Sin acceso"}
        </span>
      </div>
    `;

    box.appendChild(div);
  }
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let text = "";

  for (let i = 0; i < 10; i++) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  document.getElementById("plainPassword").value = text;
}

async function load() {
  const dashboard = await fetchJson("/api/dashboard");
  users = dashboard.users || [];

  try {
    const compliance = await fetchJson("/api/compliance");
    complianceUsers = compliance.compliance?.users || [];
  } catch (_) {
    complianceUsers = [];
  }

  const accountData = await fetchJson("/api/member-accounts");
  accounts = accountData.accounts || [];

  fillMemberSelect();
  renderAccounts();
}

function bindEvents() {
  document.getElementById("memberSelect").addEventListener("change", () => {
    const userId = document.getElementById("memberSelect").value;
    const user = mergeMembers().find(u => u.user_id === userId);

    if (!user) return;

    document.getElementById("discordUserId").value = user.user_id;
    document.getElementById("webUsername").value =
      (user.username || user.display_name || user.user_id)
        .toLowerCase()
        .replaceAll(" ", "_");
  });

  document.getElementById("generatePassword").addEventListener("click", generatePassword);

  document.getElementById("saveAccount").addEventListener("click", async () => {
    try {
      const body = {
        discordUserId: document.getElementById("discordUserId").value,
        webUsername: document.getElementById("webUsername").value,
        plainPassword: document.getElementById("plainPassword").value,
        active: document.getElementById("active").value === "1",
        notify: document.getElementById("notify").value === "1"
      };

      await fetchJson("/api/member-accounts", {
        method: "POST",
        body: JSON.stringify(body)
      });

      setStatus("Cuenta guardada correctamente.", "ok");

      document.getElementById("plainPassword").value = "";

      await load();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

(async function init() {
  bindEvents();

  try {
    await load();
  } catch (error) {
    setStatus(error.message, "error");
  }
})();
