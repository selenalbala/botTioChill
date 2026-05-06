const bcrypt = require("bcryptjs");
const db = require("../db");
const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  TIRADA_COOLDOWN_MS,
  META_POR_TIRADA,
  DAILY_REQUIRED_TIRADAS,
  WEEKLY_REQUIRED_TIRADAS
} = require("../config");
const { getLocalYmd, getCurrentWeekRange } = require("./complianceService");
const { getMoneyConfig } = require("./metaMoneyService");

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function assertPassword(password) {
  const text = String(password || "");
  if (text.length < 6) {
    throw new Error("La contraseña debe tener al menos 6 caracteres.");
  }
  return text;
}

async function setMemberAccount({ discordUserId, webUsername, plainPassword, active = true }) {
  const userId = String(discordUserId || "").trim();
  const username = normalizeUsername(webUsername);

  if (!userId) throw new Error("Falta el ID de Discord del usuario.");
  if (!username) throw new Error("Falta el usuario de acceso.");

  const existing = db.getMemberWebAccountByDiscordId(userId);
  let passwordHash = existing?.password_hash || null;

  if (plainPassword !== undefined && String(plainPassword || "").trim() !== "") {
    passwordHash = await bcrypt.hash(assertPassword(plainPassword), 10);
  }

  if (!passwordHash) {
    throw new Error("Debes indicar una contraseña para crear la cuenta.");
  }

  db.upsertMemberWebAccount({
    discordUserId: userId,
    webUsername: username,
    passwordHash,
    active: active ? 1 : 0
  });

  return db.getMemberWebAccountByDiscordId(userId);
}

async function validateMemberLogin(username, password) {
  const normalized = normalizeUsername(username);
  const account = db.getMemberWebAccountByUsername(normalized);

  if (!account || Number(account.active) !== 1) return null;

  const ok = await bcrypt.compare(String(password || ""), account.password_hash);
  if (!ok) return null;

  db.markMemberWebAccountLogin(account.discord_user_id);
  return account;
}

