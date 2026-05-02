const DEFAULT_ALLOWED_TIRADA_ROLE_IDS = [
  "1492824944575254599",
  "1495144231654653993",
  "1492828339457495182",
  "1492833353391673395",
  "1492833439433359430",
  "1492833441442566154",
  "1492833504206262442"
];

function parseRoleIdsFromEnv(value) {
  return String(value || "")
    .split(",")
    .map(roleId => roleId.trim())
    .filter(Boolean);
}

function readNumberFromEnv(names, defaultValue) {
  for (const name of names) {
    const value = process.env[name];

    if (value === undefined || value === null || String(value).trim() === "") {
      continue;
    }

    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }

    console.warn(
      `[CONFIG] La variable ${name} tiene un valor inválido: ${value}. Se usará ${defaultValue}.`
    );
  }

  return defaultValue;
}

const ENV_ALLOWED_TIRADA_ROLE_IDS = parseRoleIdsFromEnv(
  process.env.ALLOWED_TIRADA_ROLE_IDS
);

const ALLOWED_TIRADA_ROLE_IDS = ENV_ALLOWED_TIRADA_ROLE_IDS.length
  ? ENV_ALLOWED_TIRADA_ROLE_IDS
  : DEFAULT_ALLOWED_TIRADA_ROLE_IDS;

const META_POR_TIRADA = readNumberFromEnv(
  ["META_POR_TIRADA"],
  56
);

/**
 * Guía recomendada para procesar.
 * Antes lo llamabas META_MAXIMA_PROCESO.
 * Ahora también lo dejamos como META_GUIA_PROCESO para que el panel no rompa.
 */
const META_GUIA_PROCESO = readNumberFromEnv(
  ["META_GUIA_PROCESO", "META_MAXIMA_PROCESO"],
  448
);

/**
 * Capacidad visual máxima del panel.
 * Sirve para mostrar 448/500, pero NO bloquea procesar.
 */
const META_CAPACIDAD_MAXIMA = readNumberFromEnv(
  ["META_CAPACIDAD_MAXIMA"],
  500
);

/**
 * Compatibilidad con el código antiguo.
 */
const META_MAXIMA_PROCESO = META_GUIA_PROCESO;

const TIRADAS_PARA_PROCESAR = readNumberFromEnv(
  ["TIRADAS_PARA_PROCESAR"],
  Math.ceil(META_GUIA_PROCESO / META_POR_TIRADA)
);

/**
 * Guía recomendada para empaquetar.
 * Antes lo llamabas META_PARA_EMPAQUETAR.
 * Ahora también lo dejamos como META_GUIA_EMPAQUETAR para que el panel no rompa.
 */
const META_GUIA_EMPAQUETAR = readNumberFromEnv(
  ["META_GUIA_EMPAQUETAR", "META_PARA_EMPAQUETAR"],
  448
);

/**
 * Compatibilidad con el código antiguo.
 */
const META_PARA_EMPAQUETAR = META_GUIA_EMPAQUETAR;

const TIRADA_COOLDOWN_MS = readNumberFromEnv(
  ["TIRADA_COOLDOWN_MS"],
  70 * 60 * 1000
);

const DAILY_REQUIRED_TIRADAS = readNumberFromEnv(
  ["DAILY_REQUIRED_TIRADAS"],
  2
);

const WEEKLY_REQUIRED_TIRADAS = readNumberFromEnv(
  ["WEEKLY_REQUIRED_TIRADAS"],
  14
);

const MEMBERS_CACHE_MS = readNumberFromEnv(
  ["MEMBERS_CACHE_MS"],
  5 * 60 * 1000
);

module.exports = {
  TARGET_CHANNEL_ID: process.env.TARGET_CHANNEL_ID,

  ACTION_LOG_CHANNEL_ID:
    process.env.ACTION_LOG_CHANNEL_ID || "1498007351993831485",

  DELETE_REVIEW_ROLE_ID:
    process.env.DELETE_REVIEW_ROLE_ID || "1492832332892082196",

  TIMEZONE:
    process.env.TIMEZONE || "Europe/Madrid",

  META_POR_TIRADA,

  // Nombres nuevos
  META_GUIA_PROCESO,
  META_CAPACIDAD_MAXIMA,
  META_GUIA_EMPAQUETAR,

  // Nombres antiguos para que no rompa nada
  META_MAXIMA_PROCESO,
  META_PARA_EMPAQUETAR,

  TIRADAS_PARA_PROCESAR,
  TIRADA_COOLDOWN_MS,

  DAILY_REQUIRED_TIRADAS,
  WEEKLY_REQUIRED_TIRADAS,
  MEMBERS_CACHE_MS,

  ALLOWED_TIRADA_ROLE_IDS,
  ALLOWED_TIRADA_ROLE_ID_SET: new Set(ALLOWED_TIRADA_ROLE_IDS)
};
