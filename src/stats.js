const { TIMEZONE } = require("./config");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getLocalParts(date = new Date(), timeZone = TIMEZONE) {
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

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

function getLocalDateText(date = new Date(), timeZone = TIMEZONE) {
  const local = getLocalParts(date, timeZone);
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${local.hour}:${local.minute}:${local.second}`;
}

function getIsoWeekFromParts(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;

  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / MS_PER_DAY) + 1) / 7);

  return {
    isoYear: d.getUTCFullYear(),
    isoWeek: week
  };
}

function buildTiradaRow(interaction) {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);
  const iso = getIsoWeekFromParts(local.year, local.month, local.day);

  return {
    timestamp_utc: now.toISOString(),
    fecha_local: getLocalDateText(now, TIMEZONE),
    anio: local.year,
    mes: local.month,
    dia: local.day,
    semana_iso: iso.isoWeek,
    anio_semana_iso: iso.isoYear,
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    user_id: interaction.user.id,
    username: interaction.user.username,
    display_name: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    conteo: 1
  };
}

function getCurrentPeriod() {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);
  const iso = getIsoWeekFromParts(local.year, local.month, local.day);

  return {
    year: local.year,
    month: local.month,
    isoYear: iso.isoYear,
    isoWeek: iso.isoWeek
  };
}

module.exports = {
  getLocalParts,
  getLocalDateText,
  getIsoWeekFromParts,
  buildTiradaRow,
  getCurrentPeriod
};
