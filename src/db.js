const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

require("dotenv").config();

const DEFAULT_DB_PATH = path.join(process.cwd(), "tiradas.db");
const DB_PATH = process.env.DB_PATH || DEFAULT_DB_PATH;

function ensureDbDirectory(dbPath) {
  if (!dbPath || dbPath === ":memory:") return;

  const directory = path.dirname(path.resolve(dbPath));

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

ensureDbDirectory(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function columnExists(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some(column => column.name === columnName);
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tiradas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_utc TEXT NOT NULL,
      fecha_local TEXT NOT NULL,
      anio INTEGER NOT NULL,
      mes INTEGER NOT NULL,
      dia INTEGER NOT NULL,
      semana_iso INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      conteo INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS procesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_utc TEXT NOT NULL,
      fecha_local TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      processor_user_id TEXT NOT NULL,
      processor_username TEXT NOT NULL,
      processor_display_name TEXT NOT NULL,
      tiradas_consumidas INTEGER NOT NULL,
      meta_total INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS empaquetados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_utc TEXT NOT NULL,
      fecha_local TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      packer_user_id TEXT NOT NULL,
      packer_username TEXT NOT NULL,
      packer_display_name TEXT NOT NULL,
      meta_empaquetada INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_logs (
      report_key TEXT PRIMARY KEY,
      sent_at_utc TEXT NOT NULL,
      channel_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS acciones_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_utc TEXT NOT NULL,
      fecha_local TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT,
      user_id TEXT,
      username TEXT,
      display_name TEXT,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS role_delete_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_utc TEXT NOT NULL,
      resolved_at_utc TEXT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      old_roles TEXT,
      new_roles TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by_user_id TEXT,
      resolved_by_username TEXT
    );

    CREATE TABLE IF NOT EXISTS meta_status_message (
      channel_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS member_web_accounts (
      discord_user_id TEXT PRIMARY KEY,
      web_username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      last_login_at_utc TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tiradas_user_id ON tiradas(user_id);
    CREATE INDEX IF NOT EXISTS idx_tiradas_anio_mes ON tiradas(anio, mes);
    CREATE INDEX IF NOT EXISTS idx_tiradas_anio_semana ON tiradas(anio, semana_iso);
    CREATE INDEX IF NOT EXISTS idx_tiradas_timestamp ON tiradas(timestamp_utc);
    CREATE INDEX IF NOT EXISTS idx_tiradas_fecha_local ON tiradas(fecha_local);
    CREATE INDEX IF NOT EXISTS idx_tiradas_channel_id ON tiradas(channel_id);
    CREATE INDEX IF NOT EXISTS idx_procesos_channel_id ON procesos(channel_id);
    CREATE INDEX IF NOT EXISTS idx_empaquetados_channel_id ON empaquetados(channel_id);
    CREATE INDEX IF NOT EXISTS idx_acciones_log_timestamp ON acciones_log(timestamp_utc);
    CREATE INDEX IF NOT EXISTS idx_role_delete_reviews_status ON role_delete_reviews(status);
    CREATE INDEX IF NOT EXISTS idx_role_delete_reviews_user ON role_delete_reviews(user_id);
    CREATE INDEX IF NOT EXISTS idx_member_web_accounts_username ON member_web_accounts(web_username);
  `);

  if (!columnExists("tiradas", "conteo_procesado")) {
    db.exec(`
      ALTER TABLE tiradas
      ADD COLUMN conteo_procesado INTEGER NOT NULL DEFAULT 0
    `);
  }

  if (!columnExists("procesos", "meta_empaquetada")) {
    db.exec(`
      ALTER TABLE procesos
      ADD COLUMN meta_empaquetada INTEGER NOT NULL DEFAULT 0
    `);
  }
}

initDb();

const insertTiradaStmt = db.prepare(`
  INSERT INTO tiradas (
    timestamp_utc,
    fecha_local,
    anio,
    mes,
    dia,
    semana_iso,
    guild_id,
    channel_id,
    user_id,
    username,
    display_name,
    conteo,
    conteo_procesado
  ) VALUES (
    @timestamp_utc,
    @fecha_local,
    @anio,
    @mes,
    @dia,
    @semana_iso,
    @guild_id,
    @channel_id,
    @user_id,
    @username,
    @display_name,
    @conteo,
    0
  )
`);

function insertTirada(row) {
  return insertTiradaStmt.run(row);
}

function getAllTiradas() {
  return db.prepare(`
    SELECT *
    FROM tiradas
    ORDER BY id DESC
  `).all();
}

function getTotalGeneral() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
  `).get();

  return Number(row.total || 0);
}

function getTotalByUser(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE user_id = ?
  `).get(userId);

  return Number(row.total || 0);
}

function getUserSummary(userId) {
  return db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      MAX(username) AS username,
      MAX(guild_id) AS guild_id,
      MAX(channel_id) AS channel_id,
      COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE user_id = ?
    GROUP BY user_id
  `).get(userId);
}

function getLastButtonTiradaByUser(userId, channelId) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE user_id = ?
      AND channel_id = ?
      AND conteo > 0
    ORDER BY timestamp_utc DESC
    LIMIT 1
  `).get(userId, channelId);
}

function getLastButtonTiradaGlobal(channelId) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE channel_id = ?
      AND conteo > 0
      AND user_id NOT LIKE 'panel-web-%'
    ORDER BY timestamp_utc DESC
    LIMIT 1
  `).get(channelId);
}

