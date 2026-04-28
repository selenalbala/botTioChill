let users = [];
let complianceUsers = [];
let accounts = [];
let complianceDebug = null;

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

  if (!el) return;

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
    if (!user?.user_id) continue;

    map.set(user.user_id, {
      user_id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      total: Number(user.total || 0),
      source: "database"
    });
  }

  for (const user of complianceUsers) {
    if (!user?.user_id) continue;

    if (!map.has(user.user_id)) {
      map.set(user.user_id, {
        user_id: user.user_id,
        username: user.username,
        display_name: user.display_name,
        total: Number(user.week_count || 0),
        source: "discord"
      });
    } else {
      const existing = map.get(user.user_id);

      map.set(user.user_id, {
        ...existing,
        username: existing.username || user.username,
        display_name: existing.display_name || user.display_name,
        source: "database_discord"
      });
    }
  }

  return [...map.values()].sort((a, b) =>
    String(a.display_name || a.username || "").localeCompare(
      String(b.display_name || b.username || "")
    )
  );
}

function fillMemberSelect() {
  const select = document.getElementById("memberSelect");

  select.innerHTML = `<option value="">Selecciona usuario</option>`;

  const members = mergeMembers();

  for (const user of members) {
    const option = document.createElement("option");

    option.value = user.user_id;
    option.textContent = `${user.display_name || user.username || user.user_id} · ${user.user_id}`;

    select.appendChild(option);
  }

  if (!members.length) {
    const option = document.createElement("option");

    option.value = "";
    option.textContent = "No se encontraron miembros con roles permitidos";

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

function buildUsernameFromMember(user) {
  return String(user.username || user.display_name || user.user_id || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace(/[^\w.-]/g, "");
}

function renderLoadSummary() {
  const members = mergeMembers();

  if (complianceDebug) {
    setStatus(
      `Miembros cargados: ${members.length}. Humanos en servidor: ${complianceDebug.total_human_members}. Con roles permitidos: ${complianceDebug.total_allowed_members}.`,
      "ok"
    );
  } else {
    setStatus(`Miembros cargados: ${members.length}.`, "ok");
  }
}

async function load() {
  setStatus("Cargando miembros...", "");

  const dashboard = await fetchJson("/api/dashboard");
  users = dashboard.users || [];

  try {
    const compliance = await fetchJson("/api/compliance");

    complianceUsers = compliance.compliance?.users || [];
    complianceDebug = compliance.compliance?.debug || null;
  } catch (error) {
    complianceUsers = [];
    complianceDebug = null;

    console.error("Error cargando miembros del servidor:", error);

    setStatus(
      "No se pudieron cargar todos los miembros del servidor. Revisa SERVER MEMBERS INTENT, GUILD_ID y los roles permitidos.",
      "error"
    );
  }

  const accountData = await fetchJson("/api/member-accounts");
  accounts = accountData.accounts || [];

  fillMemberSelect();
  renderAccounts();

  if (complianceUsers.length) {
    renderLoadSummary();
  }
}

function bindEvents() {
  document.getElementById("memberSelect").addEventListener("change", () => {
    const userId = document.getElementById("memberSelect").value;
    const user = mergeMembers().find(u => u.user_id === userId);

    if (!user) return;

    document.getElementById("discordUserId").value = user.user_id;
    document.getElementById("webUsername").value = buildUsernameFromMember(user);
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
