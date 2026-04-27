const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  ALLOWED_TIRADA_ROLE_ID_SET,
  DELETE_REVIEW_ROLE_ID,
  DAILY_REQUIRED_TIRADAS,
  WEEKLY_REQUIRED_TIRADAS
} = require("../config");

const db = require("../db");

function getMemberRoleIds(member) {
  if (!member?.roles) return [];

  if (member.roles.cache) {
    return [...member.roles.cache.keys()];
  }

  if (Array.isArray(member.roles)) {
    return member.roles;
  }

  return [];
}

function memberHasAllowedRole(member) {
  return getMemberRoleIds(member).some(roleId => ALLOWED_TIRADA_ROLE_ID_SET.has(roleId));
}

function memberHasDeleteReviewRole(member) {
  return getMemberRoleIds(member).includes(DELETE_REVIEW_ROLE_ID);
}

function getLocalYmd(date = new Date(), timeZone = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(date);
}

function addDaysToYmd(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getCurrentWeekRange(timeZone = TIMEZONE) {
  const today = getLocalYmd(new Date(), timeZone);
  const [year, month, day] = today.split("-").map(Number);

  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNumber = d.getUTCDay() || 7;

  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dayNumber + 1);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10)
  };
}

function rowsToMap(rows) {
  const map = new Map();

  for (const row of rows) {
    map.set(row.user_id, Number(row.total || 0));
  }

  return map;
}

async function getComplianceForGuild(guild) {
  await guild.members.fetch();

  const members = [...guild.members.cache.values()]
    .filter(member => !member.user.bot)
    .filter(memberHasAllowedRole);

  const today = getLocalYmd(new Date(), TIMEZONE);
  const week = getCurrentWeekRange(TIMEZONE);

  const todayCounts = rowsToMap(
    db.getCountsByUserForLocalDateRange(TARGET_CHANNEL_ID, today, today)
  );

  const weekCounts = rowsToMap(
    db.getCountsByUserForLocalDateRange(TARGET_CHANNEL_ID, week.start, week.end)
  );

  const users = members.map(member => {
    const todayCount = todayCounts.get(member.id) || 0;
    const weekCount = weekCounts.get(member.id) || 0;

    return {
      user_id: member.id,
      username: member.user.username,
      display_name: member.displayName,
      today_count: todayCount,
      week_count: weekCount,
      daily_required: DAILY_REQUIRED_TIRADAS,
      weekly_required: WEEKLY_REQUIRED_TIRADAS,
      daily_ok: todayCount >= DAILY_REQUIRED_TIRADAS,
      weekly_ok: weekCount >= WEEKLY_REQUIRED_TIRADAS
    };
  });

  users.sort((a, b) => {
    if (a.daily_ok !== b.daily_ok) return a.daily_ok ? 1 : -1;
    if (a.weekly_ok !== b.weekly_ok) return a.weekly_ok ? 1 : -1;
    return a.display_name.localeCompare(b.display_name);
  });

  return {
    dailyRequired: DAILY_REQUIRED_TIRADAS,
    weeklyRequired: WEEKLY_REQUIRED_TIRADAS,
    today,
    week,
    users
  };
}

module.exports = {
  getMemberRoleIds,
  memberHasAllowedRole,
  memberHasDeleteReviewRole,
  getLocalYmd,
  getCurrentWeekRange,
  getComplianceForGuild
};
