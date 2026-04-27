const {
  TARGET_CHANNEL_ID,
  META_POR_TIRADA,
  META_MAXIMA_PROCESO,
  TIRADAS_PARA_PROCESAR,
  META_PARA_EMPAQUETAR
} = require("../config");

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
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

function buildMetaPanelContent(channelId = TARGET_CHANNEL_ID) {
  const state = getMetaState(channelId);

  return [
    "🏍️ **Panel de tiradas**",
    "",
    "Pulsa **+1 tirada** para sumar **56 de metanfetamina**.",
    "",
    `Meta actual: **${state.metaActual}/${META_MAXIMA_PROCESO}**`,
    `Tiradas actuales: **${state.tiradasPendientes}/${TIRADAS_PARA_PROCESAR}**`,
    `Cada tirada: **${META_POR_TIRADA}**`,
    "",
    state.listoParaProcesar
      ? "✅ Estado de proceso: **listo para procesar**"
      : `⏳ Estado de proceso: faltan **${state.metaRestante}** de meta.`,
    "",
    `Meta procesada pendiente de empaquetar: **${state.metaProcesadaPendiente}/${META_PARA_EMPAQUETAR}**`,
    state.listoParaEmpaquetar
      ? "✅ Estado de empaquetado: **listo para empaquetar**"
      : `⏳ Estado de empaquetado: faltan **${state.metaProcesadaRestante}**.`,
    "",
    "Los botones actualizan este panel automáticamente."
  ].join("\n");
}

async function refreshMetaPanel(client, channelId = TARGET_CHANNEL_ID) {
  if (!channelId) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildText) {
    console.log(`No se encontró el canal ${channelId}`);
    return null;
  }

  const content = buildMetaPanelContent(channelId);
  const components = buildPanelRows();

  const saved = db.getMetaStatusMessage(channelId);

  if (saved?.message_id) {
    const savedMessage = await channel.messages.fetch(saved.message_id).catch(() => null);

    if (savedMessage) {
      await savedMessage.edit({ content, components });
      db.saveMetaStatusMessage(channelId, savedMessage.id);
      return savedMessage;
    }
  }

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);

  const existingPanel = messages?.find(
    msg =>
      msg.author.id === client.user.id &&
      msg.components.length > 0 &&
      msg.components.some(row =>
        row.components.some(component =>
          component.customId === "tirada_plus_one" ||
          component.customId === "procesar_meta" ||
          component.customId === "empaquetar_meta"
        )
      )
  );

  if (existingPanel) {
    await existingPanel.edit({ content, components });
    db.saveMetaStatusMessage(channelId, existingPanel.id);
    return existingPanel;
  }

  const message = await channel.send({ content, components });
  db.saveMetaStatusMessage(channelId, message.id);
  return message;
}

module.exports = {
  buildPanelRows,
  buildMetaPanelContent,
  refreshMetaPanel
};