function deleteTiradasByUser(userId) {
  return db.prepare(`
    DELETE FROM tiradas
    WHERE user_id = ?
  `).run(userId);
}

function getByUser(userId) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId);
}

function getByMonth(anio, mes) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE anio = ? AND mes = ?
    ORDER BY id DESC
  `).all(anio, mes);
}

function getByWeek(anio, semana) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE anio = ? AND semana_iso = ?
    ORDER BY id DESC
  `).all(anio, semana);
}

function getByRange(fromIso, toIso) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE timestamp_utc >= ? AND timestamp_utc <= ?
    ORDER BY id DESC
  `).all(fromIso, toIso);
}

function getByLocalDateRange(desde, hasta) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE fecha_local >= ? AND fecha_local <= ?
    ORDER BY id DESC
  `).all(`${desde} 00:00:00`, `${hasta} 23:59:59`);
}

function getTopUsersByLocalDateRange(desde, hasta, limit = 10) {
  return db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      MAX(username) AS username,
      SUM(conteo) AS total
    FROM tiradas
    WHERE fecha_local >= ?
      AND fecha_local <= ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
    ORDER BY total DESC, display_name ASC
    LIMIT ?
  `).all(`${desde} 00:00:00`, `${hasta} 23:59:59`, limit);
}

function getDailyTotalsByLocalDateRange(desde, hasta) {
  return db.prepare(`
    SELECT
      substr(fecha_local, 1, 10) AS fecha,
      COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE fecha_local >= ? AND fecha_local <= ?
    GROUP BY substr(fecha_local, 1, 10)
    ORDER BY fecha ASC
  `).all(`${desde} 00:00:00`, `${hasta} 23:59:59`);
}

function getTopUsers(limit = 10) {
  return db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      MAX(username) AS username,
      SUM(conteo) AS total
    FROM tiradas
    WHERE user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
    ORDER BY total DESC, display_name ASC
    LIMIT ?
  `).all(limit);
}

