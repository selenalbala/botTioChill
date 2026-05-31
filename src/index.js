require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits
} = require("discord.js");

const { TARGET_CHANNEL_ID, ALLOWED_TIRADA_ROLE_IDS } = require("./config");
const db = require("./db");
const { buildTiradaRow, getCurrentPeriod } = require("./stats");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

function buildPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tirada_plus_one")
        .setLabel("+1 tirada")
        .setStyle(ButtonStyle.Primary)
    ),

    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("tirada_consulta_select")
        .setPlaceholder("Ver mis tiradas...")
        .addOptions(
          {
            label: "Resumen",
            description: "Semana, mes y total histórico",
            value: "resumen",
            emoji: "🎲"
          },
          {
            label: "Semana actual",
            description: "Tus tiradas de esta semana",
            value: "semana",
            emoji: "📅"
          },
          {
            label: "Mes actual",
            description: "Tus tiradas de este mes",
            value: "mes",
            emoji: "🗓️"
          },
          {
            label: "Total histórico",
            description: "Todas tus tiradas registradas",
            value: "total",
            emoji: "📊"
          }
        )
    )
  ];
}

function formatTop(rows) {
  if (!rows.length) return "Todavía no hay tiradas registradas.";

  return rows
    .map((row, index) => {
      const name = row.display_name || row.username || row.user_id;
      return `${index + 1}. **${name}** — ${row.total}`;
    })
    .join("\n");
}

function buildPanelContent() {
  const period = getCurrentPeriod();
  const total = db.getTotalGeneral();
  const totalMes = db.getTotalMonth(period.year, period.month);
  const totalSemana = db.getTotalWeek(period.isoYear, period.isoWeek);
  const topSemana = db.getTopUsersWeek(period.isoYear, period.isoWeek, 5);

  return [
    "🎲 **Panel de tiradas**",
    "",
    "Pulsa **+1 tirada** para sumar una tirada a tu contador.",
    "Usa **Ver mis tiradas...** para consultar tus estadísticas en privado.",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    `📅 **Esta semana:** ${totalSemana} tirada(s)`,
    `🗓️ **Este mes:** ${totalMes} tirada(s)`,
    `📊 **Total histórico:** ${total} tirada(s)`,
    "",
    "🏆 **Top semanal:**",
    formatTop(topSemana)
  ].join("\n");
}

async function findPanelMessage(channel) {
  const saved = db.getPanelMessage(channel.id);

  if (saved?.message_id) {
    const savedMessage = await channel.messages.fetch(saved.message_id).catch(() => null);
    if (savedMessage) return savedMessage;
  }

  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!messages) return null;

  return messages.find(message => {
    if (message.author?.id !== client.user?.id) return false;

    const content = String(message.content || "");
    return content.includes("Panel de tiradas") || content.includes("Panel de meta de la banda");
  }) || null;
}

async function refreshPanel() {
  if (!TARGET_CHANNEL_ID) {
    throw new Error("Falta TARGET_CHANNEL_ID en el .env.");
  }

  const channel = await client.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);

  if (!channel || typeof channel.send !== "function") {
    throw new Error("No se pudo encontrar el canal del panel.");
  }

  const payload = {
    content: buildPanelContent(),
    components: buildPanelRows()
  };

  const existing = await findPanelMessage(channel);

  if (existing) {
    const edited = await existing.edit(payload);
    db.savePanelMessage(channel.id, edited.id);
    return edited;
  }

  const sent = await channel.send(payload);
  db.savePanelMessage(channel.id, sent.id);
  return sent;
}

function hasAllowedRole(member) {
  if (!ALLOWED_TIRADA_ROLE_IDS.length) return true;
  return ALLOWED_TIRADA_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
}

