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

    CREATE INDEX IF NOT EXISTS idx_empaquetados_channel_id ON empaquetados(channel_id);

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

    CREATE TABLE IF NOT EXISTS report_logs (
      report_key TEXT PRIMARY KEY,
      sent_at_utc TEXT NOT NULL,
      channel_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tiradas_user_id ON tiradas(user_id);
    CREATE INDEX IF NOT EXISTS idx_tiradas_anio_mes ON tiradas(anio, mes);
    CREATE INDEX IF NOT EXISTS idx_tiradas_anio_semana ON tiradas(anio, semana_iso);
    CREATE INDEX IF NOT EXISTS idx_tiradas_timestamp ON tiradas(timestamp_utc);
    CREATE INDEX IF NOT EXISTS idx_tiradas_fecha_local ON tiradas(fecha_local);
    CREATE INDEX IF NOT EXISTS idx_tiradas_channel_id ON tiradas(channel_id);
    CREATE INDEX IF NOT EXISTS idx_procesos_channel_id ON procesos(channel_id);
  `);

  if (!columnExists("tiradas", "conteo_procesado")) {
    db.exec(`
      ALTER TABLE tiradas
      ADD COLUMN conteo_procesado INTEGER NOT NULL DEFAULT 0
    `);
  }
}

  if (!columnExists("procesos", "meta_empaquetada")) {
    db.exec(`
      ALTER TABLE procesos
      ADD COLUMN meta_empaquetada INTEGER NOT NULL DEFAULT 0
    `);
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

  return row.total;
}

function getTotalByUser(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE user_id = ?
  `).get(userId);

  return row.total;
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
    WHERE fecha_local >= ? AND fecha_local <= ?
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
    total,
    usuarios,
    hoy: hoyTotal,
    mes: mesTotal
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
    SELECT COALESCE(SUM(
      CASE
        WHEN conteo > conteo_procesado THEN conteo - conteo_procesado
        ELSE 0
      END
    ), 0) AS total
    FROM tiradas
    WHERE channel_id = ?
      AND conteo > 0
  `).get(channelId);

  return Number(row.total || 0);
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
      COALESCE(SUM(
        CASE
          WHEN conteo > conteo_procesado THEN conteo - conteo_procesado
          ELSE 0
        END
      ), 0) AS tiradas_pendientes
    FROM tiradas
    WHERE channel_id = ?
      AND conteo > 0
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

  const rows = db.prepare(`
    SELECT
      id,
      conteo,
      conteo_procesado,
      conteo - conteo_procesado AS pendiente
    FROM tiradas
    WHERE channel_id = ?
      AND conteo > conteo_procesado
      AND conteo > 0
    ORDER BY id ASC
  `).all(channelId);

  for (const row of rows) {
    if (remaining <= 0) break;

    const take = Math.min(Number(row.pendiente), remaining);
    const nuevoProcesado = Number(row.conteo_procesado) + take;

    db.prepare(`
      UPDATE tiradas
      SET conteo_procesado = ?
      WHERE id = ?
    `).run(nuevoProcesado, row.id);

    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error("No hay suficientes tiradas pendientes para procesar.");
  }

  const result = db.prepare(`
    INSERT INTO procesos (
      timestamp_utc,
      fecha_local,
      guild_id,
      channel_id,
      processor_user_id,
      processor_username,
      processor_display_name,
      tiradas_consumidas,
      meta_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  return result;
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
  getPendingMetaTotal,
  getPendingTiradasByUser,
  processPendingTiradas,
  getProcesos,
  hasReportBeenSent,
  markReportSent,
  backupDatabase,
  getDbPath
};
