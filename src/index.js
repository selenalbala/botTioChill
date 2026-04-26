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
  getLastButtonTiradaByUser
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
const WEEKLY_REPORT_CHANNEL_ID = process.env.WEEKLY_REPORT_CHANNEL_ID || "1492877561888243752";
const WEEKLY_REPORT_DAY = Number(process.env.WEEKLY_REPORT_DAY || 1);
const WEEKLY_REPORT_HOUR = Number(process.env.WEEKLY_REPORT_HOUR || 10);
const WEEKLY_REPORT_MINUTE = Number(process.env.WEEKLY_REPORT_MINUTE || 0);

const TIRADA_COOLDOWN_MS = 70 * 60 * 1000;

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
          .map((item, index) => `${index + 1}. **${item.display_name || item.username}** — ${item.total}`)
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
      if (interaction.customId !== "tirada_plus_one") return;

      if (interaction.channelId !== TARGET_CHANNEL_ID) {
        await interaction.reply({
          content: "Este botón no corresponde a este canal.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const lastTirada = getLastButtonTiradaByUser(
        interaction.user.id,
        TARGET_CHANNEL_ID
      );

      if (lastTirada) {
        const lastTime = new Date(lastTirada.timestamp_utc).getTime();
        const now = Date.now();

        if (!Number.isNaN(lastTime)) {
          const elapsed = now - lastTime;
          const remaining = TIRADA_COOLDOWN_MS - elapsed;

          if (remaining > 0) {
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

      const totalUsuario = getTotalByUser(interaction.user.id);

      await interaction.editReply({
        content: `Tirada registrada. Tu total acumulado es **${totalUsuario}**. Podrás volver a sumar otra dentro de **1h 10min**.`
      });

      return;
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