async function handleTiradaButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este botón solo funciona en el canal configurado para las tiradas.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!interaction.member || !hasAllowedRole(interaction.member)) {
    await interaction.reply({
      content: "No tienes permiso para usar este botón.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const row = buildTiradaRow(interaction);
  db.insertTirada(row);

  const period = getCurrentPeriod();
  const total = db.getTotalByUser(interaction.user.id);
  const semanal = db.getTotalByUserWeek(interaction.user.id, period.isoYear, period.isoWeek);
  const mensual = db.getTotalByUserMonth(interaction.user.id, period.year, period.month);

  await refreshPanel();

  await interaction.reply({
    content: [
      "✅ Tirada registrada correctamente.",
      "",
      `📅 Esta semana llevas **${semanal}** tirada(s).`,
      `🗓️ Este mes llevas **${mensual}** tirada(s).`,
      `📊 Total histórico: **${total}** tirada(s).`
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });
}

function buildUserStatsText(user) {
  const period = getCurrentPeriod();

  const total = db.getTotalByUser(user.id);
  const semanal = db.getTotalByUserWeek(user.id, period.isoYear, period.isoWeek);
  const mensual = db.getTotalByUserMonth(user.id, period.year, period.month);

  return [
    `🎲 Tiradas de ${user}`,
    "",
    `📅 Semana actual: **${semanal}**`,
    `🗓️ Mes actual: **${mensual}**`,
    `📊 Total histórico: **${total}**`
  ].join("\n");
}
function buildUserStatsOptionText(user, option) {
  const period = getCurrentPeriod();

  if (option === "semana") {
    const semanal = db.getTotalByUserWeek(user.id, period.isoYear, period.isoWeek);
    return `📅 ${user}, esta semana llevas **${semanal}** tirada(s).`;
  }

  if (option === "mes") {
    const mensual = db.getTotalByUserMonth(user.id, period.year, period.month);
    return `🗓️ ${user}, este mes llevas **${mensual}** tirada(s).`;
  }

  if (option === "total") {
    const total = db.getTotalByUser(user.id);
    return `📊 ${user}, tienes **${total}** tirada(s) en total.`;
  }

  return buildUserStatsText(user);
}

async function handleTiradaStatsSelect(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este menú solo funciona en el canal configurado para las tiradas.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const option = interaction.values?.[0] || "resumen";

  await interaction.reply({
    content: buildUserStatsOptionText(interaction.user, option),
    flags: MessageFlags.Ephemeral
  });
}


function getPeriodLabel(period) {
  if (period === "semana") return "esta semana";
  if (period === "mes") return "este mes";
  return "histórico";
}

function getTopByPeriod(period, limit) {
  const current = getCurrentPeriod();

  if (period === "semana") {
    return db.getTopUsersWeek(current.isoYear, current.isoWeek, limit);
  }

  if (period === "mes") {
    return db.getTopUsersMonth(current.year, current.month, limit);
  }

  return db.getTopUsers(limit);
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot encendido como ${client.user.tag}`);
  console.log(`DB PATH: ${db.getDbPath()}`);

  try {
    await refreshPanel();
    console.log("Panel de tiradas actualizado.");
  } catch (error) {
    console.error("No se pudo actualizar el panel:", error.message);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "tirada_plus_one") {
        await handleTiradaButton(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "tirada_consulta_select") {
        await handleTiradaStatsSelect(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "panel_tiradas") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: "Solo alguien con permiso de gestionar servidor puede regenerar el panel.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await refreshPanel();
      await interaction.reply({
        content: `Panel actualizado en <#${TARGET_CHANNEL_ID}>.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "mis_tiradas") {
      await interaction.reply({
        content: buildUserStatsText(interaction.user),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "tiradas_usuario") {
      const user = interaction.options.getUser("usuario", true);

      await interaction.reply({
        content: buildUserStatsText(user),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "total_tiradas") {
      const current = getCurrentPeriod();

      await interaction.reply({
        content: [
          "📊 **Resumen de tiradas**",
          "",
          `📅 Esta semana: **${db.getTotalWeek(current.isoYear, current.isoWeek)}**`,
          `🗓️ Este mes: **${db.getTotalMonth(current.year, current.month)}**`,
          `📊 Total histórico: **${db.getTotalGeneral()}**`
        ].join("\n"),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "top_tiradas") {
      const limite = Math.min(interaction.options.getInteger("limite") || 10, 25);
      const periodo = interaction.options.getString("periodo") || "total";
      const rows = getTopByPeriod(periodo, limite);

      await interaction.reply({
        content: `🏆 **Top ${getPeriodLabel(periodo)}**\n\n${formatTop(rows)}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "tiradas_mes") {
      const anio = interaction.options.getInteger("anio", true);
      const mes = interaction.options.getInteger("mes", true);
      const user = interaction.options.getUser("usuario");

      if (mes < 1 || mes > 12) {
        await interaction.reply({
          content: "El mes debe estar entre 1 y 12.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const total = user
        ? db.getTotalByUserMonth(user.id, anio, mes)
        : db.getTotalMonth(anio, mes);

      await interaction.reply({
        content: user
          ? `${user} tiene **${total}** tirada(s) en **${mes}/${anio}**.`
          : `En **${mes}/${anio}** hay **${total}** tirada(s).`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "tiradas_semana") {
      const anio = interaction.options.getInteger("anio", true);
      const semana = interaction.options.getInteger("semana", true);
      const user = interaction.options.getUser("usuario");

      if (semana < 1 || semana > 53) {
        await interaction.reply({
          content: "La semana debe estar entre 1 y 53.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const total = user
        ? db.getTotalByUserWeek(user.id, anio, semana)
        : db.getTotalWeek(anio, semana);

      await interaction.reply({
        content: user
          ? `${user} tiene **${total}** tirada(s) en la semana **${semana}/${anio}**.`
          : `En la semana **${semana}/${anio}** hay **${total}** tirada(s).`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
  } catch (error) {
    console.error("Error en interacción:", error);

    const payload = {
      content: "Ha ocurrido un error al procesar la acción.",
      flags: MessageFlags.Ephemeral
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error("Falta DISCORD_TOKEN en el .env.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