function getNextTiradaInfo(channelId = TARGET_CHANNEL_ID) {
  const last = db.getLastButtonTiradaGlobal(channelId);

  if (!last) {
    return {
      available: true,
      lastUser: null,
      nextAtUtc: null,
      nextUnix: null,
      remainingMs: 0
    };
  }

  const lastMs = new Date(last.timestamp_utc).getTime();

  if (Number.isNaN(lastMs)) {
    return {
      available: true,
      lastUser: last.display_name || last.username || null,
      nextAtUtc: null,
      nextUnix: null,
      remainingMs: 0
    };
  }

  const nextMs = lastMs + TIRADA_COOLDOWN_MS;
  const remainingMs = nextMs - Date.now();

  return {
    available: remainingMs <= 0,
    lastUser: last.display_name || last.username || null,
    nextAtUtc: new Date(nextMs).toISOString(),
    nextUnix: Math.floor(nextMs / 1000),
    remainingMs: Math.max(remainingMs, 0)
  };
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

function getDailyCountsMapForUser(channelId, userId, desde, hasta) {
  const rows = db.db.prepare(`
    SELECT
      substr(fecha_local, 1, 10) AS fecha,
      COALESCE(SUM(CASE WHEN conteo > 0 THEN conteo ELSE 0 END), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND user_id = ?
      AND fecha_local >= ?
      AND fecha_local <= ?
    GROUP BY substr(fecha_local, 1, 10)
  `).all(channelId, String(userId), `${desde} 00:00:00`, `${hasta} 23:59:59`);

  return new Map(rows.map(row => [row.fecha, Number(row.total || 0)]));
}

function calculateExtraTiradas(dailyCounts, dates, weekTotal) {
  const days = dates.map(fecha => {
    const total = Number(dailyCounts.get(fecha) || 0);
    return {
      fecha,
      total,
      extra: Math.max(total - DAILY_REQUIRED_TIRADAS, 0)
    };
  });

  const extraByDaily = days.reduce((acc, day) => acc + day.extra, 0);
  const extraByWeekly = Math.max(Number(weekTotal || 0) - WEEKLY_REQUIRED_TIRADAS, 0);

  /*
    Regla corregida:
    - Se muestran las tiradas extra diarias para control interno.
    - Pero el dinero limpio solo se paga cuando la semana supera las 14 tiradas.
  */
  return {
    days,
    extraByDaily,
    extraByWeekly,
    extraTiradas: extraByWeekly
  };
}

function getMemberPrivateStats(userId) {
  const today = getLocalYmd(new Date(), TIMEZONE);
  const week = getCurrentWeekRange(TIMEZONE);

  const total = Number(db.getTotalByUser(userId));
  const pendingTiradas = Number(db.getPendingTiradasCountByUser(TARGET_CHANNEL_ID, userId));
  const todayCount = Number(db.getTotalByUserForLocalDateRange(TARGET_CHANNEL_ID, userId, today, today));
  const weekCount = Number(db.getTotalByUserForLocalDateRange(TARGET_CHANNEL_ID, userId, week.start, week.end));

  const account = db.getMemberWebAccountByDiscordId(userId);
  const summary = db.getUserSummary(userId);

  const moneyConfig = getMoneyConfig();
  const weekDates = datesBetween(week.start, week.end);
  const dailyCounts = getDailyCountsMapForUser(TARGET_CHANNEL_ID, userId, week.start, week.end);
  const extra = calculateExtraTiradas(dailyCounts, weekDates, weekCount);

  const grossTotal = extra.extraTiradas * moneyConfig.grossPerTirada;
  const cleanTotal = extra.extraTiradas * moneyConfig.cleanPerTirada;

  return {
    discordUserId: userId,
    username: account?.web_username || summary?.username || userId,
    displayName: summary?.display_name || account?.web_username || userId,

    total,
    pendingTiradas,
    pendingMeta: pendingTiradas * META_POR_TIRADA,

    today,
    todayCount,
    dailyRequired: DAILY_REQUIRED_TIRADAS,
    dailyOk: todayCount >= DAILY_REQUIRED_TIRADAS,

    week,
    weekCount,
    weeklyRequired: WEEKLY_REQUIRED_TIRADAS,
    weeklyOk: weekCount >= WEEKLY_REQUIRED_TIRADAS,
    weeklyMeta: weekCount * META_POR_TIRADA,

    extraByDaily: extra.extraByDaily,
    extraByWeekly: extra.extraByWeekly,
    extraTiradas: extra.extraTiradas,
    grossPerTirada: moneyConfig.grossPerTirada,
    cleanDiscountPercent: moneyConfig.cleanDiscountPercent,
    cleanPerTirada: moneyConfig.cleanPerTirada,
    grossTotal,
    cleanTotal,
    days: extra.days,

    nextTirada: getNextTiradaInfo(TARGET_CHANNEL_ID)
  };
}

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString("es-ES")} €`;
}

function buildDiscordTime(info) {
  if (!info || info.available || !info.nextUnix) return "ya está disponible";
  return `<t:${info.nextUnix}:R>`;
}

function buildMemberDmContent(userId, reason = "consulta") {
  const stats = getMemberPrivateStats(userId);
  const title = reason === "tirada_registrada" ? "✅ Tirada registrada" : "🏍️ Tu estado de meta";

  return [
    `**${title}**`,
    "",
    `Total histórico: **${stats.total}** tirada(s).`,
    `Hoy: **${stats.todayCount}/${stats.dailyRequired}** ${stats.dailyOk ? "✅" : "⏳"}`,
    `Esta semana: **${stats.weekCount}/${stats.weeklyRequired}** ${stats.weeklyOk ? "✅" : "⏳"}`,
    `Meta semanal generada: **${stats.weeklyMeta}**.`,
    `Pendiente para procesar: **${stats.pendingTiradas}** tirada(s) · **${stats.pendingMeta}** de meta.`,
    `Tiradas de más: **${stats.extraTiradas}**.`,
    `Dinero limpio a recibir: **${formatMoney(stats.cleanTotal)}**.`,
    "",
    `Siguiente tirada: **${buildDiscordTime(stats.nextTirada)}**`,
    stats.nextTirada?.lastUser ? `Última tirada registrada por: **${stats.nextTirada.lastUser}**.` : null
  ].filter(Boolean).join("\n");
}

async function sendMemberStatsDm(discordUser, reason = "consulta") {
  if (!discordUser?.send) return false;

  const content = buildMemberDmContent(discordUser.id, reason);
  await discordUser.send({ content });
  return true;
}

async function sendMemberCredentialsDm(client, { discordUserId, webUsername, plainPassword, publicUrl }) {
  if (!client || !discordUserId) return false;

  const user = await client.users.fetch(discordUserId).catch(() => null);
  if (!user) return false;

  const loginUrl = publicUrl
    ? `${String(publicUrl).replace(/\/$/, "")}/mi-meta/login`
    : "el panel /mi-meta/login";

  const lines = [
    "🏍️ **Acceso a tu panel de meta**",
    "",
    `URL: ${loginUrl}`,
    `Usuario: **${webUsername}**`,
    plainPassword ? `Contraseña: **${plainPassword}**` : "Contraseña: la que te haya indicado staff.",
    "",
    "Ahí podrás ver tus tiradas, tu meta de hoy, tu meta semanal, tu dinero limpio a recibir y cuándo se puede hacer la siguiente tirada."
  ];

  await user.send({ content: lines.join("\n") });
  return true;
}

module.exports = {
  setMemberAccount,
  validateMemberLogin,
  getNextTiradaInfo,
  getMemberPrivateStats,
  buildMemberDmContent,
  sendMemberStatsDm,
  sendMemberCredentialsDm
};
