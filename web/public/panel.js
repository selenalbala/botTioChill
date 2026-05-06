let currentUser = null;
let calendar = null;
let selectedSalidaId = null;
let lastUsers = [];

const ROLE_NAMES = { member: "Miembro", staff: "Autorizado", boss: "Jefe" };
const VOTE_LABELS = { going: "✅ Va", not_going: "❌ No va", maybe: "❔ Dudoso" };

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function statusText(status) {
  if (status === "open") return "Abierta";
  if (status === "closed") return "Cerrada";
  if (status === "cancelled") return "Cancelada";
  return status || "-";
}

function setStatus(message, type = "") {
  const el = document.getElementById("statusMessage");
  if (!el) return;
  el.textContent = message || "";
  el.className = `status ${type}`.trim();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });

  const data = await res.json().catch(() => ({ ok: false, error: "Respuesta no válida." }));
  if (!res.ok || data.ok === false) {
    if (res.status === 401) {
      window.location.href = "/panel/login";
      return null;
    }
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }
  return data;
}

function isBoss() {
  return currentUser?.role === "boss";
}

function canStaff() {
  return Boolean(currentUser?.permissions?.canStaff || currentUser?.role === "boss" || currentUser?.role === "staff");
}

function showRoleSections() {
  document.querySelectorAll(".boss-only").forEach(el => {
    el.style.display = isBoss() ? "" : "none";
  });
  document.querySelectorAll(".staff-only").forEach(el => {
    el.style.display = canStaff() ? "" : "none";
  });
}

function setActiveTab(tabId) {
  if (tabId === "usersTab" && !isBoss()) tabId = "calendarTab";

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab").forEach(tab => {
    tab.classList.toggle("active", tab.id === tabId);
  });

  const titles = {
    calendarTab: ["Calendario de salidas", "Vista mensual tipo calendario."],
    salidasTab: ["Salidas", "Vota, comenta y revisa asistentes."],
    moneyTab: ["Meta y pagos", canStaff() ? "Control de excedentes y dinero limpio." : "Tu resumen personal de excedentes."],
    usersTab: ["Usuarios", "Crea usuarios, cambia roles y resetea contraseñas."]
  };

  const [title, subtitle] = titles[tabId] || titles.calendarTab;
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageSubtitle").textContent = subtitle;

  if (tabId === "calendarTab" && calendar) setTimeout(() => calendar.updateSize(), 50);
  if (tabId === "salidasTab") loadSalidasList().catch(error => setStatus(error.message, "error"));
  if (tabId === "moneyTab") loadBonus().catch(error => setStatus(error.message, "error"));
  if (tabId === "usersTab") loadUsers().catch(error => setStatus(error.message, "error"));
}

async function loadMe() {
  const data = await fetchJson("/api/panel/me");
  if (!data) return;
  currentUser = data.user;
  document.getElementById("currentDisplayName").textContent = currentUser.displayName || currentUser.username;
  document.getElementById("currentRole").textContent = canStaff() ? "Autorizado" : (ROLE_NAMES[currentUser.role] || currentUser.role);
  showRoleSections();
}

function initCalendar() {
  const el = document.getElementById("calendar");
  if (!el || !window.FullCalendar) return;

  calendar = new FullCalendar.Calendar(el, {
    locale: "es",
    initialView: "dayGridMonth",
    height: "auto",
    firstDay: 1,
    nowIndicator: true,
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,listWeek"
    },
    events(info, success, failure) {
      fetch(`/api/panel/salidas?format=calendar&start=${encodeURIComponent(info.startStr)}&end=${encodeURIComponent(info.endStr)}`)
        .then(res => res.json())
        .then(data => success(Array.isArray(data) ? data : []))
        .catch(failure);
    },
    eventClick(info) {
      selectedSalidaId = info.event.id;
      setActiveTab("salidasTab");
      loadSalidaDetail(selectedSalidaId).catch(error => setStatus(error.message, "error"));
    }
  });

  calendar.render();
}

