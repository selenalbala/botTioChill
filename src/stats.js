function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function buildTiradaRow(interaction, timeZone = "Europe/Madrid") {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const parts = formatter.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value ?? "";

  const fechaLocal = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;

  return {
    timestamp_utc: now.toISOString(),
    fecha_local: fechaLocal,
    anio: Number(get("year")),
    mes: Number(get("month")),
    dia: Number(get("day")),
    semana_iso: getIsoWeek(now),
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    user_id: interaction.user.id,
    username: interaction.user.username,
    display_name: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    conteo: 1
  };
}

function sumRegistros(rows) {
  return rows.reduce((acc, row) => acc + Number(row.conteo || 0), 0);
}

module.exports = {
  buildTiradaRow,
  sumRegistros
};