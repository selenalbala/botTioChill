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
const {
  getMemberRoleIds,
  getCurrentWeekRange
} = require("./complianceService");

const sqlite = dbModule.db;

const MEMBERS_CACHE_MS = Number(process.env.META_MONEY_MEMBERS_CACHE_MS || 5 * 60 * 1000);
const MEMBERS_RETRY_AFTER_MS = Number(process.env.META_MONEY_MEMBERS_RETRY_AFTER_MS || 30 * 1000);

let membersCache = {
  guildId: null,
  members: [],
  method: "empty",
  expiresAt: 0,
  blockedUntil: 0,
  errors: []
};

let pendingMembersFetch = null;

function nowIso() {
  return new Date().toISOString();
}

function parseRetryAfterMs(error) {
  const retryAfter = Number(error?.data?.retry_after ?? error?.retry_after ?? error?.retryAfter ?? 0);

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000) + 1000;
  }

  return MEMBERS_RETRY_AFTER_MS;
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
      guild_id TEXT,
      channel_id TEXT,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      amount INTEGER NOT NULL,
      actor_user_id TEXT,
      actor_username TEXT,
      actor_display_name TEXT,
      note TEXT,
      created_at_utc TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_meta_clean_payments_user
      ON meta_clean_payments(user_id);

    CREATE INDEX IF NOT EXISTS idx_meta_clean_payments_created
      ON meta_clean_payments(created_at_utc);

    CREATE TABLE IF NOT EXISTS meta_payment_panel_messages (
      channel_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
  `);

  const existing = sqlite.prepare(`
    SELECT id
    FROM meta_money_config
    WHERE id = 1
  `).get();

  if (!existing) {
    sqlite.prepare(`
      INSERT INTO meta_money_config
        (id, gross_per_tirada, clean_discount_percent, updated_at_utc)
      VALUES (1, ?, ?, ?)
    `).run(DEFAULT_GROSS_PER_TIRADA, DEFAULT_CLEAN_DISCOUNT_PERCENT, nowIso());
  }
}

function getMoneyConfig() {
  initMoneyTables();

  const row = sqlite.prepare(`
    SELECT *
    FROM meta_money_config
    WHERE id = 1
  `).get();

  const grossPerTirada = Number(row?.gross_per_tirada ?? DEFAULT_GROSS_PER_TIRADA);
  const cleanDiscountPercent = Number(row?.clean_discount_percent ?? DEFAULT_CLEAN_DISCOUNT_PERCENT);

  return {
    grossPerTirada,
    cleanDiscountPercent,
    cleanPerTirada: Math.round(grossPerTirada * (1 - cleanDiscountPercent / 100)),
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
    INSERT INTO meta_money_config
      (id, gross_per_tirada, clean_discount_percent, updated_at_utc)
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
    SELECT
      user_id,
      substr(fecha_local, 1, 10) AS fecha,
      COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND fecha_local >= ?
      AND fecha_local <= ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id, substr(fecha_local, 1, 10)
  `).all(channelId, desdeText, hastaText);

  const map = new Map();

  for (const row of rows) {
    if (!map.has(row.user_id)) {
      map.set(row.user_id, new Map());
    }

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

  for (let i = 0; i < 366; i++) {
    dates.push(current);

    if (current === hasta) {
      break;
    }

    current = addDaysToYmd(current, 1);
  }

  return dates;
}

function isGroupMember(member) {
  return getMemberRoleIds(member).some(roleId =>
    MEMBER_ROLE_ID_SET.has(String(roleId))
  );
}

function getDisplayNameFromMember(member) {
  return (
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    member?.id ||
    "Desconocido"
  );
}

