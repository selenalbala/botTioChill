const path = require("path");

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

function attachCurrentUser(req, res, next) {
  req.panelUser = getUserById(req.session.panelUserId);

  if (!req.panelUser || !req.panelUser.active) {
    req.session.panelUserId = null;
    req.session.panelRole = null;
    req.session.panelUsername = null;
    return res.status(401).json({ ok: false, error: "Sesión caducada. Vuelve a iniciar sesión." });
  }

  return next();
}

function requireMinimumRole(role) {
  return (req, res, next) => {
    const user = req.panelUser || getUserById(req.session.panelUserId);

    if (!user || !hasRole(user, role)) {
      return res.status(403).json({ ok: false, error: "No tienes permisos para esta acción." });
    }

    req.panelUser = user;
    return next();
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

function mirrorPanelSessionToLegacySessions(req, user) {
  req.session.panelUserId = user.id;
  req.session.panelRole = user.role;
  req.session.panelUsername = user.username;

  // Permite que el panel antiguo de tiradas y cuentas-miembros no pida otro login.
  if (["boss", "staff"].includes(user.role)) {
    req.session.authenticated = true;
    req.session.username = user.username;
  } else {
    delete req.session.authenticated;
    delete req.session.username;
  }

  // Permite que los miembros entren en /mi-meta sin otro login.
  if (user.discordUserId) {
    req.session.memberAuthenticated = true;
    req.session.memberUserId = user.discordUserId;
    req.session.memberUsername = user.username;
  } else {
    delete req.session.memberAuthenticated;
    delete req.session.memberUserId;
    delete req.session.memberUsername;
  }
}

async function notifySalidaToDiscord(client, salida, action, actor) {
  const channelId = process.env.SALIDAS_CHANNEL_ID;
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
    `🕒 ${salida.startsAt}${salida.endsAt ? ` - ${salida.endsAt}` : ""}`,
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

  seedDefaultBossFromEnv()
    .then(() => {
      importMemberWebAccountsIntoPanelUsers();
    })
    .catch(error => {
      console.error("[PANEL] Error creando usuario jefe inicial:", error);
    });

  const publicDir = getPublicDir();

  app.get("/panel/login", (req, res) => {
    if (req.session?.panelUserId) return res.redirect("/panel");
    return res.sendFile(path.join(publicDir, "panel-login.html"));
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

      mirrorPanelSessionToLegacySessions(req, user);

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
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/panel/me", requirePanelApi, attachCurrentUser, (req, res) => {
    res.json({ ok: true, user: req.panelUser });
  });

  app.get("/api/panel/users", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), (req, res) => {
    res.json({ ok: true, users: listUsers() });
  });

  app.post("/api/panel/users", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), async (req, res) => {
    try {
      const user = await createUser({
        discordUserId: req.body.discordUserId,
        username: req.body.username,
        displayName: req.body.displayName,
        password: req.body.password,
        role: req.body.role || "member",
        active: req.body.active !== false
      });

      importMemberWebAccountsIntoPanelUsers();
      res.json({ ok: true, user });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.patch("/api/panel/users/:id", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), async (req, res) => {
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

  app.post("/api/panel/users/:id/password", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), async (req, res) => {
    try {
      const user = await resetPassword(req.params.id, req.body.password);
      res.json({ ok: true, user });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/panel/salidas", requirePanelApi, attachCurrentUser, (req, res) => {
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

  app.get("/api/panel/salidas/:id", requirePanelApi, attachCurrentUser, (req, res) => {
    try {
      const details = getSalidaDetails(req.params.id, req.panelUser.id);
      res.json({ ok: true, ...details });
    } catch (error) {
      res.status(404).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/salidas", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), async (req, res) => {
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

  app.patch("/api/panel/salidas/:id", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), async (req, res) => {
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

  app.post("/api/panel/salidas/:id/status", requirePanelApi, attachCurrentUser, requireMinimumRole("boss"), async (req, res) => {
    try {
      const salida = setSalidaStatus(req.params.id, req.body.status);
      await notifySalidaToDiscord(client, salida, salida.status === "cancelled" ? "cancelled" : "closed", req.panelUser).catch(error => {
        console.error("[PANEL] No se pudo publicar cambio de estado en Discord:", error.message);
      });

      res.json({ ok: true, salida });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/panel/salidas/:id/vote", requirePanelApi, attachCurrentUser, (req, res) => {
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

  app.post("/api/panel/salidas/:id/comments", requirePanelApi, attachCurrentUser, (req, res) => {
    try {
      addComment({
        salidaId: req.params.id,
        userId: req.panelUser.id,
        comment: req.body.comment
      });

      const details = getSalidaDetails(req.params.id, req.panelUser.id);
      res.json({ ok: true, ...details });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/panel/comments/:id", requirePanelApi, attachCurrentUser, (req, res) => {
    try {
      deleteComment({ commentId: req.params.id, requester: req.panelUser });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { attachPanelRoutes };
