let allRows = [];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, type = "") {
  const element = document.getElementById("statusMessage");
  if (!element) return;

  element.textContent = message || "";
  element.className = `status-message ${type}`.trim();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = { ok: false, error: "Respuesta no válida del servidor." };
  }

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }

  return data;
}

function formatTopItem(item, index) {
  return `
    <div class="top-rank">${index + 1}</div>
    <div>
      <div class="top-name">${escapeHtml(item.display_name || item.username)}</div>
      <div class="top-meta">${escapeHtml(item.username || item.user_id || "")}</div>
    </div>
    <div class="top-score">${escapeHtml(item.total)}</div>
  `;
}

async function loadDashboard() {
  const data = await fetchJson("/api/dashboard");

  document.getElementById("statTotal").textContent = data.stats.total;
  document.getElementById("statUsers").textContent = data.stats.usuarios;
  document.getElementById("statHoy").textContent = data.stats.hoy;
  document.getElementById("statMes").textContent = data.stats.mes;

  const userSelect = document.getElementById("user_id");
  const adjustUserSelect = document.getElementById("adjust_user_id");

  const currentUserFilter = userSelect.value;
  const currentAdjustUser = adjustUserSelect.value;

  userSelect.innerHTML = `<option value="">Todos los usuarios</option>`;
  adjustUserSelect.innerHTML = `<option value="">Selecciona usuario</option>`;

  for (const user of data.users) {
    const label = `${user.display_name || user.username} · total ${user.total} · ${user.user_id}`;

    const option1 = document.createElement("option");
    option1.value = user.user_id;
    option1.textContent = label;
    userSelect.appendChild(option1);

    const option2 = document.createElement("option");
    option2.value = user.user_id;
    option2.textContent = label;
    adjustUserSelect.appendChild(option2);
  }

  userSelect.value = currentUserFilter;
  adjustUserSelect.value = currentAdjustUser;

  const topContainer = document.getElementById("topUsers");
  topContainer.innerHTML = "";

  if (!data.top.length) {
    topContainer.innerHTML = `<div class="top-item"><div class="top-name">Sin actividad todavía</div></div>`;
  } else {
    data.top.forEach((item, index) => {
      const div = document.createElement("div");
      div.className = "top-item";
      div.innerHTML = formatTopItem(item, index);
      topContainer.appendChild(div);
    });
  }

  const dbPath = document.getElementById("dbPath");
  if (dbPath && data.dbPath) {
    dbPath.textContent = `DB: ${data.dbPath}`;
  }
}

function getFilters() {
  return {
    user_id: document.getElementById("user_id").value,
    anio: document.getElementById("anio").value,
    mes: document.getElementById("mes").value,
    semana: document.getElementById("semana").value,
    desde: document.getElementById("desde").value,
    hasta: document.getElementById("hasta").value
  };
}

function filtersToQuery(filters) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") params.append(key, value);
  }

  return params.toString();
}

function createTextCell(content) {
  const td = document.createElement("td");
  if (content instanceof HTMLElement) {
    td.appendChild(content);
  } else {
    td.textContent = content ?? "";
  }
  return td;
}

function createCompositeCell(main, sub = "") {
  const wrapper = document.createElement("div");

  const mainEl = document.createElement("span");
  mainEl.className = "cell-main";
  mainEl.textContent = main ?? "";
  wrapper.appendChild(mainEl);

  if (sub) {
    const subEl = document.createElement("span");
    subEl.className = "cell-sub";
    subEl.textContent = sub;
    wrapper.appendChild(subEl);
  }

  return createTextCell(wrapper);
}

function createChannelCell(row) {
  const isAdjustment = row.channel_id === "panel-web-ajuste" || Number(row.conteo) < 0;
  const tag = document.createElement("span");
  tag.className = `tag ${isAdjustment ? "adjust" : ""}`.trim();
  tag.textContent = isAdjustment ? "Ajuste manual" : row.channel_id;
  return createTextCell(tag);
}

function createConteoCell(row) {
  const td = document.createElement("td");

  const wrap = document.createElement("div");
  wrap.className = "conteo-wrap";

  const input = document.createElement("input");
  input.type = "number";
  input.step = "1";
  input.className = "conteo-input";
  input.value = row.conteo;
  input.dataset.id = row.id;

  const preview = document.createElement("span");
  preview.className = `conteo-preview ${Number(row.conteo) < 0 ? "negative" : ""}`.trim();
  preview.textContent = Number(row.conteo) < 0 ? "Ajuste negativo" : "Conteo";

  wrap.appendChild(input);
  wrap.appendChild(preview);
  td.appendChild(wrap);
  return td;
}

