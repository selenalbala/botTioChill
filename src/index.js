require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits
} = require("discord.js");

const {
  TARGET_CHANNEL_ID,
  ALLOWED_TIRADA_ROLE_IDS,
  STATS_ADMIN_ROLE_IDS,
  META_PER_TIRADA,
  TIRADA_COOLDOWN_MINUTES
} = require("./config");

const db = require("./db");
const { buildTiradaRow, getCurrentPeriod } = require("./stats");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

let panelRefreshTimeout = null;

function formatNumber(value) {
  return new Intl.NumberFormat("es-ES").format(Number(value || 0));
}

function metaFromTiradas(tiradas) {
  return Number(tiradas || 0) * META_PER_TIRADA;
}

function formatMeta(tiradas) {
  return formatNumber(metaFromTiradas(tiradas));
}

function formatTiradaMetaLine(label, tiradas) {
  return `${label}: **${formatMeta(tiradas)} de meta** (${formatNumber(tiradas)} tirada(s) × ${META_PER_TIRADA})`;
}

function discordTimestamp(date, style = "t") {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";

  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}min`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}min`;
}

function buildNextTiradaInfoFromRow(last) {
  if (!last?.timestamp_utc) {
    return {
      canRoll: true,
      lastAt: null,
      nextAt: null,
      remainingMs: 0,
      last
    };
  }

  const lastAt = new Date(last.timestamp_utc);

  if (Number.isNaN(lastAt.getTime())) {
    return {
      canRoll: true,
      lastAt: null,
      nextAt: null,
      remainingMs: 0,
      last
    };
  }

  const nextAt = new Date(lastAt.getTime() + TIRADA_COOLDOWN_MINUTES * 60 * 1000);
  const remainingMs = nextAt.getTime() - Date.now();

  return {
    canRoll: remainingMs <= 0,
    lastAt,
    nextAt,
    remainingMs: Math.max(0, remainingMs),
    last
  };
}

function getNextTiradaInfo(userId) {
  return buildNextTiradaInfoFromRow(db.getLastTiradaByUser(userId));
}

function getNextGlobalTiradaInfo() {
  return buildNextTiradaInfoFromRow(db.getLastTirada());
}

function buildNextTiradaText(userId) {
  const info = getNextTiradaInfo(userId);

  if (!info.nextAt || info.canRoll) {
    return "⏱️ **Tu siguiente tirada:** disponible ahora.";
  }

  return [
    `⏱️ **Tu siguiente tirada:** ${discordTimestamp(info.nextAt, "t")} · ${discordTimestamp(info.nextAt, "R")}.`,
    `Te queda aprox. **${formatRemaining(info.remainingMs)}**.`
  ].join("\n");
}

function buildPanelNextTiradaText() {
  const info = getNextGlobalTiradaInfo();

  if (!info.nextAt) {
    return "⏱️ **Siguiente tirada:** disponible ahora. Aún no hay tiradas registradas.";
  }

  const lastName = info.last?.display_name || info.last?.username || "alguien";

  if (info.canRoll) {
    return [
      "⏱️ **Siguiente tirada:** disponible ahora.",
      `Última tirada: **${lastName}** ${discordTimestamp(info.lastAt, "R")}.`
    ].join("\n");
  }

  return [
    `⏱️ **Siguiente tirada:** ${discordTimestamp(info.nextAt, "t")} · ${discordTimestamp(info.nextAt, "R")}.`,
    `Queda aprox. **${formatRemaining(info.remainingMs)}**.`,
    `Última tirada: **${lastName}** ${discordTimestamp(info.lastAt, "R")}.`
  ].join("\n");
}

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
            description: "Semana, mes, total y siguiente tirada",
            value: "resumen",
            emoji: "📌"
          },
          {
            label: "Semana actual",
            description: "Tus tiradas y meta de esta semana",
            value: "semana",
            emoji: "📅"
          },
          {
            label: "Mes actual",
            description: "Tus tiradas y meta de este mes",
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
    ),

    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("tirada_admin_open_user_select")
        .setLabel("Jefatura: consultar usuario")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildPanelContent() {
  const period = getCurrentPeriod();
  const totalMes = db.getTotalMonth(period.year, period.month);
  const totalSemana = db.getTotalWeek(period.isoYear, period.isoWeek);

  return [
    "🧪 **Panel de meta**",
    "",
    `Pulsa **+1 tirada** para sumar **${META_PER_TIRADA} de meta** a tu contador.`,
    "La **siguiente tirada** se actualiza aquí automáticamente para que todos la vean.",
    "Usa **Ver mis tiradas...** para consultar tus tiradas en privado.",
    "",
    buildPanelNextTiradaText(),
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    formatTiradaMetaLine("📅 **Total semanal**", totalSemana),
    formatTiradaMetaLine("🗓️ **Total mensual**", totalMes)
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
    return content.includes("Panel de meta") || content.includes("Panel de tiradas") || content.includes("Panel de meta de la banda");
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
    schedulePanelAvailabilityRefresh();
    return edited;
  }

  const sent = await channel.send(payload);
  db.savePanelMessage(channel.id, sent.id);
  schedulePanelAvailabilityRefresh();
  return sent;
}

