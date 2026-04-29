const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BRAND = "𝓣𝓱𝓮 𝓛𝓸𝓼𝓽 𝓜𝓒 𝟏%";

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(ROOT, relativePath), content, "utf8");
  console.log(`[OK] ${relativePath}`);
}

function replaceBrand(relativePath) {
  if (!fileExists(relativePath)) return;

  let content = read(relativePath);

  const replacements = [
    [/TÍO CHILL MC/g, BRAND],
    [/TIO CHILL MC/g, BRAND],
    [/Tío Chill MC/g, BRAND],
    [/Tío Chill/g, "The Lost"],
    [/TIO CHILL/g, "THE LOST"],
    [/TÍO CHILL/g, "THE LOST"]
  ];

  for (const [pattern, value] of replacements) {
    content = content.replace(pattern, value);
  }

  write(relativePath, content);
}

function appendCssFix(relativePath) {
  if (!fileExists(relativePath)) return;

  let content = read(relativePath);

  if (content.includes("/* LOST_UI_FIX */")) {
    return;
  }

  content += `\n\n/* LOST_UI_FIX */\nselect, select option, select optgroup, input, textarea {\n  background: #050505 !important;\n  color: #ffffff !important;\n}\n\nselect:disabled, input:disabled, textarea:disabled {\n  background: #101010 !important;\n  color: #bdbdbd !important;\n}\n\nselect option:checked {\n  background: #d4af37 !important;\n  color: #050505 !important;\n}\n\n.brand-icon:not(:has(*))::before {\n  content: "🏍️";\n}\n`;

  write(relativePath, content);
}

function ensureWebPlusInIndex() {
  const relativePath = "src/index.js";
  if (!fileExists(relativePath)) return;

  let content = read(relativePath);
  const before = content;

  content = content.replace('require("./web")', 'require("./webPlus")');
  content = content.replace("require('./web')", "require('./webPlus')");

  if (content !== before) {
    write(relativePath, content);
  }
}

[
  "web/public/index.html",
  "web/public/login.html",
  "web/public/member-admin.html",
  "web/public/member-login.html",
  "web/public/member.html",
  "web/public/panel-login.html",
  "web/public/panel.html"
].forEach(replaceBrand);

appendCssFix("web/public/styles.css");
appendCssFix("web/public/panel.css");
ensureWebPlusInIndex();

console.log("Arreglos aplicados: login unificado, marca The Lost y controles oscuros.");
