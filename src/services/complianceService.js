const {
  TARGET_CHANNEL_ID,
  TIMEZONE,
  ALLOWED_TIRADA_ROLE_IDS,
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
  return getMemberRoleIds(member).some(roleId =>
    ALLOWED_TIRADA_ROLE_ID_SET.has(String(roleId))
  );
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

function compareSnowflakes(a, b) {
  const aa = BigInt(a);
  const bb = BigInt(b);

  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

async function fetchMembersWithGateway(guild) {
  const collection = await guild.members.fetch({
    withPresences: false,
    time: 30000
  });

  return [...collection.values()];
}

async function fetchMembersWithRestList(guild) {
  if (typeof guild.members.list !== "function") {
    return [];
  }

  const all = new Map();
  let after = "0";

  for (let i = 0; i < 30; i++) {
    const page = await guild.members.list({
      limit: 1000,
      after
    });

    if (!page || page.size === 0) break;

    for (const [id, member] of page) {
      all.set(id, member);
    }

    const ids = [...page.keys()].sort(compareSnowflakes);
    after = ids[ids.length - 1];

    if (page.size < 1000) break;
  }

  return [...all.values()];
}

async function fetchAllGuildMembers(guild) {
  const errors = [];

  try {
    const members = await fetchMembersWithGateway(guild);

    if (members.length > 0) {
      return {
        members,
        method: "gateway_fetch",
        errors
      };
    }
  } catch (error) {
    errors.push(`gateway_fetch: ${error.message}`);
    console.error("Error usando guild.members.fetch():", error);
  }

  try {
    const members = await fetchMembersWithRestList(guild);

    if (members.length > 0) {
      return {
        members,
        method: "rest_list",
        errors
      };
    }
  } catch (error) {
    errors.push(`rest_list: ${error.message}`);
    console.error("Error usando guild.members.list():", error);
  }

  const cachedMembers = [...guild.members.cache.values()];

  return {
    members: cachedMembers,
    method: "cache_fallback",
    errors
  };
}

async function getComplianceForGuild(guild) {
  if (!guild) {
    throw new Error("No se ha recibido el servidor de Discord.");
  }

  const loaded = await fetchAllGuildMembers(guild);
  const allMembers = loaded.members;

  const humanMembers = allMembers.filter(member => !member.user?.bot);
  const members = humanMembers.filter(memberHasAllowedRole);

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
      display_name: member.displayName || member.user.globalName || member.user.username,
      avatar_url: member.user.displayAvatarURL?.() || null,
      role_ids: getMemberRoleIds(member),
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

    return String(a.display_name || a.username || "").localeCompare(
      String(b.display_name || b.username || "")
    );
  });

  return {
    dailyRequired: DAILY_REQUIRED_TIRADAS,
    weeklyRequired: WEEKLY_REQUIRED_TIRADAS,
    today,
    week,
    users,
    debug: {
      guild_id: guild.id,
      guild_name: guild.name,
      load_method: loaded.method,
      load_errors: loaded.errors,
      total_members_loaded: allMembers.length,
      total_human_members: humanMembers.length,
      total_allowed_members: users.length,
      allowed_role_ids: ALLOWED_TIRADA_ROLE_IDS
    }
  };
}

module.exports = {
  getMemberRoleIds,
  memberHasAllowedRole,
  memberHasDeleteReviewRole,
  getLocalYmd,
  addDaysToYmd,
  getCurrentWeekRange,
  getComplianceForGuild
};
