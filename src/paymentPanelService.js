const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require("discord.js");
const {
  CLEAN_PAYMENT_PANEL_CHANNEL_ID,
  CLEAN_PAYMENT_LOG_CHANNEL_ID,
  TARGET_CHANNEL_ID,
  STAFF_ROLE_ID_SET
} = require("../config");
const {
  initMoneyTables,
  buildBonusSummary,
  recordCleanPayment,
  getPaymentPanelMessage,
  savePaymentPanelMessage
} = require("./metaMoneyService");

const SELECT_ID = "clean_payment_select";
const MODAL_PREFIX = "clean_payment_modal:";

function formatMoney(value) {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function isStaffMember(member) {
  const cache = member?.roles?.cache;
  if (!cache) return false;
  return [...cache.keys()].some(roleId => STAFF_ROLE_ID_SET.has(String(roleId)));
}

async function getMainGuild(client) {
  if (!client) return null;

  if (process.env.GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
    if (guild) return guild;
  }

  if (TARGET_CHANNEL_ID) {
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);
    if (channel?.guild) return channel.guild;
  }

  return client.guilds.cache.first() || null;
}

function buildPanelPayload(summary) {
  const pendingRows = (summary.rows || [])
    .filter(row => Number(row.pendingCleanTotal || 0) > 0)
    .sort((a, b) => Number(b.pendingCleanTotal || 0) - Number(a.pendingCleanTotal || 0));

  const description = [
    "💸 **Panel de pagos de dinero limpio**",
    "",
    "Selecciona a quién se le ha pagado. Después se abrirá una ventana para escribir la cantidad.",
    "El pago se descontará del dinero pendiente y **no se reiniciará semanalmente**.",
    "",
    `Pendiente total: **${formatMoney(summary.totals.pendingCleanTotal)} €**`,
    `Pagado total: **${formatMoney(summary.totals.paidCleanTotal)} €**`,
    `Generado total: **${formatMoney(summary.totals.generatedCleanTotal)} €**`
  ].join("\n");

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder(pendingRows.length ? "Elige el miembro al que se le ha pagado" : "No hay dinero pendiente")
    .setMinValues(1)
    .setMaxValues(1);

  if (!pendingRows.length) {
    select
      .setDisabled(true)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Sin pagos pendientes")
          .setDescription("No hay dinero limpio pendiente ahora mismo.")
          .setValue("none")
      );
  } else {
    for (const row of pendingRows.slice(0, 25)) {
      select.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(String(row.displayName || row.username || row.userId).slice(0, 100))
          .setDescription(`Debe ${formatMoney(row.pendingCleanTotal)} € · pagado ${formatMoney(row.paidCleanTotal)} €`.slice(0, 100))
          .setValue(String(row.userId))
      );
    }
  }

  return {
    content: description,
    components: [new ActionRowBuilder().addComponents(select)]
  };
}

async function refreshPaymentPanel(client) {
  initMoneyTables();
  const channelId = CLEAN_PAYMENT_PANEL_CHANNEL_ID;
  if (!client || !channelId) return null;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return null;

  const guild = channel.guild || await getMainGuild(client);
  const summary = await buildBonusSummary({ guild, channelId: TARGET_CHANNEL_ID });
  const payload = buildPanelPayload(summary);

  const saved = getPaymentPanelMessage(channelId);
  if (saved?.message_id) {
    const existing = await channel.messages.fetch(saved.message_id).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      savePaymentPanelMessage(channelId, existing.id);
      return existing;
    }
  }

  const message = await channel.send(payload);
  savePaymentPanelMessage(channelId, message.id);
  return message;
}

async function sendPaymentLog(client, payment, context = {}) {
  const channelId = CLEAN_PAYMENT_LOG_CHANNEL_ID;
  if (!client || !channelId) return false;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return false;

  const before = Number(context.beforePending || 0);
  const after = Number(context.afterPending || 0);

  await channel.send({
    content: [
      "💰 **Pago de dinero limpio registrado**",
      "",
      `Miembro: **${payment.display_name || payment.username || payment.user_id}** (<@${payment.user_id}>)`,
      `Cantidad pagada: **${formatMoney(payment.amount)} €**`,
      `Pendiente antes: **${formatMoney(before)} €**`,
      `Pendiente después: **${formatMoney(after)} €**`,
      "",
      `Registrado por: **${payment.actor_display_name || payment.actor_username || "staff"}**`,
      payment.note ? `Nota: ${payment.note}` : null
    ].filter(Boolean).join("\n")
  });

  return true;
}

