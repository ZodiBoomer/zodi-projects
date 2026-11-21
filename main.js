const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const UI_LOCK_FILE = path.join(__dirname, "ui_instance.json");
const BOT_LOCK_FILE = path.join(__dirname, "..", ".zodibot.lock");

let mainWindow = null;
let botStarted = false;

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function takeUiLock() {
  try {
    if (fs.existsSync(UI_LOCK_FILE)) {
      const raw = fs.readFileSync(UI_LOCK_FILE, "utf8");
      const parsed = JSON.parse(raw);
      const otherPid = Number(parsed?.pid);
      if (otherPid && otherPid !== process.pid && isProcessAlive(otherPid)) {
        try {
          if (process.platform === "win32") {
            spawnSync("taskkill", ["/PID", String(otherPid), "/T", "/F"], { stdio: "ignore" });
          } else {
            process.kill(otherPid);
          }
        } catch (e) {}
      }
    }
    fs.writeFileSync(UI_LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2), "utf8");
  } catch (e) {
    // ignore lock errors
  }
}

function releaseUiLock() {
  try {
    if (!fs.existsSync(UI_LOCK_FILE)) return;
    const raw = fs.readFileSync(UI_LOCK_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Number(parsed?.pid) === process.pid) {
      fs.unlinkSync(UI_LOCK_FILE);
    }
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    backgroundColor: "#0e0f11",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function startBotOnce() {
  if (process.env.ZODI_SKIP_BOT === "1") return;
  if (botStarted) return;
  try {
    if (fs.existsSync(BOT_LOCK_FILE)) {
      const raw = fs.readFileSync(BOT_LOCK_FILE, "utf8").trim();
      const existingPid = Number(raw);
      if (existingPid && existingPid !== process.pid && isProcessAlive(existingPid)) return;
      try { fs.unlinkSync(BOT_LOCK_FILE); } catch (e) {}
    }
  } catch (e) {}
  botStarted = true;
  try {
    require(path.join(__dirname, "..", "index.js"));
  } catch (e) {
    console.error("Failed to start bot from Electron:", e);
  }
}

app.whenReady().then(() => {
  takeUiLock();
  createWindow();
  startBotOnce();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    releaseUiLock();
    app.quit();
  }
});

app.on("before-quit", () => {
  releaseUiLock();
});
