require("dotenv").config();

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { sendWeeklyReport, startWeeklyReportScheduler } = require("./report");

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ChannelType
} = require("discord.js");

const {
  initDb,
  insertTirada,
  getAllTiradas,
  getTotalGeneral,
  getTotalByUser,
  getUserSummary,
  getDistinctUsers,
  getByMonth,
  getByWeek,
  getByRange,
  getTopUsers,
  getLastButtonTiradaByUser,
  deleteTiradasByUser
} = require("./db");

const { buildTiradaRow, sumRegistros } = require("./stats");
const { createWebApp } = require("./web");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const TIMEZONE = process.env.TIMEZONE || "Europe/Madrid";
const EXPORTS_DIR = path.join(process.cwd(), "exports");

const WEEKLY_REPORT_CHANNEL_ID =
  process.env.WEEKLY_REPORT_CHANNEL_ID || "1492877561888243752";

const WEEKLY_REPORT_DAY = Number(process.env.WEEKLY_REPORT_DAY || 1);
const WEEKLY_REPORT_HOUR = Number(process.env.WEEKLY_REPORT_HOUR || 10);
const WEEKLY_REPORT_MINUTE = Number(process.env.WEEKLY_REPORT_MINUTE || 0);

const TIRADA_COOLDOWN_MS = 70 * 60 * 1000;
const CLEANUP_REVIEW_CHANNEL_ID = "1498007351993831485";

const pendingCleanupRequests = new Set();

const ALLOWED_TIRADA_ROLE_IDS = new Set([
  "1492824944575254599",
  "1495144231654653993",
  "1492828339457495182",
  "1492833353391673395",
  "1492833439433359430",
  "1492833441442566154",
  "1492833504206262442"
]);

function getMemberRoleIds(member) {
  if (!member?.roles) return [];

  if (member.roles.cache) {
    return [...member.roles.cache.keys()];
  }

  if (Array.isArray(member.roles)) {
    return member.roles;
  }

  return [];
}

function memberHasAllowedTiradaRole(member) {
  const roleIds = getMemberRoleIds(member);
  return roleIds.some(roleId => ALLOWED_TIRADA_ROLE_IDS.has(roleId));
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds} segundos`;
  }

  return `${minutes} min ${seconds} s`;
}

function ensureExportsDir() {
  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }
}

async function replySafe(interaction, payload) {
  if (interaction.deferred) {
    return interaction.editReply(payload);
  }

  if (interaction.replied) {
    return interaction.followUp(payload);
  }

  return interaction.reply(payload);
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("tirada_plus_one")
      .setLabel("+1 tirada")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildCleanupReviewRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cleanup_approve:${userId}`)
      .setLabel("Borrar de la BBDD")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId(`cleanup_reject:${userId}`)
      .setLabel("Mantener datos")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function getCleanupReviewChannel() {
  const channel = await client.channels
    .fetch(CLEANUP_REVIEW_CHANNEL_ID)
    .catch(() => null);

  if (!channel || typeof channel.send !== "function") {
    console.error(`No se pudo acceder al canal de responsables ${CLEANUP_REVIEW_CHANNEL_ID}`);
    return null;
  }

  return channel;
}

async function sendTiradaPressLog({
  userId,
  username,
  displayName,
  status,
  reason,
  totalBefore,
  totalAfter,
  channelId,
  guildName
}) {
  const reviewChannel = await getCleanupReviewChannel();
  if (!reviewChannel) return;

  await reviewChannel.send({
    content: [
      "🧾 **Registro de pulsación de tirada**",
      "",
      `Usuario: <@${userId}>`,
      `Nombre: **${displayName || username || userId}**`,
      `ID: \`${userId}\``,
      `Servidor: **${guildName || "Desconocido"}**`,
      `Canal del botón: \`${channelId || "Desconocido"}\``,
      `Estado: **${status}**`,
      reason ? `Motivo: **${reason}**` : null,
      totalBefore !== undefined ? `Total antes: **${totalBefore}**` : null,
      totalAfter !== undefined ? `Total después: **${totalAfter}**` : null
    ].filter(Boolean).join("\n")
  });
}