function getDistinctUsers() {
  return db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      MAX(username) AS username,
      COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
    ORDER BY display_name ASC
  `).all();
}

function getDashboardStats() {
  const total = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
  `).get().total;

  const usuarios = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS total
    FROM tiradas
    WHERE user_id NOT LIKE 'panel-web-%'
  `).get().total;

  const hoy = new Date().toISOString().slice(0, 10);

  const hoyTotal = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE substr(timestamp_utc, 1, 10) = ?
  `).get(hoy).total;

  const mesActual = new Date().getMonth() + 1;
  const anioActual = new Date().getFullYear();

  const mesTotal = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE anio = ? AND mes = ?
  `).get(anioActual, mesActual).total;

  return {
    total: Number(total || 0),
    usuarios: Number(usuarios || 0),
    hoy: Number(hoyTotal || 0),
    mes: Number(mesTotal || 0)
  };
}

function getFilteredTiradas(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.user_id) {
    conditions.push(`user_id = ?`);
    params.push(filters.user_id);
  }

  if (filters.anio) {
    conditions.push(`anio = ?`);
    params.push(Number(filters.anio));
  }

  if (filters.mes) {
    conditions.push(`mes = ?`);
    params.push(Number(filters.mes));
  }

  if (filters.semana_iso) {
    conditions.push(`semana_iso = ?`);
    params.push(Number(filters.semana_iso));
  }

  if (filters.desde) {
    conditions.push(`fecha_local >= ?`);
    params.push(`${filters.desde} 00:00:00`);
  }

  if (filters.hasta) {
    conditions.push(`fecha_local <= ?`);
    params.push(`${filters.hasta} 23:59:59`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return db.prepare(`
    SELECT *
    FROM tiradas
    ${where}
    ORDER BY id DESC
    LIMIT 1000
  `).all(...params);
}

function getPendingTiradasCount(channelId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo - conteo_procesado), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
  `).get(channelId);

  return Math.max(0, Number(row.total || 0));
}

function getPendingTiradasCountByUser(channelId, userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo - conteo_procesado), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND user_id = ?
  `).get(channelId, userId);

  return Math.max(0, Number(row.total || 0));
}

function getPendingMetaTotal(channelId, metaPorTirada = 56) {
  return getPendingTiradasCount(channelId) * metaPorTirada;
}

function getPendingTiradasByUser(channelId) {
  return db.prepare(`
    SELECT
      user_id,
      MAX(display_name) AS display_name,
      MAX(username) AS username,
      COALESCE(SUM(conteo - conteo_procesado), 0) AS tiradas_pendientes
    FROM tiradas
    WHERE channel_id = ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
    HAVING tiradas_pendientes > 0
    ORDER BY tiradas_pendientes DESC, display_name ASC
  `).all(channelId);
}

const processPendingTiradasTransaction = db.transaction(({
  channelId,
  cantidadTiradas,
  metaTotal,
  timestampUtc,
  fechaLocal,
  guildId,
  processorUserId,
  processorUsername,
  processorDisplayName
}) => {
  let remaining = Number(cantidadTiradas);
  const totalPendiente = getPendingTiradasCount(channelId);

  if (totalPendiente < cantidadTiradas) {
    throw new Error("No hay suficientes tiradas pendientes para procesar.");
  }

  const rows = db.prepare(`
    SELECT
      id,
      conteo,
      conteo_procesado,
      conteo - conteo_procesado AS pendiente
    FROM tiradas
    WHERE channel_id = ?
      AND conteo != conteo_procesado
    ORDER BY id ASC
  `).all(channelId);

  for (const row of rows) {
    if (remaining <= 0) break;

    const pendiente = Number(row.pendiente);

    if (pendiente > 0) {
      const take = Math.min(pendiente, remaining);
      const nuevoProcesado = Number(row.conteo_procesado) + take;

      db.prepare(`
        UPDATE tiradas
        SET conteo_procesado = ?
        WHERE id = ?
      `).run(nuevoProcesado, row.id);

      remaining -= take;
    } else {
      db.prepare(`
        UPDATE tiradas
        SET conteo_procesado = conteo
        WHERE id = ?
      `).run(row.id);

      remaining -= pendiente;
    }
  }

  if (remaining > 0) {
    throw new Error("No hay suficientes tiradas pendientes para procesar.");
  }

  return db.prepare(`
    INSERT INTO procesos (
      timestamp_utc,
      fecha_local,
      guild_id,
      channel_id,
      processor_user_id,
      processor_username,
      processor_display_name,
      tiradas_consumidas,
      meta_total,
      meta_empaquetada
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    timestampUtc,
    fechaLocal,
    guildId,
    channelId,
    processorUserId,
    processorUsername,
    processorDisplayName,
    cantidadTiradas,
    metaTotal
  );
});

