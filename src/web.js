require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const XLSX = require("xlsx");

const {
  getAllTiradas,
  getTopUsers,
  getDistinctUsers,
  getDashboardStats,
  getFilteredTiradas
} = require("./db");

function createWebApp() {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(session({
    secret: process.env.SESSION_SECRET || "cambia-esto",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false
    }
  }));

  const publicDir = path.join(__dirname, "..", "web", "public");
  app.use("/static", express.static(publicDir));

  function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    return res.redirect("/login");
  }

  app.get("/login", (req, res) => {
    res.sendFile(path.join(publicDir, "login.html"));
  });

  app.post("/login", (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const validUser = username === (process.env.WEB_USERNAME || "staff");
    const validPass = password === process.env.WEB_PASSWORD;

    if (!validUser || !validPass) {
      return res.redirect("/login?error=1");
    }

    req.session.authenticated = true;
    req.session.username = username;
    return res.redirect("/");
  });

  app.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/login");
    });
  });

  app.get("/", requireAuth, (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/api/dashboard", requireAuth, (req, res) => {
    const stats = getDashboardStats();
    const top = getTopUsers(10);
    const users = getDistinctUsers();

    res.json({
      ok: true,
      stats,
      top,
      users
    });
  });

  app.get("/api/tiradas", requireAuth, (req, res) => {
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

  app.get("/api/export", requireAuth, (req, res) => {
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
    res.download(filePath, fileName);
  });

  return app;
}

module.exports = {
  createWebApp
};