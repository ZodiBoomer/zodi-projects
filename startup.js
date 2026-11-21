const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const startupDir = process.platform === "win32" && process.env.APPDATA
  ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
  : null;
const shortcutPath = startupDir ? path.join(startupDir, "ZodiBot Local.lnk") : null;
const launcherPath = path.join(rootDir, "tools", "start-local-hidden.vbs");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function runPowerShell(script) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    cwd: rootDir,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureWindows() {
  if (process.platform !== "win32") {
    fail("Le demarrage automatique est prevu pour Windows.");
  }
  if (!startupDir || !shortcutPath) {
    fail("Impossible de trouver le dossier de demarrage Windows.");
  }
}

function install() {
  ensureWindows();
  if (!fs.existsSync(launcherPath)) {
    fail(`Lanceur introuvable: ${launcherPath}`);
  }
  fs.mkdirSync(startupDir, { recursive: true });

  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${quotePs(shortcutPath)})`,
    "$shortcut.TargetPath = 'wscript.exe'",
    `$shortcut.Arguments = ${quotePs(`"${launcherPath}"`)}`,
    `$shortcut.WorkingDirectory = ${quotePs(rootDir)}`,
    "$shortcut.WindowStyle = 7",
    "$shortcut.Description = 'Demarre ZodiBot en local avec Electron'",
    "$shortcut.Save()"
  ].join("; ");

  runPowerShell(script);
  console.log(`Demarrage Windows active: ${shortcutPath}`);
}

function remove() {
  ensureWindows();
  try {
    if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath);
    console.log("Demarrage Windows desactive.");
  } catch (e) {
    fail(`Impossible de supprimer le raccourci: ${e.message || e}`);
  }
}

function status() {
  ensureWindows();
  console.log(fs.existsSync(shortcutPath)
    ? `Active: ${shortcutPath}`
    : "Desactive");
}

const action = String(process.argv[2] || "install").toLowerCase();
if (action === "install") install();
else if (action === "remove" || action === "uninstall") remove();
else if (action === "status") status();
else fail("Utilisation: node tools/startup.js install|remove|status");
