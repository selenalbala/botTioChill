const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  META_POR_TIRADA,
  META_CAPACIDAD_MAXIMA,
  META_MAXIMA_PROCESO,
  META_GUIA_PROCESO,
  TIRADAS_PARA_PROCESAR,
  META_PARA_EMPAQUETAR,
  META_GUIA_EMPAQUETAR
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
  const tiradasPendientesReales = db.getPendingTiradasCount(channelId);
  const tiradasPendientes = Math.min(tiradasPendientesReales, TIRADAS_PARA_PROCESAR);

  const metaReal = tiradasPendientes * META_POR_TIRADA;
  const metaActual = Math.min(metaReal, META_CAPACIDAD_MAXIMA);
  const metaActualSinCapar = tiradasPendientesReales * META_POR_TIRADA;

  const metaRestante = Math.max(META_GUIA_PROCESO - metaActual, 0);
  const tiradasRestantes = Math.max(TIRADAS_PARA_PROCESAR - tiradasPendientes, 0);

  const metaProcesadaPendienteReal = db.getPendingProcessedMeta(channelId);
  const metaProcesadaPendiente = Math.min(metaProcesadaPendienteReal, META_CAPACIDAD_MAXIMA);
  const metaProcesadaRestante = Math.max(META_GUIA_EMPAQUETAR - metaProcesadaPendiente, 0);

  return {
    metaPorTirada: META_POR_TIRADA,
    metaCapacidadMaxima: META_CAPACIDAD_MAXIMA,
    metaMaximaProceso: META_MAXIMA_PROCESO,
    metaGuiaProceso: META_GUIA_PROCESO,
    tiradasParaProcesar: TIRADAS_PARA_PROCESAR,

    // Estos valores son los que se usan para procesar desde el botón.
    // Si hay 9 tiradas, se muestran/procesan como 500 de meta aunque 9 x 56 sean 504.
    tiradasPendientes,
    tiradasPendientesReales,
    metaActual,
    metaActualSinCapar,
    metaRestante,
    tiradasRestantes,

    // 448/500 son guías. Procesar se permite siempre que haya al menos una tirada pendiente.
    listoParaProcesar: tiradasPendientes > 0,
    recomendadoProcesar: metaActual >= META_GUIA_PROCESO,
    porUsuarios: db.getPendingTiradasByUser(channelId),

    metaParaEmpaquetar: META_PARA_EMPAQUETAR,
    metaGuiaEmpaquetar: META_GUIA_EMPAQUETAR,
    metaProcesadaPendiente,
    metaProcesadaPendienteReal,
    metaProcesadaRestante,

    // Empaquetar se permite siempre que exista meta procesada pendiente.
    listoParaEmpaquetar: metaProcesadaPendienteReal > 0,
    recomendadoEmpaquetar: metaProcesadaPendiente >= META_GUIA_EMPAQUETAR,

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

function metaToTiradas(metaActual) {
  if (metaActual <= 0) return 0;
  if (metaActual >= META_CAPACIDAD_MAXIMA) return TIRADAS_PARA_PROCESAR;
  return Math.ceil(metaActual / META_POR_TIRADA);
}

function setCurrentMeta(metaActual, actor = {}) {
  if (!Number.isInteger(metaActual) || metaActual < 0) {
    throw new Error("La meta actual debe ser un número entero mayor o igual a 0.");
  }

  if (metaActual > META_CAPACIDAD_MAXIMA) {
    throw new Error(`La meta no puede superar ${META_CAPACIDAD_MAXIMA}.`);
  }

  const tiradasActuales = db.getPendingTiradasCount(TARGET_CHANNEL_ID);
  const tiradasDeseadas = metaToTiradas(metaActual);
  const deltaTiradas = tiradasDeseadas - tiradasActuales;

  if (deltaTiradas !== 0) {
    db.insertTirada(buildMetaAdjustmentRow(deltaTiradas, actor));
  }

  const nuevasTiradas = db.getPendingTiradasCount(TARGET_CHANNEL_ID);
  const nuevaMeta = Math.min(nuevasTiradas * META_POR_TIRADA, META_CAPACIDAD_MAXIMA);

  return {
    beforeMeta: Math.min(tiradasActuales * META_POR_TIRADA, META_CAPACIDAD_MAXIMA),
    afterMeta: nuevaMeta,
    beforeTiradas: tiradasActuales,
    afterTiradas: nuevasTiradas,
    deltaTiradas
  };
}

function buildProcessStatusText(channelId = TARGET_CHANNEL_ID) {
  const state = getMetaState(channelId);
  return [
    `Meta acumulada: **${state.metaActual}/${state.metaCapacidadMaxima}**`,
    `Guía recomendada para procesar: **${state.metaGuiaProceso}**`,
    `Tiradas acumuladas: **${state.tiradasPendientes}/${state.tiradasParaProcesar}**`,
    state.tiradasPendientes > 0
      ? state.recomendadoProcesar
        ? "Estado: **recomendado procesar**."
        : "Estado: **se puede procesar si hace falta**, aunque todavía no se haya llegado a la guía."
      : "Estado: **sin tiradas pendientes**."
  ].join("\n");
}

function buildPackagingStatusText(channelId = TARGET_CHANNEL_ID) {
  const state = getMetaState(channelId);
  return [
    `Meta procesada pendiente de empaquetar: **${state.metaProcesadaPendiente}/${state.metaCapacidadMaxima}**`,
    `Guía recomendada para empaquetar: **${state.metaGuiaEmpaquetar}**`,
    state.metaProcesadaPendienteReal > 0
      ? state.recomendadoEmpaquetar
        ? "Estado: **recomendado empaquetar**."
        : "Estado: **se puede empaquetar si hace falta**, aunque todavía no se haya llegado a la guía."
      : "Estado: **sin meta procesada pendiente**."
  ].join("\n");
}

function buildUserPendingText(channelId = TARGET_CHANNEL_ID) {
  const rows = db.getPendingTiradasByUser(channelId);
  if (!rows.length) return "No hay tiradas pendientes.";

  return rows
    .map(row => {
      const tiradas = Number(row.tiradas_pendientes || 0);
      const meta = Math.min(tiradas * META_POR_TIRADA, META_CAPACIDAD_MAXIMA);
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