async function fetchMembersWithRestList(guild) {
  if (!guild?.members || typeof guild.members.list !== "function") {
    return [];
  }

  const all = new Map();
  let after = "0";

  for (let i = 0; i < 30; i++) {
    const page = await guild.members.list({
      limit: 1000,
      after
    });

    if (!page || page.size === 0) {
      break;
    }

    for (const [id, member] of page) {
      all.set(id, member);
    }

    const ids = [...page.keys()].sort((a, b) => {
      const aa = BigInt(a);
      const bb = BigInt(b);

      if (aa < bb) return -1;
      if (aa > bb) return 1;
      return 0;
    });

    after = ids[ids.length - 1];

    if (page.size < 1000) {
      break;
    }
  }

  return [...all.values()];
}

async function fetchMembersWithGateway(guild) {
  const collection = await guild.members.fetch({
    withPresences: false,
    time: 30000
  });

  return [...collection.values()];
}

async function fetchGuildMembers(guild, options = {}) {
  if (!guild) {
    return [];
  }

  const force = options.force === true;
  const now = Date.now();

  if (
    !force &&
    membersCache.guildId === guild.id &&
    membersCache.members.length > 0 &&
    membersCache.expiresAt > now
  ) {
    return membersCache.members;
  }

  if (
    !force &&
    membersCache.guildId === guild.id &&
    membersCache.blockedUntil > now
  ) {
    return membersCache.members.length
      ? membersCache.members
      : [...guild.members.cache.values()];
  }

  if (!force && pendingMembersFetch) {
    return pendingMembersFetch;
  }

  pendingMembersFetch = (async () => {
    const errors = [];

    try {
      const restMembers = await fetchMembersWithRestList(guild);

      if (restMembers.length > 0) {
        membersCache = {
          guildId: guild.id,
          members: restMembers,
          method: "rest_list",
          expiresAt: Date.now() + MEMBERS_CACHE_MS,
          blockedUntil: 0,
          errors
        };

        return restMembers;
      }
    } catch (error) {
      errors.push(`rest_list: ${error.message}`);
      console.warn("[META MONEY] No se pudieron cargar miembros por REST:", error.message);
    }

    try {
      const gatewayMembers = await fetchMembersWithGateway(guild);

      if (gatewayMembers.length > 0) {
        membersCache = {
          guildId: guild.id,
          members: gatewayMembers,
          method: "gateway_fetch",
          expiresAt: Date.now() + MEMBERS_CACHE_MS,
          blockedUntil: 0,
          errors
        };

        return gatewayMembers;
      }
    } catch (error) {
      const retryAfterMs = parseRetryAfterMs(error);

      errors.push(`gateway_fetch: ${error.message}`);

      membersCache = {
        guildId: guild.id,
        members:
          membersCache.guildId === guild.id && membersCache.members.length
            ? membersCache.members
            : [...guild.members.cache.values()],
        method: "cache_fallback",
        expiresAt: Date.now() + Math.min(MEMBERS_CACHE_MS, retryAfterMs),
        blockedUntil: Date.now() + retryAfterMs,
        errors
      };

      console.warn(
        `[META MONEY] Discord ha limitado la carga de miembros. Se usará caché durante ${Math.ceil(retryAfterMs / 1000)}s.`,
        error.message
      );

      return membersCache.members;
    } finally {
      pendingMembersFetch = null;
    }

    membersCache = {
      guildId: guild.id,
      members: [...guild.members.cache.values()],
      method: "cache_only",
      expiresAt: Date.now() + MEMBERS_CACHE_MS,
      blockedUntil: 0,
      errors
    };

    return membersCache.members;
  })();

  return pendingMembersFetch;
}

function getUsersFromTiradas(channelId = TARGET_CHANNEL_ID) {
  const rows = sqlite.prepare(`
    SELECT
      user_id,
      MAX(username) AS username,
      MAX(display_name) AS display_name
    FROM tiradas
    WHERE channel_id = ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
  `).all(channelId);

  return rows.map(row => ({
    userId: String(row.user_id),
    username: row.username || String(row.user_id),
    displayName: row.display_name || row.username || String(row.user_id),
    roleIds: [],
    fromHistory: true
  }));
}

