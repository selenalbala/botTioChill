const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  META_POR_TIRADA,
  META_MAXIMA_PROCESO,
  TIRADAS_PARA_PROCESAR,
  META_PARA_EMPAQUETAR
} = require("../config");

const db = require("../db");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getLocalParts(date = new Date(), timeZone = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value ?? "0";

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

function getLocalDateText(date = new Date(), timeZone = TIMEZONE) {
  const local = getLocalParts(date, timeZone);

  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${local.hour}:${local.minute}:${local.second}`;
}

function getIsoWeekFromParts(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;

  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

  return Math.ceil((((d - yearStart) / MS_PER_DAY) + 1) / 7);
}

function getMetaState(channelId = TARGET_CHANNEL_ID) {
  const tiradasPendientes = db.getPendingTiradasCount(channelId);
  const metaActual = db.getPendingMetaTotal(channelId, META_POR_TIRADA);
  const metaRestante = Math.max(META_MAXIMA_PROCESO - metaActual, 0);
  const tiradasRestantes = Math.max(TIRADAS_PARA_PROCESAR - tiradasPendientes, 0);

  const metaProcesadaPendiente = db.getPendingProcessedMeta(channelId);
  const metaProcesadaRestante = Math.max(META_PARA_EMPAQUETAR - metaProcesadaPendiente, 0);

  return {
    metaPorTirada: META_POR_TIRADA,
    metaMaximaProceso: META_MAXIMA_PROCESO,
    tiradasParaProcesar: TIRADAS_PARA_PROCESAR,

    tiradasPendientes,
    metaActual,
    metaRestante,
    tiradasRestantes,

    // Los 448 son una guía/recomendación, no un bloqueo obligatorio.
    listoParaProcesar: metaActual >= META_MAXIMA_PROCESO,

    porUsuarios: db.getPendingTiradasByUser(channelId),

    metaParaEmpaquetar: META_PARA_EMPAQUETAR,
    metaProcesadaPendiente,
    metaProcesadaRestante,

    // Los 448 procesados son una guía/recomendación para empaquetar.
    listoParaEmpaquetar: metaProcesadaPendiente >= META_PARA_EMPAQUETAR,

    ultimosProcesos: db.getProcesos(5),
    ultimosEmpaquetados: db.getEmpaquetados(5)
  };
}

function buildMetaAdjustmentRow(deltaTiradas, actor = {}) {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);

  return {
    timestamp_utc: now.toISOString(),
    fecha_local: getLocalDateText(now, TIMEZONE),
    anio: local.year,
    mes: local.month,
    dia: local.day,
    semana_iso: getIsoWeekFromParts(local.year, local.month, local.day),

    guild_id: actor.guildId || process.env.GUILD_ID || "panel-web",
    channel_id: TARGET_CHANNEL_ID,

    user_id: "panel-web-meta-ajuste",
    username: actor.username || "panel-web-meta-ajuste",
    display_name: actor.displayName || "Ajuste manual de meta",

    conteo: deltaTiradas
  };
}

function setCurrentMeta(metaActual, actor = {}) {
  if (!Number.isInteger(metaActual) || metaActual < 0) {
    throw new Error("La meta actual debe ser un número entero mayor o igual a 0.");
  }

  if (metaActual % META_POR_TIRADA !== 0) {
    throw new Error(`La meta debe ser múltiplo de ${META_POR_TIRADA}.`);
  }

  const tiradasActuales = db.getPendingTiradasCount(TARGET_CHANNEL_ID);
  const tiradasDeseadas = metaActual / META_POR_TIRADA;
  const deltaTiradas = tiradasDeseadas - tiradasActuales;

  if (deltaTiradas !== 0) {
    db.insertTirada(buildMetaAdjustmentRow(deltaTiradas, actor));
  }

  const nuevasTiradas = db.getPendingTiradasCount(TARGET_CHANNEL_ID);
  const nuevaMeta = nuevasTiradas * META_POR_TIRADA;

  return {
    beforeMeta: tiradasActuales * META_POR_TIRADA,
    afterMeta: nuevaMeta,
    beforeTiradas: tiradasActuales,
    afterTiradas: nuevasTiradas,
    deltaTiradas
  };
}

function buildProcessStatusText(channelId = TARGET_CHANNEL_ID) {
  const state = getMetaState(channelId);

  return [
    `Meta acumulada: **${state.metaActual}/${META_MAXIMA_PROCESO}**`,
    `Tiradas acumuladas: **${state.tiradasPendientes}/${TIRADAS_PARA_PROCESAR}**`,
    state.listoParaProcesar
      ? "Estado: **recomendado procesar**."
      : `Aún faltan **${state.metaRestante}** de meta para llegar a la guía recomendada. Igualmente se puede procesar si hace falta.`
  ].join("\n");
}

function buildPackagingStatusText(channelId = TARGET_CHANNEL_ID) {
  const state = getMetaState(channelId);

  return [
    `Meta procesada pendiente de empaquetar: **${state.metaProcesadaPendiente}/${META_PARA_EMPAQUETAR}**`,
    state.listoParaEmpaquetar
      ? "Estado: **recomendado empaquetar**."
      : `Aún faltan **${state.metaProcesadaRestante}** de meta procesada para llegar a la guía recomendada. Igualmente se puede empaquetar si hace falta.`
  ].join("\n");
}

function buildUserPendingText(channelId = TARGET_CHANNEL_ID) {
  const rows = db.getPendingTiradasByUser(channelId);

  if (!rows.length) {
    return "No hay tiradas pendientes.";
  }

  return rows
    .map(row => {
      const tiradas = Number(row.tiradas_pendientes || 0);
      const meta = tiradas * META_POR_TIRADA;

      return `- **${row.display_name || row.username}**: ${tiradas} tirada(s) · ${meta} de meta`;
    })
    .join("\n");
}

module.exports = {
  getLocalParts,
  getLocalDateText,
  getIsoWeekFromParts,
  getMetaState,
  setCurrentMeta,
  buildProcessStatusText,
  buildPackagingStatusText,
  buildUserPendingText
};
