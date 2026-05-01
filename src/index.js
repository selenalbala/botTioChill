require("dotenv").config();

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const { sendWeeklyReport, startWeeklyReportScheduler } = require("./report");
const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags
} = require("discord.js");

const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  META_POR_TIRADA,
  META_MAXIMA_PROCESO,
  TIRADAS_PARA_PROCESAR,
  META_PARA_EMPAQUETAR,
  TIRADA_COOLDOWN_MS
} = require("./config");

const db = require("./db");
const { buildTiradaRow } = require("./stats");
const { createWebApp } = require("./webPlus");
const { logAction, actionFromInteraction } = require("./services/actionLogService");
const {
  getLocalDateText,
  getMetaState,
  buildProcessStatusText,
  buildPackagingStatusText,
  buildUserPendingText
} = require("./services/metaService");
const { refreshMetaPanel } = require("./services/panelService");
const { memberHasAllowedRole } = require("./services/complianceService");
const { handleGuildMemberUpdate } = require("./services/roleReviewService");
const { sendMemberStatsDm } = require("./services/memberAuthService");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

const EXPORTS_DIR = path.join(process.cwd(), "exports");
const WEEKLY_REPORT_CHANNEL_ID = process.env.WEEKLY_REPORT_CHANNEL_ID || process.env.TARGET_CHANNEL_ID;
const WEEKLY_REPORT_DAY = Number(process.env.WEEKLY_REPORT_DAY || 1);
const WEEKLY_REPORT_HOUR = Number(process.env.WEEKLY_REPORT_HOUR || 10);
const WEEKLY_REPORT_MINUTE = Number(process.env.WEEKLY_REPORT_MINUTE || 0);
const PORT = Number(process.env.PORT || 3000);

let cooldownPanelTimer = null;

