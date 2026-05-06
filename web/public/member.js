let nextTiradaInterval = null;
let nextTiradaUnix = null;

function setStatus(message, type = "") {
  const el = document.getElementById("statusMessage");
  if (!el) return;
  el.textContent = message || "";
  el.className = `status-message ${type}`.trim();
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
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

function formatMoney(value) {
  const number = Number(value || 0);
  return `${number.toLocaleString("es-ES")} €`;
}

function startCountdown(info) {
  if (nextTiradaInterval) {
    clearInterval(nextTiradaInterval);
    nextTiradaInterval = null;
  }

  const next = document.getElementById("nextTirada");
  if (!next) return;

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
  setText("memberName", me.displayName || me.username);

  setText("total", me.total);
  setText("today", `${me.todayCount}/${me.dailyRequired}`);
  setText("week", `${me.weekCount}/${me.weeklyRequired}`);
  setText("weeklyMeta", me.weeklyMeta || 0);

  setText("extraTiradas", me.extraTiradas || 0);
  setText("cleanTotal", formatMoney(me.cleanTotal));
  setText("grossPerTirada", formatMoney(me.grossPerTirada));
  setText("cleanDiscountPercent", `${Number(me.cleanDiscountPercent || 0).toLocaleString("es-ES")}%`);
  setText("cleanPerTirada", formatMoney(me.cleanPerTirada));

  setText("pendingTiradas", me.pendingTiradas);
  setText("pendingMetaBox", me.pendingMeta);

  const badge = document.getElementById("statusBadge");
  const ok = me.dailyOk && me.weeklyOk;
  if (badge) {
    badge.textContent = ok ? "Cumplido" : "Pendiente";
    badge.className = ok ? "badge badge-ok" : "badge";
  }

  const moneyHelp = document.getElementById("moneyHelp");
  if (moneyHelp) {
    if (Number(me.extraTiradas || 0) > 0) {
      moneyHelp.textContent = `Esta semana tienes ${me.extraTiradas} tirada(s) de más. Te corresponde ${formatMoney(me.cleanTotal)} limpio.`;
    } else {
      moneyHelp.textContent = "Todavía no tienes tiradas de más esta semana. El dinero limpio aparece cuando superas 2 tiradas en un día o 14 tiradas semanales.";
    }
  }

  startCountdown(me.nextTirada);

  const lastUser = document.getElementById("lastUser");
  if (lastUser) {
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
}

async function load() {
  setStatus("");
  const data = await fetchJson("/api/mi-meta");
  render(data.me);
}

const refreshBtn = document.getElementById("refreshBtn");
if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    try {
      await load();
      setStatus("Actualizado.", "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

(async function init() {
  try {
    await load();
  } catch (error) {
    setStatus(error.message, "error");
  }
})();
