let usersCache = [];

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
    error: "Respuesta no válida del servidor."
  }));

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }

  return data;
}

function fillUserSelect(selectId, placeholder) {
  const select = document.getElementById(selectId);
  const oldValue = select.value;

  select.innerHTML = `<option value="">${placeholder}</option>`;

  for (const user of usersCache) {
    const option = document.createElement("option");
    option.value = user.user_id;
    option.textContent = `${user.display_name || user.username} · ${user.total} tiradas`;
    select.appendChild(option);
  }

  select.value = oldValue;
}

function getSelectedUser() {
  const userId = document.getElementById("quickUser").value;
  return usersCache.find(u => u.user_id === userId);
}

function refreshCurrentTotal() {
  const user = getSelectedUser();
  const currentTotal = document.getElementById("currentTotal");
  const newTotal = document.getElementById("newTotal");

  if (!user) {
    currentTotal.textContent = "-";
    newTotal.value = "";
    return;
  }

  currentTotal.textContent = user.total;
  newTotal.value = user.total;
}

async function setUserTotal(userId, total) {
  if (!userId) {
    setStatus("Selecciona un usuario.", "error");
    return;
  }

  if (!Number.isInteger(total) || total < 0) {
    setStatus("El total debe ser un número entero mayor o igual a 0.", "error");
    return;
  }

  const data = await fetchJson(`/api/users/${encodeURIComponent(userId)}/total`, {
    method: "POST",
    body: JSON.stringify({ total })
  });

  setStatus(`Total cambiado. Antes: ${data.before}, ahora: ${data.after}.`, "ok");
  await refreshAll(false);
}

async function loadDashboard() {
  const data = await fetchJson("/api/dashboard");

  document.getElementById("statTotal").textContent = data.stats.total;
  document.getElementById("statUsers").textContent = data.stats.usuarios;
  document.getElementById("statHoy").textContent = data.stats.hoy;
  document.getElementById("statMes").textContent = data.stats.mes;

  usersCache = data.users || [];

  fillUserSelect("quickUser", "Selecciona usuario");
  fillUserSelect("filterUser", "Todos los usuarios");

  refreshCurrentTotal();

  const top = document.getElementById("topUsers");
  top.innerHTML = "";

  if (!data.top.length) {
    top.innerHTML = `<div class="top-item">Sin tiradas todavía</div>`;
    return;
  }

  data.top.forEach((user, index) => {
    const div = document.createElement("div");
    div.className = "top-item";
    div.innerHTML = `
      <div class="top-rank">${index + 1}</div>
      <div>
        <div class="top-name">${escapeHtml(user.display_name || user.username)}</div>
        <div class="top-user">${escapeHtml(user.username || user.user_id)}</div>
      </div>
      <div class="top-total">${escapeHtml(user.total)}</div>
    `;
    top.appendChild(div);
  });
}

function getFilters() {
  return {
    user_id: document.getElementById("filterUser").value,
    desde: document.getElementById("filterDesde").value,
    hasta: document.getElementById("filterHasta").value
  };
}

function filtersToQuery(filters) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) params.append(key, value);
  }

  return params.toString();
}

async function loadTable() {
  const query = filtersToQuery(getFilters());
  const data = await fetchJson(`/api/tiradas?${query}`);

  document.getElementById("tableTotal").textContent = `${data.total} tiradas`;

  const tbody = document.getElementById("tbodyRows");
  tbody.innerHTML = "";

  for (const row of data.rows) {
    const tr = document.createElement("tr");

    const isAdjustment = row.channel_id === "panel-web-ajuste";
    const canal = isAdjustment
      ? `<span class="channel-adjust">Ajuste manual</span>`
      : escapeHtml(row.channel_id);

    tr.innerHTML = `
      <td>${escapeHtml(row.fecha_local)}</td>
      <td>${escapeHtml(row.display_name)}</td>
      <td>${escapeHtml(row.username)}</td>
      <td>${canal}</td>
      <td><strong>${escapeHtml(row.conteo)}</strong></td>
    `;

    tbody.appendChild(tr);
  }
}

async function refreshAll(clearMessage = true) {
  if (clearMessage) setStatus("");
  await loadDashboard();
  await loadTable();
}

function setDate(id, date) {
  document.getElementById(id).value = date.toISOString().slice(0, 10);
}

function setTodayFilter() {
  const today = new Date();
  setDate("filterDesde", today);
  setDate("filterHasta", today);
}

function setWeekFilter() {
  const today = new Date();
  const day = today.getDay() || 7;

  const monday = new Date(today);
  monday.setDate(today.getDate() - day + 1);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  setDate("filterDesde", monday);
  setDate("filterHasta", sunday);
}

function setMonthFilter() {
  const today = new Date();

  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  setDate("filterDesde", first);
  setDate("filterHasta", last);
}

function bindEvents() {
  document.getElementById("quickUser").addEventListener("change", refreshCurrentTotal);

  document.getElementById("saveTotal").addEventListener("click", async () => {
    try {
      const userId = document.getElementById("quickUser").value;
      const total = Number(document.getElementById("newTotal").value);
      await setUserTotal(userId, total);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("plusOne").addEventListener("click", async () => {
    try {
      const user = getSelectedUser();
      if (!user) {
        setStatus("Selecciona un usuario.", "error");
        return;
      }

      await setUserTotal(user.user_id, Number(user.total) + 1);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("minusOne").addEventListener("click", async () => {
    try {
      const user = getSelectedUser();
      if (!user) {
        setStatus("Selecciona un usuario.", "error");
        return;
      }

      await setUserTotal(user.user_id, Math.max(0, Number(user.total) - 1));
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("applyFilters").addEventListener("click", async () => {
    try {
      await loadTable();
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("filterUser").addEventListener("change", loadTable);
  document.getElementById("filterDesde").addEventListener("change", loadTable);
  document.getElementById("filterHasta").addEventListener("change", loadTable);

  document.getElementById("clearFilters").addEventListener("click", async () => {
    document.getElementById("filterUser").value = "";
    document.getElementById("filterDesde").value = "";
    document.getElementById("filterHasta").value = "";
    await loadTable();
  });

  document.getElementById("filterToday").addEventListener("click", async () => {
    setTodayFilter();
    await loadTable();
  });

  document.getElementById("filterWeek").addEventListener("click", async () => {
    setWeekFilter();
    await loadTable();
  });

  document.getElementById("filterMonth").addEventListener("click", async () => {
    setMonthFilter();
    await loadTable();
  });

  document.getElementById("exportExcel").addEventListener("click", () => {
    const query = filtersToQuery(getFilters());
    window.location.href = `/api/export?${query}`;
  });

  document.getElementById("downloadDb").addEventListener("click", () => {
    window.location.href = "/api/download-db";
  });
}

(async function init() {
  bindEvents();

  try {
    await refreshAll();
  } catch (error) {
    setStatus(error.message, "error");
  }
})();
