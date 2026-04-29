const fs = require("fs");
const path = require("path");

const indexPath = path.join(process.cwd(), "src", "index.js");

if (!fs.existsSync(indexPath)) {
  console.error("No encuentro src/index.js. Ejecuta este script desde la raíz del proyecto.");
  process.exit(1);
}

const original = fs.readFileSync(indexPath, "utf8");

if (original.includes('require("./webPlus")')) {
  console.log("src/index.js ya está configurado para usar webPlus.");
  process.exit(0);
}

const changed = original.replace(
  'const { createWebApp } = require("./web");',
  'const { createWebApp } = require("./webPlus");'
);

if (changed === original) {
  console.error('No he podido encontrar la línea: const { createWebApp } = require("./web");');
  console.error("Cámbiala manualmente por:");
  console.error('const { createWebApp } = require("./webPlus");');
  process.exit(1);
}

fs.writeFileSync(indexPath, changed, "utf8");
console.log("He actualizado src/index.js para cargar el panel ampliado.");