async function sendCleanupRequest({
  userId,
  username,
  displayName,
  total,
  reason,
  source
}) {
  if (pendingCleanupRequests.has(userId)) return false;

  const reviewChannel = await getCleanupReviewChannel();
  if (!reviewChannel) return false;

  pendingCleanupRequests.add(userId);

  await reviewChannel.send({
    content: [
      "⚠️ **Revisión para borrar tiradas de la BBDD**",
      "",
      `Usuario: <@${userId}>`,
      `Nombre guardado: **${displayName || username || userId}**`,
      `ID: \`${userId}\``,
      `Total actual en BBDD: **${total}** tiradas`,
      `Origen de la revisión: **${source}**`,
      `Motivo: **${reason}**`,
      "",
      "Un responsable debe decidir desde este canal si se borran sus tiradas."
    ].join("\n"),
    components: [buildCleanupReviewRow(userId)]
  });

  return true;
}

async function sendPanelIfMissing(guild) {
  const channel = guild.channels.cache.get(TARGET_CHANNEL_ID);

  if (!channel || channel.type !== ChannelType.GuildText) {
    console.log(`No se encontró el canal ${TARGET_CHANNEL_ID}`);
    return;
  }

  const messages = await channel.messages.fetch({ limit: 20 });

  const existingPanel = messages.find(
    msg =>
      msg.author.id === client.user.id &&
      msg.components.length > 0 &&
      msg.components[0].components.some(
        component => component.customId === "tirada_plus_one"
      )
  );

  if (existingPanel) {
    console.log("El panel de tiradas ya existe.");
    return;
  }

  await channel.send({
    content: "Pulsa el botón para sumar una tirada.",
    components: [buildPanelRow()]
  });

  console.log("Panel de tiradas enviado automáticamente.");
}

async function scanInvalidUsersInDatabase(guild) {
  const users = getDistinctUsers();

  for (const user of users) {
    const userId = user.user_id;
    const total = Number(user.total || 0);

    if (total <= 0) continue;

    let member = null;

    try {
      member = await guild.members.fetch(userId);
    } catch (_) {
      member = null;
    }

    if (!member) {
      await sendCleanupRequest({
        userId,
        username: user.username,
        displayName: user.display_name,
        total,
        source: "Revisión automática al arrancar el bot",
        reason: "El usuario ya no está en el servidor"
      });
      continue;
    }

    if (!memberHasAllowedTiradaRole(member)) {
      await sendCleanupRequest({
        userId,
        username: user.username,
        displayName: user.display_name,
        total,
        source: "Revisión automática al arrancar el bot",
        reason: "El usuario está en el servidor, pero ya no tiene un rango autorizado"
      });
    }
  }
}

