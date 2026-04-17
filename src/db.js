const Database = require("better-sqlite3");
require("dotenv").config();

const db = new Database(process.env.DB_PATH || "./tiradas.db");

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

    CREATE INDEX IF NOT EXISTS idx_tiradas_user_id ON tiradas(user_id);
    CREATE INDEX IF NOT EXISTS idx_tiradas_anio_mes ON tiradas(anio, mes);
    CREATE INDEX IF NOT EXISTS idx_tiradas_anio_semana ON tiradas(anio, semana_iso);
    CREATE INDEX IF NOT EXISTS idx_tiradas_timestamp ON tiradas(timestamp_utc);
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
    conteo
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
    @conteo
  )
`);

function insertTirada(row) {
  return insertTiradaStmt.run(row);
}

function getAllTiradas() {
  return db.prepare(`
    SELECT *
    FROM tiradas
    ORDER BY id ASC
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

function getByUser(userId) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE user_id = ?
    ORDER BY id ASC
  `).all(userId);
}

function getByMonth(anio, mes) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE anio = ? AND mes = ?
    ORDER BY id ASC
  `).all(anio, mes);
}

function getByWeek(anio, semana) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE anio = ? AND semana_iso = ?
    ORDER BY id ASC
  `).all(anio, semana);
}

function getByRange(fromIso, toIso) {
  return db.prepare(`
    SELECT *
    FROM tiradas
    WHERE timestamp_utc >= ? AND timestamp_utc <= ?
    ORDER BY id ASC
  `).all(fromIso, toIso);
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

module.exports = {
  db,
  initDb,
  insertTirada,
  getAllTiradas,
  getTotalGeneral,
  getTotalByUser,
  getByUser,
  getByMonth,
  getByWeek,
  getByRange,
  getTopUsers
};