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