async function loadSalidasList() {
  const data = await fetchJson("/api/panel/salidas");
  if (!data) return;

  const box = document.getElementById("salidasList");
  if (!data.salidas.length) {
    box.innerHTML = `<div class="muted-box">No hay salidas registradas todavía.</div>`;
    return;
  }

  box.innerHTML = data.salidas.map(salida => `
    <button class="list-item ${String(salida.status)}" data-salida-id="${salida.id}">
      <strong>${escapeHtml(salida.title)}</strong>
      <span>${escapeHtml(salida.location || "Sin lugar")} · ${formatDate(salida.startsAt)}</span>
      <em>${statusText(salida.status)}</em>
    </button>
  `).join("");

  box.querySelectorAll("[data-salida-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      selectedSalidaId = btn.dataset.salidaId;
      await loadSalidaDetail(selectedSalidaId);
      await loadSalidasList();
    });
  });
}

function renderVotes(votes) {
  const groups = { going: [], maybe: [], not_going: [] };
  for (const vote of votes || []) {
    if (groups[vote.status]) groups[vote.status].push(vote);
  }

  return Object.entries(groups).map(([status, items]) => `
    <div class="vote-group">
      <h4>${VOTE_LABELS[status]} ${items.length}</h4>
      ${items.length ? items.map(item => `
        <div class="mini-row">
          <strong>${escapeHtml(item.displayName || item.username)}</strong>
          <span>${escapeHtml(ROLE_NAMES[item.role] || item.role)}</span>
        </div>
      `).join("") : `<p class="muted">Sin respuestas</p>`}
    </div>
  `).join("");
}

function renderComments(comments) {
  if (!comments || !comments.length) return `<p class="muted">Sin comentarios todavía.</p>`;

  return comments.map(comment => {
    const canDelete = canStaff() || Number(comment.userId) === Number(currentUser.id);
    return `
      <div class="comment">
        <strong>${escapeHtml(comment.displayName || comment.username)}</strong>
        <span>${formatDate(comment.createdAt)}</span>
        <p>${escapeHtml(comment.comment)}</p>
        ${canDelete ? `<button class="btn-secondary small" data-delete-comment="${comment.id}">Borrar</button>` : ""}
      </div>
    `;
  }).join("");
}

