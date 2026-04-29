const { createWebApp: createBaseWebApp } = require("./web");
const { attachPanelRoutes } = require("./routes/panelRoutes");

/**
 * Crea la misma web que ya tienes actualmente, pero añade encima:
 * - Login unificado por usuarios web.
 * - Panel de miembros/staff/jefes.
 * - Calendario de salidas.
 * - Gestión de usuarios y contraseñas para jefes.
 *
 * No borra ni sustituye tus rutas actuales de tiradas.
 */
function createWebApp(options = {}) {
  const app = createBaseWebApp(options);
  attachPanelRoutes(app, options);
  return app;
}

module.exports = { createWebApp };
