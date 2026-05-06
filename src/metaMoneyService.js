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

    CREATE TABLE IF NOT EXISTS meta_clean_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_utc TEXT NOT NULL,
      fecha_local TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      amount INTEGER NOT NULL,
      actor_user_id TEXT,
      actor_username TEXT,
      actor_display_name TEXT,
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_meta_clean_payments_user ON meta_clean_payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_meta_clean_payments_created ON meta_clean_payments(created_at_utc);

    CREATE TABLE IF NOT EXISTS meta_clean_payment_panel_message (
      channel_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
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

function getAllTimeWeeklyExtrasMap({ channelId = TARGET_CHANNEL_ID } = {}) {
  const rows = sqlite.prepare(`
    SELECT user_id, anio, semana_iso, COALESCE(SUM(CASE WHEN conteo > 0 THEN conteo ELSE 0 END), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id, anio, semana_iso
  `).all(channelId);

  const map = new Map();
  for (const row of rows) {
    const extra = Math.max(Number(row.total || 0) - WEEKLY_REQUIRED_TIRADAS, 0);
    if (!map.has(row.user_id)) map.set(row.user_id, 0);
    map.set(row.user_id, map.get(row.user_id) + extra);
  }
  return map;
}

function getPaidTotalsMap() {
  initMoneyTables();
  const rows = sqlite.prepare(`
    SELECT user_id, COALESCE(SUM(amount), 0) AS total
    FROM meta_clean_payments
    GROUP BY user_id
  `).all();

  const map = new Map();
  for (const row of rows) {
    map.set(String(row.user_id), Number(row.total || 0));
  }
  return map;
}

function getPaidTotalForUser(userId) {
  initMoneyTables();
  const row = sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM meta_clean_payments
    WHERE user_id = ?
  `).get(String(userId));
  return Number(row?.total || 0);
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

    // Regla de pago corregida: solo se paga lo que supere 14 semanal.
    // El extra diario se muestra para control, pero no genera dinero si la semana no supera 14.
    extraTiradas: extraByWeekly,
    dailyOk: totalsByDay.every(item => item.total >= DAILY_REQUIRED_TIRADAS),
    weeklyOk: weekTotal >= WEEKLY_REQUIRED_TIRADAS
  };
}

function addMissingMembersFromTiradas(members, channelId = TARGET_CHANNEL_ID) {
  const existingIds = new Set(members.map(member => String(member.userId)));
  const rows = sqlite.prepare(`
    SELECT user_id, MAX(username) AS username, MAX(display_name) AS display_name
    FROM tiradas
    WHERE channel_id = ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
  `).all(channelId);

  for (const row of rows) {
    if (existingIds.has(String(row.user_id))) continue;
    members.push({
      userId: String(row.user_id),
      username: row.username || String(row.user_id),
      displayName: row.display_name || row.username || String(row.user_id),
      roleIds: []
    });
  }

  return members.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "es"));
}

async function buildBonusSummary({ guild, channelId = TARGET_CHANNEL_ID, desde, hasta, onlyDiscordUserId } = {}) {
  initMoneyTables();

  const range = desde && hasta ? { start: desde, end: hasta } : getCurrentWeekRange(TIMEZONE);
  const fechas = datesBetween(range.start, range.end);
  const moneyConfig = getMoneyConfig();
  const countsMap = getDailyCountsMap({ channelId, desde: range.start, hasta: range.end });
  const allTimeExtrasMap = getAllTimeWeeklyExtrasMap({ channelId });
  const paidTotalsMap = getPaidTotalsMap();

  let members = await getGroupMembers(guild);
  members = addMissingMembersFromTiradas(members, channelId);

  if (onlyDiscordUserId) {
    members = members.filter(member => String(member.userId) === String(onlyDiscordUserId));

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
    const currentWeekCleanTotal = calculated.extraTiradas * moneyConfig.cleanPerTirada;
    const currentWeekGrossTotal = calculated.extraTiradas * moneyConfig.grossPerTirada;

    const allTimeExtraTiradas = Number(allTimeExtrasMap.get(member.userId) || 0);
    const generatedCleanTotal = allTimeExtraTiradas * moneyConfig.cleanPerTirada;
    const generatedGrossTotal = allTimeExtraTiradas * moneyConfig.grossPerTirada;
    const paidCleanTotal = Number(paidTotalsMap.get(String(member.userId)) || 0);
    const pendingCleanTotal = Math.max(generatedCleanTotal - paidCleanTotal, 0);

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
      allTimeExtraTiradas,
      grossPerTirada: moneyConfig.grossPerTirada,
      cleanDiscountPercent: moneyConfig.cleanDiscountPercent,
      cleanPerTirada: moneyConfig.cleanPerTirada,
      grossTotal: generatedGrossTotal,
      cleanTotal: pendingCleanTotal,
      currentWeekCleanTotal,
      currentWeekGrossTotal,
      generatedCleanTotal,
      generatedGrossTotal,
      paidCleanTotal,
      pendingCleanTotal,
      days: calculated.totalsByDay
    };
  });

  rows.sort((a, b) => {
    if (b.pendingCleanTotal !== a.pendingCleanTotal) return b.pendingCleanTotal - a.pendingCleanTotal;
    if (b.generatedCleanTotal !== a.generatedCleanTotal) return b.generatedCleanTotal - a.generatedCleanTotal;
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
      allTimeExtraTiradas: rows.reduce((acc, row) => acc + row.allTimeExtraTiradas, 0),
      currentWeekCleanTotal: rows.reduce((acc, row) => acc + row.currentWeekCleanTotal, 0),
      generatedCleanTotal: rows.reduce((acc, row) => acc + row.generatedCleanTotal, 0),
      paidCleanTotal: rows.reduce((acc, row) => acc + row.paidCleanTotal, 0),
      pendingCleanTotal: rows.reduce((acc, row) => acc + row.pendingCleanTotal, 0),
      cleanTotal: rows.reduce((acc, row) => acc + row.pendingCleanTotal, 0),
      grossTotal: rows.reduce((acc, row) => acc + row.generatedGrossTotal, 0)
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

function recordCleanPayment({ guildId, channelId, userId, username, displayName, amount, actorUserId, actorUsername, actorDisplayName, note }) {
  initMoneyTables();

  const cleanAmount = Number(amount);
  if (!Number.isInteger(cleanAmount) || cleanAmount <= 0 || cleanAmount > 1000000000) {
    throw new Error("La cantidad pagada debe ser un número entero mayor que 0.");
  }

  const now = new Date();
  const result = sqlite.prepare(`
    INSERT INTO meta_clean_payments (
      created_at_utc, fecha_local, guild_id, channel_id,
      user_id, username, display_name, amount,
      actor_user_id, actor_username, actor_display_name, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now.toISOString(),
    getLocalDateText(now, TIMEZONE),
    guildId || process.env.GUILD_ID || null,
    channelId || null,
    String(userId),
    username || String(userId),
    displayName || username || String(userId),
    cleanAmount,
    actorUserId || null,
    actorUsername || null,
    actorDisplayName || actorUsername || null,
    note || null
  );

  return getCleanPaymentById(result.lastInsertRowid);
}

function getCleanPaymentById(id) {
  initMoneyTables();
  return sqlite.prepare(`SELECT * FROM meta_clean_payments WHERE id = ?`).get(id);
}

function getCleanPayments({ userId, limit = 50 } = {}) {
  initMoneyTables();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (userId) {
    return sqlite.prepare(`
      SELECT * FROM meta_clean_payments
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(String(userId), safeLimit);
  }

  return sqlite.prepare(`
    SELECT * FROM meta_clean_payments
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit);
}

function getPaymentPanelMessage(channelId) {
  initMoneyTables();
  return sqlite.prepare(`
    SELECT * FROM meta_clean_payment_panel_message
    WHERE channel_id = ?
  `).get(String(channelId));
}

function savePaymentPanelMessage(channelId, messageId) {
  initMoneyTables();
  return sqlite.prepare(`
    INSERT OR REPLACE INTO meta_clean_payment_panel_message (channel_id, message_id, updated_at_utc)
    VALUES (?, ?, ?)
  `).run(String(channelId), String(messageId), nowIso());
}

module.exports = {
  initMoneyTables,
  getMoneyConfig,
  setMoneyConfig,
  buildBonusSummary,
  setUserWeekTotal,
  recordCleanPayment,
  getCleanPaymentById,
  getCleanPayments,
  getPaidTotalForUser,
  getPaymentPanelMessage,
  savePaymentPanelMessage
};