async function getGroupMembers(guild, channelId = TARGET_CHANNEL_ID) {
  const byId = new Map();

  if (guild) {
    const members = await fetchGuildMembers(guild);

    for (const member of members) {
      if (member.user?.bot) {
        continue;
      }

      if (!isGroupMember(member)) {
        continue;
      }

      byId.set(String(member.id), {
        userId: String(member.id),
        username: member.user?.username || String(member.id),
        displayName: getDisplayNameFromMember(member),
        roleIds: getMemberRoleIds(member).map(String),
        fromDiscord: true
      });
    }
  }

  for (const user of getUsersFromTiradas(channelId)) {
    if (!byId.has(String(user.userId))) {
      byId.set(String(user.userId), user);
    }
  }

  return [...byId.values()].sort((a, b) =>
    String(a.displayName).localeCompare(String(b.displayName), "es")
  );
}

function calculateExtras(dailyCounts, dates) {
  const totalsByDay = dates.map(fecha => {
    const total = Math.max(Number(dailyCounts.get(fecha) || 0), 0);

    return {
      fecha,
      total,
      extra: Math.max(total - DAILY_REQUIRED_TIRADAS, 0)
    };
  });

  const weekTotal = totalsByDay.reduce((acc, item) => acc + item.total, 0);
  const extraByDaily = totalsByDay.reduce((acc, item) => acc + item.extra, 0);
  const extraByWeekly = Math.max(weekTotal - WEEKLY_REQUIRED_TIRADAS, 0);

  return {
    totalsByDay,
    weekTotal,
    extraByDaily,
    extraByWeekly,

    /*
      Regla corregida:
      - El exceso diario se muestra como control.
      - El dinero limpio solo se genera cuando la semana supera 14 tiradas.
    */
    extraTiradas: extraByWeekly,

    dailyOk: totalsByDay.every(item => item.total >= DAILY_REQUIRED_TIRADAS),
    weeklyOk: weekTotal >= WEEKLY_REQUIRED_TIRADAS
  };
}

function getLifetimeGeneratedByUserMap({
  channelId = TARGET_CHANNEL_ID,
  cleanPerTirada,
  grossPerTirada
}) {
  const rows = sqlite.prepare(`
    SELECT
      user_id,
      anio,
      semana_iso,
      COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id, anio, semana_iso
  `).all(channelId);

  const map = new Map();

  for (const row of rows) {
    const userId = String(row.user_id);
    const weekTotal = Math.max(Number(row.total || 0), 0);
    const extra = Math.max(weekTotal - WEEKLY_REQUIRED_TIRADAS, 0);

    if (!map.has(userId)) {
      map.set(userId, {
        generatedExtraTiradasTotal: 0,
        generatedCleanTotal: 0,
        generatedGrossTotal: 0
      });
    }

    const item = map.get(userId);

    item.generatedExtraTiradasTotal += extra;
    item.generatedCleanTotal += extra * cleanPerTirada;
    item.generatedGrossTotal += extra * grossPerTirada;
  }

  return map;
}

function getPaymentsByUserMap() {
  initMoneyTables();

  const rows = sqlite.prepare(`
    SELECT
      user_id,
      COALESCE(SUM(amount), 0) AS total_paid
    FROM meta_clean_payments
    GROUP BY user_id
  `).all();

  const map = new Map();

  for (const row of rows) {
    map.set(String(row.user_id), Number(row.total_paid || 0));
  }

  return map;
}

function getPaymentPanelMessage(channelId) {
  initMoneyTables();

  return sqlite.prepare(`
    SELECT channel_id, message_id, updated_at_utc
    FROM meta_payment_panel_messages
    WHERE channel_id = ?
  `).get(String(channelId));
}

function savePaymentPanelMessage(channelId, messageId) {
  initMoneyTables();

  sqlite.prepare(`
    INSERT INTO meta_payment_panel_messages
      (channel_id, message_id, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      message_id = excluded.message_id,
      updated_at_utc = excluded.updated_at_utc
  `).run(String(channelId), String(messageId), nowIso());

  return getPaymentPanelMessage(channelId);
}

