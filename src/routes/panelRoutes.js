const path = require("path");
const {
  SALIDAS_CHANNEL_ID,
  TARGET_CHANNEL_ID,
  STAFF_ROLE_ID_SET
} = require("../config");
const {
  initPanelAuthTables,
  seedDefaultBossFromEnv,
  importMemberWebAccountsIntoPanelUsers,
  listUsers,
  createUser,
  updateUser,
  resetPassword,
  validateLogin,
  getUserById,
  hasRole
} = require("../services/panelAuthService");
const {
  initSalidaTables,
  listSalidas,
  getSalidaDetails,
  createSalida,
  updateSalida,
  setSalidaStatus,
  upsertVote,
  addComment,
  deleteComment
} = require("../services/salidaService");
const { getMemberRoleIds } = require("../services/complianceService");
const {
  initMoneyTables,
  getMoneyConfig,
  setMoneyConfig,
  buildBonusSummary,
  setUserWeekTotal
} = require("../services/metaMoneyService");
const { refreshMetaPanel } = require("../services/panelService");

function getPublicDir() {
  return path.join(__dirname, "..", "..", "web", "public");
}

function requirePanelPage(req, res, next) {
  if (req.session?.panelUserId) return next();
  return res.redirect("/panel/login");
}

function requirePanelApi(req, res, next) {
  if (req.session?.panelUserId) return next();
  return res.status(401).json({ ok: false, error: "Sesión caducada. Vuelve a iniciar sesión." });
}

async function getMainGuild(client) {
  if (!client) return null;

  if (process.env.GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
    if (guild) return guild;
  }

  if (TARGET_CHANNEL_ID) {
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);
    if (channel?.guild) return channel.guild;
  }

  return client.guilds.cache.first() || null;
}

async function getDiscordMemberForPanelUser(client, panelUser) {
  if (!client || !panelUser?.discordUserId) return null;
  const guild = await getMainGuild(client);
  if (!guild) return null;
  return guild.members.fetch(String(panelUser.discordUserId)).catch(() => null);
}

async function buildPermissions(client, panelUser) {
  const member = await getDiscordMemberForPanelUser(client, panelUser);
  const discordRoleIds = member ? getMemberRoleIds(member).map(String) : [];
  const hasConfiguredStaffRole = discordRoleIds.some(roleId => STAFF_ROLE_ID_SET.has(roleId));

  // No hace falta un rol genérico llamado "staff". Se validan los IDs configurados.
  const canStaff = hasConfiguredStaffRole || hasRole(panelUser, "staff");
  const canBoss = hasConfiguredStaffRole || hasRole(panelUser, "boss");

  return {
    canStaff,
    canBoss,
    hasConfiguredStaffRole,
    discordRoleIds
  };
}

function requireMinimumRole(role) {
  return (req, res, next) => {
    const user = getUserById(req.session.panelUserId);
    if (!user || !hasRole(user, role)) {
      return res.status(403).json({ ok: false, error: "No tienes permisos para esta acción." });
    }
    req.panelUser = user;
    return next();
  };
}

function attachCurrentUser(client) {
  return async (req, res, next) => {
    req.panelUser = getUserById(req.session.panelUserId);
    if (!req.panelUser || !req.panelUser.active) {
      req.session.panelUserId = null;
      return res.status(401).json({ ok: false, error: "Sesión caducada. Vuelve a iniciar sesión." });
    }

    req.panelPermissions = await buildPermissions(client, req.panelUser);
    return next();
  };
}

function requireConfiguredStaff() {
  return (req, res, next) => {
    if (req.panelPermissions?.canStaff) return next();
    return res.status(403).json({ ok: false, error: "No tienes permisos para esta acción." });
  };
}

function eventToCalendar(salida) {
  const statusText = salida.status === "cancelled" ? "❌ " : salida.status === "closed" ? "🔒 " : "🏍️ ";
  return {
    id: String(salida.id),
    title: `${statusText}${salida.title}`,
    start: salida.startsAt,
    end: salida.endsAt || undefined,
    extendedProps: {
      location: salida.location,
      description: salida.description,
      status: salida.status,
      creatorName: salida.creatorName
    }
  };
}