async function handleCleanupReviewButton(interaction) {
  const [action, userId] = interaction.customId.split(":");

  if (interaction.channelId !== CLEANUP_REVIEW_CHANNEL_ID) {
    await interaction.reply({
      content: "Esta decisión solo puede hacerse desde el canal de responsables.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!userId) {
    await interaction.reply({
      content: "No se ha podido identificar al usuario.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === "cleanup_reject") {
    pendingCleanupRequests.delete(userId);

    await interaction.update({
      content: [
        "✅ **Revisión cerrada**",
        "",
        `El responsable ${interaction.user} ha decidido **mantener** las tiradas de <@${userId}> en la base de datos.`
      ].join("\n"),
      components: []
    });

    return;
  }

  if (action !== "cleanup_approve") {
    await interaction.reply({
      content: "Acción no válida.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  let member = null;

  try {
    member = await interaction.guild.members.fetch(userId);
  } catch (_) {
    member = null;
  }

  if (member && memberHasAllowedTiradaRole(member)) {
    pendingCleanupRequests.delete(userId);

    await interaction.update({
      content: [
        "⚠️ **Borrado cancelado**",
        "",
        `El usuario <@${userId}> vuelve a tener un rango autorizado.`,
        "No se ha borrado nada de la base de datos."
      ].join("\n"),
      components: []
    });

    return;
  }

  const result = deleteTiradasByUser(userId);
  pendingCleanupRequests.delete(userId);

  await interaction.update({
    content: [
      "🗑️ **Tiradas borradas de la BBDD**",
      "",
      `El responsable ${interaction.user} ha aprobado borrar las tiradas de <@${userId}>.`,
      `Registros eliminados: **${result.changes}**`
    ].join("\n"),
    components: []
  });
}

async function handleTiradaButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await sendTiradaPressLog({
      userId: interaction.user.id,
      username: interaction.user.username,
      displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
      status: "Bloqueado",
      reason: "Canal incorrecto",
      channelId: interaction.channelId,
      guildName: interaction.guild?.name
    });

    await interaction.reply({
      content: "Este botón no corresponde a este canal.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const member = interaction.member;
  const userId = interaction.user.id;
  const userSummary = getUserSummary(userId);
  const totalBefore = Number(getTotalByUser(userId));
  const displayName =
    interaction.member?.displayName ||
    interaction.user.globalName ||
    interaction.user.username;

  if (!member) {
    await sendTiradaPressLog({
      userId,
      username: interaction.user.username,
      displayName,
      status: "Bloqueado",
      reason: "No se pudo comprobar el miembro en el servidor",
      totalBefore,
      channelId: interaction.channelId,
      guildName: interaction.guild?.name
    });

    await interaction.reply({
      content: "No se ha podido comprobar si sigues dentro del servidor.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!memberHasAllowedTiradaRole(member)) {
    await sendTiradaPressLog({
      userId,
      username: interaction.user.username,
      displayName,
      status: "Bloqueado",
      reason: "No tiene rango autorizado",
      totalBefore,
      channelId: interaction.channelId,
      guildName: interaction.guild?.name
    });

    if (userSummary && totalBefore > 0) {
      await sendCleanupRequest({
        userId,
        username: userSummary.username || interaction.user.username,
        displayName: userSummary.display_name || displayName,
        total: totalBefore,
        source: "Ha pulsado el botón +1 tirada",
        reason: "El usuario no tiene actualmente un rango autorizado"
      });

      await interaction.reply({
        content: "No tienes un rango autorizado para registrar tiradas. Se ha avisado a responsables para revisar si deben borrar tus tiradas de la BBDD.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: "No tienes un rango autorizado para registrar tiradas.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const lastTirada = getLastButtonTiradaByUser(userId, TARGET_CHANNEL_ID);

  if (lastTirada) {
    const lastTime = new Date(lastTirada.timestamp_utc).getTime();
    const now = Date.now();

    if (!Number.isNaN(lastTime)) {
      const elapsed = now - lastTime;
      const remaining = TIRADA_COOLDOWN_MS - elapsed;

      if (remaining > 0) {
        await sendTiradaPressLog({
          userId,
          username: interaction.user.username,
          displayName,
          status: "Bloqueado",
          reason: `Cooldown activo. Falta ${formatRemainingTime(remaining)}`,
          totalBefore,
          channelId: interaction.channelId,
          guildName: interaction.guild?.name
        });

        await interaction.reply({
          content: `Ya has registrado una tirada hace poco. Tienes que esperar **${formatRemainingTime(remaining)}** para volver a pulsar +1 tirada.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  const row = buildTiradaRow(interaction, TIMEZONE);
  insertTirada(row);

  const totalAfter = Number(getTotalByUser(userId));

  await sendTiradaPressLog({
    userId,
    username: interaction.user.username,
    displayName,
    status: "Aceptado",
    reason: "Tirada registrada correctamente",
    totalBefore,
    totalAfter,
    channelId: interaction.channelId,
    guildName: interaction.guild?.name
  });

  await interaction.editReply({
    content: `Tirada registrada. Tu total acumulado es **${totalAfter}**. Podrás volver a sumar otra dentro de **1h 10min**.`
  });
}

client.once(Events.ClientReady, async () => {
  initDb();
  ensureExportsDir();

  console.log(`Bot listo como ${client.user.tag}`);
  console.log("DB PATH:", process.env.DB_PATH || "./tiradas.db");

  for (const guild of client.guilds.cache.values()) {
    try {
      await sendPanelIfMissing(guild);
      await scanInvalidUsersInDatabase(guild);
    } catch (error) {
      console.error(`Error revisando ${guild.name}:`, error);
    }
  }

  startWeeklyReportScheduler(client, {
    channelId: WEEKLY_REPORT_CHANNEL_ID,
    timeZone: TIMEZONE,
    day: WEEKLY_REPORT_DAY,
    hour: WEEKLY_REPORT_HOUR,
    minute: WEEKLY_REPORT_MINUTE
  });

  console.log(
    `Informe semanal configurado para el canal ${WEEKLY_REPORT_CHANNEL_ID}, día ${WEEKLY_REPORT_DAY}, hora ${WEEKLY_REPORT_HOUR}:${String(WEEKLY_REPORT_MINUTE).padStart(2, "0")}`
  );
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "total") {
        await interaction.reply({
          content: `Total general: **${getTotalGeneral()}** tiradas.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "tiradas_usuario") {
        const user = interaction.options.getUser("usuario", true);
        const total = getTotalByUser(user.id);

        await interaction.reply({
          content: `${user} tiene **${total}** tiradas.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "tiradas_mes") {
        const anio = interaction.options.getInteger("anio", true);
        const mes = interaction.options.getInteger("mes", true);

        if (mes < 1 || mes > 12) {
          await interaction.reply({
            content: "El mes debe estar entre 1 y 12.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const rows = getByMonth(anio, mes);

        await interaction.reply({
          content: `Mes ${mes}/${anio}: **${sumRegistros(rows)}** tiradas.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "tiradas_semana") {
        const anio = interaction.options.getInteger("anio", true);
        const semana = interaction.options.getInteger("semana", true);
        const rows = getByWeek(anio, semana);

        await interaction.reply({
          content: `Semana ${semana} de ${anio}: **${sumRegistros(rows)}** tiradas.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "tiradas_rango") {
        const desde = interaction.options.getString("desde", true);
        const hasta = interaction.options.getString("hasta", true);

        const fromIso = `${desde}T00:00:00.000Z`;
        const toIso = `${hasta}T23:59:59.999Z`;

        const rows = getByRange(fromIso, toIso);

        await interaction.reply({
          content: `Desde ${desde} hasta ${hasta}: **${sumRegistros(rows)}** tiradas.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "top_tiradas") {
        const limite = interaction.options.getInteger("limite") || 10;
        const top = getTopUsers(limite);

        if (!top.length) {
          await interaction.reply({
            content: "No hay tiradas registradas todavía.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const texto = top
          .map(
            (item, index) =>
              `${index + 1}. **${item.display_name || item.username}** — ${item.total}`
          )
          .join("\n");

        await interaction.reply({
          content: `Top ${limite}:\n${texto}`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "exportar_excel") {
        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const rows = getAllTiradas();

        if (!rows.length) {
          await interaction.editReply({
            content: "No hay datos para exportar."
          });
          return;
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);
        const workbook = XLSX.utils.book_new();

        XLSX.utils.book_append_sheet(workbook, worksheet, "Tiradas");

        const fileName = `tiradas_${Date.now()}.xlsx`;
        const filePath = path.join(EXPORTS_DIR, fileName);

        XLSX.writeFile(workbook, filePath);

        await interaction.editReply({
          content: "Excel generado correctamente.",
          files: [filePath]
        });
        return;
      }

      if (interaction.commandName === "informe_semana") {
        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const result = await sendWeeklyReport(client, {
          channelId: WEEKLY_REPORT_CHANNEL_ID,
          timeZone: TIMEZONE,
          force: true,
          markAsSent: false
        });

        await interaction.editReply({
          content: result.sent
            ? `Informe semanal enviado al canal <#${WEEKLY_REPORT_CHANNEL_ID}>.`
            : "No se ha enviado el informe."
        });

        return;
      }

      return;
    }

    if (interaction.isButton()) {
      if (
        interaction.customId.startsWith("cleanup_approve:") ||
        interaction.customId.startsWith("cleanup_reject:")
      ) {
        await handleCleanupReviewButton(interaction);
        return;
      }

      if (interaction.customId === "tirada_plus_one") {
        await handleTiradaButton(interaction);
        return;
      }
    }
  } catch (error) {
    console.error("Error en interacción:", error);

    try {
      await replySafe(interaction, {
        content: "Ha ocurrido un error.",
        flags: MessageFlags.Ephemeral
      });
    } catch (e) {
      console.error("No se pudo responder al error:", e);
    }
  }
});

const app = createWebApp();
const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`Panel web escuchando en puerto ${port}`);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught Exception:", error);
});

client.login(process.env.DISCORD_TOKEN);
