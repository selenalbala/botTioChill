let nextTiradaInterval = null;
let nextTiradaUnix = null;

function setStatus(message, type = "") {
  const el = document.getElementById("statusMessage");
  el.textContent = message || "";
  el.className = `status-message ${type}`.trim();
}

async function fetchJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({
    ok: false,
    error: "Respuesta no válida."
  }));

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }

  return data;
}

function formatRemaining(ms) {
  if (ms <= 0) return "Disponible";

  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function startCountdown(info) {
  if (nextTiradaInterval) {
    clearInterval(nextTiradaInterval);
    nextTiradaInterval = null;
  }

  const next = document.getElementById("nextTirada");

  if (!info || info.available || !info.nextUnix) {
    next.textContent = "Disponible";
    nextTiradaUnix = null;
    return;
  }

  nextTiradaUnix = Number(info.nextUnix);

  function tick() {
    const remainingMs = nextTiradaUnix * 1000 - Date.now();
    next.textContent = formatRemaining(remainingMs);

    if (remainingMs <= 0) {
      clearInterval(nextTiradaInterval);
      nextTiradaInterval = null;
      next.textContent = "Disponible";
    }
  }

  tick();
  nextTiradaInterval = setInterval(tick, 1000);
}

function render(me) {
  document.getElementById("memberName").textContent = me.displayName || me.username;

  document.getElementById("total").textContent = me.total;
  document.getElementById("today").textContent = `${me.todayCount}/${me.dailyRequired}`;
  document.getElementById("week").textContent = `${me.weekCount}/${me.weeklyRequired}`;

  document.getElementById("pendingMeta").textContent = me.pendingMeta;
  document.getElementById("pendingTiradas").textContent = me.pendingTiradas;
  document.getElementById("pendingMetaBox").textContent = me.pendingMeta;

  const badge = document.getElementById("statusBadge");
  const ok = me.dailyOk && me.weeklyOk;

  badge.textContent = ok ? "Cumplido" : "Pendiente";
  badge.className = ok ? "badge badge-ok" : "badge";

  startCountdown(me.nextTirada);

  const lastUser = document.getElementById("lastUser");

  if (me.nextTirada?.available) {
    lastUser.textContent = "Ya se puede pulsar +1 tirada en el servidor.";
  } else {
    const date = new Date(me.nextTirada.nextUnix * 1000);
    const hora = date.toLocaleTimeString("es-ES", {
      hour: "2-digit",
      minute: "2-digit"
    });

    lastUser.textContent = `Siguiente tirada a las ${hora}. Última tirada: ${me.nextTirada.lastUser || "desconocido"}.`;
  }
}

async function load() {
  setStatus("");
  const data = await fetchJson("/api/mi-meta");
  render(data.me);
}

document.getElementById("refreshBtn").addEventListener("click", async () => {
  try {
    await load();
    setStatus("Actualizado.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

(async function init() {
  try {
    await load();
  } catch (error) {
    setStatus(error.message, "error");
  }
})();
