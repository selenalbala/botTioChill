const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "tiradas.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tiradas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp_utc TEXT NOT NULL,
  fecha_local TEXT NOT NULL,
  anio INTEGER NOT NULL,
  mes INTEGER NOT NULL,
  dia INTEGER NOT NULL,
  semana_iso INTEGER NOT NULL,
  anio_semana_iso INTEGER,
  guild_id TEXT,
  channel_id TEXT,
  user_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  conteo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS panel_messages (
  channel_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tiradas_user ON tiradas(user_id);
CREATE INDEX IF NOT EXISTS idx_tiradas_user_time ON tiradas(user_id, timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_tiradas_month ON tiradas(anio, mes);
CREATE INDEX IF NOT EXISTS idx_tiradas_week ON tiradas(anio_semana_iso, semana_iso);
`);

/*
  Si tu BD venía de una versión anterior, esto añade columnas nuevas sin borrar datos.
*/
const columns = db.prepare("PRAGMA table_info(tiradas)").all().map(col => col.name);

if (!columns.includes("anio_semana_iso")) {
  db.exec("ALTER TABLE tiradas ADD COLUMN anio_semana_iso INTEGER");
  db.exec("UPDATE tiradas SET anio_semana_iso = anio WHERE anio_semana_iso IS NULL");
}

const insertStmt = db.prepare(`
INSERT INTO tiradas (
  timestamp_utc,
  fecha_local,
  anio,
  mes,
  dia,
  semana_iso,
  anio_semana_iso,
  guild_id,
  channel_id,
  user_id,
  username,
  display_name,
  conteo
)
VALUES (
  @timestamp_utc,
  @fecha_local,
  @anio,
  @mes,
  @dia,
  @semana_iso,
  @anio_semana_iso,
  @guild_id,
  @channel_id,
  @user_id,
  @username,
  @display_name,
  @conteo
)
`);

function insertTirada(row) {
  return insertStmt.run(row);
}

function getLastTiradaByUser(userId) {
  return db.prepare(`
    SELECT timestamp_utc, fecha_local, display_name, username, user_id
    FROM tiradas
    WHERE user_id = ?
    ORDER BY timestamp_utc DESC
    LIMIT 1
  `).get(userId);
}

function getLastTirada() {
  return db.prepare(`
    SELECT timestamp_utc, fecha_local, display_name, username, user_id
    FROM tiradas
    ORDER BY timestamp_utc DESC
    LIMIT 1
  `).get();
}

function getTotalGeneral() {
  const row = db.prepare("SELECT COALESCE(SUM(conteo), 0) AS total FROM tiradas").get();
  return Number(row.total || 0);
}

function getTotalByUser(userId) {
  const row = db.prepare("SELECT COALESCE(SUM(conteo), 0) AS total FROM tiradas WHERE user_id = ?").get(userId);
  return Number(row.total || 0);
}

function getTotalByUserMonth(userId, year, month) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE user_id = ? AND anio = ? AND mes = ?
  `).get(userId, year, month);

  return Number(row.total || 0);
}

function getTotalByUserWeek(userId, isoYear, isoWeek) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE user_id = ? AND COALESCE(anio_semana_iso, anio) = ? AND semana_iso = ?
  `).get(userId, isoYear, isoWeek);

  return Number(row.total || 0);
}

function getTotalMonth(year, month) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE anio = ? AND mes = ?
  `).get(year, month);

  return Number(row.total || 0);
}

function getTotalWeek(isoYear, isoWeek) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(conteo), 0) AS total
    FROM tiradas
    WHERE COALESCE(anio_semana_iso, anio) = ? AND semana_iso = ?
  `).get(isoYear, isoWeek);

  return Number(row.total || 0);
}

function savePanelMessage(channelId, messageId) {
  db.prepare(`
    INSERT INTO panel_messages(channel_id, message_id)
    VALUES (?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET message_id = excluded.message_id
  `).run(channelId, messageId);
}

function getPanelMessage(channelId) {
  return db.prepare("SELECT message_id FROM panel_messages WHERE channel_id = ?").get(channelId);
}

function getDbPath() {
  return dbPath;
}

module.exports = {
  insertTirada,
  getLastTiradaByUser,
  getLastTirada,
  getTotalGeneral,
  getTotalByUser,
  getTotalByUserMonth,
  getTotalByUserWeek,
  getTotalMonth,
  getTotalWeek,
  savePanelMessage,
  getPanelMessage,
  getDbPath
};
