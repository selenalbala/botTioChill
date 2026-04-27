const { ACTION_LOG_CHANNEL_ID } = require("../config");
const { getLocalDateText } = require("./metaService");
const db = require("../db");

function buildLogText(action) {
  return [
    "🧾 **Registro de acción**",
    "",
    `Acción: **${action.action_type}**`,
    `Estado: **${action.status}**`,
    action.user_id ? `Usuario: <@${action.user_id}>` : null,
    action.display_name ? `Nombre: **${action.display_name}**` : null,
    action.user_id ? `ID: \`${action.user_id}\`` : null,
    action.channel_id ? `Canal: \`${action.channel_id}\`` : null,
    action.details ? `Detalles: ${action.details}` : null
  ].filter(Boolean).join("\n");
}

async function logAction(client, payload) {
  const now = new Date();

  const action = {
    timestamp_utc: payload.timestamp_utc || now.toISOString(),
    fecha_local: payload.fecha_local || getLocalDateText(now),
    guild_id: payload.guild_id || null,
    channel_id: payload.channel_id || null,
    user_id: payload.user_id || null,
    username: payload.username || null,
    display_name: payload.display_name || null,
    action_type: payload.action_type,
    status: payload.status,
    details: payload.details || null
  };

  db.insertActionLog(action);

  const channel = await client.channels.fetch(ACTION_LOG_CHANNEL_ID).catch(() => null);

  if (channel && typeof channel.send === "function") {
    await channel.send({
      content: buildLogText(action)
    }).catch(() => {});
  }

  return action;
}

function actionFromInteraction(interaction, actionType, status, details = "") {
  return {
    guild_id: interaction.guildId || null,
    channel_id: interaction.channelId || null,
    user_id: interaction.user?.id || null,
    username: interaction.user?.username || null,
    display_name:
      interaction.member?.displayName ||
      interaction.user?.globalName ||
      interaction.user?.username ||
      null,
    action_type: actionType,
    status,
    details
  };
}

module.exports = {
  logAction,
  actionFromInteraction
};