function schedulePanelAvailabilityRefresh() {
  if (panelRefreshTimeout) {
    clearTimeout(panelRefreshTimeout);
    panelRefreshTimeout = null;
  }

  const info = getNextGlobalTiradaInfo();

  if (!info.nextAt || info.canRoll) return;

  const delay = Math.min(info.remainingMs + 1500, 2_147_483_647);

  panelRefreshTimeout = setTimeout(async () => {
    try {
      await refreshPanel();
    } catch (error) {
      console.error("No se pudo refrescar el panel al acabar el tiempo:", error.message);
    }
  }, delay);
}

function hasAnyRole(member, roleIds) {
  if (!member || !roleIds.length) return false;

  const roles = member.roles;

  // GuildMember normal: member.roles.cache.has(id)
  if (roles?.cache) {
    return roleIds.some(roleId => roles.cache.has(roleId));
  }

  // A veces Discord entrega los roles como array de IDs en interacciones.
  if (Array.isArray(roles)) {
    return roleIds.some(roleId => roles.includes(roleId));
  }

  return false;
}

function hasAllowedTiradaRole(member) {
  if (!ALLOWED_TIRADA_ROLE_IDS.length) return true;
  return hasAnyRole(member, ALLOWED_TIRADA_ROLE_IDS);
}

async function canViewOtherUsers(interaction) {
  if (!interaction.guild) return false;

  // Importante: NO dejamos pasar por permisos como ManageGuild/Administrator.
  // Solo pueden consultar otros usuarios quienes tengan uno de los roles exactos
  // configurados en STATS_ADMIN_ROLE_IDS.
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
  return hasAnyRole(member, STATS_ADMIN_ROLE_IDS);
}

async function denyNoStatsPermission(interaction) {
  await interaction.reply({
    content: "No tienes permiso para consultar las tiradas de otra persona.",
    flags: MessageFlags.Ephemeral
  });
}

