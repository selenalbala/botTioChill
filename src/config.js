const STAFF_ROLE_IDS = [
  "1492824944575254599",
  "1495144231654653993",
  "1492828339457495182"
];

const MEMBER_ROLE_IDS = [
  "1492833353391673395",
  "1492833439433359430",
  "1492833504206262442",
  "1492833441442566154"
];

const ALLOWED_TIRADA_ROLE_IDS = [...new Set([...STAFF_ROLE_IDS, ...MEMBER_ROLE_IDS])];

module.exports = {
  // Canal donde está el panel de meta.
  TARGET_CHANNEL_ID: process.env.TARGET_CHANNEL_ID || "1492835062453112933",

  // Canal donde el bot publica logs de acciones generales.
  ACTION_LOG_CHANNEL_ID: process.env.ACTION_LOG_CHANNEL_ID || "1498007351993831485",

  // Canal donde se avisan las salidas creadas desde el calendario.
  SALIDAS_CHANNEL_ID: process.env.SALIDAS_CHANNEL_ID || "1492875427226587328",

  // Canal donde estará el panel de pagos de dinero limpio.
  CLEAN_PAYMENT_PANEL_CHANNEL_ID: process.env.CLEAN_PAYMENT_PANEL_CHANNEL_ID || "1501541196516954333",

  // Canal donde se registran los pagos de dinero limpio.
  CLEAN_PAYMENT_LOG_CHANNEL_ID: process.env.CLEAN_PAYMENT_LOG_CHANNEL_ID || "1501545616960913449",

  DELETE_REVIEW_ROLE_ID: process.env.DELETE_REVIEW_ROLE_ID || "1492832332892082196",
  TIMEZONE: process.env.TIMEZONE || "Europe/Madrid",

  // Meta.
  META_POR_TIRADA: Number(process.env.META_POR_TIRADA || 56),
  META_CAPACIDAD_MAXIMA: Number(process.env.META_CAPACIDAD_MAXIMA || 500),

  // Guías/recomendaciones. No bloquean procesar ni empaquetar.
  META_MAXIMA_PROCESO: Number(process.env.META_MAXIMA_PROCESO || 448),
  META_GUIA_PROCESO: Number(process.env.META_GUIA_PROCESO || 448),
  TIRADAS_PARA_PROCESAR: Number(process.env.TIRADAS_PARA_PROCESAR || 9),
  META_PARA_EMPAQUETAR: Number(process.env.META_PARA_EMPAQUETAR || 448),
  META_GUIA_EMPAQUETAR: Number(process.env.META_GUIA_EMPAQUETAR || 448),

  TIRADA_COOLDOWN_MS: Number(process.env.TIRADA_COOLDOWN_MS || 70 * 60 * 1000),

  DAILY_REQUIRED_TIRADAS: Number(process.env.DAILY_REQUIRED_TIRADAS || 2),
  WEEKLY_REQUIRED_TIRADAS: Number(process.env.WEEKLY_REQUIRED_TIRADAS || 14),

  // Dinero limpio por excedente.
  DEFAULT_GROSS_PER_TIRADA: Number(process.env.DEFAULT_GROSS_PER_TIRADA || 40000),
  DEFAULT_CLEAN_DISCOUNT_PERCENT: Number(process.env.DEFAULT_CLEAN_DISCOUNT_PERCENT || 25),

  STAFF_ROLE_IDS,
  STAFF_ROLE_ID_SET: new Set(STAFF_ROLE_IDS),
  MEMBER_ROLE_IDS,
  MEMBER_ROLE_ID_SET: new Set(MEMBER_ROLE_IDS),

  ALLOWED_TIRADA_ROLE_IDS,
  ALLOWED_TIRADA_ROLE_ID_SET: new Set(ALLOWED_TIRADA_ROLE_IDS)
};