async function loadSalidaDetail(id) {
  const data = await fetchJson(`/api/panel/salidas/${id}`);
  if (!data) return;

  const { salida, counts, votes, comments } = data;
  selectedSalidaId = salida.id;

  const detail = document.getElementById("salidaDetail");
  detail.className = "detail";
  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h3>${escapeHtml(salida.title)}</h3>
        <p>${escapeHtml(salida.description || "Sin descripción")}</p>
      </div>
      <span class="pill">${statusText(salida.status)}</span>
    </div>
    <div class="meta-line">📍 ${escapeHtml(salida.location || "Sin lugar")}</div>
    <div class="meta-line">🗓️ ${formatDate(salida.startsAt)}${salida.endsAt ? ` - ${formatDate(salida.endsAt)}` : ""}</div>
    <div class="meta-line">👤 ${escapeHtml(salida.creatorName || "Autorizado")}</div>

    <div class="vote-actions">
      <button data-vote="going">✅ Voy (${counts.going})</button>
      <button data-vote="not_going" class="danger-btn">❌ No voy (${counts.notGoing})</button>
      <button data-vote="maybe" class="btn-secondary">❔ Dudoso (${counts.maybe})</button>
      ${canStaff() ? `<button data-edit-salida class="btn-secondary">Editar salida</button>` : ""}
    </div>

    <div class="votes-grid">${renderVotes(votes)}</div>

    <h4>Comentarios</h4>
    <form id="commentForm" class="comment-form">
      <input id="commentInput" placeholder="Escribe un comentario..." required maxlength="1000" />
      <button type="submit">Comentar</button>
    </form>
    <div class="comments">${renderComments(comments)}</div>
  `;

  detail.querySelectorAll("[data-vote]").forEach(button => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson(`/api/panel/salidas/${salida.id}/vote`, {
          method: "POST",
          body: JSON.stringify({ status: button.dataset.vote })
        });
        setStatus("Voto guardado.", "ok");
        await loadSalidaDetail(salida.id);
        await loadSalidasList();
        calendar?.refetchEvents();
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  });

  const editButton = detail.querySelector("[data-edit-salida]");
  if (editButton) editButton.addEventListener("click", () => openEditSalidaDialog(salida));

  detail.querySelector("#commentForm").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("commentInput");
    try {
      await fetchJson(`/api/panel/salidas/${salida.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ comment: input.value })
      });
      input.value = "";
      setStatus("Comentario añadido.", "ok");
      await loadSalidaDetail(salida.id);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  detail.querySelectorAll("[data-delete-comment]").forEach(button => {
    button.addEventListener("click", async () => {
      if (!confirm("¿Borrar este comentario?")) return;
      try {
        await fetchJson(`/api/panel/comments/${button.dataset.deleteComment}`, { method: "DELETE" });
        setStatus("Comentario borrado.", "ok");
        await loadSalidaDetail(salida.id);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  });
}

function toDatetimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clearSalidaForm() {
  document.getElementById("salidaId").value = "";
  document.getElementById("salidaTitle").value = "";
  document.getElementById("salidaLocation").value = "";
  document.getElementById("salidaStartsAt").value = "";
  document.getElementById("salidaEndsAt").value = "";
  document.getElementById("salidaDescription").value = "";
  document.getElementById("salidaStatus").value = "open";
  document.getElementById("cancelSalidaBtn").style.display = "none";
  document.getElementById("salidaDialogTitle").textContent = "Crear salida";
}

function openCreateSalidaDialog() {
  clearSalidaForm();
  document.getElementById("salidaDialog").showModal();
}

function openEditSalidaDialog(salida) {
  document.getElementById("salidaId").value = salida.id;
  document.getElementById("salidaTitle").value = salida.title || "";
  document.getElementById("salidaLocation").value = salida.location || "";
  document.getElementById("salidaStartsAt").value = toDatetimeLocal(salida.startsAt);
  document.getElementById("salidaEndsAt").value = toDatetimeLocal(salida.endsAt);
  document.getElementById("salidaDescription").value = salida.description || "";
  document.getElementById("salidaStatus").value = salida.status || "open";
  document.getElementById("cancelSalidaBtn").style.display = "";
  document.getElementById("salidaDialogTitle").textContent = "Editar salida";
  document.getElementById("salidaDialog").showModal();
}

async function saveSalida(event) {
  event.preventDefault();
  const id = document.getElementById("salidaId").value;
  const payload = {
    title: document.getElementById("salidaTitle").value,
    location: document.getElementById("salidaLocation").value,
    startsAt: document.getElementById("salidaStartsAt").value,
    endsAt: document.getElementById("salidaEndsAt").value,
    description: document.getElementById("salidaDescription").value,
    status: document.getElementById("salidaStatus").value
  };

  try {
    const url = id ? `/api/panel/salidas/${id}` : "/api/panel/salidas";
    const method = id ? "PATCH" : "POST";
    const data = await fetchJson(url, { method, body: JSON.stringify(payload) });
    setStatus(id ? "Salida actualizada." : "Salida creada y avisada en Discord.", "ok");
    document.getElementById("salidaDialog").close();
    selectedSalidaId = data.salida.id;
    calendar?.refetchEvents();
    await loadSalidasList();
    await loadSalidaDetail(data.salida.id);
    setActiveTab("salidasTab");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function cancelSelectedSalida() {
  const id = document.getElementById("salidaId").value;
  if (!id) return;
  if (!confirm("¿Seguro que quieres cancelar esta salida?")) return;

  try {
    await fetchJson(`/api/panel/salidas/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "cancelled" })
    });
    setStatus("Salida cancelada.", "ok");
    document.getElementById("salidaDialog").close();
    calendar?.refetchEvents();
    await loadSalidasList();
    await loadSalidaDetail(id);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderDayBadges(days) {
  return `<div class="day-badges">${(days || []).map(day => `
    <span title="${escapeHtml(day.fecha)}" class="${day.total >= 2 ? "ok" : "bad"}">${day.total}</span>
  `).join("")}</div>`;
}

async function loadBonus() {
  const url = canStaff() ? "/api/panel/meta/bonus" : "/api/panel/meta/bonus/me";
  const data = await fetchJson(url);
  if (!data) return;

  document.getElementById("bonusMembers").textContent = data.totals.members;
  document.getElementById("bonusExtras").textContent = data.totals.extraTiradas;
  document.getElementById("bonusCleanTotal").textContent = formatMoney(data.totals.cleanTotal);
  document.getElementById("bonusCleanEach").textContent = formatMoney(data.moneyConfig.cleanPerTirada);
  document.getElementById("bonusTitle").textContent = canStaff() ? "Pagos por excedente" : "Tu pago por excedente";
  document.getElementById("bonusSubtitle").textContent = `Semana ${data.range.start} a ${data.range.end}. Obligación: ${data.dailyRequired}/día o ${data.weeklyRequired}/semana.`;

  if (canStaff()) {
    document.getElementById("grossPerTirada").value = data.moneyConfig.grossPerTirada;
    document.getElementById("cleanDiscountPercent").value = data.moneyConfig.cleanDiscountPercent;
  }

  const tbody = document.getElementById("bonusTable");
  if (!data.rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No hay miembros para mostrar.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.rows.map(row => `
    <tr>
      <td>
        <strong>${escapeHtml(row.displayName)}</strong>
        <span class="sub">${escapeHtml(row.username)} · ${escapeHtml(row.userId)}</span>
        ${renderDayBadges(row.days)}
      </td>
      <td><strong>${row.weekTotal}/${row.weeklyRequired}</strong><span class="sub ${row.weeklyOk ? "ok-text" : "bad-text"}">${row.weeklyOk ? "Cumple semanal" : "Pendiente semanal"}</span></td>
      <td>${row.extraByDaily}</td>
      <td>${row.extraByWeekly}</td>
      <td><strong>${row.extraTiradas}</strong></td>
      <td><strong>${formatMoney(row.cleanTotal)}</strong><span class="sub">${formatMoney(row.cleanPerTirada)} limpio/tirada</span></td>
      <td class="staff-only adjust-cell">
        <input type="number" min="0" step="1" value="${row.weekTotal}" data-week-total="${escapeHtml(row.userId)}" />
        <button class="small" data-save-week-total="${escapeHtml(row.userId)}">Guardar</button>
      </td>
    </tr>
  `).join("");

  showRoleSections();

  tbody.querySelectorAll("[data-save-week-total]").forEach(button => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.saveWeekTotal;
      const input = tbody.querySelector(`[data-week-total="${CSS.escape(userId)}"]`);
      try {
        await fetchJson(`/api/panel/meta/members/${encodeURIComponent(userId)}/week-total`, {
          method: "POST",
          body: JSON.stringify({ total: Number(input.value) })
        });
        setStatus("Tiradas semanales modificadas.", "ok");
        await loadBonus();
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  });
}

async function saveBonusConfig(event) {
  event.preventDefault();
  try {
    await fetchJson("/api/panel/meta/bonus-config", {
      method: "POST",
      body: JSON.stringify({
        grossPerTirada: Number(document.getElementById("grossPerTirada").value),
        cleanDiscountPercent: Number(document.getElementById("cleanDiscountPercent").value)
      })
    });
    setStatus("Configuración de dinero guardada.", "ok");
    await loadBonus();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function loadUsers() {
  if (!isBoss()) return;
  const data = await fetchJson("/api/panel/users");
  if (!data) return;

  lastUsers = data.users;
  const box = document.getElementById("usersTable");
  if (!data.users.length) {
    box.innerHTML = `<div class="muted-box">No hay usuarios.</div>`;
    return;
  }

  box.innerHTML = data.users.map(user => `
    <div class="user-row">
      <div>
        <strong>${escapeHtml(user.displayName)}</strong>
        <span>${escapeHtml(user.discordUserId || "sin Discord ID")} · ${escapeHtml(user.username)}</span>
      </div>
      <div><span class="pill">${escapeHtml(ROLE_NAMES[user.role] || user.role)}</span></div>
      <div>${user.active ? "Activo" : "Desactivado"}</div>
      <div class="row-actions">
        <button class="btn-secondary small" data-edit-user="${user.id}">Editar</button>
        <button class="btn-secondary small" data-reset-password="${user.id}">Contraseña</button>
      </div>
    </div>
  `).join("");

  box.querySelectorAll("[data-edit-user]").forEach(button => {
    button.addEventListener("click", () => {
      const user = lastUsers.find(item => Number(item.id) === Number(button.dataset.editUser));
      if (!user) return;
      document.getElementById("userId").value = user.id;
      document.getElementById("userUsername").value = user.username;
      document.getElementById("userDisplayName").value = user.displayName;
      document.getElementById("userDiscordId").value = user.discordUserId || "";
      document.getElementById("userRole").value = user.role;
      document.getElementById("userPassword").value = "";
      document.getElementById("userActive").checked = user.active;
      setStatus(`Editando a ${user.displayName}.`, "ok");
    });
  });

  box.querySelectorAll("[data-reset-password]").forEach(button => {
    button.addEventListener("click", async () => {
      const password = prompt("Nueva contraseña para este usuario:");
      if (!password) return;
      try {
        await fetchJson(`/api/panel/users/${button.dataset.resetPassword}/password`, {
          method: "POST",
          body: JSON.stringify({ password })
        });
        setStatus("Contraseña cambiada.", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  });
}

function clearUserForm() {
  document.getElementById("userId").value = "";
  document.getElementById("userUsername").value = "";
  document.getElementById("userDisplayName").value = "";
  document.getElementById("userDiscordId").value = "";
  document.getElementById("userRole").value = "member";
  document.getElementById("userPassword").value = "";
  document.getElementById("userActive").checked = true;
}

async function saveUser(event) {
  event.preventDefault();
  const id = document.getElementById("userId").value;
  const password = document.getElementById("userPassword").value;
  const payload = {
    username: document.getElementById("userUsername").value,
    displayName: document.getElementById("userDisplayName").value,
    discordUserId: document.getElementById("userDiscordId").value,
    role: document.getElementById("userRole").value,
    active: document.getElementById("userActive").checked
  };
  if (!id || password.trim()) payload.password = password;

  try {
    await fetchJson(id ? `/api/panel/users/${id}` : "/api/panel/users", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    if (id && password.trim()) {
      await fetchJson(`/api/panel/users/${id}/password`, {
        method: "POST",
        body: JSON.stringify({ password })
      });
    }
    setStatus(id ? "Usuario actualizado." : "Usuario creado.", "ok");
    clearUserForm();
    await loadUsers();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetchJson("/api/panel/logout", { method: "POST", body: JSON.stringify({}) });
    window.location.href = "/panel/login";
  });

  document.getElementById("openCreateSalidaBtn")?.addEventListener("click", openCreateSalidaDialog);
  document.getElementById("closeSalidaDialogBtn").addEventListener("click", () => document.getElementById("salidaDialog").close());
  document.getElementById("salidaForm").addEventListener("submit", saveSalida);
  document.getElementById("cancelSalidaBtn").addEventListener("click", cancelSelectedSalida);
  document.getElementById("refreshSalidasBtn").addEventListener("click", async () => {
    await loadSalidasList();
    calendar?.refetchEvents();
  });
  document.getElementById("refreshBonusBtn").addEventListener("click", loadBonus);
  document.getElementById("bonusConfigForm").addEventListener("submit", saveBonusConfig);
  document.getElementById("userForm").addEventListener("submit", saveUser);
  document.getElementById("clearUserFormBtn").addEventListener("click", clearUserForm);
  document.getElementById("refreshUsersBtn").addEventListener("click", loadUsers);
}

(async function init() {
  bindEvents();
  try {
    await loadMe();
    initCalendar();
    await loadSalidasList();
    await loadBonus();
    if (isBoss()) await loadUsers();
  } catch (error) {
    setStatus(error.message, "error");
  }
})();