function formatRemainingTime(ms) {
  const safeMs = Math.max(0, Number(ms || 0));
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${seconds} s`;

  return `${minutes} min ${seconds} s`;
}

function ensureExportsDir() {
  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }
}

function scheduleCooldownPanelRefresh() {
  if (cooldownPanelTimer) {
    clearTimeout(cooldownPanelTimer);
    cooldownPanelTimer = null;
  }

  const last = db.getLastButtonTiradaGlobal(TARGET_CHANNEL_ID);
  if (!last) return;

  const lastMs = new Date(last.timestamp_utc).getTime();
  if (Number.isNaN(lastMs)) return;

  const delay = lastMs + TIRADA_COOLDOWN_MS - Date.now() + 2000;

  if (delay > 0 && delay < 2147483647) {
    cooldownPanelTimer = setTimeout(() => {
      refreshMetaPanel(client).catch(error => {
        console.error("Error refrescando panel tras cooldown:", error);
      });
    }, delay);
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

async function ensureMemberAllowed(interaction, actionName) {
  const member = interaction.member;

  if (!member) {
    await logAction(client, {
      ...actionFromInteraction(interaction, actionName, "blocked", "No se pudo comprobar el miembro.")
    });

    await interaction.reply({
      content: "No se ha podido comprobar si sigues dentro del servidor.",
      flags: MessageFlags.Ephemeral
    });

    return false;
  }

  if (!memberHasAllowedRole(member)) {
    await logAction(client, {
      ...actionFromInteraction(interaction, actionName, "blocked", "No tiene un rol autorizado.")
    });

    await interaction.reply({
      content: "No tienes un rango autorizado para usar este botón.",
      flags: MessageFlags.Ephemeral
    });

    return false;
  }

  return true;
}

function getNextTiradaUnixFromLast(lastTirada) {
  if (!lastTirada) return null;

  const lastTime = new Date(lastTirada.timestamp_utc).getTime();
  if (Number.isNaN(lastTime)) return null;

  return Math.floor((lastTime + TIRADA_COOLDOWN_MS) / 1000);
}

async function handleTiradaButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await logAction(client, {
      ...actionFromInteraction(interaction, "tirada_click", "blocked", "Canal incorrecto.")
    });

    await interaction.reply({
      content: "Este botón no corresponde a este canal.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const allowed = await ensureMemberAllowed(interaction, "tirada_click");
  if (!allowed) return;

  const userId = interaction.user.id;
  const totalBefore = Number(db.getTotalByUser(userId));
  const lastTirada = db.getLastButtonTiradaGlobal(TARGET_CHANNEL_ID);

  if (lastTirada) {
    const lastTime = new Date(lastTirada.timestamp_utc).getTime();
    const now = Date.now();

    if (!Number.isNaN(lastTime)) {
      const elapsed = now - lastTime;
      const remaining = TIRADA_COOLDOWN_MS - elapsed;

      if (remaining > 0) {
        const nombreUltimo = lastTirada.display_name || lastTirada.username || "otro usuario";
        const nextUnix = getNextTiradaUnixFromLast(lastTirada);

        await logAction(client, {
          ...actionFromInteraction(
            interaction,
            "tirada_click",
            "blocked",
            `Cooldown activo por última tirada de ${nombreUltimo}. Falta ${formatRemainingTime(remaining)}.`
          )
        });

        await interaction.reply({
          content: [
            "Ahora no se puede hacer otra tirada.",
            "",
            `La última tirada la hizo **${nombreUltimo}**.`,
            nextUnix
              ? `Tienes que esperar hasta **<t:${nextUnix}:R>** · hora: <t:${nextUnix}:t>.`
              : `Tienes que esperar **${formatRemainingTime(remaining)}** para volver a pulsar +1 tirada.`,
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
  db.insertTirada(row);

  const totalAfter = Number(db.getTotalByUser(userId));
const state = getMetaState(TARGET_CHANNEL_ID);

if (!state.listoParaProcesar) {
  await logAction(client, {
    ...actionFromInteraction(
      interaction,
      "procesar_click",
      "blocked",
      `No se ha llegado a la guía de proceso. Meta actual: ${state.metaActual}/${state.metaGuiaProceso}.`
    )
  });

  await interaction.reply({
    content: [
      "Todavía no se debe procesar.",
      "",
      `La guía es **${state.metaGuiaProceso}**. No hace falta esperar a **500**, pero tampoco se debería procesar antes de la guía.`,
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

const tiradasAProcesar = state.tiradasPendientes;
const metaAProcesar = state.metaActual;

db.processPendingTiradas({
  channelId: TARGET_CHANNEL_ID,
  cantidadTiradas: tiradasAProcesar,
  metaTotal: metaAProcesar,
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

await logAction(client, {
  ...actionFromInteraction(
    interaction,
    "procesar_success",
    "success",
    `Se han procesado ${metaAProcesar} de meta. Tiradas consumidas: ${tiradasAProcesar}.`
  )
});
  scheduleCooldownPanelRefresh();

  try {
    await sendMemberStatsDm(interaction.user, "tirada_registrada");
  } catch (error) {
    console.error("No se pudo enviar MD al usuario:", error.message);
  }

  await interaction.editReply({
    content: [
      `Tirada registrada. Has sumado **${META_POR_TIRADA}** de metanfetamina.`,
      "",
      `Tu total acumulado es **${totalAfter}** tirada(s).`,
      `Siguiente tirada: **<t:${nextUnix}:R>** · hora: <t:${nextUnix}:t>.`,
      "",
      buildProcessStatusText(TARGET_CHANNEL_ID),
      "",
      state.listoParaProcesar
        ? "Ya se ha llegado al máximo. Ahora se puede pulsar **Procesar**."
        : "Podrá hacerse otra tirada cuando pase **1h 10min** desde esta."
    ].join("\n")
  });
}

async function handleProcesarButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await logAction(client, {
      ...actionFromInteraction(interaction, "procesar_click", "blocked", "Canal incorrecto.")
    });

    await interaction.reply({
      content: "Este botón no corresponde a este canal.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const allowed = await ensureMemberAllowed(interaction, "procesar_click");
  if (!allowed) return;

  const state = getMetaState(TARGET_CHANNEL_ID);

if (!state.listoParaEmpaquetar) {
  await logAction(client, {
    ...actionFromInteraction(
      interaction,
      "empaquetar_click",
      "blocked",
      `No se ha llegado a la guía de empaquetado. Meta procesada: ${state.metaProcesadaPendiente}/${state.metaGuiaEmpaquetar}.`
    )
  });

  await interaction.reply({
    content: [
      "Todavía no se debe empaquetar.",
      "",
      `La guía es **${state.metaGuiaEmpaquetar}**. No hace falta esperar a **500**, pero tampoco se debería empaquetar antes de la guía.`,
      "",
      buildPackagingStatusText(TARGET_CHANNEL_ID)
    ].join("\n"),
    flags: MessageFlags.Ephemeral
  });

  return;
}

await interaction.deferReply({
  flags: MessageFlags.Ephemeral
});

const metaAempaquetar = state.metaProcesadaPendiente;

db.packagePendingMeta({
  channelId: TARGET_CHANNEL_ID,
  metaAempaquetar,
  timestampUtc: new Date().toISOString(),
  fechaLocal: getLocalDateText(new Date(), TIMEZONE),
  guildId: interaction.guildId,
  packerUserId: interaction.user.id,
  packerUsername: interaction.user.username,
  packerDisplayName:
    interaction.member?.displayName ||
    interaction.user.globalName ||
    interaction.user.username
});

await logAction(client, {
  ...actionFromInteraction(
    interaction,
    "empaquetar_success",
    "success",
    `Se han empaquetado ${metaAempaquetar} de meta.`
  )
});

await interaction.editReply({
  content: [
    "Proceso registrado correctamente.",
    "",
`Se han procesado **${metaAProcesar}** de metanfetamina.`,
`Se han consumido **${tiradasAProcesar}** tiradas pendientes.`,
    "",
    buildPackagingStatusText(TARGET_CHANNEL_ID),
    "",
    "Ahora se puede pulsar **Empaquetar** si hay suficiente meta procesada."
  ].join("\n")
});
}

async function handleEmpaquetarButton(interaction) {
  if (interaction.channelId !== TARGET_CHANNEL_ID) {
    await logAction(client, {
      ...actionFromInteraction(interaction, "empaquetar_click", "blocked", "Canal incorrecto.")
    });

    await interaction.reply({
      content: "Este botón no corresponde a este canal.",
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  const allowed = await ensureMemberAllowed(interaction, "empaquetar_click");
  if (!allowed) return;

  const state = getMetaState(TARGET_CHANNEL_ID);

  if (!state.listoParaEmpaquetar) {
    await logAction(client, {
      ...actionFromInteraction(interaction, "empaquetar_click", "blocked", "No hay meta procesada suficiente para empaquetar.")
    });

    await interaction.reply({
      content: [
        "Todavía no se puede empaquetar.",
        "",
        buildPackagingStatusText(TARGET_CHANNEL_ID)
      ].join("\n"),
      flags: MessageFlags.Ephemeral
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  db.packagePendingMeta({
    channelId: TARGET_CHANNEL_ID,
    metaAempaquetar: META_PARA_EMPAQUETAR,
    timestampUtc: new Date().toISOString(),
    fechaLocal: getLocalDateText(new Date(), TIMEZONE),
    guildId: interaction.guildId,
    packerUserId: interaction.user.id,
    packerUsername: interaction.user.username,
    packerDisplayName:
      interaction.member?.displayName ||
      interaction.user.globalName ||
      interaction.user.username
  });

  await logAction(client, {
    ...actionFromInteraction(
      interaction,
      "empaquetar_success",
      "success",
      `Se han empaquetado ${META_PARA_EMPAQUETAR} de meta.`
    )
  });

  await refreshMetaPanel(client);

  await interaction.editReply({
    content: [
      "Empaquetado registrado correctamente.",
      "",
      `Se han empaquetado **${metaAempaquetar}** de metanfetamina.`,
      "",
      buildPackagingStatusText(TARGET_CHANNEL_ID)
    ].join("\n")
  });
}

function startWebPanel() {
  const app = createWebApp({ client });

  app.listen(PORT, () => {
    console.log(`Panel web escuchando en puerto ${PORT}`);
    console.log(`DB PATH: ${db.getDbPath()}`);
  });
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot listo como ${client.user.tag}`);

  ensureExportsDir();
  startWebPanel();

  try {
    await refreshMetaPanel(client);
    scheduleCooldownPanelRefresh();
    console.log("Panel de meta actualizado.");
  } catch (error) {
    console.error("Error actualizando panel de meta:", error);
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

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    await handleGuildMemberUpdate(client, oldMember, newMember);
  } catch (error) {
    console.error("Error revisando cambio de rol:", error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "total") {
        await interaction.reply({
          content: [
            `Total general histórico: **${db.getTotalGeneral()}** tiradas.`,
            "",
            buildProcessStatusText(TARGET_CHANNEL_ID),
            "",
            buildPackagingStatusText(TARGET_CHANNEL_ID)
          ].join("\n"),
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (interaction.commandName === "tiradas_usuario") {
        const user = interaction.options.getUser("usuario", true);
        const total = db.getTotalByUser(user.id);

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

        const rows = db.getByMonth(anio, mes);
        const total = rows.reduce((acc, row) => acc + Number(row.conteo || 0), 0);

        await interaction.reply({
          content: `En **${mes}/${anio}** hay **${total}** tiradas registradas.`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (interaction.commandName === "tiradas_semana") {
        const anio = interaction.options.getInteger("anio", true);
        const semana = interaction.options.getInteger("semana", true);
        const rows = db.getByWeek(anio, semana);
        const total = rows.reduce((acc, row) => acc + Number(row.conteo || 0), 0);

        await interaction.reply({
          content: `En la semana **${semana}/${anio}** hay **${total}** tiradas registradas.`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      if (interaction.commandName === "top") {
        const limite = interaction.options.getInteger("limite") || 10;
        const top = db.getTopUsers(limite);

        const texto = top.length
          ? top
              .map((item, index) => `${index + 1}. **${item.display_name || item.username}** — ${item.total}`)
              .join("\n")
          : "No hay tiradas registradas.";

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

        const rows = db.getAllTiradas();

        if (!rows.length) {
          await interaction.editReply({
            content: "No hay datos para exportar."
          });

          return;
        }

        ensureExportsDir();

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

      if (interaction.customId === "empaquetar_meta") {
        await handleEmpaquetarButton(interaction);
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

if (!process.env.DISCORD_TOKEN) {
  console.error("Falta DISCORD_TOKEN en las variables de entorno.");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
