const { db } = require("../db");

const SALIDA_STATUS = {
  OPEN: "open",
  CLOSED: "closed",
  CANCELLED: "cancelled"
};

const VOTE_STATUS = {
  GOING: "going",
  NOT_GOING: "not_going",
  MAYBE: "maybe"
};

function nowIso() {
  return new Date().toISOString();
}

function assertSalidaStatus(status) {
  const value = String(status || SALIDA_STATUS.OPEN).trim().toLowerCase();
  if (!Object.values(SALIDA_STATUS).includes(value)) {
    throw new Error("Estado de salida no válido.");
  }
  return value;
}

function assertVoteStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (!Object.values(VOTE_STATUS).includes(value)) {
    throw new Error("Voto no válido. Usa going, not_going o maybe.");
  }
  return value;
}

function assertDate(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Falta ${fieldName}.`);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} no tiene una fecha válida.`);
  }
  return text;
}

function initSalidaTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS salidas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES panel_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS salida_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salida_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(salida_id, user_id),
      FOREIGN KEY (salida_id) REFERENCES salidas(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES panel_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS salida_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      salida_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (salida_id) REFERENCES salidas(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES panel_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_salidas_dates ON salidas(starts_at, ends_at);
    CREATE INDEX IF NOT EXISTS idx_salidas_status ON salidas(status);
    CREATE INDEX IF NOT EXISTS idx_salida_votes_salida ON salida_votes(salida_id);
    CREATE INDEX IF NOT EXISTS idx_salida_comments_salida ON salida_comments(salida_id);
  `);
}

function mapSalida(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || "",
    location: row.location || "",
    startsAt: row.starts_at,
    endsAt: row.ends_at || null,
    status: row.status,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creatorName: row.creator_name || ""
  };
}

function mapVote(row) {
  return {
    id: Number(row.id),
    salidaId: Number(row.salida_id),
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    status: row.status,
    updatedAt: row.updated_at
  };
}

function mapComment(row) {
  return {
    id: Number(row.id),
    salidaId: Number(row.salida_id),
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    comment: row.comment,
    createdAt: row.created_at,
    deletedAt: row.deleted_at || null
  };
}

function listSalidas({ start, end, includeCancelled = true } = {}) {
  const conditions = [];
  const params = [];

  if (start) {
    conditions.push(`COALESCE(ends_at, starts_at) >= ?`);
    params.push(String(start));
  }

  if (end) {
    conditions.push(`starts_at <= ?`);
    params.push(String(end));
  }

  if (!includeCancelled) {
    conditions.push(`status != 'cancelled'`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return db.prepare(`
    SELECT s.*, u.display_name AS creator_name
    FROM salidas s
    LEFT JOIN panel_users u ON u.id = s.created_by
    ${where}
    ORDER BY s.starts_at ASC
  `).all(...params).map(mapSalida);
}

function getSalidaById(id) {
  return mapSalida(db.prepare(`
    SELECT s.*, u.display_name AS creator_name
    FROM salidas s
    LEFT JOIN panel_users u ON u.id = s.created_by
    WHERE s.id = ?
  `).get(Number(id)));
}

function getVotesForSalida(salidaId) {
  return db.prepare(`
    SELECT v.*, u.username, u.display_name, u.role
    FROM salida_votes v
    INNER JOIN panel_users u ON u.id = v.user_id
    WHERE v.salida_id = ?
    ORDER BY
      CASE v.status WHEN 'going' THEN 1 WHEN 'maybe' THEN 2 ELSE 3 END,
      u.display_name COLLATE NOCASE ASC,
      u.username COLLATE NOCASE ASC
  `).all(Number(salidaId)).map(mapVote);
}

function getCommentsForSalida(salidaId) {
  return db.prepare(`
    SELECT c.*, u.username, u.display_name, u.role
    FROM salida_comments c
    INNER JOIN panel_users u ON u.id = c.user_id
    WHERE c.salida_id = ? AND c.deleted_at IS NULL
    ORDER BY c.created_at ASC
  `).all(Number(salidaId)).map(mapComment);
}

function getMyVote(salidaId, userId) {
  const row = db.prepare(`
    SELECT * FROM salida_votes
    WHERE salida_id = ? AND user_id = ?
  `).get(Number(salidaId), Number(userId));

  return row ? {
    id: Number(row.id),
    salidaId: Number(row.salida_id),
    userId: Number(row.user_id),
    status: row.status,
    updatedAt: row.updated_at
  } : null;
}

function getSalidaDetails(salidaId, currentUserId) {
  const salida = getSalidaById(salidaId);
  if (!salida) throw new Error("No se encontró la salida.");

  const votes = getVotesForSalida(salidaId);
  const comments = getCommentsForSalida(salidaId);

  const counts = {
    going: votes.filter(v => v.status === "going").length,
    notGoing: votes.filter(v => v.status === "not_going").length,
    maybe: votes.filter(v => v.status === "maybe").length
  };

  return {
    salida,
    votes,
    comments,
    counts,
    myVote: currentUserId ? getMyVote(salidaId, currentUserId) : null
  };
}

function createSalida({ title, description, location, startsAt, endsAt, createdBy }) {
  const safeTitle = String(title || "").trim();
  if (!safeTitle) throw new Error("Falta el título de la salida.");

  const safeStartsAt = assertDate(startsAt, "la fecha de inicio");
  const safeEndsAt = String(endsAt || "").trim() ? assertDate(endsAt, "la fecha de fin") : null;

  if (safeEndsAt && new Date(safeEndsAt).getTime() < new Date(safeStartsAt).getTime()) {
    throw new Error("La fecha de fin no puede ser anterior a la fecha de inicio.");
  }

  const timestamp = nowIso();

  const result = db.prepare(`
    INSERT INTO salidas (
      title, description, location, starts_at, ends_at, status, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(
    safeTitle,
    String(description || "").trim(),
    String(location || "").trim(),
    safeStartsAt,
    safeEndsAt,
    Number(createdBy),
    timestamp,
    timestamp
  );

  return getSalidaById(result.lastInsertRowid);
}

function updateSalida(id, { title, description, location, startsAt, endsAt, status }) {
  const current = getSalidaById(id);
  if (!current) throw new Error("No se encontró la salida.");

  const nextTitle = title !== undefined ? String(title || "").trim() : current.title;
  if (!nextTitle) throw new Error("Falta el título de la salida.");

  const nextStartsAt = startsAt !== undefined ? assertDate(startsAt, "la fecha de inicio") : current.startsAt;
  const nextEndsAt = endsAt !== undefined
    ? (String(endsAt || "").trim() ? assertDate(endsAt, "la fecha de fin") : null)
    : current.endsAt;

  if (nextEndsAt && new Date(nextEndsAt).getTime() < new Date(nextStartsAt).getTime()) {
    throw new Error("La fecha de fin no puede ser anterior a la fecha de inicio.");
  }

  const nextStatus = status !== undefined ? assertSalidaStatus(status) : current.status;

  db.prepare(`
    UPDATE salidas
    SET title = ?,
        description = ?,
        location = ?,
        starts_at = ?,
        ends_at = ?,
        status = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextTitle,
    description !== undefined ? String(description || "").trim() : current.description,
    location !== undefined ? String(location || "").trim() : current.location,
    nextStartsAt,
    nextEndsAt,
    nextStatus,
    nowIso(),
    Number(id)
  );

  return getSalidaById(id);
}

function setSalidaStatus(id, status) {
  return updateSalida(id, { status: assertSalidaStatus(status) });
}

function upsertVote({ salidaId, userId, status }) {
  const salida = getSalidaById(salidaId);
  if (!salida) throw new Error("No se encontró la salida.");
  if (salida.status !== SALIDA_STATUS.OPEN) {
    throw new Error("Esta salida no está abierta para votar.");
  }

  const safeStatus = assertVoteStatus(status);
  const timestamp = nowIso();

  db.prepare(`
    INSERT INTO salida_votes (salida_id, user_id, status, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(salida_id, user_id)
    DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `).run(Number(salidaId), Number(userId), safeStatus, timestamp);

  return getMyVote(salidaId, userId);
}

function addComment({ salidaId, userId, comment }) {
  const salida = getSalidaById(salidaId);
  if (!salida) throw new Error("No se encontró la salida.");
  if (salida.status === SALIDA_STATUS.CANCELLED) {
    throw new Error("No se puede comentar una salida cancelada.");
  }

  const safeComment = String(comment || "").trim();
  if (!safeComment) throw new Error("El comentario no puede estar vacío.");
  if (safeComment.length > 1000) throw new Error("El comentario no puede superar 1000 caracteres.");

  const result = db.prepare(`
    INSERT INTO salida_comments (salida_id, user_id, comment, created_at)
    VALUES (?, ?, ?, ?)
  `).run(Number(salidaId), Number(userId), safeComment, nowIso());

  return db.prepare(`
    SELECT c.*, u.username, u.display_name, u.role
    FROM salida_comments c
    INNER JOIN panel_users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);
}

function deleteComment({ commentId, requester }) {
  const comment = db.prepare(`
    SELECT * FROM salida_comments
    WHERE id = ? AND deleted_at IS NULL
  `).get(Number(commentId));

  if (!comment) throw new Error("No se encontró el comentario.");

  const isOwner = Number(comment.user_id) === Number(requester.id);
  const canModerate = requester.role === "staff" || requester.role === "boss";

  if (!isOwner && !canModerate) {
    throw new Error("No tienes permiso para borrar este comentario.");
  }

  db.prepare(`
    UPDATE salida_comments
    SET deleted_at = ?
    WHERE id = ?
  `).run(nowIso(), Number(commentId));

  return true;
}

module.exports = {
  SALIDA_STATUS,
  VOTE_STATUS,
  initSalidaTables,
  listSalidas,
  getSalidaById,
  getSalidaDetails,
  createSalida,
  updateSalida,
  setSalidaStatus,
  upsertVote,
  addComment,
  deleteComment
};
