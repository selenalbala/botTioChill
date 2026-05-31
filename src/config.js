const DEFAULT_TARGET_CHANNEL_ID = "1510256969452359680";

const DEFAULT_STATS_ADMIN_ROLE_IDS = [
  "1492824944575254599",
  "1495144231654653993",
  "1492828339457495182",
  "1492833353391673395",
  "1509004685556846664",
  "1510715514433962214"
];

function parseRoleIds(value, fallback = []) {
  const raw = String(value || "").trim();
  const source = raw ? raw : fallback.join(",");

  return source
    .split(",")
    .map(roleId => roleId.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  TARGET_CHANNEL_ID: process.env.TARGET_CHANNEL_ID || DEFAULT_TARGET_CHANNEL_ID,
  TIMEZONE: process.env.TIMEZONE || "Europe/Madrid",

  // Cada tirada suma esta cantidad de meta.
  META_PER_TIRADA: parsePositiveNumber(process.env.META_PER_TIRADA, 56),

  // Según tu captura anterior, la siguiente tirada era 70 minutos después.
  TIRADA_COOLDOWN_MINUTES: parsePositiveNumber(process.env.TIRADA_COOLDOWN_MINUTES, 70),

  // Opcional: roles que pueden pulsar +1 tirada. Vacío = todos pueden pulsar.
  ALLOWED_TIRADA_ROLE_IDS: parseRoleIds(process.env.ALLOWED_TIRADA_ROLE_IDS),

  // Roles que pueden consultar las tiradas de cualquier persona.
  STATS_ADMIN_ROLE_IDS: parseRoleIds(
    process.env.STATS_ADMIN_ROLE_IDS,
    DEFAULT_STATS_ADMIN_ROLE_IDS
  )
};
