const bcrypt = require("bcryptjs");
const { db } = require("../db");

const ROLES = {
  MEMBER: "member",
  STAFF: "staff",
  BOSS: "boss"
};

const ROLE_ORDER = {
  member: 1,
  staff: 2,
  boss: 3
};

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function assertRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (!Object.values(ROLES).includes(value)) {
    throw new Error("Rol no válido. Usa member, staff o boss.");
  }
  return value;
}

function assertPassword(password) {
  const text = String(password || "");
  if (text.length < 6) {
    throw new Error("La contraseña debe tener al menos 6 caracteres.");
  }
  return text;
}

function initPanelAuthTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT UNIQUE,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_panel_users_role ON panel_users(role);
    CREATE INDEX IF NOT EXISTS idx_panel_users_active ON panel_users(active);
    CREATE INDEX IF NOT EXISTS idx_panel_users_discord ON panel_users(discord_user_id);
  `);
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    discordUserId: row.discord_user_id || "",
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    active: Number(row.active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null
  };
}

function getUserById(id) {
  return sanitizeUser(
    db.prepare(`SELECT * FROM panel_users WHERE id = ?`).get(Number(id))
  );
}

function getRawUserById(id) {
  return db.prepare(`SELECT * FROM panel_users WHERE id = ?`).get(Number(id));
}

function getRawUserByUsername(username) {
  return db.prepare(`SELECT * FROM panel_users WHERE username = ?`).get(normalizeUsername(username));
}

function listUsers() {
  return db.prepare(`
    SELECT id, discord_user_id, username, display_name, role, active, created_at, updated_at, last_login_at
    FROM panel_users
    ORDER BY
      CASE role WHEN 'boss' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END,
      display_name COLLATE NOCASE ASC,
      username COLLATE NOCASE ASC
  `).all().map(sanitizeUser);
}

async function createUser({ discordUserId, username, displayName, password, role = "member", active = true }) {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error("Falta el usuario.");
  const safeRole = assertRole(role);
  const passwordHash = await bcrypt.hash(assertPassword(password), 10);
  const timestamp = nowIso();

  const result = db.prepare(`
    INSERT INTO panel_users (
      discord_user_id, username, display_name, password_hash, role, active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(discordUserId || "").trim() || null,
    normalized,
    String(displayName || normalized).trim(),
    passwordHash,
    safeRole,
    active ? 1 : 0,
    timestamp,
    timestamp
  );

  return getUserById(result.lastInsertRowid);
}

async function updateUser(id, { discordUserId, username, displayName, role, active }) {
  const current = getRawUserById(id);
  if (!current) throw new Error("No se encontró el usuario.");

  const normalized = username !== undefined ? normalizeUsername(username) : current.username;
  if (!normalized) throw new Error("Falta el usuario.");

  const safeRole = role !== undefined ? assertRole(role) : current.role;

  db.prepare(`
    UPDATE panel_users
    SET discord_user_id = ?,
        username = ?,
        display_name = ?,
        role = ?,
        active = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    discordUserId !== undefined ? (String(discordUserId || "").trim() || null) : current.discord_user_id,
    normalized,
    displayName !== undefined ? String(displayName || normalized).trim() : current.display_name,
    safeRole,
    active !== undefined ? (active ? 1 : 0) : current.active,
    nowIso(),
    Number(id)
  );

  return getUserById(id);
}

async function resetPassword(id, password) {
  const current = getRawUserById(id);
  if (!current) throw new Error("No se encontró el usuario.");

  const passwordHash = await bcrypt.hash(assertPassword(password), 10);
  db.prepare(`
    UPDATE panel_users
    SET password_hash = ?, updated_at = ?
    WHERE id = ?
  `).run(passwordHash, nowIso(), Number(id));

  return getUserById(id);
}

async function validateLogin(username, password) {
  const raw = getRawUserByUsername(username);
  if (!raw || Number(raw.active) !== 1) return null;

  const ok = await bcrypt.compare(String(password || ""), raw.password_hash);
  if (!ok) return null;

  db.prepare(`
    UPDATE panel_users
    SET last_login_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), raw.id);

  return getUserById(raw.id);
}

function hasRole(user, minimumRole) {
  if (!user) return false;
  const current = ROLE_ORDER[user.role] || 0;
  const needed = ROLE_ORDER[minimumRole] || 999;
  return current >= needed;
}

function countUsers() {
  return db.prepare(`SELECT COUNT(*) AS total FROM panel_users`).get().total;
}

async function seedDefaultBossFromEnv() {
  const total = Number(countUsers() || 0);
  if (total > 0) return null;

  const username = normalizeUsername(process.env.PANEL_ADMIN_USERNAME || process.env.WEB_USERNAME || "jefe");
  const password = String(process.env.PANEL_ADMIN_PASSWORD || process.env.WEB_PASSWORD || "");

  if (!password) {
    console.warn("[PANEL] No se ha creado usuario jefe inicial porque falta PANEL_ADMIN_PASSWORD o WEB_PASSWORD.");
    return null;
  }

  const user = await createUser({
    username,
    displayName: "Jefe principal",
    password,
    role: ROLES.BOSS,
    active: true
  });

  console.log(`[PANEL] Usuario jefe inicial creado: ${user.username}`);
  return user;
}

function importMemberWebAccountsIntoPanelUsers() {
  const rows = db.prepare(`
    SELECT
      a.discord_user_id,
      a.web_username,
      a.password_hash,
      a.active,
      COALESCE(MAX(t.display_name), a.web_username) AS display_name
    FROM member_web_accounts a
    LEFT JOIN tiradas t ON t.user_id = a.discord_user_id
    GROUP BY
      a.discord_user_id,
      a.web_username,
      a.password_hash,
      a.active
    ORDER BY a.web_username COLLATE NOCASE ASC
  `).all();

  const existsStmt = db.prepare(`
    SELECT id
    FROM panel_users
    WHERE username = ?
       OR (discord_user_id IS NOT NULL AND discord_user_id = ?)
    LIMIT 1
  `);

  const insertStmt = db.prepare(`
    INSERT INTO panel_users (
      discord_user_id,
      username,
      display_name,
      password_hash,
      role,
      active,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, 'member', ?, ?, ?)
  `);

  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const username = normalizeUsername(row.web_username);
    const discordUserId = String(row.discord_user_id || "").trim();

    if (!username || !row.password_hash) {
      skipped++;
      continue;
    }

    const existing = existsStmt.get(username, discordUserId || null);

    if (existing) {
      skipped++;
      continue;
    }

    const timestamp = nowIso();

    insertStmt.run(
      discordUserId || null,
      username,
      String(row.display_name || username).trim(),
      row.password_hash,
      Number(row.active) === 1 ? 1 : 0,
      timestamp,
      timestamp
    );

    created++;
  }

  if (created > 0 || rows.length > 0) {
    console.log(`[PANEL] Importación de miembros: ${created} creados, ${skipped} omitidos.`);
  }

  return {
    total: rows.length,
    created,
    skipped
  };
}

module.exports = {
  ROLES,
  initPanelAuthTables,
  seedDefaultBossFromEnv,
  importMemberWebAccountsIntoPanelUsers,
  normalizeUsername,
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  validateLogin,
  getUserById,
  hasRole,
  sanitizeUser
};
