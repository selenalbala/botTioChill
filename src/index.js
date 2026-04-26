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
  getByMonth,
  getByWeek,
  getByRange,
  getTopUsers,
  getLastButtonTiradaGlobal,
  getPendingTiradasCount,
  getPendingMetaTotal,
  getPendingTiradasByUser,
  processPendingTiradas,
  getPendingProcessedMeta,
  packagePendingMeta
} = require("./db");

const { buildTiradaRow, sumRegistros } = require("./stats");
const { createWebApp } = require("./web");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
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

const META_POR_TIRADA = 56;
const META_MAXIMA_PROCESO = 448;
const TIRADAS_PARA_PROCESAR = META_MAXIMA_PROCESO / META_POR_TIRADA;

function getLocalDateText(date = new Date(), timeZone = TIMEZONE) {
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
  const get = type => parts.find(p => p.type === type)?.value ?? "00";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
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

function formatProcessStatus(channelId = TARGET_CHANNEL_ID) {
  const tiradasPendientes = getPendingTiradasCount(channelId);
  const metaPendiente = getPendingMetaTotal(channelId, META_POR_TIRADA);
  const faltanMeta = Math.max(META_MAXIMA_PROCESO - metaPendiente, 0);
  const faltanTiradas = Math.max(TIRADAS_PARA_PROCESAR - tiradasPendientes, 0);

  return {
    tiradasPendientes,
    metaPendiente,
    faltanMeta,
    faltanTiradas,
    listo: metaPendiente >= META_MAXIMA_PROCESO
  };
}

function buildProcessStatusText(channelId = TARGET_CHANNEL_ID) {
  const status = formatProcessStatus(channelId);

  return [
    `Meta acumulada: **${status.metaPendiente}/${META_MAXIMA_PROCESO}**`,
    `Tiradas acumuladas: **${status.tiradasPendientes}/${TIRADAS_PARA_PROCESAR}**`,
    status.listo
      ? "Estado: **listo para procesar**."
      : `Faltan **${status.faltanMeta}** de meta, es decir **${status.faltanTiradas}** tirada(s).`
  ].join("\n");
}

function buildUserPendingText(channelId = TARGET_CHANNEL_ID) {
  const rows = getPendingTiradasByUser(channelId);

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
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("procesar_meta")
      .setLabel("Procesar")
      .setStyle(ButtonStyle.Success)
  );
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
        component =>
          component.customId === "tirada_plus_one" ||
          component.customId === "procesar_meta"
      )
  );

  if (existingPanel) {
    console.log("El panel de tiradas ya existe.");
    return;
  }

  await channel.send({
    content: [
      "Pulsa **+1 tirada** para sumar 56 de metanfetamina.",
      "",
      `Objetivo para procesar: **${META_MAXIMA_PROCESO}**`,
      `Cada tirada: **${META_POR_TIRADA}**`,
      `Tiradas necesarias: **${TIRADAS_PARA_PROCESAR}**`
    ].join("\n"),
    components: [buildPanelRow()]
  });

  console.log("Panel de tiradas enviado automáticamente.");
}

async function handleTiradaButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este botón no corresponde a este canal.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const lastTirada = getLastButtonTiradaGlobal(TARGET_CHANNEL_ID);

  if (lastTirada) {
    const lastTime = new Date(lastTirada.timestamp_utc).getTime();
    const now = Date.now();

    if (!Number.isNaN(lastTime)) {
      const elapsed = now - lastTime;
      const remaining = TIRADA_COOLDOWN_MS - elapsed;

      if (remaining > 0) {
        const nombreUltimo = lastTirada.display_name || lastTirada.username || "otro usuario";

        await interaction.reply({
          content: [
            `Ahora no se puede hacer otra tirada.`,
            "",
            `La última tirada la hizo **${nombreUltimo}**.`,
            `Tienes que esperar **${formatRemainingTime(remaining)}** para volver a pulsar +1 tirada.`,
            "",
            buildProcessStatusText(TARGET_CHANNEL_ID)
          ].join("\n"),
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

  const totalUsuario = getTotalByUser(interaction.user.id);
  const status = formatProcessStatus(TARGET_CHANNEL_ID);

  await interaction.editReply({
    content: [
      `Tirada registrada. Has sumado **${META_POR_TIRADA}** de metanfetamina.`,
      "",
      `Tu total acumulado es **${totalUsuario}** tirada(s).`,
      "",
      buildProcessStatusText(TARGET_CHANNEL_ID),
      "",
      status.listo
        ? "Ya se ha llegado al máximo. Ahora se puede pulsar **Procesar**."
        : "Podrá hacerse otra tirada cuando pase **1h 10min** desde esta."
    ].join("\n")
  });
}

async function handleProcesarButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await interaction.reply({
      content: "Este botón no corresponde a este canal.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const status = formatProcessStatus(TARGET_CHANNEL_ID);

  if (!status.listo) {
    await interaction.reply({
      content: [
        "Todavía no se puede procesar.",
        "",
        buildProcessStatusText(TARGET_CHANNEL_ID)
      ].join("\n"),
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  processPendingTiradas({
    channelId: TARGET_CHANNEL_ID,
    cantidadTiradas: TIRADAS_PARA_PROCESAR,
    metaTotal: META_MAXIMA_PROCESO,
    timestampUtc: new Date().toISOString(),
    fechaLocal: getLocalDateText(new Date(), TIMEZONE),
    guildId: interaction.guildId,
    processorUserId: interaction.user.id,
    processorUsername: interaction.user.username,
    processorDisplayName:
      interaction.member?.displayName ||
      interaction.user.globalName ||
      interaction.user.username
  });

  await interaction.editReply({
    content: [
      "Proceso registrado correctamente.",
      "",
      `Se han procesado **${META_MAXIMA_PROCESO}** de metanfetamina.`,
      `Se han consumido **${TIRADAS_PARA_PROCESAR}** tiradas pendientes.`,
      "",
      "**Reparto de tiradas usadas:**",
      buildUserPendingText(TARGET_CHANNEL_ID),
      "",
      "El contador pendiente vuelve a empezar para el siguiente procesado."
    ].join("\n")
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
    } catch (error) {
      console.error(`Error enviando panel en ${guild.name}:`, error);
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
          content: [
            `Total general histórico: **${getTotalGeneral()}** tiradas.`,
            "",
            buildProcessStatusText(TARGET_CHANNEL_ID)
          ].join("\n"),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === "tiradas_usuario") {
        const user = interaction.options.getUser("usuario", true);
        const total = getTotalByUser(user.id);

        await interaction.reply({
          content: `${user} tiene **${total}** tiradas históricas.`,
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
          .map((item, index) => `${index + 1}. **${item.display_name || item.username}** — ${item.total}`)
          .join("\n");

        await interaction.reply({
          content: `Top ${limite} histórico:\n${texto}`,
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
      if (interaction.customId === "tirada_plus_one") {
        await handleTiradaButton(interaction);
        return;
      }

      if (interaction.customId === "procesar_meta") {
        await handleProcesarButton(interaction);
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
