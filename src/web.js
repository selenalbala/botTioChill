require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const XLSX = require("xlsx");

const {
  TARGET_CHANNEL_ID
} = require("./config");

const db = require("./db");

const {
  getMetaState,
  setCurrentMeta,
  getLocalParts,
  getIsoWeekFromParts
} = require("./services/metaService");

const { refreshMetaPanel } = require("./services/panelService");
const { logAction } = require("./services/actionLogService");
const { getComplianceForGuild } = require("./services/complianceService");

const {
  acceptReviewFromWeb,
  denyReviewFromWeb
} = require("./services/roleReviewService");

const TIMEZONE = process.env.TIMEZONE || "Europe/Madrid";

function buildManualAdjustmentRow(user, delta) {
  const now = new Date();
  const local = getLocalParts(now, TIMEZONE);

  return {
    timestamp_utc: now.toISOString(),
    fecha_local: `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${local.hour}:${local.minute}:${local.second}`,
    anio: local.year,
    mes: local.month,
    dia: local.day,
    semana_iso: getIsoWeekFromParts(local.year, local.month, local.day),
    guild_id: user.guild_id || process.env.GUILD_ID || "panel-web",
    channel_id: "panel-web-ajuste",
    user_id: user.user_id,
    username: user.username || user.user_id,
    display_name: user.display_name || user.username || user.user_id,
    conteo: delta
  };
}

function toInteger(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);

  if (!Number.isInteger(number)) return null;

  return number;
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

