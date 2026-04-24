const {
  getByLocalDateRange,
  getTopUsersByLocalDateRange,
  getDailyTotalsByLocalDateRange,
  hasReportBeenSent,
  markReportSent
} = require("./db");

const { sumRegistros } = require("./stats");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

  return Math.ceil((((d - yearStart) / MS_PER_DAY) + 1) / 7);
}

function getLocalParts(date = new Date(), timeZone = "Europe/Madrid") {
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
  const get = type => parts.find(p => p.type === type)?.value ?? "0";

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));

  const isoWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    isoWeekday
  };
}

function formatUtcDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function getPreviousWeekRange(timeZone = "Europe/Madrid", referenceDate = new Date()) {
  const local = getLocalParts(referenceDate, timeZone);

  const localTodayUtc = Date.UTC(local.year, local.month - 1, local.day);
  const startCurrentWeekUtc = localTodayUtc - ((local.isoWeekday - 1) * MS_PER_DAY);
  const startPreviousWeekUtc = startCurrentWeekUtc - (7 * MS_PER_DAY);
  const endPreviousWeekUtc = startCurrentWeekUtc - MS_PER_DAY;

  const startDate = new Date(startPreviousWeekUtc);
  const endDate = new Date(endPreviousWeekUtc);

  return {
    desde: formatUtcDateOnly(startDate),
    hasta: formatUtcDateOnly(endDate),
    semanaIso: getIsoWeek(startDate),
    anioIso: startDate.getUTCFullYear(),
    reportKey: `weekly:${formatUtcDateOnly(startDate)}:${formatUtcDateOnly(endDate)}`
  };
}

function buildWeeklyReportContent({ timeZone = "Europe/Madrid", referenceDate = new Date() } = {}) {
  const range = getPreviousWeekRange(timeZone, referenceDate);

  const rows = getByLocalDateRange(range.desde, range.hasta);
  const top = getTopUsersByLocalDateRange(range.desde, range.hasta, 10);
  const dailyTotals = getDailyTotalsByLocalDateRange(range.desde, range.hasta);

  const total = sumRegistros(rows);
  const users = new Set(rows.map(row => row.user_id)).size;

  const topText = top.length
    ? top.map((item, index) => `${index + 1}. ${item.display_name || item.username} — ${item.total}`).join("\n")
    : "Sin tiradas registradas.";

  const dailyText = dailyTotals.length
    ? dailyTotals.map(item => `${item.fecha}: ${item.total}`).join("\n")
    : "Sin actividad diaria.";

  const content = [
    "📊 **Informe semanal de tiradas**",
    `Periodo: **${range.desde}** a **${range.hasta}**`,
    `Semana ISO: **${range.semanaIso}/${range.anioIso}**`,
    "",
    `Total semanal: **${total}** tiradas`,
    `Usuarios participantes: **${users}**`,
    "",
    "🏆 **Top usuarios**",
    topText,
    "",
    "📅 **Resumen por día**",
    dailyText
  ].join("\n");

  return {
    ...range,
    total,
    users,
    content: content.slice(0, 1900)
  };
}

async function sendWeeklyReport(client, {
  channelId,
  timeZone = "Europe/Madrid",
  force = false,
  markAsSent = true,
  referenceDate = new Date()
} = {}) {
  if (!channelId) {
    throw new Error("Falta WEEKLY_REPORT_CHANNEL_ID.");
  }

  const report = buildWeeklyReportContent({
    timeZone,
    referenceDate
  });

  if (!force && hasReportBeenSent(report.reportKey)) {
    return {
      sent: false,
      reason: "already_sent",
      report
    };
  }

  const channel = await client.channels.fetch(channelId);

  if (!channel || typeof channel.send !== "function") {
    throw new Error(`No se pudo acceder al canal de informes: ${channelId}`);
  }

  await channel.send({
    content: report.content
  });

  if (markAsSent) {
    markReportSent(report.reportKey, channelId);
  }

  return {
    sent: true,
    report
  };
}

function startWeeklyReportScheduler(client, {
  channelId,
  timeZone = "Europe/Madrid",
  day = 1,
  hour = 10,
  minute = 0
} = {}) {
  async function tick() {
    try {
      const local = getLocalParts(new Date(), timeZone);

      const isDue =
        local.isoWeekday === day &&
        local.hour === hour &&
        local.minute === minute;

      if (!isDue) return;

      const result = await sendWeeklyReport(client, {
        channelId,
        timeZone,
        force: false,
        markAsSent: true
      });

      if (result.sent) {
        console.log(`Informe semanal enviado: ${result.report.reportKey}`);
      }
    } catch (error) {
      console.error("Error enviando informe semanal:", error);
    }
  }

  setInterval(tick, 60 * 1000);
  setTimeout(tick, 10 * 1000);
}

module.exports = {
  buildWeeklyReportContent,
  sendWeeklyReport,
  startWeeklyReportScheduler
};