function createActionsCell(row) {
  const td = document.createElement("td");
  td.className = "actions-cell";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "small";
  saveBtn.textContent = "Guardar";
  saveBtn.addEventListener("click", async () => {
    const input = document.querySelector(`.conteo-input[data-id="${row.id}"]`);
    const conteo = Number(input.value);

    if (!Number.isInteger(conteo)) {
      setStatus("El conteo debe ser un número entero.", "error");
      return;
    }

    saveBtn.disabled = true;
    try {
      await fetchJson(`/api/tiradas/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ conteo })
      });
      setStatus(`Registro #${row.id} actualizado.`, "ok");
      await refreshAll(false);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "small danger";
  deleteBtn.textContent = "Eliminar";
  deleteBtn.addEventListener("click", async () => {
    const ok = confirm(`¿Eliminar la tirada #${row.id}? Esta acción no se puede deshacer.`);
    if (!ok) return;

    deleteBtn.disabled = true;
    try {
      await fetchJson(`/api/tiradas/${row.id}`, { method: "DELETE" });
      setStatus(`Registro #${row.id} eliminado.`, "ok");
      await refreshAll(false);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      deleteBtn.disabled = false;
    }
  });

  td.appendChild(saveBtn);
  td.appendChild(deleteBtn);
  return td;
}

function renderTableRows(rows) {
  const tbody = document.getElementById("tbodyRows");
  tbody.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");
    const isAdjustment = row.channel_id === "panel-web-ajuste" || Number(row.conteo) < 0;
    if (isAdjustment) tr.classList.add("row-adjustment");

    tr.appendChild(createTextCell(row.id));
    tr.appendChild(createCompositeCell(row.fecha_local, isAdjustment ? "Ajuste manual" : "Registro"));
    tr.appendChild(createCompositeCell(row.display_name, row.user_id));
    tr.appendChild(createTextCell(row.username));
    tr.appendChild(createTextCell(row.user_id));
    tr.appendChild(createTextCell(row.anio));
    tr.appendChild(createTextCell(row.mes));
    tr.appendChild(createTextCell(row.semana_iso));
    tr.appendChild(createChannelCell(row));
    tr.appendChild(createConteoCell(row));
    tr.appendChild(createActionsCell(row));

    tbody.appendChild(tr);
  }
}

function applyLocalSearch() {
  const searchValue = document.getElementById("quickSearch").value.trim().toLowerCase();
  const filtered = !searchValue
    ? allRows
    : allRows.filter(row => {
        const haystack = [
          row.id,
          row.fecha_local,
          row.display_name,
          row.username,
          row.user_id,
          row.channel_id,
          row.anio,
          row.mes,
          row.semana_iso,
          row.conteo
        ].join(" ").toLowerCase();

        return haystack.includes(searchValue);
      });

  renderTableRows(filtered);
  document.getElementById("tableTotal").textContent =
    `${filtered.reduce((acc, row) => acc + Number(row.conteo || 0), 0)} tiradas`;
}

async function loadTable() {
  const filters = getFilters();
  const query = filtersToQuery(filters);
  const data = await fetchJson(`/api/tiradas?${query}`);
  allRows = data.rows || [];
  applyLocalSearch();
}

function clearFilters() {
  document.getElementById("user_id").value = "";
  document.getElementById("anio").value = "";
  document.getElementById("mes").value = "";
  document.getElementById("semana").value = "";
  document.getElementById("desde").value = "";
  document.getElementById("hasta").value = "";
}

function setDateValue(elementId, date) {
  document.getElementById(elementId).value = date.toISOString().slice(0, 10);
}

function applyPresetToday() {
  const today = new Date();
  setDateValue("desde", today);
  setDateValue("hasta", today);
  document.getElementById("anio").value = "";
  document.getElementById("mes").value = "";
  document.getElementById("semana").value = "";
}

function applyPresetWeek() {
  const today = new Date();
  const day = today.getDay() || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  setDateValue("desde", monday);
  setDateValue("hasta", sunday);
  document.getElementById("anio").value = "";
  document.getElementById("mes").value = "";
  document.getElementById("semana").value = "";
}

function applyPresetMonth() {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  setDateValue("desde", first);
  setDateValue("hasta", last);
  document.getElementById("anio").value = "";
  document.getElementById("mes").value = "";
  document.getElementById("semana").value = "";
}

async function refreshAll(clearMessage = true) {
  if (clearMessage) setStatus("");
  await loadDashboard();
  await loadTable();
}

async function handleApplyFilters() {
  try {
    await loadTable();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindUi() {
  document.getElementById("applyFilters").addEventListener("click", handleApplyFilters);

  document.getElementById("clearFilters").addEventListener("click", async () => {
    clearFilters();
    await handleApplyFilters();
  });

  document.getElementById("reloadAll").addEventListener("click", async () => {
    await refreshAll();
  });

  document.getElementById("exportExcel").addEventListener("click", () => {
    const filters = getFilters();
    const query = filtersToQuery(filters);
    window.location.href = `/api/export?${query}`;
  });

  document.getElementById("downloadDb").addEventListener("click", () => {
    window.location.href = "/api/download-db";
  });

  document.getElementById("setUserTotal").addEventListener("click", async () => {
    const userId = document.getElementById("adjust_user_id").value;
    const nuevoTotal = Number(document.getElementById("adjust_total").value);

    if (!userId) {
      setStatus("Selecciona un usuario para ajustar el total.", "error");
      return;
    }

    if (!Number.isInteger(nuevoTotal) || nuevoTotal < 0) {
      setStatus("El nuevo total debe ser un entero mayor o igual a 0.", "error");
      return;
    }

    try {
      const data = await fetchJson(`/api/users/${encodeURIComponent(userId)}/total`, {
        method: "POST",
        body: JSON.stringify({ total: nuevoTotal })
      });

      document.getElementById("adjust_total").value = "";
      setStatus(`Total ajustado. Antes: ${data.before}, ahora: ${data.after}, ajuste aplicado: ${data.delta}.`, "ok");
      await refreshAll(false);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  document.getElementById("quickSearch").addEventListener("input", applyLocalSearch);

  document.getElementById("presetToday").addEventListener("click", async () => {
    applyPresetToday();
    await handleApplyFilters();
  });

  document.getElementById("presetWeek").addEventListener("click", async () => {
    applyPresetWeek();
    await handleApplyFilters();
  });

  document.getElementById("presetMonth").addEventListener("click", async () => {
    applyPresetMonth();
    await handleApplyFilters();
  });

  document.getElementById("focusFilters").addEventListener("click", () => {
    document.getElementById("filtersCard").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.getElementById("focusCorrection").addEventListener("click", () => {
    document.getElementById("correctionCard").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

(async function init() {
  bindUi();

  try {
    await refreshAll();
  } catch (error) {
    setStatus(error.message, "error");
  }
})();
