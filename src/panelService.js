const {
  TARGET_CHANNEL_ID,
  TIRADA_COOLDOWN_MS
} = require("../config");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");
const db = require("../db");
const { getMetaState } = require("./metaService");

function buildPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tirada_plus_one")
        .setLabel("+1 tirada")
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("procesar_meta")
        .setLabel("Procesar")
        .setStyle(ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("empaquetar_meta")
        .setLabel("Empaquetar")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildNextTiradaText(channelId = TARGET_CHANNEL_ID) {
  const last = db.getLastButtonTiradaGlobal(channelId);
  if (!last) return "⏱️ **Siguiente tirada:** disponible ahora.";

  const lastMs = new Date(last.timestamp_utc).getTime();
  if (Number.isNaN(lastMs)) return "⏱️ **Siguiente tirada:** disponible ahora.";

  const nextMs = lastMs + TIRADA_COOLDOWN_MS;
  if (Date.now() >= nextMs) return "⏱️ **Siguiente tirada:** disponible ahora.";

  const unix = Math.floor(nextMs / 1000);
  return [
    `⏱️ **Siguiente tirada:** <t:${unix}:R>`,
    `🕒 **Hora exacta:** <t:${unix}:t>`
  ].join("\n");
}

function buildMetaPanelContent(channelId = TARGET_CHANNEL_ID) {
  const state = getMetaState(channelId);

  const procesoEstado = state.tiradasPendientes <= 0
    ? "⏳ **Estado:** no hay tiradas pendientes para procesar."
    : state.recomendadoProcesar
      ? "✅ **Estado:** recomendado procesar. No hace falta esperar a 500."
      : "⚠️ **Estado:** se puede procesar si hace falta. La guía es 448, pero no bloquea.";

  const empaquetadoEstado = state.metaProcesadaPendienteReal <= 0
    ? "⏳ **Empaquetado:** no hay meta procesada pendiente."
    : state.recomendadoEmpaquetar
      ? "✅ **Empaquetado:** recomendado empaquetar. No hace falta esperar a 500."
      : "⚠️ **Empaquetado:** se puede empaquetar si hace falta. La guía es 448, pero no bloquea.";

  return [
    "🧪 **Panel de meta de la banda**",
    "",
    "Pulsa **+1 tirada** para registrar una tirada de meta.",
    "",
    buildNextTiradaText(channelId),
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `📦 **Meta actual:** ${state.metaActual}/${state.metaCapacidadMaxima}`,
    `📍 **Guía para procesar:** ${state.metaGuiaProceso}`,
    `➕ **Tiradas acumuladas:** ${state.tiradasPendientes}/${state.tiradasParaProcesar}`,
    state.tiradasPendientesReales > state.tiradasPendientes
      ? `⚠️ Hay **${state.tiradasPendientesReales}** tirada(s) reales pendientes; se procesarán por tandas de ${state.tiradasParaProcesar}.`
      : null,
    "",
    procesoEstado,
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `🎁 **Meta procesada pendiente:** ${state.metaProcesadaPendiente}/${state.metaCapacidadMaxima}`,
    `📍 **Guía para empaquetar:** ${state.metaGuiaEmpaquetar}`,
    empaquetadoEstado
  ].filter(Boolean).join("\n");
}

async function findExistingPanelMessage(channel, clientUserId) {
  const saved = db.getMetaStatusMessage(channel.id);
  if (saved?.message_id) {
    const message = await channel.messages.fetch(saved.message_id).catch(() => null);
    if (message) return message;
  }

  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!messages) return null;

  const existing = messages.find(message => {
    if (clientUserId && message.author?.id !== clientUserId) return false;
    return String(message.content || "").includes("Panel de meta de la banda");
  });

  return existing || null;
}

async function refreshMetaPanel(client, channelId = TARGET_CHANNEL_ID) {
  if (!client) throw new Error("No hay cliente de Discord disponible.");
  if (!channelId) throw new Error("TARGET_CHANNEL_ID no está configurado.");

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") {
    throw new Error("No se pudo encontrar el canal del panel de meta.");
  }

  const payload = {
    content: buildMetaPanelContent(channelId),
    components: buildPanelRows()
  };

  const existing = await findExistingPanelMessage(channel, client.user?.id);
  if (existing) {
    const edited = await existing.edit(payload);
    db.saveMetaStatusMessage(channelId, edited.id);
    return edited;
  }

  const sent = await channel.send(payload);
  db.saveMetaStatusMessage(channelId, sent.id);
  return sent;
}

module.exports = {
  buildPanelRows,
  buildNextTiradaText,
  buildMetaPanelContent,
  refreshMetaPanel
};