function recordCleanPayment({
  guildId,
  channelId,
  userId,
  username,
  displayName,
  amount,
  actorUserId,
  actorUsername,
  actorDisplayName,
  note
}) {
  initMoneyTables();

  const cleanAmount = Number(amount);

  if (!Number.isInteger(cleanAmount) || cleanAmount <= 0 || cleanAmount > 1000000000) {
    throw new Error("La cantidad pagada debe ser un número entero mayor que 0.");
  }

  const info = sqlite.prepare(`
    INSERT INTO meta_clean_payments
      (
        guild_id,
        channel_id,
        user_id,
        username,
        display_name,
        amount,
        actor_user_id,
        actor_username,
        actor_display_name,
        note,
        created_at_utc
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId || null,
    channelId || null,
    String(userId),
    username || String(userId),
    displayName || username || String(userId),
    cleanAmount,
    actorUserId || null,
    actorUsername || null,
    actorDisplayName || actorUsername || null,
    note || null,
    nowIso()
  );

  return sqlite.prepare(`
    SELECT *
    FROM meta_clean_payments
    WHERE id = ?
  `).get(info.lastInsertRowid);
}

function listCleanPayments({ userId, limit = 100 } = {}) {
  initMoneyTables();

  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);

  if (userId) {
    return sqlite.prepare(`
      SELECT *
      FROM meta_clean_payments
      WHERE user_id = ?
      ORDER BY created_at_utc DESC, id DESC
      LIMIT ?
    `).all(String(userId), safeLimit);
  }

  return sqlite.prepare(`
    SELECT *
    FROM meta_clean_payments
    ORDER BY created_at_utc DESC, id DESC
    LIMIT ?
  `).all(safeLimit);
}

async function buildBonusSummary({
  guild,
  channelId = TARGET_CHANNEL_ID,
  desde,
  hasta,
  onlyDiscordUserId
} = {}) {
  initMoneyTables();

  const range = desde && hasta
    ? { start: desde, end: hasta }
    : getCurrentWeekRange(TIMEZONE);

  const fechas = datesBetween(range.start, range.end);
  const moneyConfig = getMoneyConfig();

  const countsMap = getDailyCountsMap({
    channelId,
    desde: range.start,
    hasta: range.end
  });

  const lifetimeMap = getLifetimeGeneratedByUserMap({
    channelId,
    cleanPerTirada: moneyConfig.cleanPerTirada,
    grossPerTirada: moneyConfig.grossPerTirada
  });

  const paymentsMap = getPaymentsByUserMap();

  let members = await getGroupMembers(guild, channelId);

  if (onlyDiscordUserId) {
    members = members.filter(member =>
      String(member.userId) === String(onlyDiscordUserId)
    );

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

  const memberIds = new Set(members.map(member => String(member.userId)));

  if (!onlyDiscordUserId) {
    for (const userId of new Set([...lifetimeMap.keys(), ...paymentsMap.keys()])) {
      if (memberIds.has(String(userId))) {
        continue;
      }

      const summary = dbModule.getUserSummary(String(userId));

      members.push({
        userId: String(userId),
        username: summary?.username || String(userId),
        displayName: summary?.display_name || summary?.username || String(userId),
        roleIds: [],
        fromHistory: true
      });

      memberIds.add(String(userId));
    }
  }

  const rows = members.map(member => {
    const dailyCounts = countsMap.get(String(member.userId)) || new Map();
    const calculated = calculateExtras(dailyCounts, fechas);

    const cleanTotal = calculated.extraTiradas * moneyConfig.cleanPerTirada;
    const grossTotal = calculated.extraTiradas * moneyConfig.grossPerTirada;

    const lifetime = lifetimeMap.get(String(member.userId)) || {
      generatedExtraTiradasTotal: 0,
      generatedCleanTotal: 0,
      generatedGrossTotal: 0
    };

    const paidCleanTotal = paymentsMap.get(String(member.userId)) || 0;
    const balanceCleanTotal = lifetime.generatedCleanTotal - paidCleanTotal;
    const pendingCleanTotal = Math.max(balanceCleanTotal, 0);

    return {
      userId: member.userId,
      username: member.username,
      displayName: member.displayName,
      roleIds: member.roleIds,
      fromHistory: member.fromHistory === true,

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
      days: calculated.totalsByDay,

      generatedExtraTiradasTotal: lifetime.generatedExtraTiradasTotal,
      generatedGrossTotal: lifetime.generatedGrossTotal,
      generatedCleanTotal: lifetime.generatedCleanTotal,
      paidCleanTotal,
      balanceCleanTotal,
      pendingCleanTotal
    };
  });

  rows.sort((a, b) => {
    if (b.pendingCleanTotal !== a.pendingCleanTotal) {
      return b.pendingCleanTotal - a.pendingCleanTotal;
    }

    if (b.generatedCleanTotal !== a.generatedCleanTotal) {
      return b.generatedCleanTotal - a.generatedCleanTotal;
    }

    if (b.cleanTotal !== a.cleanTotal) {
      return b.cleanTotal - a.cleanTotal;
    }

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
      grossTotal: rows.reduce((acc, row) => acc + row.grossTotal, 0),
      generatedExtraTiradasTotal: rows.reduce((acc, row) => acc + row.generatedExtraTiradasTotal, 0),
      generatedCleanTotal: rows.reduce((acc, row) => acc + row.generatedCleanTotal, 0),
      generatedGrossTotal: rows.reduce((acc, row) => acc + row.generatedGrossTotal, 0),
      paidCleanTotal: rows.reduce((acc, row) => acc + row.paidCleanTotal, 0),
      pendingCleanTotal: rows.reduce((acc, row) => acc + row.pendingCleanTotal, 0),
      balanceCleanTotal: rows.reduce((acc, row) => acc + row.balanceCleanTotal, 0)
    },
    debug: {
      memberCache: {
        guildId: membersCache.guildId,
        method: membersCache.method,
        size: membersCache.members.length,
        expiresAt: membersCache.expiresAt,
        blockedUntil: membersCache.blockedUntil,
        errors: membersCache.errors
      }
    }
  };
}

function getWeekTotalForUser(userId, {
  channelId = TARGET_CHANNEL_ID,
  desde,
  hasta
}) {
  return dbModule.getTotalByUserForLocalDateRange(
    channelId,
    String(userId),
    desde,
    hasta
  );
}

function buildManualAdjustmentRow({
  guildId,
  channelId,
  userId,
  username,
  displayName,
  delta
}) {
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

async function setUserWeekTotal({
  guild,
  channelId = TARGET_CHANNEL_ID,
  userId,
  total
}) {
  const newTotal = Number(total);

  if (!Number.isInteger(newTotal) || newTotal < 0 || newTotal > 10000) {
    throw new Error("El total semanal debe ser un número entero entre 0 y 10000.");
  }

  const range = getCurrentWeekRange(TIMEZONE);

  const before = getWeekTotalForUser(userId, {
    channelId,
    desde: range.start,
    hasta: range.end
  });

  const delta = newTotal - before;

  if (delta === 0) {
    return {
      before,
      after: newTotal,
      delta,
      range
    };
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
    displayName: member
      ? getDisplayNameFromMember(member)
      : (summary?.display_name || summary?.username || String(userId)),
    delta
  }));

  return {
    before,
    after: newTotal,
    delta,
    range
  };
}

module.exports = {
  initMoneyTables,
  getMoneyConfig,
  setMoneyConfig,
  buildBonusSummary,
  setUserWeekTotal,
  recordCleanPayment,
  listCleanPayments,
  getPaymentPanelMessage,
  savePaymentPanelMessage
};
