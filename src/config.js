const DEFAULT_TARGET_CHANNEL_ID = "1510256969452359680";

function parseRoleIds(value) {
  return String(value || "")
    .split(",")
    .map(roleId => roleId.trim())
    .filter(Boolean);
}

module.exports = {
  TARGET_CHANNEL_ID: process.env.TARGET_CHANNEL_ID || DEFAULT_TARGET_CHANNEL_ID,
  TIMEZONE: process.env.TIMEZONE || "Europe/Madrid",
  ALLOWED_TIRADA_ROLE_IDS: parseRoleIds(process.env.ALLOWED_TIRADA_ROLE_IDS)
};