function processPendingTiradas(data) {
  return processPendingTiradasTransaction(data);
}

function getProcesos(limit = 50) {
  return db.prepare(`
    SELECT *
    FROM procesos
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function getPendingProcessedMeta(channelId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN meta_total > meta_empaquetada THEN meta_total - meta_empaquetada
        ELSE 0
      END
    ), 0) AS total
    FROM procesos
    WHERE channel_id = ?
  `).get(channelId);

  return Number(row.total || 0);
}

function getPendingProcessedByProcess(channelId) {
  return db.prepare(`
    SELECT
      id,
      timestamp_utc,
      fecha_local,
      processor_user_id,
      processor_username,
      processor_display_name,
      meta_total,
      meta_empaquetada,
      meta_total - meta_empaquetada AS meta_pendiente
    FROM procesos
    WHERE channel_id = ?
      AND meta_total > meta_empaquetada
    ORDER BY id ASC
  `).all(channelId);
}

const packagePendingMetaTransaction = db.transaction(({
  channelId,
  metaAempaquetar,
  timestampUtc,
  fechaLocal,
  guildId,
  packerUserId,
  packerUsername,
  packerDisplayName
}) => {
  let remaining = Number(metaAempaquetar);

  const rows = db.prepare(`
    SELECT
      id,
      meta_total,
      meta_empaquetada,
      meta_total - meta_empaquetada AS pendiente
    FROM procesos
    WHERE channel_id = ?
      AND meta_total > meta_empaquetada
    ORDER BY id ASC
  `).all(channelId);

  for (const row of rows) {
    if (remaining <= 0) break;

    const take = Math.min(Number(row.pendiente), remaining);
    const nuevoEmpaquetado = Number(row.meta_empaquetada) + take;

    db.prepare(`
      UPDATE procesos
      SET meta_empaquetada = ?
      WHERE id = ?
    `).run(nuevoEmpaquetado, row.id);

    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error("No hay suficiente meta procesada pendiente para empaquetar.");
  }

  return db.prepare(`
    INSERT INTO empaquetados (
      timestamp_utc,
      fecha_local,
      guild_id,
      channel_id,
      packer_user_id,
      packer_username,
      packer_display_name,
      meta_empaquetada
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestampUtc,
    fechaLocal,
    guildId,
    channelId,
    packerUserId,
    packerUsername,
    packerDisplayName,
    metaAempaquetar
  );
});

function packagePendingMeta(data) {
  return packagePendingMetaTransaction(data);
}

function getEmpaquetados(limit = 50) {
  return db.prepare(`
    SELECT *
    FROM empaquetados
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function getCountsByUserForLocalDateRange(channelId, desde, hasta) {
  return db.prepare(`
    SELECT
      user_id,
      COALESCE(SUM(CASE WHEN conteo > 0 THEN conteo ELSE 0 END), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND fecha_local >= ?
      AND fecha_local <= ?
      AND user_id NOT LIKE 'panel-web-%'
    GROUP BY user_id
  `).all(channelId, `${desde} 00:00:00`, `${hasta} 23:59:59`);
}

function getTotalByUserForLocalDateRange(channelId, userId, desde, hasta) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN conteo > 0 THEN conteo ELSE 0 END), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND user_id = ?
      AND fecha_local >= ?
      AND fecha_local <= ?
  `).get(channelId, userId, `${desde} 00:00:00`, `${hasta} 23:59:59`);

  return Number(row.total || 0);
}

function insertActionLog(action) {
  return db.prepare(`
    INSERT INTO acciones_log (
      timestamp_utc,
      fecha_local,
      guild_id,
      channel_id,
      user_id,
      username,
      display_name,
      action_type,
      status,
      details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    action.timestamp_utc,
    action.fecha_local,
    action.guild_id || null,
    action.channel_id || null,
    action.user_id || null,
    action.username || null,
    action.display_name || null,
    action.action_type,
    action.status,
    action.details || null
  );
}

function getRecentActionLogs(limit = 50) {
  return db.prepare(`
    SELECT *
    FROM acciones_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

function getMetaStatusMessage(channelId) {
  return db.prepare(`
    SELECT *
    FROM meta_status_message
    WHERE channel_id = ?
  `).get(channelId);
}

function saveMetaStatusMessage(channelId, messageId) {
  return db.prepare(`
    INSERT OR REPLACE INTO meta_status_message (
      channel_id,
      message_id,
      updated_at_utc
    ) VALUES (?, ?, ?)
  `).run(channelId, messageId, new Date().toISOString());
}

function createRoleDeleteReview(data) {
  const existing = db.prepare(`
    SELECT *
    FROM role_delete_reviews
    WHERE user_id = ?
      AND status = 'pending'
    ORDER BY id DESC
    LIMIT 1
  `).get(data.user_id);

  if (existing) return existing;

  const result = db.prepare(`
    INSERT INTO role_delete_reviews (
      created_at_utc,
      guild_id,
      user_id,
      username,
      display_name,
      old_roles,
      new_roles,
      reason,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    data.created_at_utc,
    data.guild_id,
    data.user_id,
    data.username || null,
    data.display_name || null,
    data.old_roles || null,
    data.new_roles || null,
    data.reason
  );

  return getRoleDeleteReviewById(result.lastInsertRowid);
}

function getRoleDeleteReviewById(id) {
  return db.prepare(`
    SELECT *
    FROM role_delete_reviews
    WHERE id = ?
  `).get(id);
}

function getRoleDeleteReviews(status = "pending") {
  if (status === "all") {
    return db.prepare(`
      SELECT *
      FROM role_delete_reviews
      ORDER BY id DESC
      LIMIT 100
    `).all();
  }

  return db.prepare(`
    SELECT *
    FROM role_delete_reviews
    WHERE status = ?
    ORDER BY id DESC
    LIMIT 100
  `).all(status);
}

function resolveRoleDeleteReview({ id, status, resolvedByUserId, resolvedByUsername }) {
  return db.prepare(`
    UPDATE role_delete_reviews
    SET
      status = ?,
      resolved_at_utc = ?,
      resolved_by_user_id = ?,
      resolved_by_username = ?
    WHERE id = ?
      AND status = 'pending'
  `).run(
    status,
    new Date().toISOString(),
    resolvedByUserId || null,
    resolvedByUsername || null,
    id
  );
}

function resolvePendingReviewsForUser({ userId, status, resolvedByUserId, resolvedByUsername }) {
  return db.prepare(`
    UPDATE role_delete_reviews
    SET
      status = ?,
      resolved_at_utc = ?,
      resolved_by_user_id = ?,
      resolved_by_username = ?
    WHERE user_id = ?
      AND status = 'pending'
  `).run(
    status,
    new Date().toISOString(),
    resolvedByUserId || null,
    resolvedByUsername || null,
    userId
  );
}

function hasReportBeenSent(reportKey) {
  const row = db.prepare(`
    SELECT 1 AS exists_report
    FROM report_logs
    WHERE report_key = ?
  `).get(reportKey);

  return Boolean(row);
}

function markReportSent(reportKey, channelId) {
  db.prepare(`
    INSERT OR REPLACE INTO report_logs (
      report_key,
      sent_at_utc,
      channel_id
    ) VALUES (?, ?, ?)
  `).run(reportKey, new Date().toISOString(), channelId);
}

function upsertMemberWebAccount({ discordUserId, webUsername, passwordHash, active = 1 }) {
  const now = new Date().toISOString();

  return db.prepare(`
    INSERT INTO member_web_accounts (
      discord_user_id,
      web_username,
      password_hash,
      active,
      created_at_utc,
      updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_user_id) DO UPDATE SET
      web_username = excluded.web_username,
      password_hash = excluded.password_hash,
      active = excluded.active,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    discordUserId,
    webUsername,
    passwordHash,
    active ? 1 : 0,
    now,
    now
  );
}

function getMemberWebAccountByUsername(username) {
  return db.prepare(`
    SELECT *
    FROM member_web_accounts
    WHERE lower(web_username) = lower(?)
    LIMIT 1
  `).get(username);
}

function getMemberWebAccountByDiscordId(userId) {
  return db.prepare(`
    SELECT *
    FROM member_web_accounts
    WHERE discord_user_id = ?
    LIMIT 1
  `).get(userId);
}

function markMemberWebAccountLogin(userId) {
  return db.prepare(`
    UPDATE member_web_accounts
    SET last_login_at_utc = ?
    WHERE discord_user_id = ?
  `).run(new Date().toISOString(), userId);
}

function getMemberWebAccounts() {
  return db.prepare(`
    SELECT
      a.discord_user_id,
      MAX(t.display_name) AS display_name,
      MAX(t.username) AS discord_username,
      COALESCE(SUM(t.conteo), 0) AS total_tiradas,
      a.web_username,
      a.active,
      a.created_at_utc,
      a.updated_at_utc,
      a.last_login_at_utc
    FROM member_web_accounts a
    LEFT JOIN tiradas t ON t.user_id = a.discord_user_id
    GROUP BY a.discord_user_id
    ORDER BY display_name ASC, a.web_username ASC
  `).all();
}

async function backupDatabase(destinationPath) {
  const directory = path.dirname(path.resolve(destinationPath));

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  await db.backup(destinationPath);
}

function getDbPath() {
  return DB_PATH;
}

module.exports = {
  db,
  initDb,
  insertTirada,
  getAllTiradas,
  getTotalGeneral,
  getTotalByUser,
  getUserSummary,
  getLastButtonTiradaByUser,
  getLastButtonTiradaGlobal,
  deleteTiradasByUser,
  getByUser,
  getByMonth,
  getByWeek,
  getByRange,
  getTopUsers,
  getDistinctUsers,
  getDashboardStats,
  getFilteredTiradas,
  getByLocalDateRange,
  getTopUsersByLocalDateRange,
  getDailyTotalsByLocalDateRange,
  getPendingTiradasCount,
  getPendingTiradasCountByUser,
  getPendingMetaTotal,
  getPendingTiradasByUser,
  processPendingTiradas,
  getProcesos,
  getPendingProcessedMeta,
  getPendingProcessedByProcess,
  packagePendingMeta,
  getEmpaquetados,
  getCountsByUserForLocalDateRange,
  getTotalByUserForLocalDateRange,
  insertActionLog,
  getRecentActionLogs,
  getMetaStatusMessage,
  saveMetaStatusMessage,
  createRoleDeleteReview,
  getRoleDeleteReviewById,
  getRoleDeleteReviews,
  resolveRoleDeleteReview,
  resolvePendingReviewsForUser,
  hasReportBeenSent,
  markReportSent,
  upsertMemberWebAccount,
  getMemberWebAccountByUsername,
  getMemberWebAccountByDiscordId,
  markMemberWebAccountLogin,
  getMemberWebAccounts,
  backupDatabase,
  getDbPath
};
