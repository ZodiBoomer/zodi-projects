const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const lockFile = path.join(__dirname, "..", ".zodibot.lock");

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function removeLock() {
  try { fs.unlinkSync(lockFile); } catch (e) {}
}

if (!fs.existsSync(lockFile)) {
  console.log("Aucune instance détectée.");
  process.exit(0);
}

const raw = fs.readFileSync(lockFile, "utf8").trim();
const pid = Number(raw);
if (!isAlive(pid)) {
  removeLock();
  console.log("Ancien lock supprimé.");
  process.exit(0);
}

try {
  if (process.platform === "win32") {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGTERM");
  }
  removeLock();
  console.log(`Instance arrêtée (PID ${pid}).`);
} catch (e) {
  console.error("Impossible d'arrêter l'instance:", e.message || e);
  process.exit(1);
}