async function notifySalidaToDiscord(client, salida, action, actor) {
  const channelId = process.env.SALIDAS_CHANNEL_ID || SALIDAS_CHANNEL_ID;
  if (!client || !channelId) return false;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.send) return false;

  const publicUrl = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const panelUrl = publicUrl ? `${publicUrl}/panel` : "/panel";
  const actionText = {
    created: "Nueva salida creada",
    updated: "Salida actualizada",
    cancelled: "Salida cancelada",
    closed: "Salida cerrada"
  }[action] || "Salida actualizada";

  const lines = [
    `🏍️ **${actionText}**`,
    "",
    `**${salida.title}**`,
    salida.location ? `📍 ${salida.location}` : null,
    `🗓️ ${salida.startsAt}${salida.endsAt ? ` - ${salida.endsAt}` : ""}`,
    salida.description ? `📝 ${salida.description}` : null,
    "",
    `Gestionado por: **${actor.displayName || actor.username}**`,
    `Calendario: ${panelUrl}`
  ].filter(Boolean);

  await channel.send({ content: lines.join("\n") });
  return true;
}

function attachPanelRoutes(app, { client } = {}) {
  initPanelAuthTables();
  initSalidaTables();
  initMoneyTables();

  seedDefaultBossFromEnv()
    .then(() => {
      importMemberWebAccountsIntoPanelUsers();
    })
    .catch(error => {
      console.error("[PANEL] Error creando usuario jefe inicial:", error);
    });

  const publicDir = getPublicDir();
  const withCurrentUser = attachCurrentUser(client);

  app.get("/panel/login", (req, res) => {
    res.sendFile(path.join(publicDir, "panel-login.html"));
  });

  app.get("/panel", requirePanelPage, (req, res) => {
    res.sendFile(path.join(publicDir, "panel.html"));
  });

  app.get("/panel/calendario", requirePanelPage, (req, res) => {
    res.sendFile(path.join(publicDir, "panel.html"));
  });

  app.get("/panel/jefes", requirePanelPage, (req, res) => {
    res.sendFile(path.join(publicDir, "panel.html"));
  });

  app.post("/api/panel/login", async (req, res) => {
    try {
      const user = await validateLogin(req.body.username, req.body.password);
      if (!user) {
        return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
      }

      req.session.panelUserId = user.id;
      req.session.panelRole = user.role;
      req.session.panelUsername = user.username;
      req.session.save(error => {
        if (error) {
          console.error("[PANEL] Error guardando sesión:", error);
          return res.status(500).json({ ok: false, error: "No se pudo guardar la sesión." });
        }
        return res.json({ ok: true, user });
      });
    } catch (error) {
      console.error("[PANEL] Error en login:", error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/logout", requirePanelApi, (req, res) => {
    req.session.panelUserId = null;
    req.session.panelRole = null;
    req.session.panelUsername = null;
    req.session.save(() => res.json({ ok: true }));
  });

  app.get("/api/panel/me", requirePanelApi, withCurrentUser, (req, res) => {
    res.json({ ok: true, user: { ...req.panelUser, permissions: req.panelPermissions } });
  });

  app.get("/api/panel/users", requirePanelApi, withCurrentUser, requireMinimumRole("boss"), (req, res) => {
    res.json({ ok: true, users: listUsers() });
  });

  app.post("/api/panel/users", requirePanelApi, withCurrentUser, requireMinimumRole("boss"), async (req, res) => {
    try {
      const user = await createUser({
        discordUserId: req.body.discordUserId,
        username: req.body.username,
        displayName: req.body.displayName,
        password: req.body.password,
        role: req.body.role || "member",
        active: req.body.active !== false
      });
      res.json({ ok: true, user });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.patch("/api/panel/users/:id", requirePanelApi, withCurrentUser, requireMinimumRole("boss"), async (req, res) => {
    try {
      const user = await updateUser(req.params.id, {
        discordUserId: req.body.discordUserId,
        username: req.body.username,
        displayName: req.body.displayName,
        role: req.body.role,
        active: req.body.active
      });
      res.json({ ok: true, user });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/users/:id/password", requirePanelApi, withCurrentUser, requireMinimumRole("boss"), async (req, res) => {
    try {
      const user = await resetPassword(req.params.id, req.body.password);
      res.json({ ok: true, user });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/panel/salidas", requirePanelApi, withCurrentUser, (req, res) => {
    const salidas = listSalidas({
      start: req.query.start,
      end: req.query.end,
      includeCancelled: req.query.includeCancelled !== "false"
    });

    if (req.query.format === "calendar") {
      return res.json(salidas.map(eventToCalendar));
    }

    res.json({ ok: true, salidas });
  });

  app.get("/api/panel/salidas/:id", requirePanelApi, withCurrentUser, (req, res) => {
    try {
      const details = getSalidaDetails(req.params.id, req.panelUser.id);
      res.json({ ok: true, ...details });
    } catch (error) {
      res.status(404).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/salidas", requirePanelApi, withCurrentUser, requireConfiguredStaff(), async (req, res) => {
    try {
      const salida = createSalida({
        title: req.body.title,
        description: req.body.description,
        location: req.body.location,
        startsAt: req.body.startsAt,
        endsAt: req.body.endsAt,
        createdBy: req.panelUser.id
      });

      await notifySalidaToDiscord(client, salida, "created", req.panelUser).catch(error => {
        console.error("[PANEL] No se pudo publicar salida en Discord:", error.message);
      });

      res.json({ ok: true, salida });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.patch("/api/panel/salidas/:id", requirePanelApi, withCurrentUser, requireConfiguredStaff(), async (req, res) => {
    try {
      const salida = updateSalida(req.params.id, {
        title: req.body.title,
        description: req.body.description,
        location: req.body.location,
        startsAt: req.body.startsAt,
        endsAt: req.body.endsAt,
        status: req.body.status
      });

      await notifySalidaToDiscord(client, salida, "updated", req.panelUser).catch(error => {
        console.error("[PANEL] No se pudo publicar actualización en Discord:", error.message);
      });

      res.json({ ok: true, salida });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/salidas/:id/status", requirePanelApi, withCurrentUser, requireConfiguredStaff(), async (req, res) => {
    try {
      const salida = setSalidaStatus(req.params.id, req.body.status);
      await notifySalidaToDiscord(
        client,
        salida,
        salida.status === "cancelled" ? "cancelled" : "closed",
        req.panelUser
      ).catch(error => {
        console.error("[PANEL] No se pudo publicar cambio de estado en Discord:", error.message);
      });

      res.json({ ok: true, salida });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/salidas/:id/vote", requirePanelApi, withCurrentUser, (req, res) => {
    try {
      const vote = upsertVote({
        salidaId: req.params.id,
        userId: req.panelUser.id,
        status: req.body.status
      });
      const details = getSalidaDetails(req.params.id, req.panelUser.id);
      res.json({ ok: true, vote, ...details });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/salidas/:id/comments", requirePanelApi, withCurrentUser, (req, res) => {
    try {
      addComment({ salidaId: req.params.id, userId: req.panelUser.id, comment: req.body.comment });
      const details = getSalidaDetails(req.params.id, req.panelUser.id);
      res.json({ ok: true, ...details });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/panel/comments/:id", requirePanelApi, withCurrentUser, (req, res) => {
    try {
      deleteComment({ commentId: req.params.id, requester: req.panelUser });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/panel/meta/bonus", requirePanelApi, withCurrentUser, requireConfiguredStaff(), async (req, res) => {
    try {
      const guild = await getMainGuild(client);
      const summary = await buildBonusSummary({
        guild,
        desde: req.query.desde,
        hasta: req.query.hasta
      });
      res.json({ ok: true, ...summary });
    } catch (error) {
      console.error("[PANEL] Error cargando pagos:", error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/panel/meta/bonus/me", requirePanelApi, withCurrentUser, async (req, res) => {
    try {
      if (!req.panelUser.discordUserId) {
        return res.status(400).json({ ok: false, error: "Tu usuario web no tiene ID de Discord asociado." });
      }

      const guild = await getMainGuild(client);
      const summary = await buildBonusSummary({
        guild,
        desde: req.query.desde,
        hasta: req.query.hasta,
        onlyDiscordUserId: req.panelUser.discordUserId
      });
      res.json({ ok: true, ...summary });
    } catch (error) {
      console.error("[PANEL] Error cargando pago personal:", error);
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/panel/meta/bonus-config", requirePanelApi, withCurrentUser, requireConfiguredStaff(), (req, res) => {
    try {
      res.json({ ok: true, config: getMoneyConfig() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/meta/bonus-config", requirePanelApi, withCurrentUser, requireConfiguredStaff(), (req, res) => {
    try {
      const config = setMoneyConfig({
        grossPerTirada: req.body.grossPerTirada,
        cleanDiscountPercent: req.body.cleanDiscountPercent
      });
      res.json({ ok: true, config });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/meta/members/:discordUserId/week-total", requirePanelApi, withCurrentUser, requireConfiguredStaff(), async (req, res) => {
    try {
      const guild = await getMainGuild(client);
      const result = await setUserWeekTotal({
        guild,
        channelId: TARGET_CHANNEL_ID,
        userId: req.params.discordUserId,
        total: req.body.total
      });

      await refreshMetaPanel(client).catch(error => {
        console.error("[PANEL] No se pudo refrescar el panel de meta:", error.message);
      });

      res.json({ ok: true, result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { attachPanelRoutes };
