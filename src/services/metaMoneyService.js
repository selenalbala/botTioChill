const dbModule = require("../db");
const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  DAILY_REQUIRED_TIRADAS,
  WEEKLY_REQUIRED_TIRADAS,
  DEFAULT_GROSS_PER_TIRADA,
  DEFAULT_CLEAN_DISCOUNT_PERCENT,
  MEMBER_ROLE_ID_SET,
  MEMBER_ROLE_IDS
} = require("../config");
const {
  getLocalParts,
  getLocalDateText,
  getIsoWeekFromParts
} = require("./metaService");
const { getMemberRoleIds, getCurrentWeekRange } = require("./complianceService");

const sqlite = dbModule.db;

function nowIso() {
  return new Date().toISOString();
}

function initMoneyTables() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS meta_money_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      gross_per_tirada INTEGER NOT NULL DEFAULT 40000,
      clean_discount_percent REAL NOT NULL DEFAULT 25,
      updated_at_utc TEXT NOT NULL
    );
  `);

  const existing = sqlite.prepare(`SELECT id FROM meta_money_config WHERE id = 1`).get();
  if (!existing) {
    sqlite.prepare(`
      INSERT INTO meta_money_config (id, gross_per_tirada, clean_discount_percent, updated_at_utc)
      VALUES (1, ?, ?, ?)
    `).run(DEFAULT_GROSS_PER_TIRADA, DEFAULT_CLEAN_DISCOUNT_PERCENT, nowIso());
  }
}

function getMoneyConfig() {
  initMoneyTables();
  const row = sqlite.prepare(`SELECT * FROM meta_money_config WHERE id = 1`).get();
  return {
    grossPerTirada: Number(row?.gross_per_tirada ?? DEFAULT_GROSS_PER_TIRADA),
    cleanDiscountPercent: Number(row?.clean_discount_percent ?? DEFAULT_CLEAN_DISCOUNT_PERCENT),
    cleanPerTirada: Math.round(
      Number(row?.gross_per_tirada ?? DEFAULT_GROSS_PER_TIRADA) *
      (1 - Number(row?.clean_discount_percent ?? DEFAULT_CLEAN_DISCOUNT_PERCENT) / 100)
    ),
    updatedAtUtc: row?.updated_at_utc || null
  };
}

function setMoneyConfig({ grossPerTirada, cleanDiscountPercent }) {
  initMoneyTables();

  const gross = Number(grossPerTirada);
  const percent = Number(cleanDiscountPercent);

  if (!Number.isFinite(gross) || gross < 0 || gross > 100000000) {
    throw new Error("El importe por tirada debe ser un número válido.");
  }

  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("El porcentaje debe estar entre 0 y 100.");
  }

  sqlite.prepare(`
    INSERT INTO meta_money_config (id, gross_per_tirada, clean_discount_percent, updated_at_utc)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      gross_per_tirada = excluded.gross_per_tirada,
      clean_discount_percent = excluded.clean_discount_percent,
      updated_at_utc = excluded.updated_at_utc
  `).run(Math.round(gross), percent, nowIso());

  return getMoneyConfig();
}

function ymdRangeWhere(desde, hasta) {
  return {
    desdeText: `${desde} 00:00:00`,
    hastaText: `${hasta} 23:59:59`
  };
}

function getDailyCountsMap({ channelId = TARGET_CHANNEL_ID, desde, hasta }) {
  const { desdeText, hastaText } = ymdRangeWhere(desde, hasta);
  const rows = sqlite.prepare(`
    SELECT user_id, substr(fecha_local, 1, 10) AS fecha, COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND fecha_local >= ?
      AND fecha_local <= ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id, substr(fecha_local, 1, 10)
  `).all(channelId, desdeText, hastaText);

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, new Map());
    map.get(row.user_id).set(row.fecha, Number(row.total || 0));
  }
  return map;
}

function addDaysToYmd(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function datesBetween(desde, hasta) {
  const dates = [];
  let current = desde;
  for (let i = 0; i < 14; i++) {
    dates.push(current);
    if (current === hasta) break;
    current = addDaysToYmd(current, 1);
  }
  return dates;
}

async function fetchGuildMembers(guild) {
  if (!guild) return [];
  try {
    const collection = await guild.members.fetch({ withPresences: false, time: 30000 });
    return [...collection.values()];
  } catch (error) {
    console.error("[META MONEY] No se pudieron cargar todos los miembros por gateway:", error.message);
    return [...guild.members.cache.values()];
  }
}

function isGroupMember(member) {
  return getMemberRoleIds(member).some(roleId => MEMBER_ROLE_ID_SET.has(String(roleId)));
}

function getDisplayNameFromMember(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || member?.id || "Desconocido";
}

async function getGroupMembers(guild) {
  const members = await fetchGuildMembers(guild);
  return members
    .filter(member => !member.user?.bot)
    .filter(isGroupMember)
    .map(member => ({
      userId: member.id,
      username: member.user?.username || member.id,
      displayName: getDisplayNameFromMember(member),
      roleIds: getMemberRoleIds(member)
    }))
    .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "es"));
}

function calculateExtras(dailyCounts, dates) {
  const totalsByDay = dates.map(fecha => ({
    fecha,
    total: Number(dailyCounts.get(fecha) || 0),
    extra: Math.max(Number(dailyCounts.get(fecha) || 0) - DAILY_REQUIRED_TIRADAS, 0)
  }));

  const weekTotal = totalsByDay.reduce((acc, item) => acc + item.total, 0);
  const extraByDaily = totalsByDay.reduce((acc, item) => acc + item.extra, 0);
  const extraByWeekly = Math.max(weekTotal - WEEKLY_REQUIRED_TIRADAS, 0);

  return {
    totalsByDay,
    weekTotal,
    extraByDaily,
    extraByWeekly,
    extraTiradas: Math.max(extraByDaily, extraByWeekly),
    dailyOk: totalsByDay.every(item => item.total >= DAILY_REQUIRED_TIRADAS),
    weeklyOk: weekTotal >= WEEKLY_REQUIRED_TIRADAS
  };
}

async function buildBonusSummary({ guild, channelId = TARGET_CHANNEL_ID, desde, hasta, onlyDiscordUserId } = {}) {
  initMoneyTables();

  const range = desde && hasta ? { start: desde, end: hasta } : getCurrentWeekRange(TIMEZONE);
  const fechas = datesBetween(range.start, range.end);
  const moneyConfig = getMoneyConfig();
  const countsMap = getDailyCountsMap({ channelId, desde: range.start, hasta: range.end });

  let members = await getGroupMembers(guild);

  if (onlyDiscordUserId) {
    members = members.filter(member => String(member.userId) === String(onlyDiscordUserId));

    // Si el usuario no está en caché pero tiene tiradas, lo mostramos igualmente.
    if (!members.length) {
      const summary = dbModule.getUserSummary(String(onlyDiscordUserId));
      if (summary) {
        members.push({
          userId: String(onlyDiscordUserId),
          username: summary.username || String(onlyDiscordUserId),
          displayName: summary.display_name || summary.username || String(onlyDiscordUserId),
          roleIds: []
        });
      }
    }
  }

  const rows = members.map(member => {
    const dailyCounts = countsMap.get(member.userId) || new Map();
    const calculated = calculateExtras(dailyCounts, fechas);
    const cleanTotal = calculated.extraTiradas * moneyConfig.cleanPerTirada;
    const grossTotal = calculated.extraTiradas * moneyConfig.grossPerTirada;

    return {
      userId: member.userId,
      username: member.username,
      displayName: member.displayName,
      roleIds: member.roleIds,
      weekTotal: calculated.weekTotal,
      dailyRequired: DAILY_REQUIRED_TIRADAS,
      weeklyRequired: WEEKLY_REQUIRED_TIRADAS,
      dailyOk: calculated.dailyOk,
      weeklyOk: calculated.weeklyOk,
      extraByDaily: calculated.extraByDaily,
      extraByWeekly: calculated.extraByWeekly,
      extraTiradas: calculated.extraTiradas,
      grossPerTirada: moneyConfig.grossPerTirada,
      cleanDiscountPercent: moneyConfig.cleanDiscountPercent,
      cleanPerTirada: moneyConfig.cleanPerTirada,
      grossTotal,
      cleanTotal,
      days: calculated.totalsByDay
    };
  });

  rows.sort((a, b) => {
    if (b.cleanTotal !== a.cleanTotal) return b.cleanTotal - a.cleanTotal;
    if (b.extraTiradas !== a.extraTiradas) return b.extraTiradas - a.extraTiradas;
    return String(a.displayName).localeCompare(String(b.displayName), "es");
  });

  return {
    range,
    dates: fechas,
    memberRoleIds: MEMBER_ROLE_IDS,
    dailyRequired: DAILY_REQUIRED_TIRADAS,
    weeklyRequired: WEEKLY_REQUIRED_TIRADAS,
    moneyConfig,
    rows,
    totals: {
      members: rows.length,
      extraTiradas: rows.reduce((acc, row) => acc + row.extraTiradas, 0),
      cleanTotal: rows.reduce((acc, row) => acc + row.cleanTotal, 0),
      grossTotal: rows.reduce((acc, row) => acc + row.grossTotal, 0)
    }
  };
}

function getWeekTotalForUser(userId, { channelId = TARGET_CHANNEL_ID, desde, hasta }) {
  return dbModule.getTotalByUserForLocalDateRange(channelId, String(userId), desde, hasta);
}

function buildManualAdjustmentRow({ guildId, channelId, userId, username, displayName, delta }) {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);

  return {
    timestamp_utc: now.toISOString(),
    fecha_local: getLocalDateText(now, TIMEZONE),
    anio: local.year,
    mes: local.month,
    dia: local.day,
    semana_iso: getIsoWeekFromParts(local.year, local.month, local.day),
    guild_id: guildId || process.env.GUILD_ID || "panel-web",
    channel_id: channelId || TARGET_CHANNEL_ID,
    user_id: String(userId),
    username: username || String(userId),
    display_name: displayName || username || String(userId),
    conteo: Number(delta)
  };
}

async function setUserWeekTotal({ guild, channelId = TARGET_CHANNEL_ID, userId, total }) {
  const newTotal = Number(total);
  if (!Number.isInteger(newTotal) || newTotal < 0 || newTotal > 10000) {
    throw new Error("El total semanal debe ser un número entero entre 0 y 10000.");
  }

  const range = getCurrentWeekRange(TIMEZONE);
  const before = getWeekTotalForUser(userId, { channelId, desde: range.start, hasta: range.end });
  const delta = newTotal - before;

  if (delta === 0) {
    return { before, after: newTotal, delta, range };
  }

  let member = null;
  if (guild) {
    member = await guild.members.fetch(String(userId)).catch(() => null);
  }

  const summary = dbModule.getUserSummary(String(userId));
  dbModule.insertTirada(buildManualAdjustmentRow({
    guildId: guild?.id || summary?.guild_id,
    channelId,
    userId,
    username: member?.user?.username || summary?.username || String(userId),
    displayName: member ? getDisplayNameFromMember(member) : (summary?.display_name || summary?.username || String(userId)),
    delta
  }));

  return { before, after: newTotal, delta, range };
}

module.exports = {
  initMoneyTables,
  getMoneyConfig,
  setMoneyConfig,
  buildBonusSummary,
  setUserWeekTotal
};