async function handleTiradaButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este botón solo funciona en el canal configurado para las tiradas.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!interaction.member || !hasAllowedTiradaRole(interaction.member)) {
    await interaction.reply({
      content: "No tienes permiso para usar este botón.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const beforeRoll = getNextGlobalTiradaInfo();

  if (!beforeRoll.canRoll) {
    await interaction.reply({
      content: [
        "⏳ Todavía no se puede registrar otra tirada.",
        "",
        buildPanelNextTiradaText()
      ].join("\n"),
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
      `Has sumado **${META_PER_TIRADA} de meta**.`,
      "",
      `📅 Esta semana llevas **${formatNumber(semanal)}** tirada(s), **${formatMeta(semanal)} de meta**.`,
      `🗓️ Este mes llevas **${formatNumber(mensual)}** tirada(s), **${formatMeta(mensual)} de meta**.`,
      `📊 Total histórico: **${formatNumber(total)}** tirada(s), **${formatMeta(total)} de meta**.`,
      "",
      buildPanelNextTiradaText()
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
    `🧪 **Tiradas de ${user}**`,
    "",
    `📅 Semana actual: **${formatNumber(semanal)}** tirada(s) · **${formatMeta(semanal)} de meta**`,
    `🗓️ Mes actual: **${formatNumber(mensual)}** tirada(s) · **${formatMeta(mensual)} de meta**`,
    `📊 Total histórico: **${formatNumber(total)}** tirada(s) · **${formatMeta(total)} de meta**`,
    "",
    buildPanelNextTiradaText()
  ].join("\n");
}

function buildUserStatsOptionText(user, option) {
  const period = getCurrentPeriod();

  if (option === "semana") {
    const semanal = db.getTotalByUserWeek(user.id, period.isoYear, period.isoWeek);
    return [
      `📅 ${user}, esta semana llevas **${formatNumber(semanal)}** tirada(s).`,
      `Total de meta semanal: **${formatMeta(semanal)}**.`,
      "",
      buildPanelNextTiradaText()
    ].join("\n");
  }

  if (option === "mes") {
    const mensual = db.getTotalByUserMonth(user.id, period.year, period.month);
    return [
      `🗓️ ${user}, este mes llevas **${formatNumber(mensual)}** tirada(s).`,
      `Total de meta mensual: **${formatMeta(mensual)}**.`,
      "",
      buildPanelNextTiradaText()
    ].join("\n");
  }

  if (option === "total") {
    const total = db.getTotalByUser(user.id);
    return [
      `📊 ${user}, tienes **${formatNumber(total)}** tirada(s) en total.`,
      `Total de meta histórico: **${formatMeta(total)}**.`,
      "",
      buildPanelNextTiradaText()
    ].join("\n");
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

async function handleAdminOpenUserSelect(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este botón solo funciona en el canal configurado para las tiradas.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!(await canViewOtherUsers(interaction))) {
    await denyNoStatsPermission(interaction);
    return;
  }

  await interaction.reply({
    content: "Selecciona el usuario del que quieres ver las tiradas:",
    components: [
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId("tirada_admin_private_user_select")
          .setPlaceholder("Elegir usuario...")
          .setMinValues(1)
          .setMaxValues(1)
      )
    ],
    flags: MessageFlags.Ephemeral
  });
}

async function handleTiradaUserSelect(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este menú solo funciona en el canal configurado para las tiradas.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!(await canViewOtherUsers(interaction))) {
    await denyNoStatsPermission(interaction);
    return;
  }

  const userId = interaction.values?.[0];
  const selectedUser = interaction.users?.get(userId) || await client.users.fetch(userId).catch(() => null);

  if (!selectedUser) {
    await interaction.reply({
      content: "No he podido encontrar ese usuario.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply({
    content: buildUserStatsText(selectedUser),
    flags: MessageFlags.Ephemeral
  });
}

function buildGeneralTotalsText() {
  const current = getCurrentPeriod();
  const semana = db.getTotalWeek(current.isoYear, current.isoWeek);
  const mes = db.getTotalMonth(current.year, current.month);

  return [
    "📊 **Total de meta**",
    "",
    formatTiradaMetaLine("📅 **Semana actual**", semana),
    formatTiradaMetaLine("🗓️ **Mes actual**", mes)
  ].join("\n");
}

function buildPeriodStatsText({ user, total, label }) {
  const prefix = user ? `${user} tiene` : "Hay";
  return `${prefix} **${formatNumber(total)}** tirada(s) en **${label}**: **${formatMeta(total)} de meta**.`;
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot encendido como ${client.user.tag}`);
  console.log(`DB PATH: ${db.getDbPath()}`);
  console.log(`Cada tirada suma ${META_PER_TIRADA} de meta.`);
  console.log(`Cooldown de tirada: ${TIRADA_COOLDOWN_MINUTES} minutos.`);

  try {
    await refreshPanel();
    console.log("Panel de meta actualizado.");
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

      if (interaction.customId === "tirada_admin_open_user_select") {
        await handleAdminOpenUserSelect(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "tirada_consulta_select") {
        await handleTiradaStatsSelect(interaction);
      }
      return;
    }

    if (interaction.isUserSelectMenu()) {
      // Acepta el nuevo selector privado y también el ID antiguo por si queda algún panel viejo sin actualizar.
      if (interaction.customId === "tirada_admin_private_user_select" || interaction.customId === "tirada_consulta_user_select") {
        await handleTiradaUserSelect(interaction);
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

      if (user.id !== interaction.user.id && !(await canViewOtherUsers(interaction))) {
        await denyNoStatsPermission(interaction);
        return;
      }

      await interaction.reply({
        content: buildUserStatsText(user),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "total_tiradas") {
      await interaction.reply({
        content: buildGeneralTotalsText(),
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

      if (user && user.id !== interaction.user.id && !(await canViewOtherUsers(interaction))) {
        await denyNoStatsPermission(interaction);
        return;
      }

      const total = user
        ? db.getTotalByUserMonth(user.id, anio, mes)
        : db.getTotalMonth(anio, mes);

      await interaction.reply({
        content: buildPeriodStatsText({
          user,
          total,
          label: `${mes}/${anio}`
        }),
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

      if (user && user.id !== interaction.user.id && !(await canViewOtherUsers(interaction))) {
        await denyNoStatsPermission(interaction);
        return;
      }

      const total = user
        ? db.getTotalByUserWeek(user.id, anio, semana)
        : db.getTotalWeek(anio, semana);

      await interaction.reply({
        content: buildPeriodStatsText({
          user,
          total,
          label: `semana ${semana}/${anio}`
        }),
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