function createWebApp({ client } = {}) {
  const app = express();

  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(session({
    secret: process.env.SESSION_SECRET || "cambia-esto",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 8
    }
  }));

  const publicDir = path.join(__dirname, "..", "web", "public");
  app.use("/static", express.static(publicDir));

  function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    return res.redirect("/login");
  }

  function requireApiAuth(req, res, next) {
    if (req.session?.authenticated) return next();

    return res.status(401).json({
      ok: false,
      error: "Sesión caducada. Vuelve a iniciar sesión."
    });
  }

  app.get("/login", (req, res) => {
    res.sendFile(path.join(publicDir, "login.html"));
  });

  app.post("/login", (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "").trim();

    const expectedUsername = String(process.env.WEB_USERNAME || "staff").trim();
    const expectedPassword = String(process.env.WEB_PASSWORD || "").trim();

    if (!expectedPassword) {
      console.error("WEB_PASSWORD no está configurada en Railway.");
      return res.status(500).send("WEB_PASSWORD no está configurada en Railway.");
    }

    if (username !== expectedUsername || password !== expectedPassword) {
      console.log("Login incorrecto:", {
        usernameRecibido: username,
        usernameEsperado: expectedUsername,
        passwordConfigurada: Boolean(expectedPassword),
        longitudPasswordRecibida: password.length,
        longitudPasswordEsperada: expectedPassword.length
      });

      return res.redirect("/login?error=1");
    }

    req.session.authenticated = true;
    req.session.username = username;

    req.session.save(error => {
      if (error) {
        console.error("Error guardando sesión:", error);
        return res.status(500).send("Error guardando la sesión.");
      }

      return res.redirect("/");
    });
  });

  app.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });

  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/api/dashboard", requireApiAuth, (req, res) => {
    res.json({
      ok: true,
      stats: db.getDashboardStats(),
      top: db.getTopUsers(10),
      users: db.getDistinctUsers(),
      dbPath: db.getDbPath(),
      meta: getMetaState(TARGET_CHANNEL_ID),
      recentLogs: db.getRecentActionLogs(15),
      pendingRoleReviews: db.getRoleDeleteReviews("pending")
    });
  });

  app.get("/api/compliance", requireApiAuth, async (req, res) => {
    try {
      const guild = await getMainGuild(client);

      if (!guild) {
        return res.status(500).json({
          ok: false,
          error: "No se pudo encontrar el servidor."
        });
      }

      const compliance = await getComplianceForGuild(guild);

      res.json({
        ok: true,
        compliance
      });
    } catch (error) {
      console.error("Error cargando cumplimiento:", error);

      res.status(500).json({
        ok: false,
        error: "No se pudo cargar el cumplimiento."
      });
    }
  });

  app.get("/api/tiradas", requireApiAuth, (req, res) => {
    const rows = db.getFilteredTiradas({
      user_id: req.query.user_id || "",
      anio: req.query.anio || "",
      mes: req.query.mes || "",
      semana_iso: req.query.semana || "",
      desde: req.query.desde || "",
      hasta: req.query.hasta || ""
    });

    res.json({
      ok: true,
      total: rows.reduce((acc, row) => acc + Number(row.conteo || 0), 0),
      rows
    });
  });

  app.post("/api/meta/current", requireApiAuth, async (req, res) => {
    try {
      const metaActual = toInteger(req.body.metaActual);

      if (metaActual === null) {
        return res.status(400).json({
          ok: false,
          error: "La meta actual debe ser un número entero."
        });
      }

      const result = setCurrentMeta(metaActual, {
        username: req.session.username || "web",
        displayName: "Ajuste desde panel web",
        guildId: process.env.GUILD_ID || "panel-web"
      });

      await logAction(client, {
        guild_id: process.env.GUILD_ID || "panel-web",
        channel_id: TARGET_CHANNEL_ID,
        user_id: "panel-web",
        username: req.session.username || "web",
        display_name: "Panel web",
        action_type: "meta_manual_adjust",
        status: "success",
        details: `Meta antes: ${result.beforeMeta}. Meta ahora: ${result.afterMeta}. Tiradas antes: ${result.beforeTiradas}. Tiradas ahora: ${result.afterTiradas}.`
      });

      await refreshMetaPanel(client);

      res.json({
        ok: true,
        ...result,
        meta: getMetaState(TARGET_CHANNEL_ID)
      });
    } catch (error) {
      console.error("Error modificando meta:", error);

      res.status(400).json({
        ok: false,
        error: error.message
      });
    }
  });

  app.post("/api/users/:userId/total", requireApiAuth, async (req, res) => {
    const userId = String(req.params.userId || "").trim();
    const newTotal = toInteger(req.body.total);

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Usuario no válido."
      });
    }

    if (newTotal === null || newTotal < 0 || newTotal > 1000000) {
      return res.status(400).json({
        ok: false,
        error: "El total debe ser un número entero entre 0 y 1000000."
      });
    }

    const user = db.getUserSummary(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "No se encontró ese usuario."
      });
    }

    const before = Number(db.getTotalByUser(userId));
    const delta = newTotal - before;

    if (delta !== 0) {
      db.insertTirada(buildManualAdjustmentRow(user, delta));
    }

    await logAction(client, {
      guild_id: user.guild_id || process.env.GUILD_ID || "panel-web",
      channel_id: "panel-web-ajuste",
      user_id: userId,
      username: user.username,
      display_name: user.display_name,
      action_type: "tiradas_manual_adjust",
      status: "success",
      details: `Antes: ${before}. Ahora: ${newTotal}. Ajuste: ${delta}.`
    });

    await refreshMetaPanel(client);

    res.json({
      ok: true,
      before,
      after: Number(db.getTotalByUser(userId)),
      delta
    });
  });

  app.delete("/api/users/:userId", requireApiAuth, async (req, res) => {
    const userId = String(req.params.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: "Usuario no válido."
      });
    }

    const user = db.getUserSummary(userId);
    const result = db.deleteTiradasByUser(userId);

    db.resolvePendingReviewsForUser({
      userId,
      status: "accepted",
      resolvedByUserId: "panel-web",
      resolvedByUsername: req.session.username || "web"
    });

    await logAction(client, {
      guild_id: user?.guild_id || process.env.GUILD_ID || "panel-web",
      user_id: userId,
      username: user?.username || userId,
      display_name: user?.display_name || userId,
      action_type: "delete_user_from_web",
      status: "success",
      details: `Registros eliminados: ${result.changes}.`
    });

    await refreshMetaPanel(client);

    res.json({
      ok: true,
      deletedRows: result.changes
    });
  });

  app.get("/api/role-reviews", requireApiAuth, (req, res) => {
    res.json({
      ok: true,
      reviews: db.getRoleDeleteReviews(req.query.status || "pending")
    });
  });

  app.post("/api/role-reviews/:id/accept", requireApiAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const result = await acceptReviewFromWeb(client, id, {
        userId: "panel-web",
        username: req.session.username || "web"
      });

      res.json({
        ok: true,
        deletedRows: result.deletedRows
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error.message
      });
    }
  });

  app.post("/api/role-reviews/:id/deny", requireApiAuth, async (req, res) => {
    try {
      const id = Number(req.params.id);

      await denyReviewFromWeb(client, id, {
        userId: "panel-web",
        username: req.session.username || "web"
      });

      res.json({
        ok: true
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error.message
      });
    }
  });

  app.get("/api/export", requireApiAuth, (req, res) => {
    const rows = db.getFilteredTiradas({
      user_id: req.query.user_id || "",
      anio: req.query.anio || "",
      mes: req.query.mes || "",
      semana_iso: req.query.semana || "",
      desde: req.query.desde || "",
      hasta: req.query.hasta || ""
    });

    const exportDir = path.join(process.cwd(), "exports");

    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Tiradas");

    const fileName = `tiradas_panel_${Date.now()}.xlsx`;
    const filePath = path.join(exportDir, fileName);

    XLSX.writeFile(workbook, filePath);

    res.download(filePath, fileName, () => {
      fs.rm(filePath, { force: true }, () => {});
    });
  });

  app.get("/api/download-db", requireAuth, async (req, res) => {
    try {
      const exportDir = path.join(process.cwd(), "exports");

      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `tiradas_backup_${stamp}.db`;
      const filePath = path.join(exportDir, fileName);

      await db.backupDatabase(filePath);

      res.download(filePath, fileName, err => {
        fs.rm(filePath, { force: true }, () => {});

        if (err) {
          console.error("Error descargando la DB:", err);
        }
      });
    } catch (error) {
      console.error("Error generando backup de la DB:", error);

      res.status(500).json({
        ok: false,
        error: "No se pudo generar el backup de la DB."
      });
    }
  });

  return app;
}

module.exports = {
  createWebApp
};
