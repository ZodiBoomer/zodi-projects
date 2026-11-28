const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const lockFile = path.join(__dirname, "..", ".zodibot.lock");
const target = process.env.ZODI_RESTART_TARGET || path.join(__dirname, "..", "index.js");

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function startBot() {
  try {
    const child = spawn(process.execPath, [target], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(target),
      env: process.env
    });
    child.unref();
  } catch (e) {
    console.error("restart helper failed:", e);
  }
}

function waitForRelease(attempt = 0) {
  try {
    if (!fs.existsSync(lockFile)) {
      startBot();
      return;
    }
    const raw = fs.readFileSync(lockFile, "utf8").trim();
    const pid = Number(raw);
    if (!isAlive(pid)) {
      try { fs.unlinkSync(lockFile); } catch (e) {}
      startBot();
      return;
    }
  } catch (e) {}

  if (attempt >= 60) {
    startBot();
    return;
  }
  setTimeout(() => waitForRelease(attempt + 1), 500);
}

waitForRelease();
