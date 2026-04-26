require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const XLSX = require("xlsx");

const {
  insertTirada,
  getTopUsers,
  getDistinctUsers,
  getDashboardStats,
  getFilteredTiradas,
  getTotalByUser,
  getUserSummary,
  getPendingTiradasCount,
  getPendingMetaTotal,
  getPendingTiradasByUser,
  getProcesos,
  backupDatabase,
  getDbPath
} = require("./db");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIMEZONE = process.env.TIMEZONE || "Europe/Madrid";
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const META_POR_TIRADA = 56;
const META_MAXIMA_PROCESO = 448;
const TIRADAS_PARA_PROCESAR = META_MAXIMA_PROCESO / META_POR_TIRADA;

function getIsoWeekFromParts(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / MS_PER_DAY) + 1) / 7);
}

function getLocalParts(date = new Date(), timeZone = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value ?? "0";

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

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

function createWebApp() {
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

    const validUser = username === expectedUsername;
    const validPass = password === expectedPassword;

    if (!validUser || !validPass) {
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
  const stats = getDashboardStats();
  const top = getTopUsers(10);
  const users = getDistinctUsers();

  const tiradasPendientes = getPendingTiradasCount(TARGET_CHANNEL_ID);
  const metaActual = getPendingMetaTotal(TARGET_CHANNEL_ID, META_POR_TIRADA);
  const metaRestante = Math.max(META_MAXIMA_PROCESO - metaActual, 0);
  const tiradasRestantes = Math.max(TIRADAS_PARA_PROCESAR - tiradasPendientes, 0);

  res.json({
    ok: true,
    stats,
    top,
    users,
    dbPath: getDbPath(),
    meta: {
      metaPorTirada: META_POR_TIRADA,
      metaMaximaProceso: META_MAXIMA_PROCESO,
      tiradasParaProcesar: TIRADAS_PARA_PROCESAR,
      tiradasPendientes,
      metaActual,
      metaRestante,
      tiradasRestantes,
      listoParaProcesar: metaActual >= META_MAXIMA_PROCESO,
      porUsuarios: getPendingTiradasByUser(TARGET_CHANNEL_ID),
      ultimosProcesos: getProcesos(5)
    }
  });
});

  app.get("/api/tiradas", requireApiAuth, (req, res) => {
    const rows = getFilteredTiradas({
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

  app.post("/api/users/:userId/total", requireApiAuth, (req, res) => {
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

    const user = getUserSummary(userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "No se encontró ese usuario."
      });
    }

    const before = Number(getTotalByUser(userId));
    const delta = newTotal - before;

    if (delta !== 0) {
      insertTirada(buildManualAdjustmentRow(user, delta));
    }

    res.json({
      ok: true,
      before,
      after: Number(getTotalByUser(userId)),
      delta
    });
  });

  app.get("/api/export", requireApiAuth, (req, res) => {
    const rows = getFilteredTiradas({
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

      await backupDatabase(filePath);

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