function getActorFromInteraction(interaction) {
  return {
    actorUserId: interaction.user?.id || null,
    actorUsername: interaction.user?.username || null,
    actorDisplayName: interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || "staff"
  };
}

async function handlePaymentInteraction(client, interaction) {
  if (interaction.isStringSelectMenu() && interaction.customId === SELECT_ID) {
    if (!isStaffMember(interaction.member)) {
      await interaction.reply({ content: "No tienes permisos para registrar pagos.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const userId = String(interaction.values?.[0] || "");
    if (!userId || userId === "none") {
      await interaction.reply({ content: "No hay pagos pendientes ahora mismo.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const guild = interaction.guild || await getMainGuild(client);
    const summary = await buildBonusSummary({ guild, channelId: TARGET_CHANNEL_ID });
    const row = summary.rows.find(item => String(item.userId) === userId);

    const modal = new ModalBuilder()
      .setCustomId(`${MODAL_PREFIX}${userId}`)
      .setTitle(`Pago a ${(row?.displayName || userId).slice(0, 35)}`);

    const amountInput = new TextInputBuilder()
      .setCustomId("amount")
      .setLabel("Cantidad pagada")
      .setPlaceholder(row ? `Pendiente: ${formatMoney(row.pendingCleanTotal)} €` : "Ejemplo: 30000")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);

    const noteInput = new TextInputBuilder()
      .setCustomId("note")
      .setLabel("Nota opcional")
      .setPlaceholder("Ejemplo: pagado por caja, transferencia, etc.")
      .setRequired(false)
      .setStyle(TextInputStyle.Short);

    modal.addComponents(
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(noteInput)
    );

    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
    if (!isStaffMember(interaction.member)) {
      await interaction.reply({ content: "No tienes permisos para registrar pagos.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const userId = interaction.customId.slice(MODAL_PREFIX.length);
    const rawAmount = String(interaction.fields.getTextInputValue("amount") || "").replace(/[.€\s]/g, "").replace(",", ".");
    const amount = Number(rawAmount);
    const note = String(interaction.fields.getTextInputValue("note") || "").trim();

    if (!Number.isInteger(amount) || amount <= 0) {
      await interaction.reply({ content: "La cantidad debe ser un número entero mayor que 0. Ejemplo: 30000", flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild || await getMainGuild(client);
    const beforeSummary = await buildBonusSummary({ guild, channelId: TARGET_CHANNEL_ID });
    const beforeRow = beforeSummary.rows.find(item => String(item.userId) === String(userId));

    const member = guild ? await guild.members.fetch(String(userId)).catch(() => null) : null;
    const payment = recordCleanPayment({
      guildId: guild?.id || interaction.guildId || process.env.GUILD_ID || null,
      channelId: interaction.channelId,
      userId,
      username: member?.user?.username || beforeRow?.username || String(userId),
      displayName: member?.displayName || beforeRow?.displayName || String(userId),
      amount,
      ...getActorFromInteraction(interaction),
      note
    });

    const afterSummary = await buildBonusSummary({ guild, channelId: TARGET_CHANNEL_ID });
    const afterRow = afterSummary.rows.find(item => String(item.userId) === String(userId));

    await sendPaymentLog(client, payment, {
      beforePending: beforeRow?.pendingCleanTotal || 0,
      afterPending: afterRow?.pendingCleanTotal || 0
    }).catch(error => console.error("[PAGOS] No se pudo enviar el log:", error.message));

    await refreshPaymentPanel(client).catch(error => console.error("[PAGOS] No se pudo refrescar el panel:", error.message));

    await interaction.editReply({
      content: [
        "Pago registrado correctamente.",
        `Miembro: **${payment.display_name || payment.username || payment.user_id}**`,
        `Cantidad: **${formatMoney(payment.amount)} €**`,
        `Pendiente ahora: **${formatMoney(afterRow?.pendingCleanTotal || 0)} €**`
      ].join("\n")
    });

    return true;
  }

  return false;
}

module.exports = {
  refreshPaymentPanel,
  handlePaymentInteraction,
  sendPaymentLog
};
