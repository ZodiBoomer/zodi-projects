// ==========================
// IMPORTS
// ==========================
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ComponentType,
  InteractionType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  PermissionsBitField,
  ActivityType,
  Partials
} = require("discord.js");
// PermissionsBitField has already been imported, no changes needed.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec, spawn, spawnSync } = require("child_process");
const http = require("http");
const https = require("https");
require("dotenv").config({ override: true });

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const INSTANCE_LOCK_FILE = path.join(__dirname, ".zodibot.lock");
const UI_BINDING_FILE = path.join(__dirname, "ui_binding.json");
const UI_LOCK_FILE = path.join(__dirname, "electron", "ui_instance.json");
const BOT_PROFILE_FILE = path.join(__dirname, "bot_profile.json");
const DEFAULT_BOT_BANNER_PATH = path.join(__dirname, "assets", "zodibot-banner.png");
let uiBinding = null;
let uiLocalModeEnabled = false;
let uiLocalState = null;
const uiSelectMemberCache = new Map();
const uiUserNameCache = new Map();
let uiPrimaryGuildId = null;
let uiPrimaryChannelId = null;
let uiPresencePages = [];
let uiPresencePageIndex = 0;
async function clearUiBindingMessage() {
  if (!uiBinding?.channelId || !uiBinding?.messageId) {
    uiBinding = null;
    try { if (fs.existsSync(UI_BINDING_FILE)) fs.unlinkSync(UI_BINDING_FILE); } catch (e) {}
    return;
  }
  try {
    const channel = await zodiClient.channels.fetch(uiBinding.channelId).catch(() => null);
    const message = channel?.isTextBased?.() ? await channel.messages.fetch(uiBinding.messageId).catch(() => null) : null;
    if (message) {
      await message.delete().catch(() => {});
    }
  } catch (e) {}
  uiBinding = null;
  try { if (fs.existsSync(UI_BINDING_FILE)) fs.unlinkSync(UI_BINDING_FILE); } catch (e) {}
}
let uiPendingModal = null;
const ACTION_LOG_FILE = path.join(__dirname, "action_log.json");
const BOT_STATUS_FILE = path.join(__dirname, "bot_status.json");
const actionLogMap = new Map();
const ACTION_LOG_MAX = 80;
const zodiChatMemoryMap = new Map();
const ZODI_CHAT_MEMORY_TTL_MS = 45 * 60 * 1000;
const ZODI_OLLAMA_HISTORY_ITEMS = 10;
const ZODI_OLLAMA_TIMEOUT_MS = Math.max(15000, Number(process.env.OLLAMA_TIMEOUT_MS) || 90000);
const ZODI_OPENAI_TIMEOUT_MS = Math.max(15000, Number(process.env.OPENAI_TIMEOUT_MS) || 120000);
const ZODI_BOT_DESCRIPTION = "PROPRIÉTAIRE DU BOT : zodiboomer\n\nCommande pour utiliser le bot\n[ Zodi / ]";
const ZODI_DEFAULT_ACTIVITY_NAME = "Visual Studio Code";

function loadUiBinding() {
  try {
    if (fs.existsSync(UI_BINDING_FILE)) {
      const raw = fs.readFileSync(UI_BINDING_FILE, "utf8");
      uiBinding = JSON.parse(raw);
    }
  } catch (e) {
    uiBinding = null;
  }
}

function saveUiBinding(binding) {
  try {
    uiBinding = binding;
    fs.writeFileSync(UI_BINDING_FILE, JSON.stringify(binding, null, 2), "utf8");
  } catch (e) {}
}

loadUiBinding();

function loadActionLogs() {
  try {
    if (!fs.existsSync(ACTION_LOG_FILE)) return;
    const raw = fs.readFileSync(ACTION_LOG_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    for (const [userId, entries] of Object.entries(data)) {
      if (!Array.isArray(entries)) continue;
      const normalized = entries.map(entry => {
        if (typeof entry === "string") {
          return { ts: Date.now(), text: sanitizeLogText(entry), actions: null, modal: null };
        }
        if (!entry || typeof entry !== "object") return null;
        const text = sanitizeLogText(entry.text || entry.message || "");
        if (!text) return null;
        const ts = Number(entry.ts) || Date.now();
        const actions = Array.isArray(entry.actions) ? entry.actions : null;
        const modal = entry.modal && typeof entry.modal === "object" ? entry.modal : null;
        return { ts, text, actions, modal };
      }).filter(Boolean);
      actionLogMap.set(userId, normalized.slice(-ACTION_LOG_MAX));
    }
  } catch (e) {}
}

function saveActionLogs() {
  try {
    const payload = Object.fromEntries(actionLogMap);
    fs.writeFileSync(ACTION_LOG_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {}
}

function loadBotStatus() {
  try {
    if (!fs.existsSync(BOT_STATUS_FILE)) return null;
    const raw = fs.readFileSync(BOT_STATUS_FILE, "utf8");
    const json = JSON.parse(raw);
    const status = String(json?.status || "").trim();
    if (!["online", "idle", "dnd", "invisible"].includes(status)) return null;
    return status;
  } catch (e) {
    return null;
  }
}

function saveBotStatus(status) {
  try {
    const payload = { status, updatedAt: new Date().toISOString() };
    fs.writeFileSync(BOT_STATUS_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {}
}

function sanitizeLogText(text) {
  return String(text || "")
    .replace(/<@!?(\d+)>/g, "@$1")
    .trim();
}

function normalizeLogActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const cleaned = actions.map(row => (Array.isArray(row) ? row.filter(btn => btn && btn.customId) : [])).filter(row => row.length);
  return cleaned.length ? cleaned : null;
}

function normalizeLogModal(modal) {
  if (!modal || typeof modal !== "object") return null;
  if (!modal.customId || !Array.isArray(modal.inputs)) return null;
  return {
    customId: modal.customId,
    title: modal.title || "Formulaire",
    inputs: modal.inputs.map(input => ({
      id: input.id,
      label: input.label || input.id,
      placeholder: input.placeholder || "",
      required: input.required !== false
    }))
  };
}

function addActionLog(userId, text, actions, modal) {
  if (!userId || !text) return;
  const entryText = sanitizeLogText(text).slice(0, 400);
  if (!entryText) return;
  if (/🧹|purge|suppression des messages|suppression totale|reset|réinitialiser|redémarrage|arrêt du bot|arrêt|stop/i.test(entryText)) return;
  const entryActions = normalizeLogActions(actions);
  const entryModal = normalizeLogModal(modal);
  const entry = { ts: Date.now(), text: entryText, actions: entryActions, modal: entryModal };
  const list = actionLogMap.get(userId) || [];
  const last = list[list.length - 1];
  const sameActions = JSON.stringify(last?.actions || null) === JSON.stringify(entryActions || null);
  const sameModal = JSON.stringify(last?.modal || null) === JSON.stringify(entryModal || null);
  if (last && last.text === entryText && sameActions && sameModal) return;
  list.push(entry);
  while (list.length > ACTION_LOG_MAX) list.shift();
  actionLogMap.set(userId, list);
  saveActionLogs();
}

function getActionLogs(userId) {
  return actionLogMap.get(userId) || [];
}

function clearActionLogs(userId = null) {
  if (userId) {
    actionLogMap.delete(userId);
  } else {
    actionLogMap.clear();
  }
  saveActionLogs();
}

function formatLogTimestamp(ts) {
  try {
    const d = new Date(ts);
    const date = d.toLocaleDateString("fr-FR");
    const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return `${date} ${time}`;
  } catch (e) {
    return "";
  }
}

loadActionLogs();

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function tryClosePreviousUiWindow() {
  try {
    if (!fs.existsSync(UI_LOCK_FILE)) return;
    const raw = fs.readFileSync(UI_LOCK_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const otherPid = Number(parsed?.pid);
    if (!otherPid || otherPid === process.pid) return;
    if (!isProcessAlive(otherPid)) {
      fs.unlinkSync(UI_LOCK_FILE);
      return;
    }
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(otherPid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(otherPid);
    }
    try { fs.unlinkSync(UI_LOCK_FILE); } catch (e) {}
  } catch (e) {}
}

function ensureSingleInstance() {
  try {
    if (fs.existsSync(INSTANCE_LOCK_FILE)) {
      const raw = fs.readFileSync(INSTANCE_LOCK_FILE, "utf8").trim();
      const existingPid = Number(raw);
      if (isProcessAlive(existingPid)) {
        console.error(`ZodiBot est déjà lancé (PID ${existingPid}). Arrête l'autre instance avant d'en relancer une.`);
        autoLaunchElectronUiOnce();
        process.exit(0);
      }
    }
    fs.writeFileSync(INSTANCE_LOCK_FILE, String(process.pid), "utf8");
  } catch (e) {
    console.error("Impossible de creer le fichier de lock:", e);
  }
  const cleanup = () => {
    try {
      const raw = fs.readFileSync(INSTANCE_LOCK_FILE, "utf8").trim();
      if (raw === String(process.pid)) fs.unlinkSync(INSTANCE_LOCK_FILE);
    } catch (e) {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}

ensureSingleInstance();

async function attachUiState(result) {
  if (!result || result.ok === false) return result;
  const state = await getUiState().catch(() => null);
  return state ? { ...result, state } : result;
}

app.get("/", (req, res) => res.send("Zodi Bot est en ligne !"));
app.listen(PORT, () => console.log(`Serveur actif sur port ${PORT}`));

app.get("/ui/state", async (req, res) => {
  const state = await getUiState().catch(() => ({ ready: false, bound: false }));
  res.json(state);
});

app.post("/ui/bind", async (req, res) => {
  const channelId = req.body?.channelId || null;
  const dmOnly = Boolean(req.body?.dmOnly);
  const local = Boolean(req.body?.local) || req.body?.mode === "local";
  const result = await bindUi(channelId, { dmOnly, local }).catch((e) => ({ ok: false, error: e?.message || "Erreur." }));
  res.json(await attachUiState(result));
});

app.post("/ui/action", async (req, res) => {
  const customId = req.body?.customId || "";
  const result = await handleUiAction(customId).catch((e) => ({ ok: false, error: e?.message || "Erreur." }));
  res.json(await attachUiState(result));
});

app.post("/ui/modal", async (req, res) => {
  const customId = req.body?.customId || "";
  const values = req.body?.values || {};
  const result = await handleUiModalSubmit(customId, values).catch((e) => ({ ok: false, error: e?.message || "Erreur." }));
  res.json(await attachUiState(result));
});

app.post("/ui/clear_logs", async (req, res) => {
  try {
    clearActionLogs(ADMIN_ONLY_USER_ID);
    return res.json(await attachUiState({ ok: true }));
  } catch (e) {
    return res.json({ ok: false, error: "Impossible de vider l'historique." });
  }
});

app.get("/ui/users", async (req, res) => {
  try {
    if (!zodiClient?.isReady?.()) return res.json({ ok: false, error: "Bot pas prêt." });
    const guild = await getUiPrimaryGuild();
    if (!guild) return res.json({ ok: false, error: "Serveur introuvable." });
    const limitRaw = parseInt(req.query?.limit || "25", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;
    const query = String(req.query?.q || "").toLowerCase();
    let members = [];
    if (query && typeof guild.members.search === "function") {
      const found = await guild.members.search({ query, limit }).catch(() => null);
      if (found) members = [...found.values()];
    }
    if (!members.length) {
      if (typeof guild.members.list === "function") {
        const listed = await guild.members.list({ limit: Math.min(limit, 100) }).catch(() => null);
        if (listed) members = [...listed.values()];
      } else {
        await guild.members.fetch({ limit: Math.min(limit, 100) }).catch(() => null);
        members = [...guild.members.cache.values()];
      }
    }
    members = members.filter(m => !m.user?.bot);
    if (query) {
      members = members.filter(m => {
        const name = (m.displayName || "").toLowerCase();
        const username = (m.user?.username || "").toLowerCase();
        return name.includes(query) || username.includes(query);
      });
    }
    members.sort((a, b) => {
      const an = (a.displayName || a.user?.username || "").toLowerCase();
      const bn = (b.displayName || b.user?.username || "").toLowerCase();
      return an.localeCompare(bn, "fr", { sensitivity: "base" });
    });
    const users = members.slice(0, limit).map(m => ({
      id: m.id,
      name: m.displayName || m.user?.username || m.id
    }));
    return res.json({ ok: true, users });
  } catch (e) {
    return res.json({ ok: false, error: "Impossible de charger la liste." });
  }
});

app.get("/ui/guilds", async (req, res) => {
  try {
    if (!zodiClient?.isReady?.()) return res.json({ ok: false, error: "Bot pas prêt." });
    const guilds = [];
    for (const guild of zodiClient.guilds.cache.values()) {
      const adminMember = await guild.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
      if (!adminMember) continue;
      guilds.push({ id: guild.id, name: guild.name });
    }
    return res.json({ ok: true, guilds });
  } catch (e) {
    return res.json({ ok: false, error: "Impossible de charger les serveurs." });
  }
});

app.post("/ui/select_guild", async (req, res) => {
  try {
    const guildId = String(req.body?.guildId || "");
    if (!guildId) return res.json({ ok: false, error: "Serveur invalide." });
    const guild = zodiClient.guilds.cache.get(guildId) || await zodiClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.json({ ok: false, error: "Serveur introuvable." });
    const adminMember = await guild.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
    if (!adminMember) return res.json({ ok: false, error: "Accès refusé." });
    uiPrimaryGuildId = guild.id;
    uiPrimaryChannelId = null;
    uiSelectMemberCache.clear();
    uiUserNameCache.clear();
    return res.json(await attachUiState({ ok: true }));
  } catch (e) {
    return res.json({ ok: false, error: "Sélection impossible." });
  }
});

app.get("/ui/channels", async (req, res) => {
  try {
    if (!zodiClient?.isReady?.()) return res.json({ ok: false, error: "Bot pas prêt." });
    const guild = await getUiPrimaryGuild();
    if (!guild) return res.json({ ok: false, error: "Serveur introuvable." });
    await guild.channels.fetch().catch(() => null);
    const me = guild.members.me || await guild.members.fetch(zodiClient.user.id).catch(() => null);
    const channels = [];
    for (const channel of guild.channels.cache.values()) {
      if (!channel?.isTextBased?.()) continue;
      if (channel?.isThread?.()) continue;
      if (me && channel.permissionsFor?.(me)?.has(PermissionsBitField.Flags.SendMessages)) {
        channels.push({ id: channel.id, name: `#${channel.name || channel.id}` });
      }
    }
    channels.sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
    return res.json({ ok: true, channels });
  } catch (e) {
    return res.json({ ok: false, error: "Impossible de charger les salons." });
  }
});

app.post("/ui/select_channel", async (req, res) => {
  try {
    const channelId = String(req.body?.channelId || "");
    if (!channelId) return res.json({ ok: false, error: "Salon invalide." });
    const channel = await zodiClient.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.()) return res.json({ ok: false, error: "Salon introuvable." });
    const guild = channel.guild || await getUiPrimaryGuild();
    if (!guild || (uiPrimaryGuildId && guild.id !== uiPrimaryGuildId)) {
      return res.json({ ok: false, error: "Salon hors serveur sélectionné." });
    }
    const me = guild.members.me || await guild.members.fetch(zodiClient.user.id).catch(() => null);
    if (me && !channel.permissionsFor?.(me)?.has(PermissionsBitField.Flags.SendMessages)) {
      return res.json({ ok: false, error: "Le bot n'a pas la permission d'écrire." });
    }
    uiPrimaryChannelId = channel.id;
    uiPrimaryGuildId = guild.id;
    uiLocalModeEnabled = false;
    await clearUiBindingMessage().catch(() => {});
    const msg = await sendMainMenuToChannel(uiPrimaryChannelId);
    if (!msg) return res.json({ ok: false, error: "Impossible d'envoyer le menu." });
    saveUiBinding({ channelId: uiPrimaryChannelId, messageId: msg.id });
    return res.json(await attachUiState({ ok: true }));
  } catch (e) {
    return res.json({ ok: false, error: "Sélection impossible." });
  }
});

function shouldAutoLaunchUi() {
  const uiMode = String(process.env.ZODI_UI || "").trim().toLowerCase();
  if (process.versions?.electron) return false;
  if (uiMode === "0" || uiMode === "false" || uiMode === "manual") return false;
  if (uiMode === "1" || uiMode === "true" || uiMode === "local" || uiMode === "auto") return true;
  if (process.env.REPL_ID || process.env.REPL_SLUG || process.env.REPLIT || process.env.REPL_OWNER) return false;
  if (process.env.CI) return false;
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production" && process.env.ZODI_LOCAL_PC !== "1") return false;
  return true;
}

function autoLaunchElectronUiOnce() {
  if (!shouldAutoLaunchUi()) return;
  if (global.__zodiUiLaunched) return;
  global.__zodiUiLaunched = true;
  tryClosePreviousUiWindow();
  const bin = process.platform === "win32"
    ? path.join(__dirname, "node_modules", "electron", "dist", "electron.exe")
    : path.join(__dirname, "node_modules", ".bin", "electron");
  if (!fs.existsSync(bin)) {
    console.warn("Electron non installe. Fais: npm install");
    return;
  }
  try {
    const uiScript = path.join(__dirname, "electron", "main.js");
    const logFile = path.join(__dirname, "electron", "ui.log");
    try {
      fs.appendFileSync(logFile, `${new Date().toLocaleString("fr-FR")} - lancement Electron: ${bin} ${uiScript}\n`, "utf8");
    } catch (e) {}
    let outFd = null;
    try { outFd = fs.openSync(logFile, "a"); } catch (e) {}
    const env = { ...process.env, ZODI_SKIP_BOT: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    child = spawn(bin, [uiScript], {
      cwd: __dirname,
      detached: true,
      windowsHide: process.platform === "win32",
      stdio: outFd ? ["ignore", outFd, outFd] : "ignore",
      env
    });
    try {
      fs.appendFileSync(logFile, `${new Date().toLocaleString("fr-FR")} - Electron spawn PID: ${child.pid || "inconnu"}\n`, "utf8");
    } catch (e) {}
    child.unref();
  } catch (e) {
    console.error("Impossible de lancer la fenetre Electron:", e);
  }
}

autoLaunchElectronUiOnce();

// ==========================
// BOT
// ==========================
const zodiClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.Channel],
});

async function getDefaultUiChannelId() {
  if (!zodiClient.isReady()) return null;
  const meId = zodiClient.user?.id;
  for (const guild of zodiClient.guilds.cache.values()) {
    let me = guild.members.me;
    if (!me && meId) {
      await guild.members.fetch(meId).catch(() => null);
      me = guild.members.me;
    }
    if (!me) continue;
    const sys = guild.systemChannel;
    if (sys && sys.isTextBased?.() && sys.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages)) {
      return sys.id;
    }
    for (const ch of guild.channels.cache.values()) {
      if (!ch?.isTextBased?.()) continue;
      const perms = ch.permissionsFor(me);
      if (perms?.has(PermissionsBitField.Flags.SendMessages)) return ch.id;
    }
  }
  return null;
}

async function sendMainMenuToUserDm(userId) {
  if (!userId) return null;
  const user = await zodiClient.users.fetch(userId).catch(() => null);
  if (!user) return null;
  const dm = await user.createDM().catch(() => null);
  if (!dm) return null;
  const view = buildMainMenuView();
  const msg = await dm.send({ embeds: [view.embed], components: view.components }).catch(() => null);
  if (msg?.id) {
    zodiOwnerMap.set(msg.id, userId);
    mainMenuMessageMap.set(userId, { channelId: dm.id, messageId: msg.id });
  }
  return msg;
}

async function sendMainMenuToChannel(channelId) {
  if (!channelId) return null;
  const channel = await zodiClient.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return null;
  const view = buildMainMenuView();
  const msg = await channel.send({ embeds: [view.embed], components: view.components }).catch(() => null);
  if (msg?.id) {
    zodiOwnerMap.set(msg.id, ADMIN_ONLY_USER_ID);
    mainMenuMessageMap.set(ADMIN_ONLY_USER_ID, { channelId, messageId: msg.id });
  }
  return msg;
}

async function getUiState() {
  if (uiLocalModeEnabled) {
    ensureLocalUiState();
    const rawLogs = getActionLogs(ADMIN_ONLY_USER_ID);
    const logs = await Promise.all(rawLogs.map(async entry => ({
      ...entry,
      text: await formatLogTextForUi(entry.text)
    })));
    const localState = serializeLocalUiState();
    if (localState?.embed) {
      localState.embed = await formatEmbedJsonMentions(localState.embed, { prefix: "" });
    }
    return {
      ready: true,
      bound: true,
      ...localState,
      modal: uiPendingModal,
      logs
    };
  }
  if (!zodiClient.isReady()) return { ready: false, bound: false, modal: uiPendingModal, logs: getActionLogs(ADMIN_ONLY_USER_ID) };
  if (uiBinding?.channelId && uiBinding?.messageId) {
    const channel = await zodiClient.channels.fetch(uiBinding.channelId).catch(() => null);
    const message = channel?.isTextBased?.() ? await channel.messages.fetch(uiBinding.messageId).catch(() => null) : null;
    if (message) {
      const rawLogs = getActionLogs(ADMIN_ONLY_USER_ID);
      const logs = await Promise.all(rawLogs.map(async entry => ({
        ...entry,
        text: await formatLogTextForUi(entry.text)
      })));
      return {
        ready: true,
        bound: true,
        ...await serializeMessageForUiWithNames(message),
        modal: uiPendingModal,
        logs
      };
    }
  }
  return { ready: true, bound: false, modal: uiPendingModal, logs: getActionLogs(ADMIN_ONLY_USER_ID) };
}

async function bindUi(channelId, options = {}) {
  const dmOnly = Boolean(options.dmOnly);
  const local = Boolean(options.local);
  if (local) {
    uiLocalModeEnabled = true;
    uiLocalState = null;
    uiBinding = null;
    uiPendingModal = null;
    ensureLocalUiState();
    return { ok: true, mode: "local" };
  }
  uiLocalModeEnabled = false;
  if (uiBinding?.channelId && uiBinding?.messageId) {
    const channel = await zodiClient.channels.fetch(uiBinding.channelId).catch(() => null);
    const message = channel?.isTextBased?.() ? await channel.messages.fetch(uiBinding.messageId).catch(() => null) : null;
    if (message) return { ok: true };
  }

  const existing = mainMenuMessageMap.get(ADMIN_ONLY_USER_ID);
  if (existing?.channelId && existing?.messageId) {
    const channel = await zodiClient.channels.fetch(existing.channelId).catch(() => null);
    const message = channel?.isTextBased?.() ? await channel.messages.fetch(existing.messageId).catch(() => null) : null;
    if (message) {
      saveUiBinding({ channelId: existing.channelId, messageId: existing.messageId });
      return { ok: true };
    }
  }

  const dmMsg = await sendMainMenuToUserDm(ADMIN_ONLY_USER_ID);
  if (dmMsg) {
    saveUiBinding({ channelId: dmMsg.channelId, messageId: dmMsg.id });
    return { ok: true };
  }

  if (dmOnly) {
    return { ok: false, error: "Impossible d'envoyer un DM. Active les DM pour ce serveur." };
  }

  const resolved = channelId || await getDefaultUiChannelId();
  if (!resolved) return { ok: false, error: "Aucun salon disponible." };
  const msg = await sendMainMenuToChannel(resolved);
  if (!msg) return { ok: false, error: "Impossible d'envoyer le menu." };
  saveUiBinding({ channelId: resolved, messageId: msg.id });
  return { ok: true };
}

async function buildUiInteraction(customId, message, userId) {
  const channel = message?.channel;
  const guild = message?.guild;
  const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
  const interaction = {
    type: InteractionType.MessageComponent,
    customId,
    user: { id: userId },
    member,
    message,
    channel,
    channelId: message?.channelId,
    values: [],
    deferred: false,
    replied: false,
    deferUpdate: async () => { interaction.deferred = true; },
    update: async (options) => { interaction.replied = true; return message.edit(options); },
    reply: async (options) => { interaction.replied = true; return channel.send(options); },
    followUp: async (options) => channel.send(options),
    editReply: async (options) => message.edit(options),
    showModal: async (modal) => {
      const serialized = serializeModalForUi(modal);
      uiPendingModal = serialized;
      if (serialized) addActionLog(userId, `🪟 Fenêtre ouverte : ${serialized.title}`, null, serialized);
    }
  };
  return interaction;
}

async function buildLocalUiInteraction(customId, userId) {
  const channel = createLocalUiChannel();
  const message = createLocalUiMessage();
  const interaction = {
    type: InteractionType.MessageComponent,
    customId,
    user: { id: userId },
    member: null,
    message,
    channel,
    channelId: channel.id,
    values: [],
    deferred: false,
    replied: false,
    deferUpdate: async () => { interaction.deferred = true; },
    update: async (options) => {
      interaction.replied = true;
      updateLocalUiState(options || {});
      return createLocalUiMessage();
    },
    reply: async (options) => {
      interaction.replied = true;
      if (options?.embeds || options?.components) updateLocalUiState(options || {});
      return { id: `local-ui-reply-${Date.now()}`, channelId: channel.id };
    },
    followUp: async (options) => {
      if (options?.embeds || options?.components) updateLocalUiState(options || {});
      return { id: `local-ui-followup-${Date.now()}`, channelId: channel.id };
    },
    editReply: async (options) => {
      updateLocalUiState(options || {});
      return createLocalUiMessage();
    },
    showModal: async (modal) => {
      const serialized = serializeModalForUi(modal);
      uiPendingModal = serialized;
      if (serialized) addActionLog(userId, `🪟 Fenêtre ouverte : ${serialized.title}`, null, serialized);
    }
  };
  return interaction;
}

async function handleUiAction(customId) {
  if (!customId) return { ok: false, error: "Action invalide." };
  if (uiLocalModeEnabled) {
    uiPendingModal = null;
    zodiOwnerMap.set("local-ui-message", ADMIN_ONLY_USER_ID);
    const interaction = await buildLocalUiInteraction(customId, ADMIN_ONLY_USER_ID);
    try {
      await handleZodiComponentInteraction(interaction);
      return { ok: true, mode: "local" };
    } catch (e) {
      console.error("UI local action error:", e);
      return { ok: false, error: e?.message || "Erreur action." };
    }
  }
  if (!uiBinding?.channelId || !uiBinding?.messageId) return { ok: false, error: "UI non connectee." };
  const channel = await zodiClient.channels.fetch(uiBinding.channelId).catch(() => null);
  const message = channel?.isTextBased?.() ? await channel.messages.fetch(uiBinding.messageId).catch(() => null) : null;
  if (!message) {
    return { ok: false, error: "Message introuvable. Reconnecte l'UI." };
  }
  zodiOwnerMap.set(message.id, ADMIN_ONLY_USER_ID);
  uiPendingModal = null;
  const interaction = await buildUiInteraction(customId, message, ADMIN_ONLY_USER_ID);
  try {
    await handleZodiComponentInteraction(interaction);
    return { ok: true };
  } catch (e) {
    console.error("UI action error:", e);
    return { ok: false, error: e?.message || "Erreur action." };
  }
}

async function buildUiModalInteraction(customId, values, channel, userId) {
  const fields = {
    getTextInputValue: (id) => {
      return values?.[id] ?? "";
    }
  };
  const isLocal = channel?.id === "local-ui";
  return {
    type: InteractionType.ModalSubmit,
    customId,
    user: { id: userId },
    channel,
    channelId: channel?.id,
    fields,
    replied: false,
    reply: async (options) => {
      if (isLocal) {
        updateLocalUiState(options || {});
        return { id: `local-ui-modal-reply-${Date.now()}`, channelId: channel?.id };
      }
      return channel.send(options);
    },
    followUp: async (options) => {
      if (isLocal) {
        if (options?.embeds || options?.components) updateLocalUiState(options || {});
        return { id: `local-ui-modal-followup-${Date.now()}`, channelId: channel?.id };
      }
      return channel.send(options);
    },
    editReply: async (options) => {
      if (isLocal) {
        updateLocalUiState(options || {});
        return { id: `local-ui-modal-edit-${Date.now()}`, channelId: channel?.id };
      }
      return channel.send(options);
    }
  };
}

async function handleUiModalSubmit(customId, values) {
  if (!customId) return { ok: false, error: "Modal invalide." };
  if (customId.startsWith("ui_select_")) {
    const targetCustomId = customId.replace("ui_select_", "");
    const raw = values?.ui_select_value || values?.user || values?.target || "";
    let targetId = parseUserIdFromInput(raw);
    if (!targetId) {
      targetId = await resolveUserIdByName(raw);
    }
    if (!targetId) return { ok: false, error: "Utilisateur introuvable." };
    const allowed = await isUserInAdminGuild(targetId);
    if (!allowed) return { ok: false, error: "Utilisateur introuvable dans ton serveur." };
    uiPendingModal = null;
    if (uiLocalModeEnabled) {
      const interaction = await buildLocalUiInteraction(targetCustomId, ADMIN_ONLY_USER_ID);
      interaction.values = [targetId];
      await handleZodiComponentInteraction(interaction);
      return { ok: true, mode: "local" };
    }
    if (!uiBinding?.channelId || !uiBinding?.messageId) return { ok: false, error: "UI non connectee." };
    const channel = await zodiClient.channels.fetch(uiBinding.channelId).catch(() => null);
    const message = channel?.isTextBased?.() ? await channel.messages.fetch(uiBinding.messageId).catch(() => null) : null;
    if (!message) return { ok: false, error: "Message introuvable. Reconnecte l'UI." };
    const interaction = await buildUiInteraction(targetCustomId, message, ADMIN_ONLY_USER_ID);
    interaction.values = [targetId];
    await handleZodiComponentInteraction(interaction);
    return { ok: true };
  }
  if (uiLocalModeEnabled) {
    const channel = createLocalUiChannel();
    const interaction = await buildUiModalInteraction(customId, values, channel, ADMIN_ONLY_USER_ID);
    uiPendingModal = null;
    await handleZodiModalInteraction(interaction);
    return { ok: true, mode: "local" };
  }
  if (!uiBinding?.channelId) return { ok: false, error: "UI non connectee." };
  const channel = await zodiClient.channels.fetch(uiBinding.channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return { ok: false, error: "Salon introuvable." };
  const interaction = await buildUiModalInteraction(customId, values, channel, ADMIN_ONLY_USER_ID);
  uiPendingModal = null;
  await handleZodiModalInteraction(interaction);
  return { ok: true };
}

// ==========================
// DATA MEMOCOIN
// ==========================
const memocoinData = new Map();
const bankInputMap = new Map();
const bankActionMap = new Map();
const calcInputMap = new Map();
const RESTART_NOTICE_FILE = path.join(__dirname, "restart_notice.json");
const BOT_BOOT_AT = Date.now();
// admin temporary selection for memocoin UI: adminUserId -> targetUserId
const memocoinSelectionMap = new Map();
// temporary selection for steal UI: userId -> targetUserId
const stealSelectionMap = new Map();
// pending scheduled steals: thiefId -> { timer, info }
const pendingStealsMap = new Map();
// cooldown between steals: thiefId -> timestamp (ms) when next steal is allowed
const stealCooldownMap = new Map();
// traveling merchant offers: userId -> { offers, generatedAt }
const travelingMerchantMap = new Map();
// last bank menu message: userId -> { channelId, messageId }
const bankMenuMessageMap = new Map();
// roulette owner lock: messageId -> userId allowed to use roulette buttons on that message
const rouletteOwnerMap = new Map();
// casino owner lock: messageId -> userId allowed to use casino buttons on that message
const casinoOwnerMap = new Map();
// slot owner lock: messageId -> userId allowed to use slot buttons on that message
const slotOwnerMap = new Map();
// blackjack owner lock: messageId -> userId allowed to use blackjack buttons on that message
const blackjackOwnerMap = new Map();
// main menu lock: messageId -> userId allowed to use buttons on that message
const zodiOwnerMap = new Map();
// last main menu message per user: userId -> { channelId, messageId }
const mainMenuMessageMap = new Map();
// admin temporary selection for reset UI: adminUserId -> targetUserId
const resetSelectionMap = new Map();
// admin temporary selection for prison UI: adminUserId -> targetUserId
const prisonSelectionMap = new Map();
const BLACKJACK_BUY_IN_MEMOCOIN = 1000;
const BLACKJACK_STARTING_CHIPS = 100;
const BLACKJACK_MEMOCOIN_PER_CHIP = 10;
const BLACKJACK_MAX_BET = 100;
const BLACKJACK_MAX_HANDS = 10;
const BLACKJACK_BET_OPTIONS = [1, 5, 10, 25, 50, 100];
const BLACKJACK_SUITS = ["♠", "♥", "♦", "♣"];
const BLACKJACK_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
// admin temporary selection for cybersecurity UI: adminUserId -> targetUserId
const cyberSelectionMap = new Map();
// warning alert processing state by guild: guildId -> { action, adminId, startedAt }
const cyberAlertProcessingMap = new Map();
// track if a user already attempted a steal before (first attempt behaviour)
const stealAttemptedMap = new Map();
// temporary selection for donate UI: userId -> targetUserId
const donateSelectionMap = new Map();
const DATA_FILE = "./data.json";
const STEAL_CANCEL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const POLICE_CATCH_CHANCE_MIN = 0.08; // 8%
const POLICE_CATCH_CHANCE_MAX = 0.75; // 75%
const POLICE_CURVE_MIN_AMOUNT = 1;
const POLICE_CURVE_MAX_AMOUNT = 1e35; // 10^35 ~= 99999999999999999999999999999999999
const POLICE_CURVE_EXPONENT = 1.2; // >1 keeps low amounts safer and rises progressively
const STEAL_SUCCESS_CURVE_MIN_AMOUNT = 1;
const STEAL_SUCCESS_CURVE_MAX_AMOUNT = 1e35;
const STEAL_SUCCESS_CHANCE_MAX = 0.8; // small amount max success: 80%
const STEAL_SUCCESS_CHANCE_MIN = 0.02; // huge amount min success: 2%
const STEAL_SUCCESS_CURVE_EXPONENT = 1.1;
const POLICE_LOCK_MS = 24 * 60 * 60 * 1000; // 1 day from now, not fixed midnight
const POLICE_REDUCE_PRICE = 100000;
const POLICE_REDUCE_MS = 60 * 60 * 1000; // 1h
const SHOP_PRICE_POLICE_PROTECTION = 800000000;
const PRISON_DEBT_LIMIT = -5000;
const PRISON_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const CASINO_WIN_CHANCE = 0.15;
const CASINO_WIN_REWARD = 25000;
const SLOT_JACKPOT_CHANCE = 0.00005;
const SLOT_JACKPOT_REWARD = 1000000;
const SLOT_BONUS_CHANCE = 0.06;
const SLOT_BONUS_REWARD = 10000;
const SLOT_RESET_CHANCE = 0.10;
const SLOT_SMALL_WIN_CHANCE = 0.18;
const SLOT_SMALL_WIN_REWARD = 2500;
let maintenanceModeEnabled = false;
let debtModeEnabled = true;
const cyberSecurityState = { bans: {}, silences: {}, quarantines: {}, alerts: {} };
const CYBER_MAX_SILENCE_DURATION_MS = 28 * 24 * 60 * 60 * 1000;
const CYBER_MAX_BAN_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const CYBER_MAX_QUARANTINE_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const CYBER_QUARANTINE_ROLE_NAME = "🔒・mise-en-quarantaine🔒";
const CYBER_LEGACY_QUARANTINE_ROLE_NAMES = new Set(["mise en quarantaine"]);
const DONJON_LOSE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DONJON_ACTIVITY_COOLDOWN_MS = 15 * 60 * 1000;
const DONJON_MAX_SKILL_LEVEL = 10;
const DONJON_MAX_POWER_LEVEL = 8;
const DONJON_MAX_POWER_CHARGES = 9;
const POKEMON_BASE_COOLDOWN_MS = 10 * 60 * 1000;
const ZOMBIE_BASE_COOLDOWN_MS = 8 * 60 * 1000;
const MC_EMERALD_TO_MEMOCOIN = 3;
const DG_GOLD_TO_MEMOCOIN = 10;
const ZB_SILVER_TO_MEMOCOIN = 5;
const PK_POKEDOLLAR_TO_MEMOCOIN = 1000;
const MC_ACTIONS_PER_PHASE = 10;
const MC_ACTIONS_PER_CYCLE = MC_ACTIONS_PER_PHASE * 2;
const MC_EXPLORE_COOLDOWN_MS = 5 * 60 * 1000;
const MC_BIOME_COOLDOWN_MS = 15 * 60 * 1000;
const MC_STRUCTURE_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const MC_CAVE_FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const MC_CAVE_CONTINUE_COOLDOWN_MS = 3 * 60 * 1000;
const MC_CAVE_EXIT_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
const MC_CAVE_MINE_COOLDOWN_MIN_MS = 60 * 1000;
const MC_CAVE_MINE_COOLDOWN_MAX_MS = 2 * 60 * 1000;
const MC_DEATH_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const MC_FLINT_FIND_CHANCE = 0.02;
const MC_FOOD_DEFS = [
  { id: "beef", label: "Bœuf cuit", emoji: "🥩", key: "cookedBeef", heal: 20 },
  { id: "pork", label: "Porc cuit", emoji: "🍖", key: "cookedPork", heal: 18 },
  { id: "mutton", label: "Mouton cuit", emoji: "🍖", key: "cookedMutton", heal: 16 },
  { id: "chicken", label: "Poulet cuit", emoji: "🍗", key: "cookedChicken", heal: 12 }
];

const MC_OVERWORLD_BIOMES = [
  "forêt",
  "forêt sombre",
  "forêt de bouleaux",
  "plaine",
  "collines",
  "désert",
  "montagne",
  "toundra",
  "neige",
  "jungle",
  "marais",
  "taiga",
  "savane",
  "mesa",
  "océan",
  "plage",
  "rivière",
  "champignon",
  "village"
];

const MC_MONSTERS = [
  { name: "Zombie", hp: 25, atkMin: 6, atkMax: 10 },
  { name: "Squelette", hp: 30, atkMin: 7, atkMax: 11 },
  { name: "Sorcière", hp: 50, atkMin: 8, atkMax: 14 },
  { name: "Creeper", hp: 120, atkMin: 16, atkMax: 24 }
];

const MC_ANIMALS = [
  { name: "Mouton", hp: 20, atkMin: 0, atkMax: 0, drops: { rawMutton: [1, 2] } },
  { name: "Vache", hp: 30, atkMin: 0, atkMax: 0, drops: { rawBeef: [1, 2] } }
];

const DONJON_MONSTER_POOLS = [
  {
    weight: 8,
    hpMin: 55, hpMax: 85,
    atkMin: 6, atkMax: 14,
    rewardMin: 1, rewardMax: 10,
    losePenaltyMin: 1, losePenaltyMax: 5,
    names: ["Rat géant", "Chauve-souris", "Slime", "Gobelin", "Squelette frêle", "Zombie errant", "Bandit", "Araignée", "Loup sauvage", "Kobold"]
  },
  {
    weight: 6,
    hpMin: 85, hpMax: 120,
    atkMin: 9, atkMax: 18,
    rewardMin: 1, rewardMax: 10,
    losePenaltyMin: 2, losePenaltyMax: 6,
    names: ["Orque", "Squelette archer", "Golem de pierre", "Harpie", "Troll", "Nécromancien novice", "Spectre", "Ours furieux", "Guerrier maudit", "Manticore jeune"]
  },
  {
    weight: 4,
    hpMin: 125, hpMax: 160,
    atkMin: 12, atkMax: 22,
    rewardMin: 1, rewardMax: 10,
    losePenaltyMin: 3, losePenaltyMax: 7,
    names: ["Chevalier corrompu", "Golem de fer", "Démon mineur", "Reine araignée", "Liche", "Basilic", "Garde draconique", "Seigneur loup", "Wyverne", "Gargouille"]
  },
  {
    weight: 2,
    hpMin: 165, hpMax: 210,
    atkMin: 15, atkMax: 26,
    rewardMin: 1, rewardMax: 10,
    losePenaltyMin: 4, losePenaltyMax: 8,
    names: ["Seigneur squelette", "Cyclope", "Ogre", "Démon majeur", "Dragonnet", "Chimère", "Titan d'os", "Sorcier abyssal", "Minotaure", "Kraken des caves"]
  },
  {
    weight: 1,
    hpMin: 215, hpMax: 270,
    atkMin: 18, atkMax: 32,
    rewardMin: 1, rewardMax: 10,
    losePenaltyMin: 5, losePenaltyMax: 10,
    names: ["Dragon ancien", "Liche suprême", "Titan de pierre", "Archidémon", "Hydre", "Seigneur vampire", "Phénix noir", "Colosse runique", "Reine des morts", "Gardien céleste"]
  }
];

const DONJON_MONSTERS = DONJON_MONSTER_POOLS.flatMap(pool =>
  pool.names.map(name => ({
    name,
    weight: pool.weight,
    hpMin: pool.hpMin,
    hpMax: pool.hpMax,
    atkMin: pool.atkMin,
    atkMax: pool.atkMax,
    rewardMin: pool.rewardMin,
    rewardMax: pool.rewardMax,
    losePenaltyMin: pool.losePenaltyMin,
    losePenaltyMax: pool.losePenaltyMax
  }))
);

function buildDonjonMonsterPoolByTier(maxTier) {
  const safeTier = Math.max(0, Math.min(maxTier, DONJON_MONSTER_POOLS.length - 1));
  const pools = DONJON_MONSTER_POOLS.slice(0, safeTier + 1);
  return pools.flatMap(pool =>
    pool.names.map(name => ({
      name,
      weight: pool.weight,
      hpMin: pool.hpMin,
      hpMax: pool.hpMax,
      atkMin: pool.atkMin,
      atkMax: pool.atkMax,
      rewardMin: pool.rewardMin,
      rewardMax: pool.rewardMax,
      losePenaltyMin: pool.losePenaltyMin,
      losePenaltyMax: pool.losePenaltyMax
    }))
  );
}

function getDonjonTierForProgress(dj, stage = 1, options = {}) {
  const maxTier = DONJON_MONSTER_POOLS.length - 1;
  const safeStage = Math.max(1, Number(stage) || 1);
  const stageTier = Math.min(maxTier, Math.floor((safeStage - 1) / 2));
  const wins = Math.max(0, Number(dj?.wins || 0));
  const winsTier = Math.min(maxTier, Math.floor(wins / 5));
  let tier = Math.min(maxTier, stageTier + winsTier);
  if (options.easyRun) tier = Math.max(0, tier - 1);
  return tier;
}

const DONJON_BOSS_POOL = (() => {
  const pool = DONJON_MONSTER_POOLS[DONJON_MONSTER_POOLS.length - 1];
  return pool.names.map(name => ({
    name,
    weight: 1,
    hpMin: pool.hpMin,
    hpMax: pool.hpMax,
    atkMin: pool.atkMin,
    atkMax: pool.atkMax,
    rewardMin: pool.rewardMin,
    rewardMax: pool.rewardMax,
    losePenaltyMin: pool.losePenaltyMin,
    losePenaltyMax: pool.losePenaltyMax
  }));
})();

const DONJON_CLASS_LABELS = {
  guerrier: "Guerrier",
  tank: "Tank",
  mage: "Mage",
  assassin: "Assassin"
};

const DONJON_POWER_NAMES = {
  guerrier: "Lame cyclone",
  tank: "Mur vivant",
  mage: "Nova arcanique",
  assassin: "Execution de l'ombre"
};

function getDonjonClassLabel(classType = "guerrier") {
  return DONJON_CLASS_LABELS[classType] || "Guerrier";
}

function getDonjonPowerName(classType = "guerrier") {
  return DONJON_POWER_NAMES[classType] || "Lame cyclone";
}

function getDonjonSkillUpgradeCost(level = 0) {
  const safeLevel = Math.max(0, Number(level) || 0);
  return {
    gold: 12 + (safeLevel * 8),
    essence: 2 + Math.floor(safeLevel / 2)
  };
}

function getDonjonPowerUpgradeCost(level = 0) {
  const safeLevel = Math.max(0, Number(level) || 0);
  return {
    gold: 18 + (safeLevel * 12),
    essence: 3 + safeLevel
  };
}

function gainDonjonPowerCharges(dj, amount = 1) {
  const safeAmount = Math.max(0, Number(amount) || 0);
  dj.powerCharges = Math.min(DONJON_MAX_POWER_CHARGES, Math.max(0, Number(dj.powerCharges || 0)) + safeAmount);
  return dj.powerCharges;
}

function runDonjonActivity(dj) {
  const inRun = Boolean(dj.nextEncounter && dj.nextEncounter.monster);
  const activityEvents = [
    {
      weight: 16,
      text: "📚 Salle d'entrainement: +2 essences et comp?tence recharg?e.",
      apply: () => {
        dj.essence = (dj.essence || 0) + 2;
        dj.skillCooldownUntil = 0;
      }
    },
    {
      weight: 14,
      text: "🔥 Brasero de guerre: +1 charge de pouvoir.",
      apply: () => {
        gainDonjonPowerCharges(dj, 1);
      }
    },
    {
      weight: 12,
      text: "🛡️ Armurerie abandonnee: +1 bouclier.",
      apply: () => {
        dj.shields = (dj.shields || 0) + 1;
      }
    },
    {
      weight: 12,
      text: "🥖 Reserve de voyage: +1 ration.",
      apply: () => {
        dj.rations = (dj.rations || 0) + 1;
      }
    },
    {
      weight: 11,
      text: "🪙 Cache du contrebandier: +8 pieces d'or.",
      apply: () => {
        dj.goldCoins = (dj.goldCoins || 0) + 8;
      }
    },
    {
      weight: 10,
      text: "🕯️ Autel ancien: +1 relique.",
      apply: () => {
        dj.relics = (dj.relics || 0) + 1;
      }
    },
    {
      weight: 9,
      text: "💎 Éclat de résurrection: +1 pierre de résurrection.",
      apply: () => {
        dj.reviveStones = (dj.reviveStones || 0) + 1;
      }
    },
    {
      weight: 9,
      text: "🗺️ Cartographe perdu: +1 essence et +5 pieces d'or.",
      apply: () => {
        dj.essence = (dj.essence || 0) + 1;
        dj.goldCoins = (dj.goldCoins || 0) + 5;
      }
    },
    {
      weight: 8,
      text: "⛺ Campement calme: rien d'utile, mais tu récupères ton souffle.",
      apply: () => {}
    }
  ];

  if (inRun) {
    activityEvents.push(
      {
        weight: 14,
        text: "⛲ Source claire: +18 PV pour le prochain combat.",
        apply: () => {
          dj.nextEncounter.playerHp = Math.min(110, Math.max(1, Number(dj.nextEncounter.playerHp || 110)) + 18);
        }
      },
      {
        weight: 10,
        text: "⚠️ Salle piégée: -8 PV, mais +2 essences.",
        apply: () => {
          dj.nextEncounter.playerHp = Math.max(1, Number(dj.nextEncounter.playerHp || 110) - 8);
          dj.essence = (dj.essence || 0) + 2;
        }
      },
      {
        weight: 8,
        text: "🧪 Bulle arcanique: compétence rechargée et +10 PV.",
        apply: () => {
          dj.skillCooldownUntil = 0;
          dj.nextEncounter.playerHp = Math.min(110, Math.max(1, Number(dj.nextEncounter.playerHp || 110)) + 10);
        }
      },
      {
        weight: 8,
        text: "🎁 Coffre curieux: +10 pieces d'or et +1 charge de pouvoir.",
        apply: () => {
          dj.goldCoins = (dj.goldCoins || 0) + 10;
          gainDonjonPowerCharges(dj, 1);
        }
      },
      {
        weight: 7,
        text: "👤 Mentor errant: +1 niveau de puissance temporaire via +2 essences.",
        apply: () => {
          dj.essence = (dj.essence || 0) + 2;
        }
      }
    );
  }

  const picked = weightedPick(activityEvents);
  if (picked?.apply) picked.apply();
  return picked?.text || "⛺ Rien de particulier ne se passe.";
}

// ID autorise pour les actions admin (utilisateur unique)
const ADMIN_ONLY_USER_ID = '1277048561044947075';

function loadBotProfileState() {
  try {
    if (!fs.existsSync(BOT_PROFILE_FILE)) return {};
    const raw = fs.readFileSync(BOT_PROFILE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveBotProfileState(state) {
  try {
    fs.writeFileSync(BOT_PROFILE_FILE, JSON.stringify(state || {}, null, 2), "utf8");
  } catch (e) {}
}

function getConfiguredBotBannerPath() {
  const raw = String(process.env.BOT_BANNER_PATH || DEFAULT_BOT_BANNER_PATH).trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw);
}

function getFileFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${path.resolve(filePath)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch (e) {
    return null;
  }
}

async function applyBotProfileSettings() {
  if (!zodiClient?.user) return;
  if (process.env.BOT_PROFILE_SYNC === "0") return;

  try {
    const appInfo = await zodiClient.application?.fetch?.().catch(() => null);
    const currentDescription = String(appInfo?.description || zodiClient.application?.description || "");
    if (currentDescription !== ZODI_BOT_DESCRIPTION) {
      await zodiClient.application?.edit?.({ description: ZODI_BOT_DESCRIPTION }).catch(e => {
        console.error("Impossible de modifier la description du bot:", e?.message || e);
      });
    }
  } catch (e) {
    console.error("applyBotProfileSettings description error:", e?.message || e);
  }

  const bannerPath = getConfiguredBotBannerPath();
  if (!bannerPath || !fs.existsSync(bannerPath)) return;

  try {
    const fingerprint = getFileFingerprint(bannerPath);
    if (!fingerprint) return;
    const state = loadBotProfileState();
    if (state.bannerFingerprint === fingerprint) return;
    await zodiClient.user.setBanner(bannerPath);
    saveBotProfileState({
      ...state,
      bannerFingerprint: fingerprint,
      bannerPath,
      bannerAppliedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error("Impossible de modifier la bannière du bot:", e?.message || e);
  }
}

async function ensureGuildAllowed(guild) {
  if (!guild) return false;
  try {
    const adminMember = await guild.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
    if (adminMember) return true;
    console.warn(`Serveur non autorisé (${guild.name || guild.id}) : l'admin principal est absent. Départ du bot.`);
    await guild.leave().catch(e => console.error("Impossible de quitter le serveur non autorisé:", e?.message || e));
    return false;
  } catch (e) {
    console.error("ensureGuildAllowed error:", e?.message || e);
    return false;
  }
}

async function enforceAllowedGuilds() {
  if (!zodiClient?.guilds?.cache) return;
  for (const guild of zodiClient.guilds.cache.values()) {
    await ensureGuildAllowed(guild);
  }
}

function normalizeCyberSecurityState(rawState) {
  const out = { bans: {}, silences: {}, quarantines: {}, alerts: {} };
  if (!rawState || typeof rawState !== "object") return out;

  const rawBans = rawState.bans && typeof rawState.bans === "object" ? rawState.bans : {};
  for (const [key, entry] of Object.entries(rawBans)) {
    if (!entry || typeof entry !== "object") continue;
    const guildId = String(entry.guildId || "").trim();
    const userId = String(entry.userId || "").trim();
    if (!guildId || !userId) continue;
    out.bans[key] = {
      guildId,
      userId,
      type: entry.type === "ip" ? "ip" : "ban",
      reason: String(entry.reason || "Aucune raison fournie.").slice(0, 300),
      createdAt: Number(entry.createdAt) || Date.now(),
      expiresAt: entry.expiresAt ? Number(entry.expiresAt) : null,
      active: entry.active !== false,
      liftedAt: entry.liftedAt ? Number(entry.liftedAt) : null,
      liftedBy: entry.liftedBy ? String(entry.liftedBy) : null
    };
  }

  const rawSilences = rawState.silences && typeof rawState.silences === "object" ? rawState.silences : {};
  for (const [key, entry] of Object.entries(rawSilences)) {
    if (!entry || typeof entry !== "object") continue;
    const guildId = String(entry.guildId || "").trim();
    const userId = String(entry.userId || "").trim();
    if (!guildId || !userId) continue;
    out.silences[key] = {
      guildId,
      userId,
      reason: String(entry.reason || "Réduction au silence administrateur").slice(0, 300),
      createdAt: Number(entry.createdAt) || Date.now(),
      expiresAt: entry.expiresAt ? Number(entry.expiresAt) : null,
      active: entry.active !== false,
      liftedAt: entry.liftedAt ? Number(entry.liftedAt) : null,
      liftedBy: entry.liftedBy ? String(entry.liftedBy) : null
    };
  }

  const rawQuarantines = rawState.quarantines && typeof rawState.quarantines === "object" ? rawState.quarantines : {};
  for (const [key, entry] of Object.entries(rawQuarantines)) {
    if (!entry || typeof entry !== "object") continue;
    const guildId = String(entry.guildId || "").trim();
    const userId = String(entry.userId || "").trim();
    if (!guildId || !userId) continue;
    const roles = Array.isArray(entry.roles) ? entry.roles.map(r => String(r || "").trim()).filter(Boolean) : [];
    out.quarantines[key] = {
      guildId,
      userId,
      roles,
      reason: String(entry.reason || "Quarantaine administrateur").slice(0, 300),
      createdAt: Number(entry.createdAt) || Date.now(),
      expiresAt: entry.expiresAt ? Number(entry.expiresAt) : null,
      active: entry.active !== false,
      releasedAt: entry.releasedAt ? Number(entry.releasedAt) : null,
      releasedBy: entry.releasedBy ? String(entry.releasedBy) : null
    };
  }

  const rawAlerts = rawState.alerts && typeof rawState.alerts === "object" ? rawState.alerts : {};
  for (const [key, entry] of Object.entries(rawAlerts)) {
    if (!entry || typeof entry !== "object") continue;
    const guildId = String(entry.guildId || key || "").trim();
    if (!guildId) continue;

    const rawMemberStates = entry.memberStates && typeof entry.memberStates === "object" ? entry.memberStates : {};
    const memberStates = {};
    for (const [userId, memberState] of Object.entries(rawMemberStates)) {
      const safeUserId = String(userId || "").trim();
      if (!safeUserId || !memberState || typeof memberState !== "object") continue;
      const roles = Array.isArray(memberState.roles)
        ? memberState.roles.map(roleId => String(roleId || "").trim()).filter(Boolean)
        : [];
      memberStates[safeUserId] = { roles };
    }

    out.alerts[guildId] = {
      guildId,
      active: entry.active !== false,
      startedAt: Number(entry.startedAt) || Date.now(),
      startedBy: entry.startedBy ? String(entry.startedBy) : null,
      endedAt: entry.endedAt ? Number(entry.endedAt) : null,
      endedBy: entry.endedBy ? String(entry.endedBy) : null,
      memberStates
    };
  }

  return out;
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    const json = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    // v2 format: { users: {...}, stealCooldowns: {...} }
    if (json && typeof json === "object" && json.users) {
      const users = json.users || {};
      for (const id in users) memocoinData.set(id, users[id]);

      const cooldowns = json.stealCooldowns || {};
      const now = Date.now();
      for (const id in cooldowns) {
        const ts = Number(cooldowns[id]);
        if (Number.isFinite(ts) && ts > now) {
          stealCooldownMap.set(id, ts);
        }
      }

      if (typeof json.maintenanceModeEnabled === "boolean") {
        maintenanceModeEnabled = json.maintenanceModeEnabled;
      }
      if (typeof json.debtModeEnabled === "boolean") {
        debtModeEnabled = json.debtModeEnabled;
      }
      if (json.cyberSecurityState && typeof json.cyberSecurityState === "object") {
        const normalized = normalizeCyberSecurityState(json.cyberSecurityState);
        cyberSecurityState.bans = normalized.bans;
        cyberSecurityState.silences = normalized.silences;
        cyberSecurityState.quarantines = normalized.quarantines;
        cyberSecurityState.alerts = normalized.alerts;
      }
      return;
    }

    // legacy format: { userId: { inventory, bank } }
    for (const id in json) memocoinData.set(id, json[id]);
  }
}
function saveData() {
  const now = Date.now();
  const cooldowns = {};
  for (const [userId, untilTs] of stealCooldownMap.entries()) {
    if (untilTs > now) cooldowns[userId] = untilTs;
  }

  const payload = {
    users: Object.fromEntries(memocoinData),
    stealCooldowns: cooldowns,
    maintenanceModeEnabled,
    debtModeEnabled,
    cyberSecurityState: normalizeCyberSecurityState(cyberSecurityState)
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
}
loadData();

function initUser(id) {
  if (!memocoinData.has(id)) memocoinData.set(id, {
    inventory: 0,
    bank: 0,
    antiStealProtection: 0,
    resetRoulettePower: 0,
    resetStealPower: 0,
    resetCasinoPower: 0,
    resetSlotPower: 0,
    antiPoliceProtection: 0,
    policeLockUntil: 0,
    rouletteCooldownUntil: 0,
    slotCooldownUntil: 0,
    casinoCooldownUntil: 0,
    rouletteLastPlayDay: null,
    minecraft: {},
    pokemon: {},
    donjon: {},
    zombie: {},
    horoscope: {},
    blackjack: getDefaultBlackjackState()
  });
  const user = memocoinData.get(id);
  if (typeof user.inventory !== "number") user.inventory = 0;
  if (typeof user.bank !== "number") user.bank = 0;
  if (typeof user.antiStealProtection !== "number") user.antiStealProtection = 0;
  if (typeof user.resetRoulettePower !== "number") user.resetRoulettePower = 0;
  if (typeof user.resetStealPower !== "number") user.resetStealPower = 0;
  if (typeof user.resetCasinoPower !== "number") user.resetCasinoPower = 0;
  if (typeof user.resetSlotPower !== "number") user.resetSlotPower = 0;
  if (typeof user.antiPoliceProtection !== "number") user.antiPoliceProtection = 0;
  if (typeof user.policeLockUntil !== "number") user.policeLockUntil = 0;
  if (typeof user.prisonUntil !== "number") user.prisonUntil = 0;
  if (typeof user.rouletteCooldownUntil !== "number") user.rouletteCooldownUntil = 0;
  if (typeof user.slotCooldownUntil !== "number") user.slotCooldownUntil = 0;
  if (typeof user.casinoCooldownUntil !== "number") user.casinoCooldownUntil = 0;
  if (typeof user.rouletteLastPlayDay !== "string" && user.rouletteLastPlayDay !== null) user.rouletteLastPlayDay = null;
  if (!user.minecraft || typeof user.minecraft !== "object") user.minecraft = {};
  if (!user.pokemon || typeof user.pokemon !== "object") user.pokemon = {};
  if (!user.donjon || typeof user.donjon !== "object") user.donjon = {};
  if (!user.zombie || typeof user.zombie !== "object") user.zombie = {};
  if (!user.horoscope || typeof user.horoscope !== "object") user.horoscope = {};
  user.blackjack = normalizeBlackjackState(user.blackjack);

  const horoscope = user.horoscope;
  if (typeof horoscope.accessDayKey !== "string" && horoscope.accessDayKey !== null) horoscope.accessDayKey = null;
  if (!horoscope.prediction || typeof horoscope.prediction !== "object") horoscope.prediction = null;
  if (!horoscope.oracle || typeof horoscope.oracle !== "object") horoscope.oracle = null;
  if (!Array.isArray(horoscope.recentPredictionEnergy)) horoscope.recentPredictionEnergy = [];
  if (!Array.isArray(horoscope.recentPredictionFocus)) horoscope.recentPredictionFocus = [];
  if (!Array.isArray(horoscope.recentPredictionOpening)) horoscope.recentPredictionOpening = [];
  if (!Array.isArray(horoscope.recentPredictionVigilance)) horoscope.recentPredictionVigilance = [];
  if (!Array.isArray(horoscope.recentPredictionTiming)) horoscope.recentPredictionTiming = [];
  if (!Array.isArray(horoscope.recentOracleCards)) horoscope.recentOracleCards = [];

  const mc = user.minecraft;
  if (typeof mc.wood !== "number") mc.wood = 0;
  if (typeof mc.planks !== "number") mc.planks = 0;
  if (typeof mc.sticks !== "number") mc.sticks = 0;
  if (typeof mc.stone !== "number") mc.stone = 0;
  if (typeof mc.coal !== "number") mc.coal = 0;
  if (typeof mc.ironOre !== "number") mc.ironOre = 0;
  if (typeof mc.ironIngot !== "number") mc.ironIngot = 0;
  if (typeof mc.diamonds !== "number") mc.diamonds = 0;
  if (typeof mc.goldOre !== "number") mc.goldOre = 0;
  if (typeof mc.goldIngot !== "number") mc.goldIngot = 0;
  if (typeof mc.obsidian !== "number") mc.obsidian = 0;
  if (typeof mc.flint !== "number") mc.flint = 0;
  if (typeof mc.emeralds !== "number") mc.emeralds = 0;
  if (typeof mc.blazeRods !== "number") mc.blazeRods = 0;
  if (typeof mc.enderPearls !== "number") mc.enderPearls = 0;
  if (typeof mc.eyesOfEnder !== "number") mc.eyesOfEnder = 0;
  if (typeof mc.ancientDebris !== "number") mc.ancientDebris = 0;
  if (typeof mc.netheriteScrap !== "number") mc.netheriteScrap = 0;
  if (typeof mc.totems !== "number") mc.totems = 0;
  if (typeof mc.netherStars !== "number") mc.netherStars = 0;
  if (typeof mc.dragonKills !== "number") mc.dragonKills = 0;
  if (typeof mc.woodSword !== "boolean") mc.woodSword = false;
  if (typeof mc.stoneSword !== "boolean") mc.stoneSword = false;
  if (typeof mc.ironSword !== "boolean") mc.ironSword = false;
  if (typeof mc.diamondSword !== "boolean") mc.diamondSword = false;
  if (typeof mc.netheriteSword !== "boolean") mc.netheriteSword = false;
  if (typeof mc.ironHelmet !== "boolean") mc.ironHelmet = false;
  if (typeof mc.ironChestplate !== "boolean") mc.ironChestplate = false;
  if (typeof mc.ironLeggings !== "boolean") mc.ironLeggings = false;
  if (typeof mc.ironBoots !== "boolean") mc.ironBoots = false;
  if (typeof mc.diamondHelmet !== "boolean") mc.diamondHelmet = false;
  if (typeof mc.diamondChestplate !== "boolean") mc.diamondChestplate = false;
  if (typeof mc.diamondLeggings !== "boolean") mc.diamondLeggings = false;
  if (typeof mc.diamondBoots !== "boolean") mc.diamondBoots = false;
  if (typeof mc.netheriteHelmet !== "boolean") mc.netheriteHelmet = false;
  if (typeof mc.netheriteChestplate !== "boolean") mc.netheriteChestplate = false;
  if (typeof mc.netheriteLeggings !== "boolean") mc.netheriteLeggings = false;
  if (typeof mc.netheriteBoots !== "boolean") mc.netheriteBoots = false;
  if (typeof mc.wheatSeeds !== "number") mc.wheatSeeds = 0;
  if (typeof mc.wheat !== "number") mc.wheat = 0;
  if (typeof mc.potatoes !== "number") mc.potatoes = 0;
  if (typeof mc.pumpkinSeeds !== "number") mc.pumpkinSeeds = 0;
  if (typeof mc.pumpkins !== "number") mc.pumpkins = 0;
  if (typeof mc.carrots !== "number") mc.carrots = 0;
  if (typeof mc.beetrootSeeds !== "number") mc.beetrootSeeds = 0;
  if (typeof mc.beetroots !== "number") mc.beetroots = 0;
  if (typeof mc.hasCraftingTable !== "boolean") mc.hasCraftingTable = false;
  if (typeof mc.hasFurnace !== "boolean") mc.hasFurnace = false;
  if (typeof mc.hasWoodPickaxe !== "boolean") mc.hasWoodPickaxe = false;
  if (typeof mc.hasStonePickaxe !== "boolean") mc.hasStonePickaxe = false;
  if (typeof mc.hasIronPickaxe !== "boolean") mc.hasIronPickaxe = false;
  if (typeof mc.hasDiamondPickaxe !== "boolean") mc.hasDiamondPickaxe = false;
  if (typeof mc.hasNetheritePickaxe !== "boolean") mc.hasNetheritePickaxe = false;
  if (typeof mc.selectedPickaxe !== "string") mc.selectedPickaxe = "auto";
  if (typeof mc.selectedAxe !== "string") mc.selectedAxe = "auto";
  if (typeof mc.selectedSword !== "string") mc.selectedSword = "auto";
  if (typeof mc.hasWoodAxe !== "boolean") mc.hasWoodAxe = false;
  if (typeof mc.hasStoneAxe !== "boolean") mc.hasStoneAxe = false;
  if (typeof mc.hasIronAxe !== "boolean") mc.hasIronAxe = false;
  if (typeof mc.hasDiamondAxe !== "boolean") mc.hasDiamondAxe = false;
  if (typeof mc.hasNetheriteAxe !== "boolean") mc.hasNetheriteAxe = false;
  if (typeof mc.hasNetherPortal !== "boolean") mc.hasNetherPortal = false;
  if (typeof mc.hasEndPortal !== "boolean") mc.hasEndPortal = false;
  if (typeof mc.hasFlintAndSteel !== "boolean") mc.hasFlintAndSteel = false;
  if (typeof mc.currentBiome !== "string") mc.currentBiome = "forêt";
  if (typeof mc.world !== "string") {
    if (mc.currentBiome === "nether" || mc.currentBiome === "end") {
      mc.world = mc.currentBiome;
      mc.currentBiome = "forêt";
    } else {
      mc.world = "overworld";
    }
  }
  if (typeof mc.villagerReady !== "boolean") mc.villagerReady = false;
  if (typeof mc.lastEvent !== "string") mc.lastEvent = "";
  if (typeof mc.lastStructure !== "string") mc.lastStructure = "Aucune";
  if (typeof mc.structuresFound !== "number") mc.structuresFound = 0;
  if (typeof mc.lastPurchase !== "string") mc.lastPurchase = "Aucun";
  if (typeof mc.lastSale !== "string") mc.lastSale = "Aucune";
  if (typeof mc.energy !== "number") mc.energy = 100;
  if (typeof mc.restCooldownUntil !== "number") mc.restCooldownUntil = 0;
  if (typeof mc.exploreCooldownUntil !== "number") mc.exploreCooldownUntil = 0;
  if (typeof mc.biomeCooldownUntil !== "number") mc.biomeCooldownUntil = 0;
  if (typeof mc.plantCooldownUntil !== "number") mc.plantCooldownUntil = 0;
  if (typeof mc.structureCooldownUntil !== "number") mc.structureCooldownUntil = 0;
  if (typeof mc.caveSearchCooldownUntil !== "number") mc.caveSearchCooldownUntil = 0;
  if (typeof mc.caveContinueCooldownUntil !== "number") mc.caveContinueCooldownUntil = 0;
  if (typeof mc.caveExitCooldownUntil !== "number") mc.caveExitCooldownUntil = 0;
  if (typeof mc.caveMineCooldownUntil !== "number") mc.caveMineCooldownUntil = 0;
  if (typeof mc.woodPickaxeDurability !== "number") mc.woodPickaxeDurability = 0;
  if (typeof mc.stonePickaxeDurability !== "number") mc.stonePickaxeDurability = 0;
  if (typeof mc.ironPickaxeDurability !== "number") mc.ironPickaxeDurability = 0;
  if (typeof mc.diamondPickaxeDurability !== "number") mc.diamondPickaxeDurability = 0;
  if (typeof mc.netheritePickaxeDurability !== "number") mc.netheritePickaxeDurability = 0;
  if (typeof mc.woodAxeDurability !== "number") mc.woodAxeDurability = mc.hasWoodAxe ? 80 : 0;
  if (typeof mc.stoneAxeDurability !== "number") mc.stoneAxeDurability = mc.hasStoneAxe ? 120 : 0;
  if (typeof mc.ironAxeDurability !== "number") mc.ironAxeDurability = mc.hasIronAxe ? 180 : 0;
  if (typeof mc.diamondAxeDurability !== "number") mc.diamondAxeDurability = mc.hasDiamondAxe ? 240 : 0;
  if (typeof mc.netheriteAxeDurability !== "number") mc.netheriteAxeDurability = mc.hasNetheriteAxe ? 300 : 0;
  if (typeof mc.xp !== "number") mc.xp = 0;
  if (typeof mc.actionCount !== "number") mc.actionCount = 0;
  if (typeof mc.isNight !== "boolean") mc.isNight = false;
  if (typeof mc.hp !== "number") mc.hp = 100;
  if (typeof mc.deadUntil !== "number") mc.deadUntil = 0;
  if (typeof mc.chopAvailable !== "boolean") mc.chopAvailable = true;
  if (typeof mc.inCave !== "boolean") mc.inCave = false;
  if (typeof mc.caveVein !== "object") mc.caveVein = null;
  if (typeof mc.caveMineRemaining !== "number") mc.caveMineRemaining = 0;
  if (typeof mc.encounter !== "object") mc.encounter = null;
  if (typeof mc.harvestReadyAt !== "number") mc.harvestReadyAt = 0;
  if (typeof mc.plantedWheat !== "number") mc.plantedWheat = 0;
  if (typeof mc.plantedPotatoes !== "number") mc.plantedPotatoes = 0;
  if (typeof mc.plantedPumpkins !== "number") mc.plantedPumpkins = 0;
  if (typeof mc.plantedCarrots !== "number") mc.plantedCarrots = 0;
  if (typeof mc.plantedBeetroots !== "number") mc.plantedBeetroots = 0;
  if (typeof mc.houseBuilt !== "boolean") mc.houseBuilt = false;
  if (typeof mc.rawBeef !== "number") mc.rawBeef = 0;
  if (typeof mc.rawMutton !== "number") mc.rawMutton = 0;
  if (typeof mc.rawPork !== "number") mc.rawPork = 0;
  if (typeof mc.rawChicken !== "number") mc.rawChicken = 0;
  if (typeof mc.cookedBeef !== "number") mc.cookedBeef = 0;
  if (typeof mc.cookedMutton !== "number") mc.cookedMutton = 0;
  if (typeof mc.cookedPork !== "number") mc.cookedPork = 0;
  if (typeof mc.cookedChicken !== "number") mc.cookedChicken = 0;
  if (typeof mc.woodSwordDurability !== "number") mc.woodSwordDurability = mc.woodSword ? 60 : 0;
  if (typeof mc.stoneSwordDurability !== "number") mc.stoneSwordDurability = mc.stoneSword ? 90 : 0;
  if (typeof mc.ironSwordDurability !== "number") mc.ironSwordDurability = mc.ironSword ? 140 : 0;
  if (typeof mc.diamondSwordDurability !== "number") mc.diamondSwordDurability = mc.diamondSword ? 200 : 0;
  if (typeof mc.netheriteSwordDurability !== "number") mc.netheriteSwordDurability = mc.netheriteSword ? 260 : 0;
  if (typeof mc.ironHelmetDurability !== "number") mc.ironHelmetDurability = mc.ironHelmet ? 160 : 0;
  if (typeof mc.ironChestplateDurability !== "number") mc.ironChestplateDurability = mc.ironChestplate ? 180 : 0;
  if (typeof mc.ironLeggingsDurability !== "number") mc.ironLeggingsDurability = mc.ironLeggings ? 170 : 0;
  if (typeof mc.ironBootsDurability !== "number") mc.ironBootsDurability = mc.ironBoots ? 150 : 0;
  if (typeof mc.diamondHelmetDurability !== "number") mc.diamondHelmetDurability = mc.diamondHelmet ? 220 : 0;
  if (typeof mc.diamondChestplateDurability !== "number") mc.diamondChestplateDurability = mc.diamondChestplate ? 240 : 0;
  if (typeof mc.diamondLeggingsDurability !== "number") mc.diamondLeggingsDurability = mc.diamondLeggings ? 230 : 0;
  if (typeof mc.diamondBootsDurability !== "number") mc.diamondBootsDurability = mc.diamondBoots ? 210 : 0;
  if (typeof mc.netheriteHelmetDurability !== "number") mc.netheriteHelmetDurability = mc.netheriteHelmet ? 300 : 0;
  if (typeof mc.netheriteChestplateDurability !== "number") mc.netheriteChestplateDurability = mc.netheriteChestplate ? 320 : 0;
  if (typeof mc.netheriteLeggingsDurability !== "number") mc.netheriteLeggingsDurability = mc.netheriteLeggings ? 310 : 0;
  if (typeof mc.netheriteBootsDurability !== "number") mc.netheriteBootsDurability = mc.netheriteBoots ? 290 : 0;
  normalizeMinecraftWorld(mc);

  const pk = user.pokemon;
  if (typeof pk.cooldownUntil !== "number") pk.cooldownUntil = 0;
  if (typeof pk.wins !== "number") pk.wins = 0;
  if (typeof pk.losses !== "number") pk.losses = 0;
  if (typeof pk.potions !== "number") pk.potions = 1;
  if (typeof pk.revives !== "number") pk.revives = 0;
  if (typeof pk.pokeballs !== "number") pk.pokeballs = 3;
  if (typeof pk.superballs !== "number") pk.superballs = 0;
  if (typeof pk.hyperballs !== "number") pk.hyperballs = 0;
  if (typeof pk.duskballs !== "number") pk.duskballs = 0;
  if (typeof pk.masterballs !== "number") pk.masterballs = 0;
  if (typeof pk.pokedollars !== "number") pk.pokedollars = 0;
  if (typeof pk.caughtCount !== "number") pk.caughtCount = 0;
  if (!Array.isArray(pk.collection)) pk.collection = [];
  if (typeof pk.specialCooldownUntil !== "number") pk.specialCooldownUntil = 0;
  if (typeof pk.enemyStatus !== "string") pk.enemyStatus = "";
  if (!pk.battle || typeof pk.battle !== "object") pk.battle = null;

  const dj = user.donjon;
  if (typeof dj.cooldownUntil !== "number") dj.cooldownUntil = 0;
  if (typeof dj.wins !== "number") dj.wins = 0;
  if (typeof dj.losses !== "number") dj.losses = 0;
  if (typeof dj.shields !== "number") dj.shields = 0;
  if (typeof dj.rations !== "number") dj.rations = 0;
  if (typeof dj.reviveStones !== "number") dj.reviveStones = 0;
  if (typeof dj.goldCoins !== "number") dj.goldCoins = 0;
  if (typeof dj.relics !== "number") dj.relics = 0;
  if (typeof dj.winStreak !== "number") dj.winStreak = 0;
  if (typeof dj.bestStreak !== "number") dj.bestStreak = 0;
  if (!dj.run || typeof dj.run !== "object") dj.run = null;
  if (!dj.nextEncounter || typeof dj.nextEncounter !== "object") dj.nextEncounter = null;
  if (typeof dj.classType !== "string") dj.classType = "guerrier";
  if (typeof dj.skillCooldownUntil !== "number") dj.skillCooldownUntil = 0;
  if (typeof dj.classChangeCooldownUntil !== "number") dj.classChangeCooldownUntil = 0;
  if (typeof dj.activityCooldownUntil !== "number") dj.activityCooldownUntil = 0;
  if (typeof dj.essence !== "number") dj.essence = 0;
  if (typeof dj.skillLevel !== "number") dj.skillLevel = 0;
  if (typeof dj.powerLevel !== "number") dj.powerLevel = 0;
  if (typeof dj.powerCharges !== "number") dj.powerCharges = 1;
  if (!dj.battle || typeof dj.battle !== "object") dj.battle = null;

  const zb = user.zombie;
  if (typeof zb.cooldownUntil !== "number") zb.cooldownUntil = 0;
  if (typeof zb.hp !== "number") zb.hp = 100;
  if (typeof zb.medkits !== "number") zb.medkits = 1;
  if (typeof zb.armorPlates !== "number") zb.armorPlates = 0;
  if (typeof zb.antidotes !== "number") zb.antidotes = 0;
  if (typeof zb.silverCoins !== "number") zb.silverCoins = 0;
  if (typeof zb.wins !== "number") zb.wins = 0;
  if (typeof zb.losses !== "number") zb.losses = 0;
  if (typeof zb.baseLevel !== "number") zb.baseLevel = 1;
  if (typeof zb.fortification !== "number") zb.fortification = 0;
  if (!zb.battle || typeof zb.battle !== "object") zb.battle = null;
}
function getBalance(id) {
  initUser(id);
  return memocoinData.get(id);
}
function addMemocoin(id, amount) {
  initUser(id);
  memocoinData.get(id).inventory += amount;
  saveData();
}
function removeMemocoin(id, amount) {
  initUser(id);
  const u = memocoinData.get(id);
  const removed = Math.min(u.inventory, amount);
  u.inventory -= removed;
  saveData();
  return removed;
}
function depositBank(id, amount) {
  const u = getBalance(id);
  if (isInPrison(id)) return false;
  if (u.inventory < amount) return false;
  u.inventory -= amount;
  u.bank += amount;
  saveData();
  return true;
}
function withdrawBank(id, amount) {
  const u = getBalance(id);
  if (isInPrison(id)) return false;
  if (u.bank < amount) return false;
  u.bank -= amount;
  u.inventory += amount;
  saveData();
  return true;
}
function getTotalMemocoin(id) {
  const u = getBalance(id);
  return (u.inventory || 0) + (u.bank || 0);
}
function hasEnoughMemocoin(id, amount) {
  return getTotalMemocoin(id) >= amount;
}
function getMemocoinSpendCapacity(id) {
  const total = getTotalMemocoin(id);
  if (debtModeEnabled) {
    return Math.max(0, total - PRISON_DEBT_LIMIT);
  }
  return Math.max(0, total);
}
function getMaxAffordableQuantity(totalSpendable, unitPrice, hardCap = 999) {
  if (!Number.isFinite(totalSpendable) || !Number.isFinite(unitPrice) || unitPrice <= 0) return 0;
  return Math.max(0, Math.min(hardCap, Math.floor(totalSpendable / unitPrice)));
}
function getDebtBlockedReason(actionLabel = "Action") {
  if (debtModeEnabled) return `❌ ${actionLabel} impossible. Tu ne peux pas descendre sous ${PRISON_DEBT_LIMIT}$.`;
  return `❌ ${actionLabel} impossible. Fonds insuffisants.`;
}
function canSpendMemocoinAmount(id, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (debtModeEnabled) return getTotalMemocoin(id) > PRISON_DEBT_LIMIT;
  return getTotalMemocoin(id) >= amount;
}
function spendMemocoinInventoryThenBank(id, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const u = getBalance(id);
  const totalBefore = (u.inventory || 0) + (u.bank || 0);
  let spendAmount = amount;
  if (debtModeEnabled) {
    if (totalBefore <= PRISON_DEBT_LIMIT) return false;
    const maxSpendBeforePrison = totalBefore - PRISON_DEBT_LIMIT;
    spendAmount = Math.min(amount, maxSpendBeforePrison);
  } else if (totalBefore < amount) {
    return false;
  }
  if (!Number.isFinite(spendAmount) || spendAmount <= 0) return false;
  const totalAfter = totalBefore - spendAmount;
  let remaining = spendAmount;
  const fromInventory = Math.min(u.inventory, remaining);
  u.inventory -= fromInventory;
  remaining -= fromInventory;
  if (remaining > 0) u.bank -= remaining;
  if (debtModeEnabled && totalAfter <= PRISON_DEBT_LIMIT) {
    sendToPrison(id);
  }
  saveData();
  return spendAmount;
}

function buildStatusEmbed(targetId, targetName = null) {
  const bal = getBalance(targetId);
  const mc = bal.minecraft || {};
  const pk = bal.pokemon || {};
  const dj = bal.donjon || {};
  const zb = bal.zombie || {};
  const cooldownUntil = stealCooldownMap.get(targetId) || 0;
  const cooldownRemainingMs = Math.max(0, cooldownUntil - Date.now());
  const hasPendingSteal = pendingStealsMap.has(targetId);
  const protectionCount = bal.antiStealProtection || 0;
  const rouletteResetCount = bal.resetRoulettePower || 0;
  const stealResetCount = bal.resetStealPower || 0;
  const casinoResetCount = bal.resetCasinoPower || 0;
  const slotResetCount = bal.resetSlotPower || 0;
  const antiPoliceCount = bal.antiPoliceProtection || 0;
  const policeRemaining = getPoliceWaitRemainingMs(targetId);
  const mcRestWaitMs = Math.max(0, (mc.restCooldownUntil || 0) - Date.now());
  const mcHarvestWaitMs = Math.max(0, (mc.harvestReadyAt || 0) - Date.now());
  const mcHarvestLabel = mcHarvestWaitMs > 0 ? formatShortDuration(mcHarvestWaitMs) : "Disponible";

  return new EmbedBuilder()
    .setTitle(`\u{1F4CA} Statut - ${targetName || `Utilisateur ${targetId}`}`)
    .setDescription("Informations joueur")
    .addFields(
      { name: "\u{1FA99} Memocoin", value: `${bal.inventory}$`, inline: true },
      { name: "\u{1F3E6} Banque", value: `${bal.bank}$`, inline: true },
      { name: "\u{1F6E1}\u{FE0F} Protections de vol", value: `${protectionCount}`, inline: true },
      { name: "\u26A1 Pouvoirs", value: `\ud83d\udee1\ufe0f Protection anti-police\n${antiPoliceCount}\n\u{1F504} Reset roulette\n${rouletteResetCount}\n\u{1F504} Reset vol\n${stealResetCount}\n\u{1F504} Reset casino\n${casinoResetCount}\n\u{1F504} Reset Slotomania\n${slotResetCount}`, inline: false },
      { name: "\u{1F5E1}\u{FE0F} Vol en attente", value: hasPendingSteal ? "Oui" : "Non", inline: true },
      { name: "\u23F1\u{FE0F} Cooldown vol", value: cooldownRemainingMs > 0 ? formatShortDuration(cooldownRemainingMs) : "Aucun", inline: true },
      { name: "\ud83d\udc6e Temps police restant", value: policeRemaining > 0 ? formatShortDuration(policeRemaining) : "Aucun", inline: true },

      { name: "🌍 Minecraft - Monde", value: `Biome: ${mc.currentBiome || "forêt"}\nÉnergie: ${mc.energy || 0}/100\nXP: ${mc.xp || 0}\nRepos: ${mcRestWaitMs > 0 ? formatShortDuration(mcRestWaitMs) : "Disponible"}\nRécolte: ${mcHarvestLabel}`, inline: false },
      { name: "🌍 Minecraft - Ressources", value: `Bois: ${mc.wood || 0} | Planches: ${mc.planks || 0} | Bâtons: ${mc.sticks || 0}\nPierre: ${mc.stone || 0} | Charbon: ${mc.coal || 0}\nMinerai fer: ${mc.ironOre || 0} | Minerai or: ${mc.goldOre || 0}\nLingots fer: ${mc.ironIngot || 0} | Lingots or: ${mc.goldIngot || 0}\nDiamants: ${mc.diamonds || 0} | Obsidienne: ${mc.obsidian || 0}\nSilex: ${mc.flint || 0} | Émeraudes: ${mc.emeralds || 0} | Blaze: ${mc.blazeRods || 0}\nPerles End: ${mc.enderPearls || 0} | Yeux End: ${mc.eyesOfEnder || 0}`, inline: false },
      { name: "🌍 Minecraft - Outils/Structures", value: `Table de craft: ${mc.hasCraftingTable ? "Oui" : "Non"} | Four: ${mc.hasFurnace ? "Oui" : "Non"}\nBriquet: ${mc.hasFlintAndSteel ? "Oui" : "Non"}\nPioche en bois: ${mc.hasWoodPickaxe ? "Oui" : "Non"} (${mc.woodPickaxeDurability || 0})\nPioche en pierre: ${mc.hasStonePickaxe ? "Oui" : "Non"} (${mc.stonePickaxeDurability || 0})\nPioche en fer: ${mc.hasIronPickaxe ? "Oui" : "Non"} (${mc.ironPickaxeDurability || 0})\nPioche en diamant: ${mc.hasDiamondPickaxe ? "Oui" : "Non"} (${mc.diamondPickaxeDurability || 0})\nPioche en netherite: ${mc.hasNetheritePickaxe ? "Oui" : "Non"} (${mc.netheritePickaxeDurability || 0})\nPortail du Nether: ${mc.hasNetherPortal ? "Oui" : "Non"} | Portail de l'End: ${mc.hasEndPortal ? "Oui" : "Non"}`, inline: false },

      { name: "🌎 Pokémon", value: `Pokédollars: ${pk.pokedollars || 0}\nPotions: ${pk.potions || 0} | Rappels: ${pk.revives || 0}\nPokéballs: Poké:${pk.pokeballs || 0} | Super:${pk.superballs || 0} | Hyper:${pk.hyperballs || 0}\nSombre:${pk.duskballs || 0} | Master:${pk.masterballs || 0}\nCapturés: ${pk.caughtCount || 0}\nVictoires: ${pk.wins || 0} | Défaites: ${pk.losses || 0}`, inline: false },
      { name: "🧨 Donjon", value: `Pièces d'or: ${dj.goldCoins || 0}\nBoucliers: ${dj.shields || 0} | Rations: ${dj.rations || 0} | Pierres de résurrection: ${dj.reviveStones || 0}\nClasse: ${getDonjonClassLabel(dj.classType || "guerrier")} | Reliques: ${dj.relics || 0} | Essence: ${dj.essence || 0}\nCompétence niv. ${dj.skillLevel || 0} | Pouvoir niv. ${dj.powerLevel || 0} | Charges: ${dj.powerCharges || 0}\nSérie: ${dj.winStreak || 0} (max ${dj.bestStreak || 0})\nVictoires: ${dj.wins || 0} | Défaites: ${dj.losses || 0}`, inline: false },
      { name: "🧟 Apocalypse zombie", value: `Pièces d'argent: ${zb.silverCoins || 0}\nSanté: ${zb.hp || 0}/100 | Kits de soin: ${zb.medkits || 0}\nArmures: ${zb.armorPlates || 0} | Antidotes: ${zb.antidotes || 0}\nBase: ${zb.baseLevel || 1} | Fortification: ${zb.fortification || 0}%\nVictoires: ${zb.wins || 0} | Défaites: ${zb.losses || 0}`, inline: false }
    )
    .setTimestamp();
}

function formatStatusLabel(status) {
  if (status === "online") return "🟢 En ligne";
  if (status === "idle") return "🟡 Inactif";
  if (status === "dnd") return "🔴 Ne pas déranger";
  return "⚫ Hors ligne";
}

function ensurePresenceRecord(userId) {
  if (!userStatusData.has(userId)) userStatusData.set(userId, {});
  const data = userStatusData.get(userId);
  if (!data.totals || typeof data.totals !== "object") data.totals = {};
  if (typeof data.totals.online !== "number") data.totals.online = 0;
  if (typeof data.totals.idle !== "number") data.totals.idle = 0;
  if (typeof data.totals.dnd !== "number") data.totals.dnd = 0;
  if (typeof data.totals.offline !== "number") data.totals.offline = 0;
  if (!Array.isArray(data.history)) data.history = [];
  if (typeof data.falseOfflineDetected !== "boolean") data.falseOfflineDetected = false;
  if (typeof data.falseOfflineAt !== "number") data.falseOfflineAt = 0;
  if (typeof data.suspectedOfflineDetected !== "boolean") data.suspectedOfflineDetected = false;
  if (typeof data.suspectedOfflineAt !== "number") data.suspectedOfflineAt = 0;
  if (typeof data.sessionConnectedSince !== "number") data.sessionConnectedSince = 0;
  return data;
}

function applyPresenceTransition(userId, fromStatus, toStatus, now = Date.now()) {
  const data = ensurePresenceRecord(userId);
  const previous = fromStatus || data.currentStatus || "offline";
  const since = Number(data.since || now);
  const elapsed = Math.max(0, now - since);
  if (previous && data.totals[previous] !== undefined) data.totals[previous] += elapsed;

  data.previousStatus = previous;
  data.previousSince = data.since || null;
  data.currentStatus = toStatus;
  data.since = now;
  data.lastChangeAt = now;

  if (toStatus !== "offline") data.lastSeenAt = now;
  if (toStatus === "offline") {
    data.sessionConnectedSince = 0;
  } else if (previous === "offline" || !data.sessionConnectedSince) {
    data.sessionConnectedSince = now;
  }

  data.history.unshift({
    at: now,
    from: previous,
    to: toStatus,
    durationMs: elapsed
  });
  if (data.history.length > 25) data.history = data.history.slice(0, 25);
}

function updateFalseOfflineFlag(userId, presenceStatus) {
  // Feature disabled by request: no more "faux hors ligne" détéction.
  return;
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getMinecraft(userId) {
  return getBalance(userId).minecraft;
}

function normalizeMinecraftWorld(mc) {
  const validWorlds = ["overworld", "nether", "end"];
  if (!validWorlds.includes(mc.world)) {
    if (mc.currentBiome === "nether" || mc.currentBiome === "end") {
      mc.world = mc.currentBiome;
      mc.currentBiome = "forêt";
    } else {
      mc.world = "overworld";
    }
  }
  if (!MC_OVERWORLD_BIOMES.includes(mc.currentBiome)) mc.currentBiome = "forêt";
  if (typeof mc.deadUntil !== "number") mc.deadUntil = 0;
  if (mc.deadUntil > 0 && mc.deadUntil <= Date.now()) {
    mc.deadUntil = 0;
    mc.hp = 100;
    mc.energy = 100;
    mc.encounter = null;
    mc.inCave = false;
    mc.caveVein = null;
    mc.caveMineRemaining = 0;
    mc.lastEvent = "✅ Réapparition.";
  }
}

function getMinecraftWorldLabel(world) {
  if (world === "nether") return "Nether";
  if (world === "end") return "End";
  return "Overworld";
}

function getRandomCooldownMs(baseMs, variance = 0.2) {
  const min = Math.max(1000, Math.round(baseMs * (1 - variance)));
  const max = Math.max(min, Math.round(baseMs * (1 + variance)));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function getMinecraftFoodDefs(mc) {
  return MC_FOOD_DEFS.map(def => ({
    ...def,
    count: mc[def.key] || 0
  }));
}

function resetMinecraftAfterDeath(userId, now = Date.now()) {
  const bal = getBalance(userId);
  bal.minecraft = {};
  initUser(userId);
  const mc = bal.minecraft;
  mc.deadUntil = now + MC_DEATH_COOLDOWN_MS;
  mc.hp = 0;
  mc.energy = 0;
  mc.encounter = null;
  mc.inCave = false;
  mc.caveVein = null;
  mc.caveMineRemaining = 0;
  mc.lastEvent = "💀 Tu es mort. Réapparition dans 3 jours. Tous tes objets ont été perdus.";
  return mc;
}

function advanceMinecraftAction(mc, count = 1) {
  const before = Boolean(mc.isNight);
  mc.actionCount = Math.max(0, (mc.actionCount || 0) + count);
  mc.isNight = (mc.actionCount % MC_ACTIONS_PER_CYCLE) >= MC_ACTIONS_PER_PHASE;
  if (before !== mc.isNight) {
    return mc.isNight ? "🌙 La nuit tombe." : "☀️ Le jour se lève.";
  }
  return "";
}

const MC_PICKAXE_DEFS = [
  { id: "netherite", key: "hasNetheritePickaxe", durKey: "netheritePickaxeDurability", tier: 5, label: "netherite", max: 360 },
  { id: "diamond", key: "hasDiamondPickaxe", durKey: "diamondPickaxeDurability", tier: 4, label: "diamant", max: 280 },
  { id: "iron", key: "hasIronPickaxe", durKey: "ironPickaxeDurability", tier: 3, label: "fer", max: 220 },
  { id: "stone", key: "hasStonePickaxe", durKey: "stonePickaxeDurability", tier: 2, label: "pierre", max: 150 },
  { id: "wood", key: "hasWoodPickaxe", durKey: "woodPickaxeDurability", tier: 1, label: "bois", max: 100 }
];

const MC_AXE_DEFS = [
  { id: "netherite", key: "hasNetheriteAxe", durKey: "netheriteAxeDurability", bonus: 4, label: "netherite" },
  { id: "diamond", key: "hasDiamondAxe", durKey: "diamondAxeDurability", bonus: 3, label: "diamant" },
  { id: "iron", key: "hasIronAxe", durKey: "ironAxeDurability", bonus: 2, label: "fer" },
  { id: "stone", key: "hasStoneAxe", durKey: "stoneAxeDurability", bonus: 1, label: "pierre" },
  { id: "wood", key: "hasWoodAxe", durKey: "woodAxeDurability", bonus: 0, label: "bois" }
];

const MC_SWORD_DEFS = [
  { id: "netherite", key: "netheriteSword", durKey: "netheriteSwordDurability", min: 18, max: 28, label: "netherite" },
  { id: "diamond", key: "diamondSword", durKey: "diamondSwordDurability", min: 14, max: 22, label: "diamant" },
  { id: "iron", key: "ironSword", durKey: "ironSwordDurability", min: 10, max: 18, label: "fer" },
  { id: "stone", key: "stoneSword", durKey: "stoneSwordDurability", min: 7, max: 12, label: "pierre" },
  { id: "wood", key: "woodSword", durKey: "woodSwordDurability", min: 5, max: 9, label: "bois" }
];

function getPickaxeDef(id) {
  return MC_PICKAXE_DEFS.find(def => def.id === id);
}

function getBestPickaxeDef(mc) {
  return MC_PICKAXE_DEFS.find(def => mc[def.key] && (mc[def.durKey] || 0) > 0) || null;
}

function getSelectedPickaxeDef(mc) {
  if (mc.selectedPickaxe && mc.selectedPickaxe !== "auto") {
    const def = getPickaxeDef(mc.selectedPickaxe);
    if (def && mc[def.key] && (mc[def.durKey] || 0) > 0) return def;
  }
  return getBestPickaxeDef(mc);
}

function getPickaxeTier(mc, useSelected = false) {
  const def = useSelected ? getSelectedPickaxeDef(mc) : getBestPickaxeDef(mc);
  return def ? def.tier : 0;
}

function applyPickaxeDamage(mc, amount = 6, pickaxeDef = null) {
  const def = pickaxeDef || getSelectedPickaxeDef(mc);
  if (!def) return "";
  const tier = def.tier || 1;
  const dmg = tier >= 5 ? Math.max(1, amount - 2)
    : tier >= 4 ? Math.max(1, amount - 1)
    : tier >= 3 ? amount
    : tier >= 2 ? amount + 1
    : amount + 2;
  mc[def.durKey] = Math.max(0, (mc[def.durKey] || 0) - dmg);
  if (mc[def.durKey] <= 0) {
    mc[def.key] = false;
    return `Ta pioche en ${def.label} s'est cassée.`;
  }
  return "";
}

function getMinecraftAxeStats(mc) {
  return MC_AXE_DEFS.find(opt => mc[opt.key] && (mc[opt.durKey] || 0) > 0) || null;
}

function getSelectedAxeStats(mc) {
  if (mc.selectedAxe && mc.selectedAxe !== "auto") {
    const def = MC_AXE_DEFS.find(opt => opt.id === mc.selectedAxe);
    if (def && mc[def.key] && (mc[def.durKey] || 0) > 0) return def;
  }
  return getMinecraftAxeStats(mc);
}

function applyAxeDamage(mc, amount = 4, axeDef = null) {
  const axe = axeDef || getSelectedAxeStats(mc);
  if (!axe) return "";
  mc[axe.durKey] = Math.max(0, (mc[axe.durKey] || 0) - amount);
  if (mc[axe.durKey] <= 0) {
    mc[axe.key] = false;
    return `Ta hache en ${axe.label} s'est cassée.`;
  }
  return "";
}

function getMinecraftSwordStats(mc) {
  return MC_SWORD_DEFS.find(opt => mc[opt.key] && (mc[opt.durKey] || 0) > 0) || null;
}

function getSelectedSwordStats(mc) {
  if (mc.selectedSword === "fist") return null;
  if (mc.selectedSword && mc.selectedSword !== "auto") {
    const def = MC_SWORD_DEFS.find(opt => opt.id === mc.selectedSword);
    if (def && mc[def.key] && (mc[def.durKey] || 0) > 0) return def;
  }
  return getMinecraftSwordStats(mc);
}

function getMinecraftArmorPieces(mc) {
  const pieces = [
    { key: "netheriteHelmet", durKey: "netheriteHelmetDurability", tier: "netherite", label: "casque netherite" },
    { key: "netheriteChestplate", durKey: "netheriteChestplateDurability", tier: "netherite", label: "plastron netherite" },
    { key: "netheriteLeggings", durKey: "netheriteLeggingsDurability", tier: "netherite", label: "jambières netherite" },
    { key: "netheriteBoots", durKey: "netheriteBootsDurability", tier: "netherite", label: "bottes netherite" },
    { key: "diamondHelmet", durKey: "diamondHelmetDurability", tier: "diamond", label: "casque diamant" },
    { key: "diamondChestplate", durKey: "diamondChestplateDurability", tier: "diamond", label: "plastron diamant" },
    { key: "diamondLeggings", durKey: "diamondLeggingsDurability", tier: "diamond", label: "jambières diamant" },
    { key: "diamondBoots", durKey: "diamondBootsDurability", tier: "diamond", label: "bottes diamant" },
    { key: "ironHelmet", durKey: "ironHelmetDurability", tier: "iron", label: "casque fer" },
    { key: "ironChestplate", durKey: "ironChestplateDurability", tier: "iron", label: "plastron fer" },
    { key: "ironLeggings", durKey: "ironLeggingsDurability", tier: "iron", label: "jambières fer" },
    { key: "ironBoots", durKey: "ironBootsDurability", tier: "iron", label: "bottes fer" }
  ];
  return pieces.filter(p => mc[p.key] && (mc[p.durKey] || 0) > 0);
}

function applyMinecraftDamage(mc, rawDamage) {
  const tierReductions = { iron: 0.04, diamond: 0.06, netherite: 0.08 };
  const pieces = getMinecraftArmorPieces(mc);
  const reduction = Math.min(0.6, pieces.reduce((sum, p) => sum + (tierReductions[p.tier] || 0), 0));
  const finalDamage = Math.max(1, Math.round(rawDamage * (1 - reduction)));
  mc.hp = Math.max(0, (mc.hp || 0) - finalDamage);
  const broken = [];
  for (const p of pieces) {
    mc[p.durKey] = Math.max(0, (mc[p.durKey] || 0) - 1);
    if (mc[p.durKey] <= 0) {
      mc[p.key] = false;
      broken.push(p.label);
    }
  }
  return { finalDamage, broken };
}

function rollMinecraftCaveVein(world) {
  if (world === "overworld" && Math.random() < 0.002) {
    return { id: "obsidian", required: 4, min: 1, max: 1, label: "obsidienne", remaining: 1 };
  }
  const pool = world === "nether"
    ? [
      { id: "ancientDebris", required: 3, min: 1, max: 1, label: "débris ancien" },
      { id: "goldOre", required: 2, min: 1, max: 2, label: "minerai d'or" },
      { id: "coal", required: 1, min: 1, max: 3, label: "charbon" },
      { id: "stone", required: 1, min: 2, max: 5, label: "pierre" }
    ]
    : world === "end"
    ? [
      { id: "enderPearls", required: 1, min: 1, max: 2, label: "perle de l'End" },
      { id: "diamonds", required: 3, min: 1, max: 1, label: "diamant" },
      { id: "stone", required: 1, min: 2, max: 4, label: "pierre" }
    ]
    : [
      { id: "stone", required: 1, min: 2, max: 5, label: "pierre" },
      { id: "coal", required: 1, min: 1, max: 3, label: "charbon" },
      { id: "ironOre", required: 2, min: 1, max: 3, label: "minerai de fer" },
      { id: "goldOre", required: 2, min: 1, max: 2, label: "minerai d'or" },
      { id: "diamonds", required: 3, min: 1, max: 1, label: "diamant" }
    ];
  const picked = pickRandom(pool);
  const remaining = picked.id === "diamonds" || picked.id === "ancientDebris"
    ? 1 + Math.floor(Math.random() * 2)
    : 1 + Math.floor(Math.random() * 5);
  return { ...picked, remaining };
}

function maybeStartMinecraftEncounter(mc) {
  if (mc.encounter) return "";
  const isNight = Boolean(mc.isNight);
  const canSpawnAnimals = mc.world === "overworld" && !mc.inCave && getMinecraftBiomeCategory(mc.currentBiome) !== "océan";
  const roll = Math.random();
  if (isNight) {
    if (roll < 0.6) {
      const mob = pickRandom(MC_MONSTERS);
      mc.encounter = { type: "monster", name: mob.name, hp: mob.hp, maxHp: mob.hp, atkMin: mob.atkMin, atkMax: mob.atkMax };
      return `⚔️ Un ${mob.name} surgit (${mob.hp} PV).`;
    }
    if (canSpawnAnimals && roll < 0.85) {
      const animal = pickRandom(MC_ANIMALS);
      mc.encounter = { type: "animal", name: animal.name, hp: animal.hp, maxHp: animal.hp, drops: animal.drops || {} };
      return `🐾 Tu rencontres un ${animal.name} (${animal.hp} PV).`;
    }
    return "";
  }
  if (roll < 0.01) {
    const result = applyMinecraftDamage(mc, 50);
    const brokenText = result.broken.length ? ` Armure brisée: ${result.broken.join(", ")}.` : "";
    const koText = mc.hp <= 0 ? " Tu es mort." : "";
    return `💥 Creeper: explosion ! -${result.finalDamage} PV.${brokenText}${koText}`;
  }
  if (canSpawnAnimals && roll < 0.8) {
    const animal = pickRandom(MC_ANIMALS);
    mc.encounter = { type: "animal", name: animal.name, hp: animal.hp, maxHp: animal.hp, drops: animal.drops || {} };
    return `🐾 Tu vois un ${animal.name} (${animal.hp} PV).`;
  }
  return "";
}

function getNextOverworldBiome(currentBiome) {
  const list = MC_OVERWORLD_BIOMES;
  const idx = list.indexOf(currentBiome);
  return list[(idx + 1 + list.length) % list.length];
}

function getMinecraftBiomeCategory(biome) {
  const b = (biome || "").toLowerCase();
  if (b === "forêt sombre" || b === "forêt de bouleaux") return "forêt";
  if (b === "toundra" || b === "neige") return "taiga";
  if (b === "plage" || b === "rivière") return "océan";
  if (b === "champignon") return "plaine";
  if (b === "collines") return "montagne";
  return b;
}

function getMinecraftActionState(mc) {
  normalizeMinecraftWorld(mc);
  const now = Date.now();
  const restWaitMs = Math.max(0, (mc.restCooldownUntil || 0) - now);
  const exploreWaitMs = Math.max(0, (mc.exploreCooldownUntil || 0) - now);
  const biomeWaitMs = Math.max(0, (mc.biomeCooldownUntil || 0) - now);
  const plantWaitMs = Math.max(0, (mc.plantCooldownUntil || 0) - now);
  const structureWaitMs = Math.max(0, (mc.structureCooldownUntil || 0) - now);
  const caveSearchWaitMs = Math.max(0, (mc.caveSearchCooldownUntil || 0) - now);
  const caveContinueWaitMs = Math.max(0, (mc.caveContinueCooldownUntil || 0) - now);
  const caveExitWaitMs = Math.max(0, (mc.caveExitCooldownUntil || 0) - now);
  const caveMineWaitMs = Math.max(0, (mc.caveMineCooldownUntil || 0) - now);
  const deathWaitMs = Math.max(0, (mc.deadUntil || 0) - now);
  const isDead = deathWaitMs > 0;
  const inCave = Boolean(mc.inCave);
  const inEncounter = Boolean(mc.encounter);
  const world = mc.world || "overworld";
  const hasPickaxe = getPickaxeTier(mc) > 0;
  const hasAxe = Boolean(getMinecraftAxeStats(mc));
  const hasCaveVein = mc.caveVein && (mc.caveMineRemaining || 0) > 0;
  const selectedPickaxe = getSelectedPickaxeDef(mc);
  const selectedPickaxeTier = selectedPickaxe ? selectedPickaxe.tier : 0;
  const canMineCave = inCave && hasCaveVein && caveMineWaitMs <= 0 && selectedPickaxeTier >= (mc.caveVein?.required || 1);
  const canSmeltMeat = mc.hasFurnace && ((mc.rawBeef || 0) > 0 || (mc.rawMutton || 0) > 0 || (mc.rawPork || 0) > 0 || (mc.rawChicken || 0) > 0) && (mc.coal || 0) > 0;
  const canSmeltBeef = mc.hasFurnace && (mc.rawBeef || 0) > 0 && (mc.coal || 0) > 0;
  const canSmeltMutton = mc.hasFurnace && (mc.rawMutton || 0) > 0 && (mc.coal || 0) > 0;
  const canSmeltPork = mc.hasFurnace && (mc.rawPork || 0) > 0 && (mc.coal || 0) > 0;
  const canSmeltChicken = mc.hasFurnace && (mc.rawChicken || 0) > 0 && (mc.coal || 0) > 0;
  const foodDefs = getMinecraftFoodDefs(mc);
  const canEat = (mc.hp || 0) < 100 && foodDefs.some(def => def.count > 0);
  const state = {
    restWaitMs,
    canRest: restWaitMs <= 0,
    exploreWaitMs,
    canExplore: !inEncounter && !inCave && exploreWaitMs <= 0,
    structureWaitMs,
    canFindStructure: !inEncounter && !inCave && structureWaitMs <= 0,
    caveSearchWaitMs,
    canFindCave: !inEncounter && !inCave && caveSearchWaitMs <= 0,
    caveContinueWaitMs,
    canCaveContinue: inCave && caveContinueWaitMs <= 0,
    caveExitWaitMs,
    canCaveExit: inCave && caveExitWaitMs <= 0,
    caveMineWaitMs,
    biomeWaitMs,
    canChangeBiome: !inEncounter && !inCave && biomeWaitMs <= 0 && world === "overworld",
    canChangeWorld: !inEncounter && !inCave && biomeWaitMs <= 0,
    plantWaitMs,
    canPlant: !inEncounter && plantWaitMs <= 0,
    canChopWood: !inEncounter && !inCave && mc.chopAvailable && world === "overworld",
    canMineCave,
    hasCaveVein,
    canCraftPlanks: mc.wood >= 1,
    canCraftTable: mc.planks >= 4 && !mc.hasCraftingTable,
    canCraftSticks: mc.hasCraftingTable && mc.planks >= 2,
    canCraftWoodPickaxe: mc.hasCraftingTable && mc.planks >= 3 && mc.sticks >= 2 && !mc.hasWoodPickaxe,
    canCraftFurnace: mc.hasCraftingTable && mc.stone >= 8 && !mc.hasFurnace,
    canCraftFlintSteel: mc.ironIngot >= 1 && (mc.flint || 0) >= 1 && !mc.hasFlintAndSteel,
    canSmeltIron: mc.hasFurnace && mc.ironOre >= 1 && mc.coal >= 1,
    canSmeltGold: mc.hasFurnace && mc.goldOre >= 1 && mc.coal >= 1,
    canSmeltNetherite: mc.hasFurnace && world === "nether" && mc.ancientDebris >= 1 && mc.coal >= 2,
    canSmeltMeat,
    canSmeltBeef,
    canSmeltMutton,
    canSmeltPork,
    canSmeltChicken,
    canSmeltAny: mc.hasFurnace && (
      (mc.ironOre >= 1 && mc.coal >= 1) ||
      (mc.goldOre >= 1 && mc.coal >= 1) ||
      (world === "nether" && mc.ancientDebris >= 1 && mc.coal >= 2) ||
      canSmeltMeat
    ),
    canCraftStonePickaxe: mc.hasCraftingTable && mc.stone >= 3 && mc.sticks >= 2 && !mc.hasStonePickaxe,
    canCraftIronPickaxe: mc.hasCraftingTable && mc.ironIngot >= 3 && mc.sticks >= 2 && !mc.hasIronPickaxe,
    canCraftDiamondPickaxe: mc.hasCraftingTable && mc.diamonds >= 3 && mc.sticks >= 2 && !mc.hasDiamondPickaxe,
    canCraftNetheritePickaxe: mc.hasCraftingTable && mc.netheriteScrap >= 2 && mc.sticks >= 2 && !mc.hasNetheritePickaxe,
    canCraftWoodAxe: mc.hasCraftingTable && mc.planks >= 3 && mc.sticks >= 2 && !mc.hasWoodAxe,
    canCraftStoneAxe: mc.hasCraftingTable && mc.stone >= 3 && mc.sticks >= 2 && !mc.hasStoneAxe,
    canCraftIronAxe: mc.hasCraftingTable && mc.ironIngot >= 3 && mc.sticks >= 2 && !mc.hasIronAxe,
    canCraftDiamondAxe: mc.hasCraftingTable && mc.diamonds >= 3 && mc.sticks >= 2 && !mc.hasDiamondAxe,
    canCraftNetheriteAxe: mc.hasCraftingTable && mc.netheriteScrap >= 2 && mc.sticks >= 2 && !mc.hasNetheriteAxe,
    canRepairTool: (mc.hasWoodPickaxe && mc.wood >= 3) || (mc.hasStonePickaxe && mc.stone >= 6) || (mc.hasIronPickaxe && (mc.ironIngot >= 3 || mc.netheriteScrap >= 1)) || (mc.hasDiamondPickaxe && mc.diamonds >= 2) || (mc.hasNetheritePickaxe && mc.netheriteScrap >= 1),
    canBuildNetherPortal: mc.obsidian >= 12 && mc.hasFlintAndSteel && !mc.hasNetherPortal,
    canCraftEye: mc.blazeRods >= 1 && mc.enderPearls >= 1,
    canOpenEndPortal: mc.eyesOfEnder >= 12 && !mc.hasEndPortal,
    canVillageSell: world === "overworld" && mc.currentBiome === "village" && mc.villagerReady && (mc.wood >= 20 || mc.stone >= 16 || mc.ironIngot >= 4),
    canVillageBuy: world === "overworld" && mc.currentBiome === "village" && mc.villagerReady && mc.emeralds >= 5,
    canCraftWoodSword: mc.hasCraftingTable && mc.planks >= 2 && mc.sticks >= 1 && !mc.woodSword,
    canCraftStoneSword: mc.hasCraftingTable && mc.stone >= 2 && mc.sticks >= 1 && !mc.stoneSword,
    canCraftIronSword: mc.hasCraftingTable && mc.ironIngot >= 2 && mc.sticks >= 1 && !mc.ironSword,
    canCraftDiamondSword: mc.hasCraftingTable && mc.diamonds >= 2 && mc.sticks >= 1 && !mc.diamondSword,
    canCraftNetheriteSword: mc.hasCraftingTable && mc.netheriteScrap >= 2 && mc.sticks >= 1 && !mc.netheriteSword,
    canCraftIronHelmet: mc.hasCraftingTable && mc.ironIngot >= 5 && !mc.ironHelmet,
    canCraftIronChest: mc.hasCraftingTable && mc.ironIngot >= 8 && !mc.ironChestplate,
    canCraftIronLegs: mc.hasCraftingTable && mc.ironIngot >= 7 && !mc.ironLeggings,
    canCraftIronBoots: mc.hasCraftingTable && mc.ironIngot >= 4 && !mc.ironBoots,
    canCraftDiamondHelmet: mc.hasCraftingTable && mc.diamonds >= 5 && !mc.diamondHelmet,
    canCraftDiamondChest: mc.hasCraftingTable && mc.diamonds >= 8 && !mc.diamondChestplate,
    canCraftDiamondLegs: mc.hasCraftingTable && mc.diamonds >= 7 && !mc.diamondLeggings,
    canCraftDiamondBoots: mc.hasCraftingTable && mc.diamonds >= 4 && !mc.diamondBoots,
    canCraftNetheriteHelmet: mc.hasCraftingTable && mc.netheriteScrap >= 2 && !mc.netheriteHelmet,
    canCraftNetheriteChest: mc.hasCraftingTable && mc.netheriteScrap >= 2 && !mc.netheriteChestplate,
    canCraftNetheriteLegs: mc.hasCraftingTable && mc.netheriteScrap >= 2 && !mc.netheriteLeggings,
    canCraftNetheriteBoots: mc.hasCraftingTable && mc.netheriteScrap >= 2 && !mc.netheriteBoots,
    canPlantPotato: mc.potatoes >= 1,
    canPlantPumpkin: mc.pumpkinSeeds >= 1,
    canPlantWheat: mc.wheatSeeds >= 1,
    canPlantCarrot: mc.carrots >= 1,
    canPlantBeetroot: mc.beetrootSeeds >= 1,
    inCave,
    inEncounter,
    world,
    hasPickaxe,
    hasAxe,
    canEat,
    isDead,
    deathWaitMs
  };
  if (isDead) {
    Object.keys(state).forEach(key => {
      if (key.startsWith("can")) state[key] = false;
    });
  }
  return state;
}

function buildMinecraftView(userId) {
  const mc = getMinecraft(userId);
  normalizeMinecraftWorld(mc);
  const st = getMinecraftActionState(mc);
  const worldLabel = getMinecraftWorldLabel(mc.world || "overworld");
  const biomeLabel = (mc.world === "overworld") ? mc.currentBiome : "-";
  const cyclePos = (mc.actionCount || 0) % MC_ACTIONS_PER_CYCLE;
  const timeLabel = mc.isNight ? "Nuit" : "Jour";
  const harvestWait = mc.harvestReadyAt && mc.harvestReadyAt > Date.now() ? formatShortDuration(mc.harvestReadyAt - Date.now()) : "Disponible";
  const encounterText = mc.encounter ? `${mc.encounter.name} (${mc.encounter.hp}/${mc.encounter.maxHp} PV)` : "Aucune";
  const caveMineWait = st.caveMineWaitMs > 0 ? formatShortDuration(st.caveMineWaitMs) : "Disponible";
  const formatCd = (ms) => (ms > 0 ? formatShortDuration(ms) : "Disponible");
  const deathInfo = st.isDead ? `Mort - réapparition dans ${formatShortDuration(st.deathWaitMs)}` : "Vivant";
  const toolText = [
    mc.hasWoodPickaxe ? `Pioche bois ${mc.woodPickaxeDurability || 0}/100` : null,
    mc.hasStonePickaxe ? `Pioche pierre ${mc.stonePickaxeDurability || 0}/150` : null,
    mc.hasIronPickaxe ? `Pioche fer ${mc.ironPickaxeDurability || 0}/220` : null,
    mc.hasDiamondPickaxe ? `Pioche diamant ${mc.diamondPickaxeDurability || 0}/280` : null,
    mc.hasNetheritePickaxe ? `Pioche netherite ${mc.netheritePickaxeDurability || 0}/360` : null,
    mc.hasWoodAxe ? `Hache bois ${mc.woodAxeDurability || 0}/80` : null,
    mc.hasStoneAxe ? `Hache pierre ${mc.stoneAxeDurability || 0}/120` : null,
    mc.hasIronAxe ? `Hache fer ${mc.ironAxeDurability || 0}/180` : null,
    mc.hasDiamondAxe ? `Hache diamant ${mc.diamondAxeDurability || 0}/240` : null,
    mc.hasNetheriteAxe ? `Hache netherite ${mc.netheriteAxeDurability || 0}/300` : null
  ].filter(Boolean).join("\n") || "Aucun";
  const weaponText = [
    mc.woodSword ? `Épée bois ${mc.woodSwordDurability || 0}/60` : null,
    mc.stoneSword ? `Épée pierre ${mc.stoneSwordDurability || 0}/90` : null,
    mc.ironSword ? `Épée fer ${mc.ironSwordDurability || 0}/140` : null,
    mc.diamondSword ? `Épée diamant ${mc.diamondSwordDurability || 0}/200` : null,
    mc.netheriteSword ? `Épée netherite ${mc.netheriteSwordDurability || 0}/260` : null
  ].filter(Boolean).join("\n") || "Aucune";
  const bestPick = getBestPickaxeDef(mc);
  const bestAxe = getMinecraftAxeStats(mc);
  const bestSword = getMinecraftSwordStats(mc);
  const pickLabel = (!mc.selectedPickaxe || mc.selectedPickaxe === "auto")
    ? `Auto (${bestPick ? bestPick.label : "aucune"})`
    : (getPickaxeDef(mc.selectedPickaxe)?.label || "aucune");
  const axeLabel = (!mc.selectedAxe || mc.selectedAxe === "auto")
    ? `Auto (${bestAxe ? bestAxe.label : "aucune"})`
    : (MC_AXE_DEFS.find(def => def.id === mc.selectedAxe)?.label || "aucune");
  const swordLabel = mc.selectedSword === "fist"
    ? "Poings"
    : ((!mc.selectedSword || mc.selectedSword === "auto")
      ? `Auto (${bestSword ? bestSword.label : "poings"})`
      : (MC_SWORD_DEFS.find(def => def.id === mc.selectedSword)?.label || "poings"));
  const caveText = mc.inCave
    ? (mc.caveVein ? `Veine: ${mc.caveVein.label} (${mc.caveMineRemaining || 0} restant)\nMinage: ${caveMineWait}` : "Oui")
    : "Non";
  const embed = new EmbedBuilder()
    .setTitle("🌍 Minecraft")
    .setDescription(
      `Monde: **${worldLabel}**\n` +
      `Biome: **${biomeLabel}**\n` +
      `Temps: **${timeLabel}** (${cyclePos}/${MC_ACTIONS_PER_CYCLE} actions)`
    )
    .addFields(
      { name: "❤️ PV", value: `${Math.max(0, mc.hp || 0)}/100`, inline: true },
      { name: "🔋 Énergie", value: `${Math.max(0, Math.floor(mc.energy || 0))}/100`, inline: true },
      { name: "⏱️ Repos", value: st.canRest ? "Disponible" : formatShortDuration(st.restWaitMs), inline: true },
      { name: "☠️ État", value: deathInfo, inline: true },
      { name: "🧰 Atelier", value: `Table de craft: ${mc.hasCraftingTable ? "Oui" : "Non"}\nFour: ${mc.hasFurnace ? "Oui" : "Non"}\nBriquet: ${mc.hasFlintAndSteel ? "Oui" : "Non"}\nPortail Nether: ${mc.hasNetherPortal ? "Oui" : "Non"}\nPortail End: ${mc.hasEndPortal ? "Oui" : "Non"}`, inline: false },
      { name: "🎒 Équipement", value: `Pioche: ${pickLabel}\nÉpée: ${swordLabel}\nHache: ${axeLabel}`, inline: false },
      { name: "⛏️ Outils", value: toolText, inline: false },
      { name: "🗡️ Armes", value: weaponText, inline: false },
      { name: "🪵 Ressources", value: `Bois ${mc.wood} | Planches ${mc.planks} | Bâtons ${mc.sticks}`, inline: false },
      { name: "⛏️ Minerais", value: `Pierre ${mc.stone} | Charbon ${mc.coal} | Fer ${mc.ironOre} | Or ${mc.goldOre || 0} | Diamants ${mc.diamonds} | Obsidienne ${mc.obsidian} | Silex ${mc.flint || 0}`, inline: false },
      { name: "🍖 Viandes", value: `Crues bœuf ${mc.rawBeef} | mouton ${mc.rawMutton} | porc ${mc.rawPork} | poulet ${mc.rawChicken}\nCuites bœuf ${mc.cookedBeef} | mouton ${mc.cookedMutton} | porc ${mc.cookedPork} | poulet ${mc.cookedChicken}`, inline: false },
      { name: "🌾 Plantation", value: `Planté: blé ${mc.plantedWheat} | patate ${mc.plantedPotatoes} | citrouille ${mc.plantedPumpkins}\ncarotte ${mc.plantedCarrots} | betterave ${mc.plantedBeetroots}\nRécolte: ${harvestWait}`, inline: false },
      { name: "⏳ Cooldowns", value: `Explorer: ${formatCd(st.exploreWaitMs)}\nStructure: ${formatCd(st.structureWaitMs)}\nGrotte: ${formatCd(st.caveSearchWaitMs)}\nContinuer grotte: ${formatCd(st.caveContinueWaitMs)}\nSortie grotte: ${formatCd(st.caveExitWaitMs)}\nMinage: ${formatCd(st.caveMineWaitMs)}\nChanger de biome/monde: ${formatCd(st.biomeWaitMs)}\nPlantation: ${formatCd(st.plantWaitMs)}`, inline: false },
      { name: "🐾 Rencontre", value: encounterText, inline: true },
      { name: "🕳️ Grotte", value: caveText, inline: true },
      { name: "🏛️ Structures", value: `${mc.structuresFound || 0} (dernier: ${mc.lastStructure || "Aucune"})`, inline: true },
      { name: "📣 Événement", value: mc.lastEvent || "Aucun" }
    )
    .setColor(0x2ecc71)
    .setFooter({ text: `XP Minecraft: ${mc.xp}` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mc_menu_craft").setLabel("🛠️ Crafter").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mc_menu_explore").setLabel("🧭 Explorer").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mc_menu_furnace").setLabel("🔥 Four").setStyle(ButtonStyle.Danger).setDisabled(!mc.hasFurnace),
    new ButtonBuilder().setCustomId("mc_menu_farm").setLabel("🌾 Plantation").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mc_menu_biome").setLabel("🗺️ Changer de biome").setStyle(ButtonStyle.Secondary).setDisabled(st.inCave || st.isDead)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mc_menu_build").setLabel("🏠 Construire").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mc_menu_rest").setLabel("🛌 Repos").setStyle(ButtonStyle.Secondary).setDisabled(!st.canRest),
    new ButtonBuilder().setCustomId("mc_menu_food").setLabel("🍽️ Manger").setStyle(ButtonStyle.Primary).setDisabled(!st.canEat)
  );
  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  const components = [row1, row2];
  if (st.canVillageSell || st.canVillageBuy) {
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_menu_trade").setLabel("💱 Échanger").setStyle(ButtonStyle.Primary)
    );
    components.push(row3);
  }
  if (st.inEncounter) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_mob_attack").setLabel("⚔️ Attaquer").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("mc_mob_flee").setLabel("🏃 Fuite").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mc_menu_equip_sword").setLabel("🗡️ Choisir épée").setStyle(ButtonStyle.Secondary)
    ));
  }
  components.push(navRow);
  return { embed, components };
}

function buildMinecraftSubmenuView(userId, menuId) {
  const mc = getMinecraft(userId);
  normalizeMinecraftWorld(mc);
  const st = getMinecraftActionState(mc);
  const menuLabels = {
    craft: "Crafter",
    craft_items: "Objets",
    craft_tools: "Outils",
    craft_swords: "Épées",
    craft_pickaxes: "Pioches",
    craft_axes: "Haches",
    craft_weapons: "Épées",
    craft_armors: "Armures",
    craft_portals: "Portail",
    repair: "Réparer",
    furnace: "Four",
    explore: "Exploration",
    travel: "Changer de biome",
    portals: "Changer de biome",
    biome: "Changer de biome",
    world: "Monde",
    trade: "Échanger",
    build: "Construire",
    mob: "Mobs",
    farm: "Plantation",
    food: "Manger",
    farm_harvest: "Récolte",
    rest: "Repos",
    equip_pickaxe: "Choisir pioche",
    equip_sword: "Choisir épée",
    equip_axe: "Choisir hache"
  };
  const embed = new EmbedBuilder()
    .setTitle("🌍 Minecraft")
    .setDescription(`Sous-menu: **${menuLabels[menuId] || menuId}**`)
    .setColor(0x2ecc71);
  let rows = [];
  let skipDefaultNav = false;
  if (menuId === "craft") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_menu_craft_items").setLabel("🧱 Objets").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("mc_menu_craft_tools").setLabel("🧰 Outils").setStyle(ButtonStyle.Success).setDisabled(!mc.hasCraftingTable),
      new ButtonBuilder().setCustomId("mc_menu_craft_weapons").setLabel("⚔️ Armes").setStyle(ButtonStyle.Primary).setDisabled(!mc.hasCraftingTable),
      new ButtonBuilder().setCustomId("mc_menu_craft_armors").setLabel("🛡️ Armures").setStyle(ButtonStyle.Primary).setDisabled(!mc.hasCraftingTable),
      new ButtonBuilder().setCustomId("mc_menu_craft_portals").setLabel("🌀 Portail").setStyle(ButtonStyle.Danger).setDisabled(!mc.hasCraftingTable)
    )];
  } else if (menuId === "craft_items") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_planks").setLabel("🧱 Planches").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftPlanks),
      new ButtonBuilder().setCustomId("mc_craft_sticks").setLabel("🪵 Bâtons").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftSticks),
      new ButtonBuilder().setCustomId("mc_craft_table").setLabel("🛠️ Table de craft").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftTable),
      new ButtonBuilder().setCustomId("mc_craft_furnace").setLabel("🔥 Four").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftFurnace),
      new ButtonBuilder().setCustomId("mc_craft_eye").setLabel("👁️ Œil de l'End").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftEye)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_flint_steel").setLabel("🔥 Briquet").setStyle(ButtonStyle.Secondary).setDisabled(!st.canCraftFlintSteel)
    )];
  } else if (menuId === "craft_tools") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_menu_craft_pickaxes").setLabel("⛏️ Pioches").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("mc_menu_craft_axes").setLabel("🪓 Haches").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("mc_menu_repair").setLabel("🛠️ Réparation").setStyle(ButtonStyle.Secondary)
    )];
  } else if (menuId === "craft_swords" || menuId === "craft_weapons") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_sword_wood").setLabel("🗡️ Épée bois").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftWoodSword),
      new ButtonBuilder().setCustomId("mc_craft_sword_stone").setLabel("🗡️ Épée pierre").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftStoneSword),
      new ButtonBuilder().setCustomId("mc_craft_sword_iron").setLabel("🗡️ Épée fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronSword),
      new ButtonBuilder().setCustomId("mc_craft_sword_diamond").setLabel("🗡️ Épée diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondSword),
      new ButtonBuilder().setCustomId("mc_craft_sword_netherite").setLabel("🗡️ Épée netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheriteSword)
    )];
  } else if (menuId === "craft_pickaxes") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_pickaxe").setLabel("⛏️ Pioche bois").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftWoodPickaxe),
      new ButtonBuilder().setCustomId("mc_craft_stone_pickaxe").setLabel("⛏️ Pioche pierre").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftStonePickaxe),
      new ButtonBuilder().setCustomId("mc_craft_iron_pickaxe").setLabel("⛏️ Pioche fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronPickaxe),
      new ButtonBuilder().setCustomId("mc_craft_diamond_pickaxe").setLabel("⛏️ Pioche diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondPickaxe),
      new ButtonBuilder().setCustomId("mc_craft_netherite_pickaxe").setLabel("⛏️ Pioche netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheritePickaxe)
    )];
  } else if (menuId === "craft_axes") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_axe_wood").setLabel("🪓 Hache bois").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftWoodAxe),
      new ButtonBuilder().setCustomId("mc_craft_axe_stone").setLabel("🪓 Hache pierre").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftStoneAxe),
      new ButtonBuilder().setCustomId("mc_craft_axe_iron").setLabel("🪓 Hache fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronAxe),
      new ButtonBuilder().setCustomId("mc_craft_axe_diamond").setLabel("🪓 Hache diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondAxe),
      new ButtonBuilder().setCustomId("mc_craft_axe_netherite").setLabel("🪓 Hache netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheriteAxe)
    )];
  } else if (menuId === "craft_armors") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_armor_iron_helmet").setLabel("🥽 Casque fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronHelmet),
      new ButtonBuilder().setCustomId("mc_craft_armor_iron_chest").setLabel("🛡️ Plastron fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronChest),
      new ButtonBuilder().setCustomId("mc_craft_armor_iron_legs").setLabel("👖 Jambières fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronLegs),
      new ButtonBuilder().setCustomId("mc_craft_armor_iron_boots").setLabel("🥾 Bottes fer").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftIronBoots)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_armor_diamond_helmet").setLabel("🥽 Casque diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondHelmet),
      new ButtonBuilder().setCustomId("mc_craft_armor_diamond_chest").setLabel("🛡️ Plastron diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondChest),
      new ButtonBuilder().setCustomId("mc_craft_armor_diamond_legs").setLabel("👖 Jambières diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondLegs),
      new ButtonBuilder().setCustomId("mc_craft_armor_diamond_boots").setLabel("🥾 Bottes diamant").setStyle(ButtonStyle.Primary).setDisabled(!st.canCraftDiamondBoots)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_craft_armor_netherite_helmet").setLabel("🥽 Casque netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheriteHelmet),
      new ButtonBuilder().setCustomId("mc_craft_armor_netherite_chest").setLabel("🛡️ Plastron netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheriteChest),
      new ButtonBuilder().setCustomId("mc_craft_armor_netherite_legs").setLabel("👖 Jambières netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheriteLegs),
      new ButtonBuilder().setCustomId("mc_craft_armor_netherite_boots").setLabel("🥾 Bottes netherite").setStyle(ButtonStyle.Danger).setDisabled(!st.canCraftNetheriteBoots)
    )];
  } else if (menuId === "craft_portals") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_build_nether_portal").setLabel("🧱 Portail Nether").setStyle(ButtonStyle.Primary).setDisabled(!st.canBuildNetherPortal),
      new ButtonBuilder().setCustomId("mc_open_end_portal").setLabel("🌀 Portail End").setStyle(ButtonStyle.Danger).setDisabled(!st.canOpenEndPortal)
    )];
  } else if (menuId === "repair") {
    const woodLabel = mc.hasWoodPickaxe ? `⛏️ Bois ${mc.woodPickaxeDurability || 0}/100` : "⛏️ Bois (absente)";
    const stoneLabel = mc.hasStonePickaxe ? `⛏️ Pierre ${mc.stonePickaxeDurability || 0}/150` : "⛏️ Pierre (absente)";
    const ironLabel = mc.hasIronPickaxe ? `⛏️ Fer ${mc.ironPickaxeDurability || 0}/220` : "⛏️ Fer (absente)";
    const diamondLabel = mc.hasDiamondPickaxe ? `⛏️ Diamant ${mc.diamondPickaxeDurability || 0}/280` : "⛏️ Diamant (absente)";
    const netheriteLabel = mc.hasNetheritePickaxe ? `⛏️ Netherite ${mc.netheritePickaxeDurability || 0}/360` : "⛏️ Netherite (absente)";
    const axeLabels = [
      mc.hasWoodAxe ? `🪓 Bois ${mc.woodAxeDurability || 0}/80` : "🪓 Bois (absente)",
      mc.hasStoneAxe ? `🪓 Pierre ${mc.stoneAxeDurability || 0}/120` : "🪓 Pierre (absente)",
      mc.hasIronAxe ? `🪓 Fer ${mc.ironAxeDurability || 0}/180` : "🪓 Fer (absente)",
      mc.hasDiamondAxe ? `🪓 Diamant ${mc.diamondAxeDurability || 0}/240` : "🪓 Diamant (absente)",
      mc.hasNetheriteAxe ? `🪓 Netherite ${mc.netheriteAxeDurability || 0}/300` : "🪓 Netherite (absente)"
    ];
    const swordLabels = [
      mc.woodSword ? `🗡️ Bois ${mc.woodSwordDurability || 0}/60` : "🗡️ Bois (absente)",
      mc.stoneSword ? `🗡️ Pierre ${mc.stoneSwordDurability || 0}/90` : "🗡️ Pierre (absente)",
      mc.ironSword ? `🗡️ Fer ${mc.ironSwordDurability || 0}/140` : "🗡️ Fer (absente)",
      mc.diamondSword ? `🗡️ Diamant ${mc.diamondSwordDurability || 0}/200` : "🗡️ Diamant (absente)",
      mc.netheriteSword ? `🗡️ Netherite ${mc.netheriteSwordDurability || 0}/260` : "🗡️ Netherite (absente)"
    ];
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_repair_tool_wood").setLabel(woodLabel).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasWoodPickaxe),
      new ButtonBuilder().setCustomId("mc_repair_tool_stone").setLabel(stoneLabel).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasStonePickaxe),
      new ButtonBuilder().setCustomId("mc_repair_tool_iron").setLabel(ironLabel).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasIronPickaxe)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_repair_tool_diamond").setLabel(diamondLabel).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasDiamondPickaxe),
      new ButtonBuilder().setCustomId("mc_repair_tool_netherite").setLabel(netheriteLabel).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasNetheritePickaxe)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_repair_axe_wood").setLabel(axeLabels[0]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasWoodAxe),
      new ButtonBuilder().setCustomId("mc_repair_axe_stone").setLabel(axeLabels[1]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasStoneAxe),
      new ButtonBuilder().setCustomId("mc_repair_axe_iron").setLabel(axeLabels[2]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasIronAxe),
      new ButtonBuilder().setCustomId("mc_repair_axe_diamond").setLabel(axeLabels[3]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasDiamondAxe),
      new ButtonBuilder().setCustomId("mc_repair_axe_netherite").setLabel(axeLabels[4]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.hasNetheriteAxe)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_repair_sword_wood").setLabel(swordLabels[0]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.woodSword),
      new ButtonBuilder().setCustomId("mc_repair_sword_stone").setLabel(swordLabels[1]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.stoneSword),
      new ButtonBuilder().setCustomId("mc_repair_sword_iron").setLabel(swordLabels[2]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.ironSword),
      new ButtonBuilder().setCustomId("mc_repair_sword_diamond").setLabel(swordLabels[3]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.diamondSword),
      new ButtonBuilder().setCustomId("mc_repair_sword_netherite").setLabel(swordLabels[4]).setStyle(ButtonStyle.Secondary).setDisabled(!mc.netheriteSword)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_repair_armor_iron").setLabel("🛡️ Armure fer").setStyle(ButtonStyle.Secondary).setDisabled(!(mc.ironHelmet || mc.ironChestplate || mc.ironLeggings || mc.ironBoots)),
      new ButtonBuilder().setCustomId("mc_repair_armor_diamond").setLabel("🛡️ Armure diamant").setStyle(ButtonStyle.Secondary).setDisabled(!(mc.diamondHelmet || mc.diamondChestplate || mc.diamondLeggings || mc.diamondBoots)),
      new ButtonBuilder().setCustomId("mc_repair_armor_netherite").setLabel("🛡️ Armure netherite").setStyle(ButtonStyle.Secondary).setDisabled(!(mc.netheriteHelmet || mc.netheriteChestplate || mc.netheriteLeggings || mc.netheriteBoots))
    )];
  } else if (menuId === "furnace") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_smelt_iron").setLabel("🔥 Fondre fer").setStyle(ButtonStyle.Success).setDisabled(!st.canSmeltIron),
      new ButtonBuilder().setCustomId("mc_smelt_gold").setLabel("🔥 Fondre or").setStyle(ButtonStyle.Success).setDisabled(!st.canSmeltGold),
      new ButtonBuilder().setCustomId("mc_smelt_netherite").setLabel("🔥 Fondre débris").setStyle(ButtonStyle.Danger).setDisabled(!st.canSmeltNetherite),
      new ButtonBuilder().setCustomId("mc_smelt_beef").setLabel("🍖 Cuire bœuf").setStyle(ButtonStyle.Primary).setDisabled(!st.canSmeltBeef)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_smelt_mutton").setLabel("🍖 Cuire mouton").setStyle(ButtonStyle.Primary).setDisabled(!st.canSmeltMutton),
      new ButtonBuilder().setCustomId("mc_smelt_pork").setLabel("🍖 Cuire porc").setStyle(ButtonStyle.Primary).setDisabled(!st.canSmeltPork),
      new ButtonBuilder().setCustomId("mc_smelt_chicken").setLabel("🍖 Cuire poulet").setStyle(ButtonStyle.Primary).setDisabled(!st.canSmeltChicken)
    )];
  } else if (menuId === "explore") {
    if (st.inCave) {
      rows = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mc_cave_mine").setLabel("⛏️ Miner").setStyle(ButtonStyle.Primary).setDisabled(!st.canMineCave),
        new ButtonBuilder().setCustomId("mc_cave_continue").setLabel("🧭 Continuer").setStyle(ButtonStyle.Success).setDisabled(!st.canCaveContinue),
        new ButtonBuilder().setCustomId("mc_cave_exit").setLabel("🚪 Sortir").setStyle(ButtonStyle.Secondary).setDisabled(!st.canCaveExit),
        new ButtonBuilder().setCustomId("mc_menu_equip_pickaxe").setLabel("🧰 Choisir pioche").setStyle(ButtonStyle.Secondary)
      )];
    } else {
      rows = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("mc_explore").setLabel("🧭 Explorer").setStyle(ButtonStyle.Success).setDisabled(!st.canExplore),
        new ButtonBuilder().setCustomId("mc_find_structure").setLabel("🏛️ Structure").setStyle(ButtonStyle.Primary).setDisabled(!st.canFindStructure),
        new ButtonBuilder().setCustomId("mc_find_cave").setLabel("🕳️ Grotte").setStyle(ButtonStyle.Primary).setDisabled(!st.canFindCave),
        new ButtonBuilder().setCustomId("mc_chop_wood").setLabel("🪓 Couper du bois").setStyle(ButtonStyle.Secondary).setDisabled(!st.canChopWood),
        new ButtonBuilder().setCustomId("mc_menu_equip_axe").setLabel("🧰 Choisir hache").setStyle(ButtonStyle.Secondary)
      )];
    }
  } else if (menuId === "biome" || menuId === "travel" || menuId === "portals") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_change_biome").setLabel("🌿 Changer de biome").setStyle(ButtonStyle.Secondary).setDisabled(!st.canChangeBiome),
      new ButtonBuilder().setCustomId("mc_menu_world").setLabel("🌍 Monde").setStyle(ButtonStyle.Secondary)
    )];
  } else if (menuId === "world") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_world_overworld").setLabel("🌍 Overworld").setStyle(ButtonStyle.Secondary).setDisabled(!st.canChangeWorld),
      new ButtonBuilder().setCustomId("mc_world_nether").setLabel("🔥 Nether").setStyle(ButtonStyle.Danger).setDisabled(!st.canChangeWorld || !mc.hasNetherPortal),
      new ButtonBuilder().setCustomId("mc_world_end").setLabel("✨ End").setStyle(ButtonStyle.Danger).setDisabled(!st.canChangeWorld || !mc.hasEndPortal),
      new ButtonBuilder().setCustomId("mc_menu_biome").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    )];
    skipDefaultNav = true;
  } else if (menuId === "farm") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_plant_wheat").setLabel("🌾 Planter blé").setStyle(ButtonStyle.Success).setDisabled(!st.canPlant || !st.canPlantWheat),
      new ButtonBuilder().setCustomId("mc_plant_potato").setLabel("🥔 Planter pomme de terre").setStyle(ButtonStyle.Success).setDisabled(!st.canPlant || !st.canPlantPotato),
      new ButtonBuilder().setCustomId("mc_plant_pumpkin").setLabel("🎃 Planter citrouille").setStyle(ButtonStyle.Success).setDisabled(!st.canPlant || !st.canPlantPumpkin),
      new ButtonBuilder().setCustomId("mc_plant_carrot").setLabel("🥕 Planter carotte").setStyle(ButtonStyle.Success).setDisabled(!st.canPlant || !st.canPlantCarrot),
      new ButtonBuilder().setCustomId("mc_plant_beetroot").setLabel("🌱 Planter betterave").setStyle(ButtonStyle.Success).setDisabled(!st.canPlant || !st.canPlantBeetroot)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_menu_farm_harvest").setLabel("🪓 Récolte").setStyle(ButtonStyle.Secondary)
    )];
  } else if (menuId === "farm_harvest") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_harvest_crops").setLabel("🪓 Récolter").setStyle(ButtonStyle.Success)
    )];
  } else if (menuId === "trade") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_trade_sell").setLabel("💱 Vendre").setStyle(ButtonStyle.Primary).setDisabled(!st.canVillageSell),
      new ButtonBuilder().setCustomId("mc_trade_buy").setLabel("🛒 Acheter").setStyle(ButtonStyle.Primary).setDisabled(!st.canVillageBuy),
      new ButtonBuilder().setCustomId("mc_menu_explore").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    )];
    skipDefaultNav = true;
  } else if (menuId === "build") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_build_house").setLabel("🏠 Maison").setStyle(ButtonStyle.Primary).setDisabled(mc.houseBuilt)
    )];
  } else if (menuId === "mob") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_mob_attack").setLabel("⚔️ Attaquer").setStyle(ButtonStyle.Danger).setDisabled(!st.inEncounter),
      new ButtonBuilder().setCustomId("mc_mob_flee").setLabel("🏃 Fuite").setStyle(ButtonStyle.Secondary).setDisabled(!st.inEncounter),
      new ButtonBuilder().setCustomId("jeu_minecraft").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    )];
    skipDefaultNav = true;
  } else if (menuId === "food") {
    const foods = getMinecraftFoodDefs(mc);
    rows = [new ActionRowBuilder().addComponents(
      ...foods.map(def =>
        new ButtonBuilder()
          .setCustomId(`mc_eat_${def.id}`)
          .setLabel(`${def.emoji} ${def.label} (x${def.count})`)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(def.count <= 0 || (mc.hp || 0) >= 100)
      )
    )];
  } else if (menuId === "rest") {
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_rest_sleep").setLabel("🌙 Dormir (passer la nuit)").setStyle(ButtonStyle.Primary).setDisabled(!st.canRest || !mc.isNight),
      new ButtonBuilder().setCustomId("mc_rest_awake").setLabel("☀️ Rester éveillé").setStyle(ButtonStyle.Secondary).setDisabled(!st.canRest)
    )];
  } else if (menuId === "equip_pickaxe") {
    const selected = mc.selectedPickaxe || "auto";
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_select_pickaxe_auto").setLabel("🔁 Auto").setStyle(selected === "auto" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mc_select_pickaxe_wood").setLabel("⛏️ Bois").setStyle(selected === "wood" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasWoodPickaxe || (mc.woodPickaxeDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_pickaxe_stone").setLabel("⛏️ Pierre").setStyle(selected === "stone" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasStonePickaxe || (mc.stonePickaxeDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_pickaxe_iron").setLabel("⛏️ Fer").setStyle(selected === "iron" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasIronPickaxe || (mc.ironPickaxeDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_pickaxe_diamond").setLabel("⛏️ Diamant").setStyle(selected === "diamond" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasDiamondPickaxe || (mc.diamondPickaxeDurability || 0) <= 0)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_select_pickaxe_netherite").setLabel("⛏️ Netherite").setStyle(selected === "netherite" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasNetheritePickaxe || (mc.netheritePickaxeDurability || 0) <= 0)
    )];
  } else if (menuId === "equip_sword") {
    const selected = mc.selectedSword || "auto";
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_select_sword_auto").setLabel("🔁 Auto").setStyle(selected === "auto" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mc_select_sword_fist").setLabel("👊 Poings").setStyle(selected === "fist" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mc_select_sword_wood").setLabel("🗡️ Bois").setStyle(selected === "wood" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.woodSword || (mc.woodSwordDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_sword_stone").setLabel("🗡️ Pierre").setStyle(selected === "stone" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.stoneSword || (mc.stoneSwordDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_sword_iron").setLabel("🗡️ Fer").setStyle(selected === "iron" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.ironSword || (mc.ironSwordDurability || 0) <= 0)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_select_sword_diamond").setLabel("🗡️ Diamant").setStyle(selected === "diamond" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.diamondSword || (mc.diamondSwordDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_sword_netherite").setLabel("🗡️ Netherite").setStyle(selected === "netherite" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.netheriteSword || (mc.netheriteSwordDurability || 0) <= 0)
    )];
  } else if (menuId === "equip_axe") {
    const selected = mc.selectedAxe || "auto";
    rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_select_axe_auto").setLabel("🔁 Auto").setStyle(selected === "auto" ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("mc_select_axe_wood").setLabel("🪓 Bois").setStyle(selected === "wood" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasWoodAxe || (mc.woodAxeDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_axe_stone").setLabel("🪓 Pierre").setStyle(selected === "stone" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasStoneAxe || (mc.stoneAxeDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_axe_iron").setLabel("🪓 Fer").setStyle(selected === "iron" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasIronAxe || (mc.ironAxeDurability || 0) <= 0),
      new ButtonBuilder().setCustomId("mc_select_axe_diamond").setLabel("🪓 Diamant").setStyle(selected === "diamond" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasDiamondAxe || (mc.diamondAxeDurability || 0) <= 0)
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mc_select_axe_netherite").setLabel("🪓 Netherite").setStyle(selected === "netherite" ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(!mc.hasNetheriteAxe || (mc.netheriteAxeDurability || 0) <= 0)
    )];
  }
  if (!skipDefaultNav) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_minecraft").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    ));
  }
  return { embed, components: rows };
}

function getPokemon(userId) {
  return getBalance(userId).pokemon;
}

function getPokemonBallDefs(pk) {
  return [
    { id: "poke", label: "Pokéball", emoji: "🔴", count: pk.pokeballs || 0, multiplier: 1.0, customId: "pk_throw_ball_poke" },
    { id: "super", label: "Superball", emoji: "🔵", count: pk.superballs || 0, multiplier: 1.3, customId: "pk_throw_ball_super" },
    { id: "hyper", label: "Hyperball", emoji: "⚫", count: pk.hyperballs || 0, multiplier: 1.6, customId: "pk_throw_ball_hyper" },
    { id: "dusk", label: "Sombreball", emoji: "🌙", count: pk.duskballs || 0, multiplier: 1.5, customId: "pk_throw_ball_dusk" },
    { id: "master", label: "Masterball", emoji: "🟣", count: pk.masterballs || 0, multiplier: 999, customId: "pk_throw_ball_master" }
  ];
}

function getPokemonCaptureChance(pk, battle, ballDef) {
  if (!battle || !ballDef) return 0;
  if (ballDef.id === "master") return 1;
  const maxHp = Math.max(1, battle.enemyMaxHp || battle.enemyHp || 1);
  const hpRatio = Math.max(0, Math.min(1, battle.enemyHp / maxHp));
  const missingHpRatio = 1 - hpRatio;
  const statusBonus = pk.enemyStatus ? 0.12 : 0;
  const base = 0.18 + (missingHpRatio * 0.55) + statusBonus;
  const chance = base * (ballDef.multiplier || 1);
  return Math.max(0.05, Math.min(0.92, chance));
}

function buildPokemonView(userId) {
  const pk = getPokemon(userId);
  const now = Date.now();
  const hasBattle = Boolean(pk.battle);
  const wait = Math.max(0, (pk.cooldownUntil || 0) - now);
  const canStart = !hasBattle && wait <= 0;
  const totalBalls = (pk.pokeballs || 0) + (pk.superballs || 0) + (pk.hyperballs || 0) + (pk.duskballs || 0) + (pk.masterballs || 0);

  const embed = new EmbedBuilder()
    .setTitle("🌎 Pokémon")
    .setDescription(hasBattle ? `Combat en cours contre **${pk.battle.enemyName}**.` : "Lance un combat et utilise tes actions.")
    .addFields(
      { name: "🏆 Victoires", value: String(pk.wins || 0), inline: true },
      { name: "💀 Défaites", value: String(pk.losses || 0), inline: true },
      { name: "🧪 Potions", value: String(pk.potions || 0), inline: true },
      { name: "❤️ Rappels", value: String(pk.revives || 0), inline: true },
      { name: "🎯 Pokéballs", value: `Poké:${pk.pokeballs || 0} | Super:${pk.superballs || 0} | Hyper:${pk.hyperballs || 0}\nSombre:${pk.duskballs || 0} | Master:${pk.masterballs || 0}`, inline: true },
      { name: "💴 Pokédollars", value: String(pk.pokedollars || 0), inline: true },
      { name: "📘 Capturés", value: String(pk.caughtCount || 0), inline: true },
      { name: "✨ Spéciale", value: Math.max(0, (pk.specialCooldownUntil || 0) - Date.now()) > 0 ? `Prête dans ${formatShortDuration((pk.specialCooldownUntil || 0) - Date.now())}` : "Prête", inline: true },
      { name: "🧪 Statut ennemi", value: pk.enemyStatus || "Aucun", inline: true },
      { name: "⏱️ Attente", value: wait > 0 ? formatShortDuration(wait) : "Aucune", inline: true },
      { name: "❤️ PV joueur", value: hasBattle ? String(Math.max(0, pk.battle.playerHp)) : "-", inline: true },
      { name: "🩸 PV ennemi", value: hasBattle ? String(Math.max(0, pk.battle.enemyHp)) : "-", inline: true }
    )
    .setColor(0xe67e22);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pk_start").setLabel("⚔️ Lancer un combat").setStyle(ButtonStyle.Success).setDisabled(!canStart),
    new ButtonBuilder().setCustomId("pk_attack").setLabel("💥 Attaquer").setStyle(ButtonStyle.Danger).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("pk_defend").setLabel("🛡️ Défendre").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("pk_flee").setLabel("🏃 S'enfuir").setStyle(ButtonStyle.Secondary).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("pk_potion").setLabel("🧪 Potion").setStyle(ButtonStyle.Secondary).setDisabled(!hasBattle || (pk.potions || 0) <= 0)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pk_special").setLabel("✨ Attaque spéciale").setStyle(ButtonStyle.Danger).setDisabled(!hasBattle || (pk.specialCooldownUntil || 0) > Date.now()),
    new ButtonBuilder().setCustomId("pk_ball_menu").setLabel("🎯 Pokéballs").setStyle(ButtonStyle.Success).setDisabled(!hasBattle || totalBalls <= 0),
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row, nav] };
}

function buildPokemonBallMenuView(userId) {
  const pk = getPokemon(userId);
  const defs = getPokemonBallDefs(pk);
  const battle = pk.battle;
  const hasBattle = Boolean(battle);

  const lines = defs.map(def => {
    const chance = hasBattle ? getPokemonCaptureChance(pk, battle, def) : 0;
    const pct = hasBattle ? `${Math.round(chance * 100)}%` : "-";
    return `${def.emoji} ${def.label}: ${def.count} (taux: ${pct})`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🎯 Pokéballs")
    .setDescription(hasBattle ? `Choisis une Pokéball contre **${battle.enemyName}**.` : "Aucun combat actif.")
    .addFields({ name: "Stocks", value: lines, inline: false })
    .setColor(0xf1c40f);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pk_throw_ball_poke").setLabel("🔴 Pokéball").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle || (pk.pokeballs || 0) <= 0),
    new ButtonBuilder().setCustomId("pk_throw_ball_super").setLabel("🔵 Superball").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle || (pk.superballs || 0) <= 0),
    new ButtonBuilder().setCustomId("pk_throw_ball_hyper").setLabel("⚫ Hyperball").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle || (pk.hyperballs || 0) <= 0),
    new ButtonBuilder().setCustomId("pk_throw_ball_dusk").setLabel("🌙 Sombreball").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle || (pk.duskballs || 0) <= 0),
    new ButtonBuilder().setCustomId("pk_throw_ball_master").setLabel("🟣 Masterball").setStyle(ButtonStyle.Danger).setDisabled(!hasBattle || (pk.masterballs || 0) <= 0)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_pokemon").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row1, row2] };
}

function getDonjon(userId) {
  return getBalance(userId).donjon;
}

function buildDonjonView(userId) {
  const dj = getDonjon(userId);
  const now = Date.now();
  const hasBattle = Boolean(dj.battle);
  const hasNextEncounter = Boolean(dj.nextEncounter && dj.nextEncounter.monster);
  const wait = Math.max(0, (dj.cooldownUntil || 0) - now);
  const classWait = Math.max(0, (dj.classChangeCooldownUntil || 0) - now);
  const activityWait = Math.max(0, (dj.activityCooldownUntil || 0) - now);
  const canStart = !hasBattle && !hasNextEncounter && wait <= 0;
  const monster = hasBattle ? dj.battle.monsterName : "Aucun";
  const canChangeClass = !hasBattle && classWait <= 0;
  const relicBonusPct = Math.min(25, dj.relics || 0);
  const streakBonusPct = Math.min(25, (dj.winStreak || 0) * 2);
  const totalBonusPct = relicBonusPct + streakBonusPct;
  const stage = dj.run?.stage || 0;
  const totalStages = dj.run?.total || 0;
  const skillLevel = Math.max(0, Number(dj.skillLevel || 0));
  const powerLevel = Math.max(0, Number(dj.powerLevel || 0));
  const powerCharges = Math.max(0, Number(dj.powerCharges || 0));
  const skillCost = getDonjonSkillUpgradeCost(skillLevel);
  const powerCost = getDonjonPowerUpgradeCost(powerLevel);
  const canUpgradeSkill = !hasBattle && skillLevel < DONJON_MAX_SKILL_LEVEL && (dj.goldCoins || 0) >= skillCost.gold && (dj.essence || 0) >= skillCost.essence;
  const canUpgradePower = !hasBattle && powerLevel < DONJON_MAX_POWER_LEVEL && (dj.goldCoins || 0) >= powerCost.gold && (dj.essence || 0) >= powerCost.essence;
  const canUseActivity = !hasBattle && activityWait <= 0;
  const classLabel = getDonjonClassLabel(dj.classType || "guerrier");
  const powerName = getDonjonPowerName(dj.classType || "guerrier");

  const embed = new EmbedBuilder()
    .setTitle("🧨 Donjon")
    .setDescription(
      hasBattle
        ? `Un **${monster}** bloque le passage.`
        : (hasNextEncounter
          ? "Fin de combat. Choisis si tu veux continuer ou explorer."
          : "Lance un donjon. 9 monstres + 1 boss final. Améliore tes pouvoirs, tes compétences et prépare ton aventure.")
    )
    .addFields(
      { name: "🏆 Victoires", value: String(dj.wins || 0), inline: true },
      { name: "💀 Defaites", value: String(dj.losses || 0), inline: true },
      { name: "🛡️ Boucliers", value: String(dj.shields || 0), inline: true },
      { name: "🥖 Rations", value: String(dj.rations || 0), inline: true },
      { name: "💎 Pierres de résurrection", value: String(dj.reviveStones || 0), inline: true },
      { name: "🪙 Pièces d'or", value: String(dj.goldCoins || 0), inline: true },
      { name: "🧭 Classe", value: classLabel, inline: true },
      { name: "🏺 Reliques", value: `${dj.relics || 0} (+${relicBonusPct}%)`, inline: true },
      { name: "✨ Essence", value: String(dj.essence || 0), inline: true },
      { name: "🔥 Serie", value: `${dj.winStreak || 0} (max ${dj.bestStreak || 0})`, inline: true },
      { name: "🎁 Bonus gains", value: `${totalBonusPct}%`, inline: true },
      { name: "📍 Progression", value: totalStages > 0 ? `${stage}/${totalStages}` : "Aucune", inline: true },
      { name: "📘 Compétence", value: skillLevel >= DONJON_MAX_SKILL_LEVEL ? `Niv. max (${skillLevel})` : `Niv. ${skillLevel} | +1: ${skillCost.gold} or / ${skillCost.essence} essence`, inline: false },
      { name: "🔥 Pouvoir", value: `${powerName} | Niv. ${powerLevel} | Charges: ${powerCharges}/${DONJON_MAX_POWER_CHARGES}`, inline: false },
      { name: "🏕️ Activite", value: activityWait > 0 ? formatShortDuration(activityWait) : "Disponible", inline: true },
      { name: "⏱️ Changement classe", value: classWait > 0 ? formatShortDuration(classWait) : "Disponible", inline: true },
      { name: "⏱️ Attente", value: wait > 0 ? formatShortDuration(wait) : "Aucune", inline: true },
      { name: "❤️ PV joueur", value: hasBattle ? String(Math.max(0, dj.battle.playerHp)) : "-", inline: true },
      { name: "🩸 PV monstre", value: hasBattle ? String(Math.max(0, dj.battle.enemyHp)) : "-", inline: true }
    )
    .setColor(0x8e44ad);

  const rowStart = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_start").setLabel("🚪 Lancer le donjon").setStyle(ButtonStyle.Success).setDisabled(!canStart)
  );
  const rowCombat = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_attack").setLabel("⚔️ Attaquer").setStyle(ButtonStyle.Danger).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("dg_skill").setLabel("✨ Compétence").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle || (dj.skillCooldownUntil || 0) > Date.now()),
    new ButtonBuilder().setCustomId("dg_power").setLabel("🔥 Pouvoir").setStyle(ButtonStyle.Success).setDisabled(!hasBattle || powerCharges <= 0),
    new ButtonBuilder().setCustomId("dg_defend").setLabel("🛡️ Se defendre").setStyle(ButtonStyle.Secondary).setDisabled(!hasBattle)
  );
  const rowItems = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_flee").setLabel("🏃 S'enfuir").setStyle(ButtonStyle.Secondary).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("dg_ration").setLabel("🥖 Utiliser ration").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle || (dj.rations || 0) <= 0)
  );
  const rowPostFight = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_continue").setLabel("⚔️ Continuer").setStyle(ButtonStyle.Success).setDisabled(!hasNextEncounter),
    new ButtonBuilder().setCustomId("dg_explore").setLabel("🧭 Explorer").setStyle(ButtonStyle.Primary).setDisabled(!hasNextEncounter)
  );
  const rowMeta = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_upgrade_skill").setLabel("📘 Compétence +1").setStyle(ButtonStyle.Primary).setDisabled(!canUpgradeSkill),
    new ButtonBuilder().setCustomId("dg_upgrade_power").setLabel("🔥 Pouvoir +1").setStyle(ButtonStyle.Primary).setDisabled(!canUpgradePower),
    new ButtonBuilder().setCustomId("dg_activity").setLabel("🏕️ Activite").setStyle(ButtonStyle.Secondary).setDisabled(!canUseActivity)
  );
  const rowClass = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_change_class").setLabel("🧭 Changer de classe").setStyle(ButtonStyle.Primary).setDisabled(!canChangeClass)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  const components = [];
  if (canStart) components.push(rowStart);
  if (hasBattle) {
    components.push(rowCombat, rowItems);
  } else if (hasNextEncounter) {
    components.push(rowPostFight);
  }
  components.push(rowMeta, rowClass, nav);
  return { embed, components };
}

const MC_MENU_LABEL_TO_ID = {
  "Crafter": "craft",
  "Objets": "craft_items",
  "Outils": "craft_tools",
  "Épées": "craft_swords",
  "Pioches": "craft_pickaxes",
  "Haches": "craft_axes",
  "Armures": "craft_armors",
  "Portail": "craft_portals",
  "Réparer": "repair",
  "Four": "furnace",
  "Exploration": "explore",
  "Changer de biome": "biome",
  "Monde": "world",
  "Échanger": "trade",
  "Construire": "build",
  "Mobs": "mob",
  "Plantation": "farm",
  "Manger": "food",
  "Récolte": "farm_harvest",
  "Repos": "rest",
  "Choisir pioche": "equip_pickaxe",
  "Choisir épée": "equip_sword",
  "Choisir hache": "equip_axe"
};

function syncMinecraftMenuFromMessage(userId, message) {
  const embed = message?.embeds?.[0];
  const desc = embed?.description || "";
  const match = desc.match(/Sous-menu:\s*\*\*(.+?)\*\*/i);
  const mc = getMinecraft(userId);
  if (match && match[1]) {
    const label = match[1].trim();
    mc.lastMenu = MC_MENU_LABEL_TO_ID[label] || mc.lastMenu;
  } else if (embed?.title?.includes("Minecraft")) {
    mc.lastMenu = "main";
  }
}

function getMinecraftCurrentView(userId) {
  const mc = getMinecraft(userId);
  const menuId = mc.lastMenu;
  if (menuId && menuId !== "main") {
    return buildMinecraftSubmenuView(userId, menuId);
  }
  return buildMinecraftView(userId);
}

function getZombie(userId) {
  return getBalance(userId).zombie;
}

function buildZombieView(userId) {
  const zb = getZombie(userId);
  const now = Date.now();
  const hasBattle = Boolean(zb.battle);
  const wait = Math.max(0, (zb.cooldownUntil || 0) - now);
  const canStart = !hasBattle && wait <= 0;

  const embed = new EmbedBuilder()
    .setTitle("🧟 Apocalypse Zombie")
    .setDescription(hasBattle ? `Menace active: **${zb.battle.enemyName}**.` : "Survis, combats, et ramasse des ressources.")
    .addFields(
      { name: "❤️ Santé", value: String(Math.max(0, zb.hp || 0)), inline: true },
      { name: "🩹 Kits de soin", value: String(zb.medkits || 0), inline: true },
      { name: "🧱 Armures", value: String(zb.armorPlates || 0), inline: true },
      { name: "🧴 Antidotes", value: String(zb.antidotes || 0), inline: true },
      { name: "🥈 Pièces d'argent", value: String(zb.silverCoins || 0), inline: true },
      { name: "🏚️ Base", value: `Niv.${zb.baseLevel || 1}`, inline: true },
      { name: "🧱 Fortification", value: `${zb.fortification || 0}%`, inline: true },
      { name: "🏆 Victoires", value: String(zb.wins || 0), inline: true },
      { name: "💀 Défaites", value: String(zb.losses || 0), inline: true },
      { name: "⏱️ Attente", value: wait > 0 ? formatShortDuration(wait) : "Aucune", inline: true }
    )
    .setColor(0x27ae60);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("zb_start").setLabel("🚨 Explorer").setStyle(ButtonStyle.Success).setDisabled(!canStart),
    new ButtonBuilder().setCustomId("zb_attack").setLabel("🔫 Attaquer").setStyle(ButtonStyle.Danger).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("zb_defend").setLabel("🧱 Se couvrir").setStyle(ButtonStyle.Primary).setDisabled(!hasBattle),
    new ButtonBuilder().setCustomId("zb_medkit").setLabel("🩹 Utiliser medkit").setStyle(ButtonStyle.Secondary).setDisabled((zb.medkits || 0) <= 0 || (zb.hp || 0) >= 100),
    new ButtonBuilder().setCustomId("zb_flee").setLabel("🏃 Fuir").setStyle(ButtonStyle.Secondary).setDisabled(!hasBattle)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("zb_upgrade_base").setLabel("🏚️ Améliorer base").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("zb_scavenge").setLabel("📦 Fouiller").setStyle(ButtonStyle.Success).setDisabled(hasBattle),
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row, nav] };
}

function getWalletAmountByCurrency(bal, currency) {
  if (currency === "emerald") return Number(bal?.minecraft?.emeralds || 0);
  if (currency === "pokedollar") return Number(bal?.pokemon?.pokedollars || 0);
  if (currency === "gold") return Number(bal?.donjon?.goldCoins || 0);
  if (currency === "silver") return Number(bal?.zombie?.silverCoins || 0);
  return Number(bal?.inventory || 0); // memocoin
}

function getCurrencyLabel(currency) {
  if (currency === "emerald") return "émeraudes";
  if (currency === "pokedollar") return "Pokédollars";
  if (currency === "gold") return "pièces d'or";
  if (currency === "silver") return "pièces d'argent";
  return "Memocoins";
}

function getGameShopDef(game, item) {
  const defs = {
    mc: {
      wood: { price: 25, currency: "emerald", label: "Bois x20", apply: (bal, mc, q) => { mc.wood += q * 20; } },
      stone: { price: 40, currency: "emerald", label: "Pierre x20", apply: (bal, mc, q) => { mc.stone += q * 20; } },
      coal: { price: 75, currency: "emerald", label: "Charbon x10", apply: (bal, mc, q) => { mc.coal += q * 10; } },
      ironore: { price: 110, currency: "emerald", label: "Minerai de fer x8", apply: (bal, mc, q) => { mc.ironOre += q * 8; } },
      obsidian: { price: 180, currency: "emerald", label: "Obsidienne x1", apply: (bal, mc, q) => { mc.obsidian += q; } },
      pearl: { price: 240, currency: "emerald", label: "Perle de l'End x1", apply: (bal, mc, q) => { mc.enderPearls += q; } },
      blazerod: { price: 320, currency: "emerald", label: "Bâton de blaze x1", apply: (bal, mc, q) => { mc.blazeRods += q; } }
    },
    pk: {
      potion: { price: 900, currency: "pokedollar", label: "Potion x1", apply: (bal, mc, q) => { bal.pokemon.potions += q; } },
      pack: { price: 2400, currency: "pokedollar", label: "Pack potion x3", apply: (bal, mc, q) => { bal.pokemon.potions += q * 3; } },
      revive: { price: 5000, currency: "pokedollar", label: "Rappel x1", apply: (bal, mc, q) => { bal.pokemon.revives += q; } },
      ball: { price: 700, currency: "pokedollar", label: "Pokéball x1", apply: (bal, mc, q) => { bal.pokemon.pokeballs += q; } },
      superball: { price: 1400, currency: "pokedollar", label: "Superball x1", apply: (bal, mc, q) => { bal.pokemon.superballs += q; } },
      hyperball: { price: 2500, currency: "pokedollar", label: "Hyperball x1", apply: (bal, mc, q) => { bal.pokemon.hyperballs += q; } },
      duskball: { price: 3200, currency: "pokedollar", label: "Sombreball x1", apply: (bal, mc, q) => { bal.pokemon.duskballs += q; } },
      masterball: { price: 15000, currency: "pokedollar", label: "Masterball x1", apply: (bal, mc, q) => { bal.pokemon.masterballs += q; } }
    },
    dg: {
      shield: { price: 30, currency: "gold", label: "Bouclier x1", apply: (bal, mc, q) => { bal.donjon.shields += q; } },
      ration: { price: 5, currency: "gold", label: "Ration x1", apply: (bal, mc, q) => { bal.donjon.rations += q; } },
      revive: { price: 90, currency: "gold", label: "Pierre de résurrection x1", apply: (bal, mc, q) => { bal.donjon.reviveStones += q; } }
    },
    zb: {
      medkit: { price: 120, currency: "silver", label: "Kit de soin x1", apply: (bal, mc, q) => { bal.zombie.medkits += q; } },
      armor: { price: 260, currency: "silver", label: "Armure x1", apply: (bal, mc, q) => { bal.zombie.armorPlates += q; } },
      antidote: { price: 340, currency: "silver", label: "Antidote x1", apply: (bal, mc, q) => { bal.zombie.antidotes += q; } }
    },
    mm: {
      anti_steal: { price: 150000, currency: "memocoin", label: "Protection de vol x1", apply: (bal, mc, q) => { bal.antiStealProtection += q; } },
      police: { price: SHOP_PRICE_POLICE_PROTECTION, currency: "memocoin", label: "Protection anti-police x1", apply: (bal, mc, q) => { bal.antiPoliceProtection = (bal.antiPoliceProtection || 0) + q; } },
      reset_steal: { price: 45000, currency: "memocoin", label: "Reset vol x1", apply: (bal, mc, q) => { bal.resetStealPower += q; } },
      reset_roulette: { price: 755000, currency: "memocoin", label: "Reset roulette x1", apply: (bal, mc, q) => { bal.resetRoulettePower += q; } },
      reset_casino: { price: 34500, currency: "memocoin", label: "Reset casino x1", apply: (bal, mc, q) => { bal.resetCasinoPower += q; } }
    }
  };
  return defs?.[game]?.[item] || null;
}

function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function getParisHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    hour: "2-digit"
  }).formatToParts(date);
  return Number(parts.find(p => p.type === "hour")?.value || 0);
}

function isTravelingMerchantOpen(date = new Date()) {
  const h = getParisHour(date);
  return h >= 14 && h < 16;
}

function getTravelingMerchantOffers() {
  const pool = [
    { id: "mc_wood", label: "🪵 Bois x20", memocoinPrice: 900, apply: (bal, qty) => { bal.minecraft.wood += 20 * qty; } },
    { id: "mc_stone", label: "🪨 Pierre x20", memocoinPrice: 1400, apply: (bal, qty) => { bal.minecraft.stone += 20 * qty; } },
    { id: "mc_coal", label: "🪨 Charbon x10", memocoinPrice: 2500, apply: (bal, qty) => { bal.minecraft.coal += 10 * qty; } },
    { id: "mc_ironore", label: "⛓️ Minerai fer x8", memocoinPrice: 4200, apply: (bal, qty) => { bal.minecraft.ironOre += 8 * qty; } },
    { id: "mc_obsidian", label: "🟪 Obsidienne x1", memocoinPrice: 6500, apply: (bal, qty) => { bal.minecraft.obsidian += 1 * qty; } },
    { id: "mc_pearl", label: "🫧 Perle x1", memocoinPrice: 7600, apply: (bal, qty) => { bal.minecraft.enderPearls += 1 * qty; } },
    { id: "mc_blazerod", label: "🔥 Blaze x1", memocoinPrice: 8900, apply: (bal, qty) => { bal.minecraft.blazeRods += 1 * qty; } },
    { id: "pk_pokeball", label: "🔴 Pokéball x1", memocoinPrice: 1400, apply: (bal, qty) => { bal.pokemon.pokeballs += 1 * qty; } },
    { id: "pk_superball", label: "🔵 Superball x1", memocoinPrice: 2800, apply: (bal, qty) => { bal.pokemon.superballs += 1 * qty; } },
    { id: "pk_hyperball", label: "⚫ Hyperball x1", memocoinPrice: 4500, apply: (bal, qty) => { bal.pokemon.hyperballs += 1 * qty; } },
    { id: "pk_duskball", label: "🌙 Sombreball x1", memocoinPrice: 5200, apply: (bal, qty) => { bal.pokemon.duskballs += 1 * qty; } },
    { id: "pk_masterball", label: "🟣 Masterball x1", memocoinPrice: 25000, apply: (bal, qty) => { bal.pokemon.masterballs += 1 * qty; } },
    { id: "dg_shield", label: "🛡️ Bouclier x1", memocoinPrice: 1900, apply: (bal, qty) => { bal.donjon.shields += 1 * qty; } },
    { id: "dg_ration", label: "🥖 Ration x1", memocoinPrice: 1200, apply: (bal, qty) => { bal.donjon.rations += 1 * qty; } },
    { id: "zb_medkit", label: "🩹 Kit de soin x1", memocoinPrice: 1700, apply: (bal, qty) => { bal.zombie.medkits += 1 * qty; } },
    { id: "zb_armor", label: "🧱 Armure x1", memocoinPrice: 2800, apply: (bal, qty) => { bal.zombie.armorPlates += 1 * qty; } }
  ];

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, 5).map((o, idx) => ({ ...o, slot: idx + 1 }));
}

function buildTravelingMerchantView(userId, options = {}) {
  const bal = getBalance(userId);
  const locked = isInPrison(userId);
  const open = isTravelingMerchantOpen();
  const embed = new EmbedBuilder()
    .setTitle("🧳 Marchand ambulant")
    .setColor(0x2ecc71);

  if (!open) {
    embed.setDescription("Le marchand ambulant est fermé.\nHoraires: 14h à 16h (heure de Paris).");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("merchant_closed").setLabel("⏰ Fermé").setStyle(ButtonStyle.Secondary).setDisabled(true)
    );
    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );
    return { embed, components: [row, nav] };
  }

  const forceNew = options.forceNew !== false;
  let offers = null;
  if (!forceNew) {
    offers = travelingMerchantMap.get(userId)?.offers;
  }
  if (!offers || forceNew) {
    offers = getTravelingMerchantOffers();
    travelingMerchantMap.set(userId, { offers, generatedAt: Date.now() });
  }

  const lines = offers.map((offer) => `${offer.slot}. ${offer.label} - ${offer.memocoinPrice} Memocoins`).join("\n");
  embed
    .setDescription("Offres disponibles. Les offres changent à chaque ouverture ou rafraîchissement.")
    .addFields(
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "🧾 Offres", value: lines || "Aucune", inline: false }
    );

  const buttons = offers.map((offer) => (
    new ButtonBuilder()
      .setCustomId(`merchant_buy_${offer.slot}`)
      .setLabel(offer.label)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(locked)
  ));
  const rows = [];
  if (buttons.length > 0) rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 3)));
  if (buttons.length > 3) rows.push(new ActionRowBuilder().addComponents(...buttons.slice(3, 5)));
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  rows.push(nav);
  return { embed, components: rows };
}

function buildMinecraftShopView(userId) {
  const mc = getMinecraft(userId);
  const bal = getBalance(userId);
  const embed = new EmbedBuilder()
    .setTitle("🛒 Boutique Minecraft")
    .setDescription(
      "- Bois x20: 25 Émeraudes.\n" +
      "- Pierre x20: 40 Émeraudes.\n" +
      "- Charbon x10: 75 Émeraudes.\n" +
      "- Minerai de fer x8: 110 Émeraudes.\n" +
      "- Obsidienne x1: 180 Émeraudes.\n" +
      "- Perle de l'End x1: 240 Émeraudes.\n" +
      "- Bâton de blaze x1: 320 Émeraudes."
    )
    .addFields(
      { name: "💚 Émeraudes", value: String(mc.emeralds || 0), inline: true },
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "🪵 Bois", value: String(mc.wood || 0), inline: true },
      { name: "🪨 Pierre", value: String(mc.stone || 0), inline: true },
      { name: "🪨 Charbon", value: String(mc.coal || 0), inline: true },
      { name: "⛓️ Minerai de fer", value: String(mc.ironOre || 0), inline: true },
      { name: "🟪 Obsidienne", value: String(mc.obsidian || 0), inline: true },
      { name: "🫧 Perles", value: String(mc.enderPearls || 0), inline: true },
      { name: "🔥 Bâtons de blaze", value: String(mc.blazeRods || 0), inline: true }
    )
    .setColor(0x16a085);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mc_shop_buy_wood").setLabel("🪵 Bois x20").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 25),
    new ButtonBuilder().setCustomId("mc_shop_buy_stone").setLabel("🪨 Pierre x20").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 40),
    new ButtonBuilder().setCustomId("mc_shop_buy_coal").setLabel("🪨 Charbon x10").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 75),
    new ButtonBuilder().setCustomId("mc_shop_buy_ironore").setLabel("⛓️ Fer x8").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 110),
    new ButtonBuilder().setCustomId("mc_shop_buy_obsidian").setLabel("🟪 Obsidienne x1").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 180)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mc_shop_buy_pearl").setLabel("🫧 Perle x1").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 240),
    new ButtonBuilder().setCustomId("mc_shop_buy_blazerod").setLabel("🔥 Blaze x1").setStyle(ButtonStyle.Primary).setDisabled((mc.emeralds || 0) < 320)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row, row2, nav] };
}

function buildMemocoinShopView(userId) {
  const bal = getBalance(userId);
  const locked = isInPrison(userId);
  const embed = new EmbedBuilder()
    .setTitle("🪙 Boutique Memocoin")
    .setDescription(
      "- Protection de vol x1: 150000 Memocoins.\n" +
      `- Protection anti-police x1: ${SHOP_PRICE_POLICE_PROTECTION} Memocoins.\n` +
      "- Reset vol x1: 45000 Memocoins."
    )
    .addFields(
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "🛡️ Prot. vol", value: String(bal.antiStealProtection || 0), inline: true },
      { name: "👮🛡️ Prot. police", value: String(bal.antiPoliceProtection || 0), inline: true },
      { name: "⚡ Reset vol", value: String(bal.resetStealPower || 0), inline: true }
    )
    .setColor(0xf1c40f);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mm_shop_buy_anti_steal").setLabel("🛡️ Prot. vol").setStyle(ButtonStyle.Primary).setDisabled(locked),
    new ButtonBuilder().setCustomId("mm_shop_buy_police").setLabel("👮🛡️ Prot. police").setStyle(ButtonStyle.Primary).setDisabled(locked),
    new ButtonBuilder().setCustomId("mm_shop_buy_reset_steal").setLabel("⚡ Reset vol").setStyle(ButtonStyle.Primary).setDisabled(locked)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row1, nav] };
}

function buildPokemonShopView(userId) {
  const pk = getPokemon(userId);
  const bal = getBalance(userId);
  const embed = new EmbedBuilder()
    .setTitle("🛒 Boutique Pokémon")
    .setDescription(
      "- Potion x1: 900 Pokédollars.\n" +
      "- Pack soin x3: 2400 Pokédollars.\n" +
      "- Rappel x1: 5000 Pokédollars.\n" +
      "- Pokéball x1: 700 Pokédollars.\n" +
      "- Superball x1: 1400 Pokédollars.\n" +
      "- Hyperball x1: 2500 Pokédollars.\n" +
      "- Sombreball x1: 3200 Pokédollars.\n" +
      "- Masterball x1: 15000 Pokédollars."
    )
    .addFields(
      { name: "💴 Pokédollars", value: String(pk.pokedollars || 0), inline: true },
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "🧪 Potions", value: String(pk.potions || 0), inline: true },
      { name: "❤️ Rappels", value: String(pk.revives || 0), inline: true },
      { name: "🎯 Pokéballs", value: `Poké:${pk.pokeballs || 0} | Super:${pk.superballs || 0} | Hyper:${pk.hyperballs || 0}\nSombre:${pk.duskballs || 0} | Master:${pk.masterballs || 0}`, inline: false }
    )
    .setColor(0xe67e22);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pk_shop_buy_potion").setLabel("🧪 Potion x1").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 900),
    new ButtonBuilder().setCustomId("pk_shop_buy_pack").setLabel("🧪 Pack x3").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 2400),
    new ButtonBuilder().setCustomId("pk_shop_buy_revive").setLabel("❤️ Rappel x1").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 5000)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pk_shop_buy_ball").setLabel("🔴 Pokéball x1").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 700),
    new ButtonBuilder().setCustomId("pk_shop_buy_superball").setLabel("🔵 Superball x1").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 1400),
    new ButtonBuilder().setCustomId("pk_shop_buy_hyperball").setLabel("⚫ Hyperball x1").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 2500)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pk_shop_buy_duskball").setLabel("🌙 Sombreball x1").setStyle(ButtonStyle.Primary).setDisabled((pk.pokedollars || 0) < 3200),
    new ButtonBuilder().setCustomId("pk_shop_buy_masterball").setLabel("🟣 Masterball x1").setStyle(ButtonStyle.Danger).setDisabled((pk.pokedollars || 0) < 15000)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row, row2, row3, nav] };
}

function buildDonjonShopView(userId) {
  const dj = getDonjon(userId);
  const bal = getBalance(userId);
  const embed = new EmbedBuilder()
    .setTitle("🛒 Boutique Donjon")
    .setDescription(
      "- Bouclier donjon x1: 30 pièces d'or.\n" +
      "- Ration de secours x1: 5 pièces d'or.\n" +
      "- Pierre de résurrection x1: 90 pièces d'or."
    )
    .addFields(
      { name: "🪙 Pièces d'or", value: String(dj.goldCoins || 0), inline: true },
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "🛡️ Boucliers", value: String(dj.shields || 0), inline: true },
      { name: "🥖 Rations", value: String(dj.rations || 0), inline: true },
      { name: "💎 Pierre de résurrection", value: String(dj.reviveStones || 0), inline: true }
    )
    .setColor(0x8e44ad);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dg_shop_buy_shield").setLabel("🛡️ Bouclier x1").setStyle(ButtonStyle.Primary).setDisabled((dj.goldCoins || 0) < 30),
    new ButtonBuilder().setCustomId("dg_shop_buy_ration").setLabel("🥖 Ration x1").setStyle(ButtonStyle.Primary).setDisabled((dj.goldCoins || 0) < 5),
    new ButtonBuilder().setCustomId("dg_shop_buy_revive").setLabel("💎 Pierre de résurrection x1").setStyle(ButtonStyle.Primary).setDisabled((dj.goldCoins || 0) < 90)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row, nav] };
}

function buildZombieShopView(userId) {
  const zb = getZombie(userId);
  const bal = getBalance(userId);
  const embed = new EmbedBuilder()
    .setTitle("🛒 Boutique Zombie")
    .setDescription(
      "- Kit de soin x1: 120 pièces d'argent.\n" +
      "- Plaque d'armure x1: 260 pièces d'argent.\n" +
      "- Antidote x1: 340 pièces d'argent."
    )
    .addFields(
      { name: "🥈 Pièces d'argent", value: String(zb.silverCoins || 0), inline: true },
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "🩹 Kits de soin", value: String(zb.medkits || 0), inline: true },
      { name: "🧱 Armures", value: String(zb.armorPlates || 0), inline: true },
      { name: "🧴 Antidotes", value: String(zb.antidotes || 0), inline: true }
    )
    .setColor(0x27ae60);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("zb_shop_buy_medkit").setLabel("🩹 Kit de soin x1").setStyle(ButtonStyle.Primary).setDisabled((zb.silverCoins || 0) < 120),
    new ButtonBuilder().setCustomId("zb_shop_buy_armor").setLabel("🧱 Armure x1").setStyle(ButtonStyle.Primary).setDisabled((zb.silverCoins || 0) < 260),
    new ButtonBuilder().setCustomId("zb_shop_buy_antidote").setLabel("🧴 Antidote x1").setStyle(ButtonStyle.Primary).setDisabled((zb.silverCoins || 0) < 340)
  );
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row, nav] };
}

function weightedPick(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function getParisDayKey(date = new Date()) {
  // YYYY-MM-DD in Europe/Paris timezone
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function msUntilParisMidnight(date = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);

  const get = t => Number(parts.find(p => p.type === t)?.value || 0);
  const h = get("hour");
  const m = get("minute");
  const s = get("second");
  const elapsed = (h * 3600) + (m * 60) + s;
  const remain = Math.max(1, 86400 - elapsed);
  return remain * 1000;
}

function hasActiveStealWait(userId) {
  const pending = pendingStealsMap.has(userId);
  const cooldownUntil = stealCooldownMap.get(userId) || 0;
  return pending || cooldownUntil > Date.now();
}

function getPoliceCatchChanceForAmount(amount) {
  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw <= POLICE_CURVE_MIN_AMOUNT) return POLICE_CATCH_CHANCE_MIN;

  const clamped = Math.min(raw, POLICE_CURVE_MAX_AMOUNT);
  const minLog = Math.log10(POLICE_CURVE_MIN_AMOUNT);
  const maxLog = Math.log10(POLICE_CURVE_MAX_AMOUNT);
  const t = (Math.log10(clamped) - minLog) / (maxLog - minLog); // 0..1
  const curved = Math.pow(Math.max(0, Math.min(1, t)), POLICE_CURVE_EXPONENT);

  const chance = POLICE_CATCH_CHANCE_MIN + (POLICE_CATCH_CHANCE_MAX - POLICE_CATCH_CHANCE_MIN) * curved;
  return Math.max(POLICE_CATCH_CHANCE_MIN, Math.min(POLICE_CATCH_CHANCE_MAX, chance));
}

function formatPercent(value) {
  return `${(value * 100).toFixed(3).replace(/\.?0+$/, "")}%`;
}

function getStealSuccessChanceForAmount(amount) {
  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw <= STEAL_SUCCESS_CURVE_MIN_AMOUNT) return STEAL_SUCCESS_CHANCE_MAX;

  const clamped = Math.min(raw, STEAL_SUCCESS_CURVE_MAX_AMOUNT);
  const minLog = Math.log10(STEAL_SUCCESS_CURVE_MIN_AMOUNT);
  const maxLog = Math.log10(STEAL_SUCCESS_CURVE_MAX_AMOUNT);
  const t = (Math.log10(clamped) - minLog) / (maxLog - minLog); // 0..1
  const curved = Math.pow(Math.max(0, Math.min(1, t)), STEAL_SUCCESS_CURVE_EXPONENT);
  const chance = STEAL_SUCCESS_CHANCE_MAX - (STEAL_SUCCESS_CHANCE_MAX - STEAL_SUCCESS_CHANCE_MIN) * curved;

  return Math.max(STEAL_SUCCESS_CHANCE_MIN, Math.min(STEAL_SUCCESS_CHANCE_MAX, chance));
}

function getPoliceWaitRemainingMs(userId) {
  const bal = getBalance(userId);
  return Math.max(0, (bal.policeLockUntil || 0) - Date.now());
}

function hasPoliceLock(userId) {
  return getPoliceWaitRemainingMs(userId) > 0;
}

function getPrisonRemainingMs(userId) {
  const bal = getBalance(userId);
  return Math.max(0, (bal.prisonUntil || 0) - Date.now());
}

function isInPrison(userId) {
  return getPrisonRemainingMs(userId) > 0;
}

function sendToPrison(userId, durationMs = PRISON_DURATION_MS) {
  const bal = getBalance(userId);
  const now = Date.now();
  const target = now + durationMs;
  bal.prisonUntil = Math.max(target, bal.prisonUntil || 0);
  saveData();
}

function triggerPoliceLock(userId, durationMs = POLICE_LOCK_MS) {
  const bal = getBalance(userId);
  const now = Date.now();
  bal.policeLockUntil = Math.max(now + durationMs, bal.policeLockUntil || 0);
  saveData();
}

function tryConsumePoliceProtection(userId) {
  const bal = getBalance(userId);
  if ((bal.antiPoliceProtection || 0) <= 0) return false;
  bal.antiPoliceProtection -= 1;
  saveData();
  return true;
}

function formatParisDateTime(ts) {
  try {
    return new Date(ts).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    });
  } catch (e) {
    return "inconnu";
  }
}

function getCyberEntryKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function sanitizeCyberReason(rawReason, fallback = "Aucune raison fournie.") {
  const txt = String(rawReason || "").trim();
  if (!txt) return fallback;
  return txt.slice(0, 300);
}

function parseCyberDurationMs(raw) {
  const input = String(raw || "").trim().toLowerCase();
  if (!input) return null;

  const single = input.match(/^(\d+)\s*(mois|mo|j|h|min|m)$/i);
  if (single) {
    const value = Number(single[1]);
    const unit = single[2].toLowerCase();
    if (!Number.isFinite(value) || value <= 0) return null;
    if (unit === "mois" || unit === "mo") return value * 30 * 24 * 60 * 60 * 1000;
    if (unit === "j") return value * 24 * 60 * 60 * 1000;
    if (unit === "h") return value * 60 * 60 * 1000;
    return value * 60 * 1000;
  }

  if (/^\d+$/.test(input)) {
    const minutes = Number(input);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return minutes * 60 * 1000;
  }

  return null;
}

function getCyberBanEntry(guildId, userId) {
  return cyberSecurityState.bans[getCyberEntryKey(guildId, userId)] || null;
}

function getCyberSilenceEntry(guildId, userId) {
  return cyberSecurityState.silences[getCyberEntryKey(guildId, userId)] || null;
}

function getCyberQuarantineEntry(guildId, userId) {
  return cyberSecurityState.quarantines[getCyberEntryKey(guildId, userId)] || null;
}

function getActiveCyberBansForGuild(guildId) {
  return Object.values(cyberSecurityState.bans || {})
    .filter(entry => entry && entry.guildId === guildId && entry.active);
}

function getActiveCyberSilencesForGuild(guildId) {
  return Object.values(cyberSecurityState.silences || {})
    .filter(entry => entry && entry.guildId === guildId && entry.active);
}

function getActiveCyberQuarantinesForGuild(guildId) {
  return Object.values(cyberSecurityState.quarantines || {})
    .filter(entry => entry && entry.guildId === guildId && entry.active);
}

function getCyberAlertState(guildId) {
  if (!guildId) return null;
  return cyberSecurityState.alerts[guildId] || null;
}

function getCyberAlertProcessingState(guildId) {
  if (!guildId) return null;
  return cyberAlertProcessingMap.get(guildId) || null;
}

function setCyberAlertProcessingState(guildId, action, adminId) {
  if (!guildId) return null;
  const state = { guildId, action, adminId, startedAt: Date.now() };
  cyberAlertProcessingMap.set(guildId, state);
  return state;
}

function clearCyberAlertProcessingState(guildId) {
  if (!guildId) return;
  cyberAlertProcessingMap.delete(guildId);
}

function getCyberAlertProcessingLabel(state) {
  if (!state?.action) return "";
  if (state.action === "warning_off") {
    return "⏳ Fin d'alerte en cours. Les rôles sont en train d'être restaurés.";
  }
  return "⏳ Warning global en cours. Les rôles sont en train d'être appliqués.";
}

function formatCyberUntilLabel(expiresAt) {
  if (!expiresAt) return "Définitif";
  const remaining = Math.max(0, Number(expiresAt) - Date.now());
  if (remaining <= 0) return `Expiré (${formatParisDateTime(expiresAt)})`;
  return `${formatShortDuration(remaining)} (jusqu'au ${formatParisDateTime(expiresAt)})`;
}

function buildCyberSanctionLinesForGuild(guildId, limit = 20) {
  const silences = getActiveCyberSilencesForGuild(guildId).map(entry => ({
    kind: "silence",
    at: Number(entry.createdAt) || 0,
    text:
      `🔇 <@${entry.userId}> - Réduction en silence - ${formatCyberUntilLabel(entry.expiresAt)}`
  }));
  const bans = getActiveCyberBansForGuild(guildId).map(entry => ({
    kind: "ban",
    at: Number(entry.createdAt) || 0,
    text:
      `⛔ <@${entry.userId}> - ${entry.type === "ip" ? "Ban IP simulé" : "Ban"} - ${formatCyberUntilLabel(entry.expiresAt)}`
  }));
  const quarantines = getActiveCyberQuarantinesForGuild(guildId).map(entry => ({
    kind: "quarantine",
    at: Number(entry.createdAt) || 0,
    text:
      `🧱 <@${entry.userId}> - Quarantaine - ${formatCyberUntilLabel(entry.expiresAt)}`
  }));
  const merged = [...silences, ...bans, ...quarantines].sort((a, b) => b.at - a.at);
  return merged.slice(0, Math.max(1, Math.min(50, limit))).map(x => x.text);
}

function getCyberStoredRolesForQuarantine(member, quarantineRole, guildId) {
  const alertState = getCyberAlertState(guildId);
  const alertMemberState = alertState?.active ? alertState.memberStates?.[member.id] || null : null;
  if (alertMemberState) {
    return Array.isArray(alertMemberState.roles) ? [...alertMemberState.roles] : [];
  }
  return member.roles.cache
    .filter(r => r.id !== guildId && r.id !== quarantineRole.id && !r.managed)
    .map(r => r.id);
}

async function getOrCreateQuarantineRole(guild) {
  if (!guild) return null;
  await guild.roles.fetch().catch(() => {});
  let role = guild.roles.cache.find(r => (r.name || "").trim() === CYBER_QUARANTINE_ROLE_NAME);
  if (role) return role;

  role = guild.roles.cache.find(r => CYBER_LEGACY_QUARANTINE_ROLE_NAMES.has((r.name || "").trim().toLowerCase()));
  if (role) {
    const renamedRole = await role.edit({
      name: CYBER_QUARANTINE_ROLE_NAME,
      reason: "Cybersécurité: renommage du rôle de quarantaine"
    }).catch(() => null);
    return renamedRole || role;
  }

  return guild.roles.create({
    name: CYBER_QUARANTINE_ROLE_NAME,
    color: 0x7f8c8d,
    reason: "Cybersécurité: création du rôle de quarantaine"
  }).catch(() => null);
}

async function applyCyberSilence(guild, targetId, adminId, options = {}) {
  const existingEntry = getCyberSilenceEntry(guild.id, targetId);
  if (existingEntry?.active) {
    return { ok: false, error: "Cet utilisateur est déjà réduit en silence." };
  }
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { ok: false, error: "Utilisateur introuvable dans le serveur." };

  const durationMs = Number(options.durationMs || 0);
  if (!Number.isFinite(durationMs) || durationMs < 60 * 1000 || durationMs > CYBER_MAX_SILENCE_DURATION_MS) {
    return { ok: false, error: "Durée invalide pour la réduction en silence." };
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { ok: false, error: "Le bot est introuvable dans le serveur." };
  if (!botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
    return { ok: false, error: "Le bot n'a pas la permission 'Exclure temporairement des membres'." };
  }
  if (!member.moderatable) {
    return { ok: false, error: "Impossible de réduire cet utilisateur en silence (hiérarchie des rôles ou permissions)." };
  }

  const reason = sanitizeCyberReason(options.reason, "Réduction au silence administrateur");
  try {
    await member.timeout(durationMs, `Cybersécurité: réduction en silence par ${adminId} - ${reason}`);
  } catch (e) {
    return { ok: false, error: `Impossible d'appliquer la réduction en silence (${e?.message || e}).` };
  }

  const key = getCyberEntryKey(guild.id, targetId);
  cyberSecurityState.silences[key] = {
    guildId: guild.id,
    userId: targetId,
    reason,
    createdAt: Date.now(),
    expiresAt: Date.now() + durationMs,
    active: true,
    liftedAt: null,
    liftedBy: null
  };
  saveData();
  return { ok: true, expiresAt: Date.now() + durationMs };
}

async function releaseCyberSilence(guild, targetId, adminId, reason = "Réduction en silence levée") {
  const key = getCyberEntryKey(guild.id, targetId);
  const entry = cyberSecurityState.silences[key];
  if (!entry || !entry.active) return { ok: false, error: "Aucune réduction en silence active pour cet utilisateur." };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    entry.active = false;
    entry.liftedAt = Date.now();
    entry.liftedBy = adminId || null;
    saveData();
    return { ok: true, note: "Utilisateur absent du serveur. Réduction en silence marquée comme levée." };
  }
  if (!member.moderatable) {
    return { ok: false, error: "Impossible de retirer la réduction en silence (hiérarchie des rôles ou permissions)." };
  }

  try {
    await member.timeout(null, `${reason} par ${adminId || "système"}`);
  } catch (e) {
    return { ok: false, error: `Impossible de retirer la réduction en silence (${e?.message || e}).` };
  }

  entry.active = false;
  entry.liftedAt = Date.now();
  entry.liftedBy = adminId || null;
  saveData();
  return { ok: true };
}

async function applyCyberQuarantine(guild, targetId, adminId, options = {}) {
  const existingEntry = getCyberQuarantineEntry(guild.id, targetId);
  if (existingEntry?.active) {
    return { ok: false, error: "Cet utilisateur est déjà en quarantaine." };
  }
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return { ok: false, error: "Utilisateur introuvable dans le serveur." };

  const durationMs = Number(options.durationMs || 0);
  if (!Number.isFinite(durationMs) || durationMs < 60 * 1000 || durationMs > CYBER_MAX_QUARANTINE_DURATION_MS) {
    return { ok: false, error: "Durée invalide pour la quarantaine." };
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { ok: false, error: "Le bot est introuvable dans le serveur." };
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { ok: false, error: "Le bot n'a pas la permission 'Gérer les rôles'." };
  }
  if (!member.manageable) return { ok: false, error: "Impossible de gérer cet utilisateur (hiérarchie des rôles)." };

  const quarantineRole = await getOrCreateQuarantineRole(guild);
  if (!quarantineRole) return { ok: false, error: `Impossible de créer/trouver le rôle '${CYBER_QUARANTINE_ROLE_NAME}'.` };
  if (quarantineRole.position >= botMember.roles.highest.position) {
    return { ok: false, error: `Le rôle '${quarantineRole.name}' doit être placé sous le rôle le plus haut du bot.` };
  }

  const managedRoleIds = member.roles.cache.filter(r => r.managed && r.id !== guild.id).map(r => r.id);
  const storedRoles = getCyberStoredRolesForQuarantine(member, quarantineRole, guild.id);

  const newRoleSet = [...new Set([...managedRoleIds, quarantineRole.id])];
  try {
    await member.roles.set(newRoleSet, `Cybersécurité: quarantaine par ${adminId}`);
  } catch (e) {
    return { ok: false, error: `Impossible d'appliquer la quarantaine (${e?.message || e}).` };
  }
  const refreshedMember = await guild.members.fetch(targetId).catch(() => member);
  const isQuarantined = refreshedMember.roles.cache.has(quarantineRole.id);
  if (!isQuarantined) {
    return { ok: false, error: "Le rôle de quarantaine n'a pas pu être appliqué (permissions insuffisantes)." };
  }

  const key = getCyberEntryKey(guild.id, targetId);
  cyberSecurityState.quarantines[key] = {
    guildId: guild.id,
    userId: targetId,
    roles: storedRoles,
    reason: sanitizeCyberReason(options.reason, "Quarantaine administrateur"),
    createdAt: Date.now(),
    expiresAt: Date.now() + durationMs,
    active: true,
    releasedAt: null,
    releasedBy: null
  };
  saveData();
  return { ok: true, roleName: quarantineRole.name, expiresAt: Date.now() + durationMs };
}

async function releaseCyberQuarantine(guild, targetId, adminId, reason = "Quarantaine levée") {
  const key = getCyberEntryKey(guild.id, targetId);
  const entry = cyberSecurityState.quarantines[key];
  if (!entry || !entry.active) return { ok: false, error: "Aucune quarantaine active pour cet utilisateur." };

  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    entry.active = false;
    entry.releasedAt = Date.now();
    entry.releasedBy = adminId || null;
    saveData();
    return { ok: true, note: "Utilisateur absent du serveur. Quarantaine marquée comme levée." };
  }
  if (!member.manageable) return { ok: false, error: "Impossible de restaurer les rôles (hiérarchie des rôles)." };

  await guild.roles.fetch().catch(() => {});
  const alertState = getCyberAlertState(guild.id);
  const alertMemberState = alertState?.active ? alertState.memberStates?.[targetId] || null : null;
  const managedRoleIds = member.roles.cache.filter(r => r.managed && r.id !== guild.id).map(r => r.id);
  let targetRoles = [];

  if (alertMemberState) {
    const quarantineRole = await getOrCreateQuarantineRole(guild);
    if (!quarantineRole) return { ok: false, error: "Impossible de maintenir la quarantaine globale active." };
    targetRoles = [...new Set([...managedRoleIds, quarantineRole.id])];
  } else {
    const restoredRoleIds = Array.isArray(entry.roles)
      ? entry.roles.filter(roleId => guild.roles.cache.has(roleId))
      : [];
    targetRoles = [...new Set([...managedRoleIds, ...restoredRoleIds])];
  }

  try {
    await member.roles.set(targetRoles, `${reason} par ${adminId || "système"}`);
  } catch (e) {
    return { ok: false, error: `Impossible de restaurer les rôles (${e?.message || e}).` };
  }

  entry.active = false;
  entry.releasedAt = Date.now();
  entry.releasedBy = adminId || null;
  saveData();
  return { ok: true, note: alertMemberState ? "Quarantaine individuelle levée, warning global maintenu." : null };
}

async function applyCyberWarningAlert(guild, adminId) {
  const currentAlert = getCyberAlertState(guild.id);
  if (currentAlert?.active) {
    return { ok: false, error: "Une alerte globale est déjà active." };
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { ok: false, error: "Le bot est introuvable dans le serveur." };
  if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { ok: false, error: "Le bot n'a pas la permission 'Gérer les rôles'." };
  }

  const quarantineRole = await getOrCreateQuarantineRole(guild);
  if (!quarantineRole) return { ok: false, error: `Impossible de créer/trouver le rôle '${CYBER_QUARANTINE_ROLE_NAME}'.` };
  if (quarantineRole.position >= botMember.roles.highest.position) {
    return { ok: false, error: `Le rôle '${quarantineRole.name}' doit être placé sous le rôle le plus haut du bot.` };
  }

  await guild.members.fetch().catch(() => {});
  const memberStates = {};
  let affectedCount = 0;
  let skippedExistingCount = 0;
  let skippedSafetyCount = 0;
  let skippedHierarchyCount = 0;
  let failedCount = 0;

  for (const member of guild.members.cache.values()) {
    if (!member || member.id === guild.id) continue;
    if (member.id === ADMIN_ONLY_USER_ID || member.id === zodiClient?.user?.id || member.user?.bot) {
      skippedSafetyCount += 1;
      continue;
    }
    if (member.roles.cache.has(quarantineRole.id) || getCyberQuarantineEntry(guild.id, member.id)?.active) {
      skippedExistingCount += 1;
      continue;
    }
    if (!member.manageable) {
      skippedHierarchyCount += 1;
      continue;
    }

    const managedRoleIds = member.roles.cache.filter(r => r.managed && r.id !== guild.id).map(r => r.id);
    const storedRoles = member.roles.cache
      .filter(r => r.id !== guild.id && r.id !== quarantineRole.id && !r.managed)
      .map(r => r.id);

    try {
      await member.roles.set([...new Set([...managedRoleIds, quarantineRole.id])], `Cybersécurité: warning global par ${adminId}`);
      memberStates[member.id] = { roles: storedRoles };
      affectedCount += 1;
    } catch (e) {
      failedCount += 1;
    }
  }

  if (!affectedCount) {
    return {
      ok: false,
      error: "Aucun membre n'a pu être placé en quarantaine pendant le warning.",
      skippedExistingCount,
      skippedSafetyCount,
      skippedHierarchyCount,
      failedCount
    };
  }

  cyberSecurityState.alerts[guild.id] = {
    guildId: guild.id,
    active: true,
    startedAt: Date.now(),
    startedBy: adminId,
    endedAt: null,
    endedBy: null,
    memberStates
  };
  saveData();
  return { ok: true, affectedCount, skippedExistingCount, skippedSafetyCount, skippedHierarchyCount, failedCount };
}

async function releaseCyberWarningAlert(guild, adminId) {
  const alertState = getCyberAlertState(guild.id);
  if (!alertState?.active) {
    return { ok: false, error: "Aucune alerte globale active." };
  }

  await guild.roles.fetch().catch(() => {});
  let restoredCount = 0;
  let preservedQuarantineCount = 0;
  let missingCount = 0;
  let failedCount = 0;

  for (const [userId, state] of Object.entries(alertState.memberStates || {})) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      missingCount += 1;
      continue;
    }
    if (getCyberQuarantineEntry(guild.id, userId)?.active) {
      preservedQuarantineCount += 1;
      continue;
    }
    if (!member.manageable) {
      failedCount += 1;
      continue;
    }

    const managedRoleIds = member.roles.cache.filter(r => r.managed && r.id !== guild.id).map(r => r.id);
    const restoredRoleIds = Array.isArray(state?.roles)
      ? state.roles.filter(roleId => guild.roles.cache.has(roleId))
      : [];

    try {
      await member.roles.set([...new Set([...managedRoleIds, ...restoredRoleIds])], `Cybersécurité: fin d'alerte par ${adminId || "système"}`);
      restoredCount += 1;
    } catch (e) {
      failedCount += 1;
    }
  }

  alertState.active = false;
  alertState.endedAt = Date.now();
  alertState.endedBy = adminId || null;
  saveData();
  return { ok: true, restoredCount, preservedQuarantineCount, missingCount, failedCount };
}

async function applyCyberBan(guild, targetId, adminId, options = {}) {
  const type = options.type === "ip" ? "ip" : "ban";
  const reason = sanitizeCyberReason(options.reason, type === "ip" ? "Ban IP simulé" : "Ban administrateur");
  const durationMs = Number(options.durationMs || 0);
  const expiresAt = Number.isFinite(durationMs) && durationMs > 0 ? Date.now() + durationMs : null;
  const apiReason = type === "ip" ? `Ban IP simulé: ${reason}` : reason;

  await guild.members.ban(targetId, { reason: apiReason, deleteMessageSeconds: 0 });
  const key = getCyberEntryKey(guild.id, targetId);
  cyberSecurityState.bans[key] = {
    guildId: guild.id,
    userId: targetId,
    type,
    reason,
    createdAt: Date.now(),
    expiresAt,
    active: true,
    liftedAt: null,
    liftedBy: null
  };
  saveData();
  return { ok: true, expiresAt };
}

async function releaseCyberBan(guild, targetId, adminId, reason = "Sanction levée") {
  const key = getCyberEntryKey(guild.id, targetId);
  const entry = cyberSecurityState.bans[key];
  if (!entry || !entry.active) return { ok: false, error: "Aucun ban actif trouvé pour cet utilisateur." };
  try {
    await guild.members.unban(targetId, reason);
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (!/Unknown Ban|10026/i.test(msg)) {
      return { ok: false, error: `Impossible de retirer le ban (${msg || "erreur inconnue"}).` };
    }
  }
  entry.active = false;
  entry.liftedAt = Date.now();
  entry.liftedBy = adminId || null;
  saveData();
  return { ok: true };
}

async function processCyberSecurityTimers() {
  if (!zodiClient?.isReady?.()) return;
  const now = Date.now();
  let dirty = false;

  for (const [key, entry] of Object.entries(cyberSecurityState.silences || {})) {
    if (!entry?.active || !entry.expiresAt || entry.expiresAt > now) continue;
    const guild = zodiClient.guilds.cache.get(entry.guildId) || await zodiClient.guilds.fetch(entry.guildId).catch(() => null);
    if (guild) {
      await releaseCyberSilence(guild, entry.userId, "system", "Fin automatique de la réduction en silence").catch(() => {});
    } else {
      entry.active = false;
      entry.liftedAt = now;
      entry.liftedBy = "system";
      cyberSecurityState.silences[key] = entry;
      dirty = true;
    }
  }

  for (const [key, entry] of Object.entries(cyberSecurityState.bans || {})) {
    if (!entry?.active || !entry.expiresAt || entry.expiresAt > now) continue;
    const guild = zodiClient.guilds.cache.get(entry.guildId) || await zodiClient.guilds.fetch(entry.guildId).catch(() => null);
    if (guild) {
      await guild.members.unban(entry.userId, "Fin automatique du ban temporaire.").catch(() => {});
    }
    entry.active = false;
    entry.liftedAt = now;
    entry.liftedBy = "system";
    cyberSecurityState.bans[key] = entry;
    dirty = true;
  }

  for (const [key, entry] of Object.entries(cyberSecurityState.quarantines || {})) {
    if (!entry?.active || !entry.expiresAt || entry.expiresAt > now) continue;
    const guild = zodiClient.guilds.cache.get(entry.guildId) || await zodiClient.guilds.fetch(entry.guildId).catch(() => null);
    if (guild) {
      await releaseCyberQuarantine(guild, entry.userId, "system", "Fin automatique de la quarantaine").catch(() => {});
    } else {
      entry.active = false;
      entry.releasedAt = now;
      entry.releasedBy = "system";
      cyberSecurityState.quarantines[key] = entry;
      dirty = true;
    }
  }

  if (dirty) saveData();
}

function buildPoliceBlockedView(userId) {
  const remaining = getPoliceWaitRemainingMs(userId);
  const bal = getBalance(userId);
  const canReduce = remaining > 0 && !isInPrison(userId);

  const embed = new EmbedBuilder()
    .setTitle("\ud83d\udc6e Menus de jeux bloques")
    .setDescription(
      `Tu t'es fait attraper par la police.\n` +
      `Temps restant: ${remaining > 0 ? formatShortDuration(remaining) : "Aucun"}\n` +
      `Tu peux payer ${POLICE_REDUCE_PRICE}$ pour reduire de 1h.`
    )
    .addFields(
      { name: "\ud83d\udcb0 Solde total", value: `${(bal.inventory || 0) + (bal.bank || 0)}$`, inline: true },
      { name: "\ud83d\udd39 Reduction", value: "-1h", inline: true }
    )
    .setColor(0xcc0000);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("police_reduce_wait").setLabel(`Payer ${POLICE_REDUCE_PRICE}$ (-1h)`).setStyle(ButtonStyle.Danger).setDisabled(!canReduce),
    new ButtonBuilder().setCustomId("jeu_back").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row] };
}

function buildPrisonBlockedView(userId) {
  const remaining = getPrisonRemainingMs(userId);
  const bal = getBalance(userId);
  const total = (bal.inventory || 0) + (bal.bank || 0);
  const embed = new EmbedBuilder()
    .setTitle("⛓️ Prison")
    .setDescription(
      `Tu es en prison pour dettes.\n` +
      `Temps restant: ${remaining > 0 ? formatShortDuration(remaining) : "Aucun"}\n` +
      `Tu ne peux pas payer pendant la peine.\n` +
      `Seule la calculatrice reste utilisable pour gagner de l'argent.`
    )
    .addFields(
      { name: "💰 Solde total", value: `${total}$`, inline: true },
      { name: "📌 Limite", value: `${PRISON_DEBT_LIMIT}$`, inline: true }
    )
    .setColor(0x8e44ad);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_calcule").setLabel("🧮 Calcul").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("jeu_back").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row] };
}

function isGameInteractionId(customId = "") {
  return customId === "menu_jeux" ||
    customId === "menu_jeux_argent" ||
    customId === "jeu_horoscope" ||
    customId === "horoscope_prediction" ||
    customId === "horoscope_oracle" ||
    customId === "jeu_memocoin" ||
    customId === "jeu_shop" ||
    customId === "shop_traveling_merchant" ||
    customId === "merchant_closed" ||
    customId === "jeu_roulette" ||
    customId === "jeu_casino" ||
    customId === "jeu_blackjack" ||
    customId === "jeu_slotomania" ||
    customId === "roulette_spin" ||
    customId === "casino_play" ||
    customId === "slot_play" ||
    customId.startsWith("blackjack_") ||
    customId === "steal_info" ||
    customId === "steal_select_user" ||
    customId === "steal_execute" ||
    customId === "steal_cancel" ||
    customId === "use_reset_steal_power" ||
    customId === "donate_info" ||
    customId === "donate_select_user" ||
    customId === "donate_execute" ||
    customId === "status_info" ||
    customId === "status_select_user" ||
    customId === "status_classement" ||
    customId === "jeu_calcule" ||
    customId === "jeu_minecraft" ||
    customId === "jeu_pokemon" ||
    customId === "jeu_dongon" ||
    customId === "jeu_apocalipse_zombi" ||
    customId === "inv" ||
    customId === "bank" ||
    customId === "bank_deposit" ||
    customId === "bank_withdraw" ||
    customId === "bank_cancel" ||
    customId.startsWith("bank_convert_") ||
    customId.startsWith("cnum_") ||
    customId.startsWith("cop_") ||
    customId.startsWith("cpar_") ||
    customId === "cback" ||
    customId === "cclear" ||
    customId === "ceval" ||
    customId === "shop_buy_anti_steal" ||
    customId === "shop_buy_police_protection" ||
    customId === "shop_buy_reset_roulette" ||
    customId === "shop_buy_reset_steal" ||
    customId === "shop_buy_reset_slot" ||
    customId === "shop_buy_reset_casino" ||
    customId.startsWith("shop_cat_") ||
    customId.startsWith("merchant_buy_") ||
    customId.startsWith("mm_") ||
    customId.startsWith("mc_") ||
    customId.startsWith("pk_") ||
    customId.startsWith("dg_") ||
    customId.startsWith("zb_");
}

function isPrisonAllowedInteractionId(customId = "") {
  return customId === "jeu_calcule" ||
    customId.startsWith("cnum_") ||
    customId.startsWith("cop_") ||
    customId.startsWith("cpar_") ||
    customId === "cback" ||
    customId === "cclear" ||
    customId === "ceval";
}

function isPrisonRestrictedInteractionId(customId = "") {
  return customId === "bank" ||
    customId === "deposit" ||
    customId === "withdraw" ||
    customId === "valider" ||
    customId === "suppr" ||
    customId.startsWith("num_") ||
    (isGameInteractionId(customId) && !isPrisonAllowedInteractionId(customId));
}

function buildRefreshButton() {
  return new ButtonBuilder().setCustomId("refresh_page").setLabel("\u{1F504} Rafraîchir").setStyle(ButtonStyle.Secondary);
}

function buildMainMenuView() {
  const embed = new EmbedBuilder()
    .setTitle("\u{1F916} Zodi - Menu Principal")
    .setDescription("\u{1F4AC} Discuter avec Zodi\n\u{1F3AE} Jeux");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_zodi_chat").setLabel("\u{1F4AC} Discuter avec Zodi").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F3AE} Jeux").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin_entry").setLabel("\u{1F512} Admin").setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("delete_embed").setLabel("\u{1F5D1}\u{FE0F} Supprimer").setStyle(ButtonStyle.Danger),
    buildRefreshButton()
  );
  return { embed, components: [row, row2] };
}

function buildZodiChatView() {
  const embed = new EmbedBuilder()
    .setTitle("💬 Discuter avec Zodi")
    .setDescription("Zodi répond avec GPT-5.5 quand l'API est disponible, puis avec le modèle local si besoin. Écris simplement ton message.")
    .setColor(0xff9f45)
    .addFields(
      { name: "Utilisation", value: "Clique sur le bouton pour écrire ton message. Les réponses tiennent compte de la date actuelle en Europe/Paris.", inline: false }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("chatgpt_ask").setLabel("💬 Écrire à Zodi").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("back_main").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row] };
}

function buildZodiChatModal(userId, topicId = "free") {
  const modal = new ModalBuilder()
    .setCustomId(`zodi_chat_modal_${userId}_${topicId || "free"}`)
    .setTitle("Discuter avec Zodi");
  const input = new TextInputBuilder()
    .setCustomId("zodi_chat_prompt")
    .setLabel("Écris ton message")
    .setPlaceholder("Écris ce que tu veux dire à Zodi...")
    .setRequired(true)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1200);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}


function serializeEmbedForUi(embed) {
  if (!embed) return null;
  if (typeof embed.toJSON === "function") return embed.toJSON();
  if (embed.data) return embed.data;
  return {
    title: embed.title,
    description: embed.description,
    fields: embed.fields,
    color: embed.color,
    footer: embed.footer
  };
}

function serializeMessageForUi(message) {
  if (!message) return null;
  const embed = message.embeds?.[0] || null;
  const rows = [];
  for (const row of (message.components || [])) {
    const btns = [];
    for (const comp of (row.components || [])) {
      if (comp.type !== ComponentType.Button) continue;
      btns.push({
        type: "button",
        customId: comp.customId,
        label: comp.label || "",
        emoji: comp.emoji?.name || comp.emoji?.id || null,
        style: comp.style || 2,
        disabled: Boolean(comp.disabled)
      });
    }
    if (btns.length) rows.push(btns);
  }
  return { embed: serializeEmbedForUi(embed), components: rows };
}

function serializeComponentsForUi(components) {
  const rows = [];
  for (const row of (components || [])) {
    const rowJson = typeof row?.toJSON === "function" ? row.toJSON() : row;
    const btns = [];
    for (const comp of (rowJson?.components || [])) {
      const type = comp?.type ?? comp?.data?.type;
      if (type === ComponentType.Button) {
        const emoji = comp.emoji?.name || comp.emoji?.id || comp.emoji || null;
        btns.push({
          type: "button",
          customId: comp.custom_id || comp.customId || comp?.data?.custom_id || comp?.data?.customId || "",
          label: comp.label || comp?.data?.label || "",
          emoji,
          style: comp.style || comp?.data?.style || 2,
          disabled: Boolean(comp.disabled ?? comp?.data?.disabled)
        });
      } else if (type === ComponentType.UserSelect) {
        btns.push({
          type: "select",
          selectType: "user",
          customId: comp.custom_id || comp.customId || comp?.data?.custom_id || comp?.data?.customId || "",
          label: comp.placeholder || comp?.data?.placeholder || "Choisir un utilisateur",
          style: 2,
          disabled: Boolean(comp.disabled ?? comp?.data?.disabled)
        });
      } else if (type === ComponentType.StringSelect) {
        const options = comp.options || comp?.data?.options || [];
        if (Array.isArray(options) && options.length) {
          btns.push({
            type: "select",
            selectType: "string",
            customId: comp.custom_id || comp.customId || comp?.data?.custom_id || comp?.data?.customId || "",
            label: comp.placeholder || comp?.data?.placeholder || "Choisir une option",
            style: 2,
            disabled: Boolean(comp.disabled ?? comp?.data?.disabled),
            options: options.map(opt => ({
              label: opt.label || opt?.data?.label || "",
              value: opt.value || opt?.data?.value || ""
            })).filter(opt => opt.label && opt.value)
          });
        }
      }
    }
    if (btns.length) rows.push(btns);
  }
  return rows;
}

function parseUserIdFromInput(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const mention = str.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  const digits = str.match(/^\d{10,20}$/);
  if (digits) return digits[0];
  const embedded = str.match(/(\d{10,20})/);
  return embedded ? embedded[1] : null;
}

async function resolveInteractionGuild(interaction) {
  if (interaction?.guild) return interaction.guild;
  if (interaction?.message?.guild) return interaction.message.guild;
  return await getUiPrimaryGuild();
}

async function ensureUserInInteractionGuild(targetId, interaction) {
  if (!targetId) return { ok: false, error: "Utilisateur invalide." };
  const guild = await resolveInteractionGuild(interaction);
  if (!guild) return { ok: false, error: "Serveur introuvable." };
  let member = guild.members.cache.get(targetId);
  if (!member) {
    member = await guild.members.fetch(targetId).catch(() => null);
  }
  if (!member) return { ok: false, error: "Utilisateur introuvable dans ce serveur." };
  return { ok: true, guild, member };
}

function getSelectedUserIdFromInteraction(interaction) {
  const values = Array.isArray(interaction?.values) ? interaction.values : [];
  const firstValue = String(values[0] || "").trim();
  if (firstValue) return firstValue;

  const selectedUser = interaction?.users?.first?.();
  if (selectedUser?.id) return selectedUser.id;

  const selectedMember = interaction?.members?.first?.();
  if (selectedMember?.user?.id) return selectedMember.user.id;

  const resolvedUsers = interaction?.resolved?.users;
  if (resolvedUsers?.first?.()?.id) return resolvedUsers.first().id;

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isUserInAdminGuild(targetId) {
  if (!targetId) return false;
  if (targetId === ADMIN_ONLY_USER_ID) return true;
  if (!zodiClient?.isReady?.()) return false;
  const cached = uiSelectMemberCache.get(targetId);
  const now = Date.now();
  if (cached && now - cached.ts < 60 * 1000) return cached.ok;
  let ok = false;
  if (uiPrimaryGuildId) {
    const guild = zodiClient.guilds.cache.get(uiPrimaryGuildId) || await zodiClient.guilds.fetch(uiPrimaryGuildId).catch(() => null);
    if (guild) {
      let adminMember = guild.members.cache.get(ADMIN_ONLY_USER_ID);
      if (!adminMember) {
        adminMember = await guild.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
      }
      if (adminMember) {
        let targetMember = guild.members.cache.get(targetId);
        if (!targetMember) {
          targetMember = await guild.members.fetch(targetId).catch(() => null);
        }
        if (targetMember) ok = true;
      }
    }
  } else {
    for (const guild of zodiClient.guilds.cache.values()) {
      let adminMember = guild.members.cache.get(ADMIN_ONLY_USER_ID);
      if (!adminMember) {
        adminMember = await guild.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
      }
      if (!adminMember) continue;
      let targetMember = guild.members.cache.get(targetId);
      if (!targetMember) {
        targetMember = await guild.members.fetch(targetId).catch(() => null);
      }
      if (targetMember) {
        ok = true;
        break;
      }
    }
  }
  uiSelectMemberCache.set(targetId, { ok, ts: now });
  return ok;
}

async function resolveUserIdByName(input) {
  const raw = String(input || "").trim();
  const query = raw.replace(/^@/, "").trim().toLowerCase();
  if (!query) return null;
  const guild = await getUiPrimaryGuild();
  if (!guild) return null;
  let members = [];
  if (typeof guild.members.search === "function") {
    const found = await guild.members.search({ query, limit: 25 }).catch(() => null);
    if (found) members = [...found.values()];
  }
  if (!members.length) {
    await guild.members.fetch({ limit: 100 }).catch(() => null);
    members = [...guild.members.cache.values()];
  }
  members = members.filter(m => !m.user?.bot);
  const matches = members.filter(m => {
    const display = (m.displayName || "").toLowerCase();
    const username = (m.user?.username || "").toLowerCase();
    return display === query || username === query || display.includes(query) || username.includes(query);
  });
  if (!matches.length) return null;
  return matches[0].id;
}

async function getUiPrimaryGuild() {
  if (!zodiClient?.isReady?.()) return null;
  if (uiPrimaryGuildId) {
    const cached = zodiClient.guilds.cache.get(uiPrimaryGuildId);
    if (cached) {
      const adminMember = await cached.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
      if (adminMember) return cached;
    }
  }
  for (const guild of zodiClient.guilds.cache.values()) {
    const adminMember = await guild.members.fetch(ADMIN_ONLY_USER_ID).catch(() => null);
    if (adminMember) {
      uiPrimaryGuildId = guild.id;
      return guild;
    }
  }
  return null;
}

async function getUiPrimaryChannel() {
  if (!uiPrimaryChannelId) return null;
  if (!zodiClient?.isReady?.()) return null;
  const channel = await zodiClient.channels.fetch(uiPrimaryChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return null;
  const guild = channel.guild || (uiPrimaryGuildId ? zodiClient.guilds.cache.get(uiPrimaryGuildId) : null);
  const me = guild?.members?.me || (guild ? await guild.members.fetch(zodiClient.user.id).catch(() => null) : null);
  if (me && channel.permissionsFor?.(me)?.has(PermissionsBitField.Flags.SendMessages)) {
    return channel;
  }
  return null;
}

async function resolveUserDisplayName(userId) {
  if (!userId) return "utilisateur";
  const cached = uiUserNameCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.ts < 10 * 60 * 1000) return cached.name;
  let name = null;
  try {
    const guild = await getUiPrimaryGuild();
    if (guild) {
      let member = guild.members.cache.get(userId);
      if (!member) {
        member = await guild.members.fetch(userId).catch(() => null);
      }
      if (member) name = member.displayName || member.user?.username || null;
    }
    if (!name && zodiClient?.users) {
      const user = zodiClient.users.cache.get(userId) || await zodiClient.users.fetch(userId).catch(() => null);
      if (user) name = user.username || null;
    }
  } catch (e) {}
  if (!name) name = "utilisateur";
  uiUserNameCache.set(userId, { name, ts: now });
  return name;
}

function presenceStatusEmoji(status) {
  if (status === "online") return "🟢";
  if (status === "idle") return "🟡";
  if (status === "dnd") return "🔴";
  return "⚫";
}

function buildPresenceSummaryPages(members) {
  const grouped = { online: [], idle: [], dnd: [], offline: [] };
  for (const member of members) {
    const status = member.presence?.status || "offline";
    const emoji = presenceStatusEmoji(status);
    const name = member.displayName || member.user?.username || member.user?.tag || member.id;
    if (!grouped[status]) grouped[status] = [];
    grouped[status].push(`${emoji} ${name}`);
  }
  const sections = [];
  const order = [
    { key: "online", label: "En ligne" },
    { key: "idle", label: "Inactif" },
    { key: "dnd", label: "Ne pas déranger" },
    { key: "offline", label: "Hors ligne" }
  ];
  for (const entry of order) {
    const list = grouped[entry.key] || [];
    if (!list.length) continue;
    sections.push(`**${entry.label} (${list.length})**`);
    sections.push(...list.map(v => `• ${v}`));
  }
  if (!sections.length) sections.push("Aucun membre trouvé.");

  const pages = [];
  let buffer = [];
  let currentLength = 0;
  const pushPage = () => {
    const description = buffer.join("\n");
    const embed = new EmbedBuilder()
      .setTitle("📡 Suivi des présences")
      .setColor(0x3498db)
      .setDescription(description)
      .setTimestamp();
    pages.push(embed);
    buffer = [];
    currentLength = 0;
  };

  for (const line of sections) {
    if (currentLength + line.length + 1 > 3500 && buffer.length) {
      pushPage();
    }
    buffer.push(line);
    currentLength += line.length + 1;
  }
  if (buffer.length) pushPage();
  return pages;
}

async function formatTextMentions(text, options = {}) {
  const prefix = options.prefix ? "@" : "";
  const str = String(text || "");
  const ids = new Set();
  str.replace(/<@!?(\d+)>|@(\d{10,20})/g, (_m, id1, id2) => {
    const id = id1 || id2;
    if (id) ids.add(id);
    return "";
  });
  if (!ids.size) return str;
  const map = new Map();
  for (const id of ids) {
    const name = await resolveUserDisplayName(id);
    map.set(id, name);
  }
  return str.replace(/<@!?(\d+)>|@(\d{10,20})/g, (_m, id1, id2) => {
    const id = id1 || id2;
    const name = map.get(id) || "utilisateur";
    return prefix ? `${prefix}${name}` : `${name}`;
  });
}

async function formatLogTextForUi(text) {
  return formatTextMentions(text, { prefix: "@" });
}

async function formatEmbedJsonMentions(embedJson, options = {}) {
  if (!embedJson || typeof embedJson !== "object") return embedJson;
  const prefix = options.prefix ? "@" : "";
  const out = { ...embedJson };
  if (typeof out.title === "string") out.title = await formatTextMentions(out.title, { prefix });
  if (typeof out.description === "string") out.description = await formatTextMentions(out.description, { prefix });
  if (out.footer?.text) {
    out.footer = { ...out.footer, text: await formatTextMentions(out.footer.text, { prefix }) };
  }
  if (out.author?.name) {
    out.author = { ...out.author, name: await formatTextMentions(out.author.name, { prefix }) };
  }
  if (Array.isArray(out.fields)) {
    out.fields = await Promise.all(out.fields.map(async field => {
      const next = { ...field };
      if (typeof next.name === "string") next.name = await formatTextMentions(next.name, { prefix });
      if (typeof next.value === "string") next.value = await formatTextMentions(next.value, { prefix });
      return next;
    }));
  }
  return out;
}

async function serializeEmbedForUiWithNames(embed) {
  const json = serializeEmbedForUi(embed);
  return formatEmbedJsonMentions(json, { prefix: "" });
}

async function serializeMessageForUiWithNames(message) {
  const base = serializeMessageForUi(message);
  if (base?.embed) {
    base.embed = await formatEmbedJsonMentions(base.embed, { prefix: "" });
  }
  return base;
}

function ensureLocalUiState() {
  if (uiLocalState) return;
  const view = buildMainMenuView();
  uiLocalState = { embed: view.embed, components: view.components };
}

function updateLocalUiState(options) {
  if (!uiLocalState) uiLocalState = { embed: null, components: [] };
  if (Array.isArray(options?.embeds) && options.embeds.length) {
    uiLocalState.embed = options.embeds[0];
  }
  if (Array.isArray(options?.components)) {
    uiLocalState.components = options.components;
  }
}

function serializeLocalUiState() {
  if (!uiLocalState) return null;
  return {
    embed: serializeEmbedForUi(uiLocalState.embed),
    components: serializeComponentsForUi(uiLocalState.components)
  };
}

function createLocalUiChannel() {
  return {
    id: uiPrimaryChannelId || "local-ui",
    isTextBased: () => true,
    send: async (options) => {
      const text = extractReplyText(options);
      const actions = extractActionRowsFromOptions(options);
      if (text || actions) addActionLog(ADMIN_ONLY_USER_ID, text || "Actions disponibles.", actions);
      if (uiPrimaryChannelId) {
        try {
          const channel = await getUiPrimaryChannel();
          if (channel) {
            await channel.send(options).catch(() => {});
          }
        } catch (e) {}
      }
      return {
        id: `local-ui-${Date.now()}`,
        channelId: uiPrimaryChannelId || "local-ui",
        embeds: options?.embeds || [],
        components: options?.components || []
      };
    }
  };
}

function createLocalUiMessage() {
  ensureLocalUiState();
  const channel = createLocalUiChannel();
  return {
    id: "local-ui-message",
    channel,
    channelId: channel.id,
    guild: null,
    embeds: uiLocalState?.embed ? [uiLocalState.embed] : [],
    components: uiLocalState?.components || [],
    edit: async (options) => {
      updateLocalUiState(options);
      return createLocalUiMessage();
    },
    delete: async () => {
      uiLocalState = null;
      return null;
    }
  };
}

function extractReplyText(options) {
  if (!options) return "";
  if (typeof options === "string") return options;
  if (typeof options.content === "string" && options.content.trim()) return options.content.trim();
  const embeds = options.embeds || [];
  if (embeds.length) {
    const e = embeds[0];
    const title = e.title || e.data?.title || "";
    const desc = e.description || e.data?.description || "";
    const fields = e.fields || e.data?.fields || [];
    const fieldLines = [];
    for (const f of fields.slice(0, 3)) {
      if (!f?.name && !f?.value) continue;
      const name = f.name ? `${f.name}` : "";
      const value = f.value ? `${f.value}` : "";
      const line = [name, value].filter(Boolean).join(": ");
      if (line) fieldLines.push(line);
    }
    if (fields.length > 3) fieldLines.push("…");
    const combined = [title, desc, ...fieldLines].filter(Boolean).join(" — ");
    return combined.trim();
  }
  return "";
}

function extractActionRowsFromOptions(options) {
  if (!options) return null;
  const rows = serializeComponentsForUi(options.components || []);
  return rows.length ? rows : null;
}

function extractActionRowsFromMessage(message) {
  if (!message) return null;
  const rows = serializeComponentsForUi(message.components || []);
  return rows.length ? rows : null;
}

function serializeModalForUi(modal) {
  if (!modal) return null;
  const json = typeof modal.toJSON === "function" ? modal.toJSON() : modal;
  if (!json) return null;
  const inputs = [];
  for (const row of (json.components || [])) {
    for (const comp of (row.components || [])) {
      inputs.push({
        id: comp.custom_id || comp.customId,
        label: comp.label || "Champ",
        placeholder: comp.placeholder || "",
        required: comp.required !== false
      });
    }
  }
  return {
    customId: json.custom_id || json.customId || "",
    title: json.title || "Formulaire",
    inputs
  };
}

function isModalTriggerCustomId(customId) {
  if (!customId) return false;
  if (customId === "chatgpt_ask") return true;
  if (customId === "menu_zodi_chat") return true;
  if (customId === "menu_chatgpt") return true;
  if (customId.startsWith("zodi_chat_topic_")) return true;
  if (customId === "donate_execute") return true;
  if (customId === "steal_execute") return true;
  if (customId === "cyber_ban_temp") return true;
  if (customId === "cyber_silence_on") return true;
  if (customId === "cyber_quarantine_on") return true;
  if (customId === "cyber_unban_by_id") return true;
  if (customId.startsWith("bank_convert_")) return true;
  if (customId.startsWith("merchant_buy_")) return true;
  if (customId.startsWith("shop_buy_reset_")) return true;
  if (customId.startsWith("mc_shop_buy_")) return true;
  if (customId.startsWith("pk_shop_buy_")) return true;
  if (customId.startsWith("dg_shop_buy_")) return true;
  if (customId.startsWith("zb_shop_buy_")) return true;
  if (customId.startsWith("mm_shop_buy_")) return true;
  if (customId.startsWith("memocoin_") && customId !== "memocoin_select_user") return true;
  return false;
}

function showQuantityModal(interaction, customId, inputId, title = "Quantité à acheter", placeholder = "1-999") {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId(inputId)
    .setLabel("Quantité")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

function getShopItemByCustomId(customId) {
  if (customId === "shop_buy_reset_slot") return { id: "reset_slot", price: 34500, label: "Reset Slotomania" };
  if (customId === "shop_buy_reset_casino") return { id: "reset_casino", price: 34500, label: "Reset Casino" };
  if (customId === "shop_buy_reset_steal") return { id: "reset_steal", price: 45000, label: "Reset vol" };
  if (customId === "shop_buy_anti_steal") return { id: "anti_steal", price: 150000, label: "Protection de vol" };
  if (customId === "shop_buy_police_protection") return { id: "police_protection", price: SHOP_PRICE_POLICE_PROTECTION, label: "Protection anti-police" };
  if (customId === "shop_buy_reset_roulette") return { id: "reset_roulette", price: 755000, label: "Reset roulette" };
  return null;
}

function applyShopPurchase(bal, shopItemId, qty) {
  let purchaseText = "";
  if (shopItemId === "reset_slot") {
    bal.resetSlotPower += qty;
    purchaseText = `Pouvoir reset attente Slotomania ajouté x${qty}.`;
  } else if (shopItemId === "reset_casino") {
    bal.resetCasinoPower += qty;
    purchaseText = `Pouvoir reset attente Casino ajouté x${qty}.`;
  } else if (shopItemId === "anti_steal") {
    bal.antiStealProtection += qty;
    purchaseText = `Protection de vol ajoutée x${qty}.`;
  } else if (shopItemId === "police_protection") {
    bal.antiPoliceProtection = (bal.antiPoliceProtection || 0) + qty;
    purchaseText = `Protection contre la police ajoutée x${qty}.`;
  } else if (shopItemId === "reset_roulette") {
    bal.resetRoulettePower += qty;
    purchaseText = `Pouvoir reset attente roulette ajouté x${qty}.`;
  } else {
    bal.resetStealPower += qty;
    purchaseText = `Pouvoir reset attente vol ajouté x${qty}.`;
  }
  return purchaseText;
}

function isAdminUser(userId) {
  return userId === ADMIN_ONLY_USER_ID;
}

function buildAdminMaintenanceButtons() {
  return [
    new ButtonBuilder()
      .setCustomId("admin_maintenance_on")
      .setLabel("🛠️ Activer la maintenance")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(maintenanceModeEnabled),
    new ButtonBuilder()
      .setCustomId("admin_maintenance_off")
      .setLabel("🟢 Arrêter la maintenance")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!maintenanceModeEnabled)
  ];
}

function getMessageCustomIds(message) {
  try {
    const ids = new Set();
    const rows = message?.components || [];
    for (const row of rows) {
      for (const c of (row.components || [])) {
        if (c?.customId) ids.add(c.customId);
      }
    }
    return ids;
  } catch (e) {
    return new Set();
  }
}

function silentInteraction(interaction) {
  return interaction.deferUpdate().catch(() => {});
}

function formatMemocoinDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return "0";
  return delta > 0 ? `+${delta}` : `${delta}`;
}

async function sendMoneyGameResultMessage(channel, userId, gameLabel, delta, cooldownUntil, extraResultText = "") {
  try {
    if (!channel) return;
    const waitMs = Math.max(1, (cooldownUntil || 0) - Date.now());
    const amountLabel = formatMemocoinDelta(delta).replace("+", "");
    const extra = String(extraResultText || "").trim();
    const isLossText = /perdu|perte|échec/i.test(extra);
    const isWinText = /gain|gagne|bonus|reset|protection/i.test(extra);

    let outcome = "joue";
    if (delta > 0) outcome = "gagne";
    else if (delta < 0) outcome = "perdu";
    else if (isWinText) outcome = "gagne";
    else if (isLossText) outcome = "perdu";

    let rewardText = "Aucune";
    if (extra) {
      rewardText = extra.replace(/[🎉💸❌🛡️]/g, "").trim();
    } else if (delta > 0) {
      rewardText = `+${amountLabel} Memocoins`;
    } else if (delta < 0) {
      rewardText = `-${amountLabel} Memocoins`;
    }
    const lossCase = delta < 0 || isLossText;
    const rewardLabel = lossCase ? "💸 Perte" : "🎁 Récompense";

    await channel.send(
      `🎮 <@${userId}> a ${outcome} sur ${gameLabel}.\n` +
      `${rewardLabel}: ${rewardText}\n` +
      `⏱️ Attente: ${formatShortDuration(waitMs)} (jusqu'a ${formatRetryClock(cooldownUntil)}).`
    );
  } catch (e) {
    console.error("sendMoneyGameResultMessage error:", e);
  }
}

async function sendBlackjackResultMessage(channel, userId, result) {
  try {
    if (!channel || !result) return;
    if (result.kind === "session") {
      await channel.send(
        `🃏 <@${userId}> termine sa session de Blackjack.\n` +
        `🎟️ Jetons finaux: ${formatBlackjackChips(result.finalChips)}.\n` +
        `🏦 Règlement: ${formatMemocoinDelta(result.settlementAmount)} Memocoins.\n` +
        `💹 Bilan session: ${formatMemocoinDelta(result.sessionNetDelta)} Memocoins.` +
        (result.sentToPrison ? `\n⛓️ Solde insuffisant: prison immédiate.` : "")
      );
      return;
    }
    await channel.send(
      `🃏 <@${userId}> termine une main de Blackjack.\n` +
      `🎯 Résultat: ${result.message}\n` +
      `🎟️ Variation: ${formatBlackjackChipDelta(result.deltaChips)} jetons.\n` +
      `🏦 Cagnotte: ${formatBlackjackChips(result.chipsAfter)} jetons.`
    );
  } catch (e) {
    console.error("sendBlackjackResultMessage error:", e);
  }
}

async function sendPowerUsedMessage(channel, userId, powerLabel, remainingCount = null) {
  try {
    if (!channel) return;
    const remainingText = remainingCount === null ? "" : ` (restant: ${remainingCount})`;
    await channel.send(`⚡ <@${userId}> a utilisé ${powerLabel}${remainingText}.`);
  } catch (e) {
    console.error("sendPowerUsedMessage error:", e);
  }
}

function buildAdminMenuView() {
  const embed = new EmbedBuilder()
    .setTitle("\u{1F6E0}\u{FE0F} Zodi - Menu Admin")
    .setColor(0xff0000)
    .setDescription("Commandes avancees :");

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_memocoin").setLabel("\u{1F4B0} Give Objet").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("admin_reset").setLabel("\u{1F504} Réinitialiser").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_bot_powers").setLabel("\u26A1 Pouvoirs du bot").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin_prison").setLabel("⛓️ STOP prison").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_debt").setLabel("💳 Dette").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin_cybersecurity").setLabel("🛡️ Cybersécurité").setStyle(ButtonStyle.Primary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_stop_bot").setLabel("\u23F9 Arr\u00eater le bot").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("admin_restart_bot").setLabel("\u{1F504} Redémarrer le bot").setStyle(ButtonStyle.Primary),
    ...buildAdminMaintenanceButtons()
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back_main").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton(),
  );

  return { embed, components: [row1, row2, row3, row4] };
}

function buildBotPowersEmbed() {
  return new EmbedBuilder()
    .setTitle("\u26A1 Pouvoirs du bot")
    .setColor(0x2ecc71)
    .setDescription("Actions admin disponibles.")
    .setTimestamp();
}

function formatBotPresenceLabel(status) {
  if (status === "online") return "🟢 En ligne";
  if (status === "idle") return "🟡 Inactif";
  if (status === "dnd") return "🔴 Ne pas déranger";
  if (status === "invisible") return "⚫ Hors ligne";
  return "⚫ Hors ligne";
}

function buildBotStatusView(statusText = null) {
  const currentStatus = zodiClient?.user?.presence?.status || "online";
  const embed = new EmbedBuilder()
    .setTitle("🟢 Statut du bot")
    .setColor(0x4cc2ff)
    .setDescription(
      `Statut actuel: **${formatBotPresenceLabel(currentStatus)}**` +
      (statusText ? `\n${statusText}` : "")
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bot_status_online").setLabel("🟢 En ligne").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("bot_status_idle").setLabel("🟡 Inactif").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("bot_status_dnd").setLabel("🔴 Ne pas déranger").setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bot_status_offline").setLabel("⚫ Hors ligne").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin_bot_powers").setLabel("🔙 Retour").setStyle(ButtonStyle.Primary),
    buildRefreshButton()
  );
  return { embed, components: [row1, row2] };
}

function buildPresencePayload(status) {
  const activityName = String(process.env.BOT_ACTIVITY_NAME || ZODI_DEFAULT_ACTIVITY_NAME).trim() || ZODI_DEFAULT_ACTIVITY_NAME;
  return {
    status,
    activities: [{ name: activityName, type: ActivityType.Playing }]
  };
}

function buildBotPowersView() {
  const embed = buildBotPowersEmbed();
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_presence").setLabel("\u{1F4E1} Suivi Présence").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin_bot_status").setLabel("🟢 Statut").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin_purge_messages").setLabel("\u{1F9F9} Supprimer tous les messages").setStyle(ButtonStyle.Danger)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back_admin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row1, row2] };
}

function buildAdminPrisonView(targetId = null, statusText = null) {
  const hasTarget = Boolean(targetId);
  let remainingLabel = "Aucun";
  let inPrison = false;
  if (hasTarget) {
    const remaining = getPrisonRemainingMs(targetId);
    inPrison = remaining > 0;
    remainingLabel = inPrison ? formatShortDuration(remaining) : "Aucun";
  }

  const embed = new EmbedBuilder()
    .setTitle("⛓️ STOP prison")
    .setColor(0x8e44ad)
    .setDescription(
      hasTarget
        ? `Cible actuelle: <@${targetId}>.\nStatut: ${inPrison ? "⛓️ En prison" : "✅ Pas en prison"}.${statusText ? `\n${statusText}` : ""}`
        : "Sélectionne un utilisateur puis choisis l'action."
    )
    .addFields(
      { name: "⏱️ Temps restant", value: remainingLabel, inline: true }
    );

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("prison_select_user")
    .setPlaceholder("Choisir un utilisateur...")
    .setMinValues(1)
    .setMaxValues(1);

  const row1 = new ActionRowBuilder().addComponents(userSelect);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("prison_release").setLabel("🟢 Libérer").setStyle(ButtonStyle.Success).setDisabled(!hasTarget || !inPrison)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back_admin").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2, row3] };
}

function buildAdminDebtView(statusText = null) {
  const modeLabel = debtModeEnabled
    ? `✅ Activé (${PRISON_DEBT_LIMIT}$)`
    : "⛔ Désactivé (solde minimum: 0$)";

  const embed = new EmbedBuilder()
    .setTitle("💳 Réglage dette")
    .setColor(debtModeEnabled ? 0x2ecc71 : 0xe67e22)
    .setDescription(
      `Statut actuel: ${modeLabel}\n` +
      "Ce réglage s'applique à tous les joueurs." +
      (statusText ? `\n${statusText}` : "")
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin_debt_enable").setLabel("🟢 Activer les dettes").setStyle(ButtonStyle.Success).setDisabled(debtModeEnabled),
    new ButtonBuilder().setCustomId("admin_debt_disable").setLabel("🔴 Désactiver les dettes").setStyle(ButtonStyle.Danger).setDisabled(!debtModeEnabled)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back_admin").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row1, row2] };
}

function buildAdminCybersecurityView(targetId = null, statusText = null, guildId = null) {
  const hasTarget = Boolean(targetId);
  const banEntry = hasTarget && guildId ? getCyberBanEntry(guildId, targetId) : null;
  const silenceEntry = hasTarget && guildId ? getCyberSilenceEntry(guildId, targetId) : null;
  const quarantineEntry = hasTarget && guildId ? getCyberQuarantineEntry(guildId, targetId) : null;
  const banActive = Boolean(banEntry?.active);
  const silenceActive = Boolean(silenceEntry?.active);
  const quarantineActive = Boolean(quarantineEntry?.active);
  const alertState = guildId ? getCyberAlertState(guildId) : null;
  const alertActive = Boolean(alertState?.active);
  const processingState = guildId ? getCyberAlertProcessingState(guildId) : null;
  const isProcessing = Boolean(processingState);
  const activeBanCount = guildId ? getActiveCyberBansForGuild(guildId).length : 0;
  const activeSilenceCount = guildId ? getActiveCyberSilencesForGuild(guildId).length : 0;
  const activeQuarantineCount = guildId ? getActiveCyberQuarantinesForGuild(guildId).length : 0;

  let targetLine = "Sélectionne un utilisateur puis choisis une action.";
  if (hasTarget) {
    const silenceLine = silenceActive
      ? `🔇 Silence actif: ${formatCyberUntilLabel(silenceEntry.expiresAt)}.`
      : "✅ Aucun silence actif.";
    const banLine = banActive
      ? `⛔ Ban actif: ${banEntry.type === "ip" ? "Ban IP simulé" : "Ban"} (${formatCyberUntilLabel(banEntry.expiresAt)}).`
      : "✅ Aucun ban actif.";
    const quarantineLine = quarantineActive
      ? `🧱 Quarantaine active: ${formatCyberUntilLabel(quarantineEntry.expiresAt)}.`
      : "✅ Aucune quarantaine active.";
    targetLine = `Cible actuelle: <@${targetId}>.\n${silenceLine}\n${banLine}\n${quarantineLine}`;
  }

  const alertLine = alertActive
    ? `🌋 Warning actif: ${Object.keys(alertState?.memberStates || {}).length} membre(s) placés en quarantaine globale.`
    : "📢 Aucune alerte globale active.";
  const processingLine = isProcessing ? getCyberAlertProcessingLabel(processingState) : "";

  const embed = new EmbedBuilder()
    .setTitle("🛡️ Cybersécurité")
    .setColor(0x0f4c81)
    .setDescription(
      `${targetLine}\n` +
      `${alertLine}\n` +
      `${processingLine ? `${processingLine}\n` : ""}` +
      "⚠️ Ban IP: Discord ne fournit pas d'IP. Cette option applique un ban classique avec suivi renforcé." +
      (statusText ? `\n${statusText}` : "")
    )
    .addFields(
      { name: "📊 Silences actifs", value: `${activeSilenceCount}`, inline: true },
      { name: "📊 Bans actifs (serveur)", value: `${activeBanCount}`, inline: true },
      { name: "📊 Quarantaines actives", value: `${activeQuarantineCount}`, inline: true }
    );

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("cyber_select_user")
    .setPlaceholder("Choisir un utilisateur...")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(isProcessing);

  const row1 = new ActionRowBuilder().addComponents(userSelect);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cyber_silence_on").setLabel("🔇 Réduire en silence").setStyle(ButtonStyle.Secondary).setDisabled(isProcessing || !hasTarget || silenceActive),
    new ButtonBuilder().setCustomId("cyber_ban_temp").setLabel("⏳ Ban temporaire").setStyle(ButtonStyle.Danger).setDisabled(isProcessing || !hasTarget),
    new ButtonBuilder().setCustomId("cyber_ban_perm").setLabel("⛔ Ban définitif").setStyle(ButtonStyle.Danger).setDisabled(isProcessing || !hasTarget),
    new ButtonBuilder().setCustomId("cyber_ban_ip").setLabel("🌐 Ban IP").setStyle(ButtonStyle.Danger).setDisabled(isProcessing || !hasTarget)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cyber_quarantine_on").setLabel("🧱 Mise en quarantaine").setStyle(ButtonStyle.Secondary).setDisabled(isProcessing || !hasTarget || quarantineActive),
    new ButtonBuilder().setCustomId("cyber_quarantine_off").setLabel("🟢 Retirer quarantaine").setStyle(ButtonStyle.Success).setDisabled(isProcessing || !hasTarget || !quarantineActive),
    new ButtonBuilder().setCustomId("cyber_list_sanctions").setLabel("📜 Voir sanctions").setStyle(ButtonStyle.Primary).setDisabled(isProcessing)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cyber_unban_selected").setLabel("🔓 Retirer sanctions").setStyle(ButtonStyle.Success).setDisabled(isProcessing || !hasTarget || (!banActive && !silenceActive && !quarantineActive)),
    new ButtonBuilder().setCustomId("cyber_warning_on").setLabel("🌋 Warning").setStyle(ButtonStyle.Danger).setDisabled(isProcessing || alertActive),
    new ButtonBuilder().setCustomId("cyber_warning_off").setLabel("📢 Fin d'alerte").setStyle(ButtonStyle.Primary).setDisabled(isProcessing || !alertActive)
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back_admin").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2, row3, row4, row5] };
}

function buildAdminResetView(targetId = null, statusText = null) {
  const hasTarget = Boolean(targetId);
  const embed = new EmbedBuilder()
    .setTitle("\u{1F504} Réinitialiser")
    .setColor(0x3399ff)
    .setDescription(
      hasTarget
        ? `Cible actuelle: <@${targetId}>.\nChoisis le reset à appliquer.${statusText ? `\n${statusText}` : ""}`
        : "Sélectionne un utilisateur puis choisis le reset à appliquer."
    );

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("reset_select_user")
    .setPlaceholder("Choisir un utilisateur...")
    .setMinValues(1)
    .setMaxValues(1);

  const row1 = new ActionRowBuilder().addComponents(userSelect);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("reset_steal_wait").setLabel("\u26A1 Reset attente vol").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_roulette_wait").setLabel("\u26A1 Reset attente roulette").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_casino_wait").setLabel("\u26A1 Reset attente casino").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_slot_wait").setLabel("\u26A1 Reset attente Slotomania").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("reset_police_wait").setLabel("\ud83d\udc6e Reset attente police").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_game_menu").setLabel("🎮 Réinitialiser jeux").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_inventory").setLabel("\u{1F9F9} Reset inventaire").setStyle(ButtonStyle.Danger).setDisabled(!hasTarget)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back_admin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton(),
  );

  return { embed, components: [row1, row2, row3, row4] };
}

function buildAdminResetGamesView(targetId = null, statusText = null) {
  const hasTarget = Boolean(targetId);
  const embed = new EmbedBuilder()
    .setTitle("🎮 Réinitialiser jeux")
    .setColor(0x3498db)
    .setDescription(
      hasTarget
        ? `Cible actuelle: <@${targetId}>.\nChoisis le jeu à réinitialiser.${statusText ? `\n${statusText}` : ""}`
        : "Sélectionne un utilisateur dans Réinitialiser puis reviens ici."
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("reset_game_mc").setLabel("🌍 Minecraft").setStyle(ButtonStyle.Success).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_game_pk").setLabel("🌎 Pokémon").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_game_dg").setLabel("🧨 Donjon").setStyle(ButtonStyle.Primary).setDisabled(!hasTarget),
    new ButtonBuilder().setCustomId("reset_game_zb").setLabel("🧟 Apocalypse zombie").setStyle(ButtonStyle.Danger).setDisabled(!hasTarget)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("reset_game_all").setLabel("♻️ Tout réinitialiser (jeux)").setStyle(ButtonStyle.Danger).setDisabled(!hasTarget)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("reset_game_back").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2, row3] };
}

function buildGlobalClassementEmbed(limit = 20) {
  const entries = [...memocoinData.entries()]
    .map(([uid, bal]) => {
      const inventory = Number(bal?.inventory || 0);
      const bank = Number(bal?.bank || 0);
      return { uid, inventory, bank, total: inventory + bank };
    })
    .sort((a, b) => b.total - a.total);

  const top = entries.slice(0, Math.max(1, Math.min(50, limit)));
  const lines = top.map((x, idx) => `${idx + 1}. <@${x.uid}> - Total: ${x.total} (Inv: ${x.inventory} | Banque: ${x.bank})`);

  return new EmbedBuilder()
    .setTitle("\u{1F3C6} Classement global")
    .setColor(0xf1c40f)
    .setDescription(lines.length ? lines.join("\n") : "Aucune donnée disponible.")
    .setFooter({ text: `Joueurs classes: ${entries.length}` })
    .setTimestamp();
}

function buildStealControlComponents(userId) {
  const hasTarget = stealSelectionMap.has(userId);
  const bal = getBalance(userId);
  const hasPendingSteal = pendingStealsMap.has(userId);
  const canUseStealReset = (bal.resetStealPower || 0) > 0 && hasActiveStealWait(userId);
  const canExecuteSteal = hasTarget && !hasPendingSteal && !hasActiveStealWait(userId) && !hasPoliceLock(userId);
  const canCancelSteal = hasPendingSteal;

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId("steal_select_user")
    .setPlaceholder("Choisir une victime...")
    .setMinValues(1)
    .setMaxValues(1);

  const row1 = new ActionRowBuilder().addComponents(userSelect);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("steal_execute").setLabel("\u{1F5E1}\u{FE0F} Voler").setStyle(ButtonStyle.Danger).setDisabled(!canExecuteSteal),
    new ButtonBuilder().setCustomId("use_reset_steal_power").setLabel("\u{26A1} Utiliser un reset de vol").setStyle(ButtonStyle.Primary).setDisabled(!canUseStealReset),
    new ButtonBuilder().setCustomId("steal_cancel").setLabel("\u274C Annuler le vol").setStyle(ButtonStyle.Secondary).setDisabled(!canCancelSteal)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return [row1, row2, row3];
}

function isRouletteOwner(interaction) {
  const messageId = interaction.message?.id;
  if (!messageId) return true;
  const currentOwner = rouletteOwnerMap.get(messageId);
  if (!currentOwner) {
    rouletteOwnerMap.set(messageId, interaction.user.id);
    return true;
  }
  return currentOwner === interaction.user.id;
}

function isCasinoOwner(interaction) {
  const messageId = interaction.message?.id;
  if (!messageId) return true;
  const currentOwner = casinoOwnerMap.get(messageId);
  if (!currentOwner) {
    casinoOwnerMap.set(messageId, interaction.user.id);
    return true;
  }
  return currentOwner === interaction.user.id;
}

function isSlotOwner(interaction) {
  const messageId = interaction.message?.id;
  if (!messageId) return true;
  const currentOwner = slotOwnerMap.get(messageId);
  if (!currentOwner) {
    slotOwnerMap.set(messageId, interaction.user.id);
    return true;
  }
  return currentOwner === interaction.user.id;
}

function isBlackjackOwner(interaction) {
  const messageId = interaction.message?.id;
  if (!messageId) return true;
  const currentOwner = blackjackOwnerMap.get(messageId);
  if (!currentOwner) {
    blackjackOwnerMap.set(messageId, interaction.user.id);
    return true;
  }
  return currentOwner === interaction.user.id;
}

function getDefaultBlackjackState() {
  return {
    sessionActive: false,
    active: false,
    bet: 0,
    chips: 0,
    deck: [],
    playerHand: [],
    dealerHand: [],
    handsPlayed: 0,
    lastResult: null,
    lastSettlement: null
  };
}

function normalizeBlackjackChipValue(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 2) / 2;
}

function formatBlackjackChips(value) {
  const normalized = normalizeBlackjackChipValue(value);
  if (Object.is(normalized, -0)) return "0";
  if (Number.isInteger(normalized)) return String(normalized);
  return normalized.toFixed(1).replace(/\.0$/, "");
}

function formatBlackjackChipDelta(delta) {
  const normalized = normalizeBlackjackChipValue(delta);
  return `${normalized > 0 ? "+" : ""}${formatBlackjackChips(normalized)}`;
}

function chipsToMemocoin(chips) {
  return Math.round(normalizeBlackjackChipValue(chips) * BLACKJACK_MEMOCOIN_PER_CHIP);
}

function cloneBlackjackCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter(card => card && typeof card === "object")
    .map(card => ({ rank: card.rank, suit: card.suit }));
}

function normalizeBlackjackCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .filter(card => card && typeof card === "object")
    .map(card => ({ rank: String(card.rank || "").toUpperCase(), suit: String(card.suit || "") }))
    .filter(card => BLACKJACK_RANKS.includes(card.rank) && BLACKJACK_SUITS.includes(card.suit));
}

function normalizeBlackjackHandResult(result) {
  if (!result || typeof result !== "object") return null;
  const bet = Math.max(0, normalizeBlackjackChipValue(result.bet));
  const payoutChips = Math.max(0, normalizeBlackjackChipValue(result.payoutChips ?? result.payout));
  const deltaChips = normalizeBlackjackChipValue(
    Number.isFinite(result.deltaChips) ? result.deltaChips : (payoutChips - bet)
  );
  return {
    kind: "hand",
    outcome: typeof result.outcome === "string" ? result.outcome : "loss",
    message: typeof result.message === "string" ? result.message : "",
    bet,
    payoutChips,
    deltaChips,
    playerHand: normalizeBlackjackCards(result.playerHand),
    dealerHand: normalizeBlackjackCards(result.dealerHand),
    playerTotal: Number.isFinite(result.playerTotal) ? Math.max(0, Math.floor(result.playerTotal)) : 0,
    dealerTotal: Number.isFinite(result.dealerTotal) ? Math.max(0, Math.floor(result.dealerTotal)) : 0,
    chipsAfter: normalizeBlackjackChipValue(result.chipsAfter),
    handsPlayed: Number.isFinite(result.handsPlayed)
      ? Math.max(0, Math.min(BLACKJACK_MAX_HANDS, Math.floor(result.handsPlayed)))
      : 0,
    endedAt: Number.isFinite(result.endedAt) && result.endedAt > 0 ? result.endedAt : Date.now()
  };
}

function normalizeBlackjackSettlement(result) {
  if (!result || typeof result !== "object") return null;
  const finalChips = normalizeBlackjackChipValue(result.finalChips ?? result.chips);
  const settlementAmount = Number.isFinite(result.settlementAmount)
    ? Math.round(result.settlementAmount)
    : chipsToMemocoin(finalChips);
  const sessionNetDelta = Number.isFinite(result.sessionNetDelta)
    ? Math.round(result.sessionNetDelta)
    : (settlementAmount - BLACKJACK_BUY_IN_MEMOCOIN);
  return {
    kind: "session",
    reason: typeof result.reason === "string" ? result.reason : "",
    message: typeof result.message === "string" ? result.message : "",
    finalChips,
    settlementAmount,
    sessionNetDelta,
    totalAfter: Number.isFinite(result.totalAfter) ? Math.round(result.totalAfter) : 0,
    handsPlayed: Number.isFinite(result.handsPlayed)
      ? Math.max(0, Math.min(BLACKJACK_MAX_HANDS, Math.floor(result.handsPlayed)))
      : 0,
    sentToPrison: Boolean(result.sentToPrison),
    endedAt: Number.isFinite(result.endedAt) && result.endedAt > 0 ? result.endedAt : Date.now()
  };
}

function normalizeBlackjackState(state) {
  let next = state && typeof state === "object" ? state : getDefaultBlackjackState();
  const hasSessionShape =
    Object.prototype.hasOwnProperty.call(next, "sessionActive") ||
    Object.prototype.hasOwnProperty.call(next, "chips") ||
    Object.prototype.hasOwnProperty.call(next, "handsPlayed") ||
    Object.prototype.hasOwnProperty.call(next, "lastSettlement");

  if (!hasSessionShape) {
    next = Object.assign(next, getDefaultBlackjackState());
  }

  if (typeof next.sessionActive !== "boolean") next.sessionActive = false;
  if (typeof next.active !== "boolean") next.active = false;
  next.bet = Math.max(0, normalizeBlackjackChipValue(next.bet));
  next.chips = normalizeBlackjackChipValue(next.chips);
  next.deck = normalizeBlackjackCards(next.deck);
  next.playerHand = normalizeBlackjackCards(next.playerHand);
  next.dealerHand = normalizeBlackjackCards(next.dealerHand);
  if (!Number.isFinite(next.handsPlayed) || next.handsPlayed < 0) next.handsPlayed = 0;
  next.handsPlayed = Math.max(0, Math.min(BLACKJACK_MAX_HANDS, Math.floor(next.handsPlayed)));
  next.lastResult = normalizeBlackjackHandResult(next.lastResult);
  next.lastSettlement = normalizeBlackjackSettlement(next.lastSettlement);

  if (next.active && (!next.sessionActive || next.playerHand.length < 2 || next.dealerHand.length < 2 || next.bet <= 0)) {
    next.active = false;
  }
  if (!next.sessionActive) {
    next.bet = 0;
    next.chips = 0;
    next.deck = [];
    next.playerHand = [];
    next.dealerHand = [];
    next.handsPlayed = 0;
    next.active = false;
  } else if (!next.active) {
    next.bet = 0;
    next.playerHand = [];
    next.dealerHand = [];
  }
  return next;
}

function isBlackjackNatural(hand) {
  return Array.isArray(hand) && hand.length === 2 && getBlackjackHandTotal(hand) === 21;
}

function createBlackjackDeck() {
  const deck = [];
  for (const suit of BLACKJACK_SUITS) {
    for (const rank of BLACKJACK_RANKS) {
      deck.push({ rank, suit });
    }
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function drawBlackjackCard(state) {
  if (!state.deck.length) state.deck = createBlackjackDeck();
  const card = state.deck.pop();
  return card ? { rank: card.rank, suit: card.suit } : null;
}

function formatBlackjackCard(card) {
  if (!card || typeof card !== "object") return "?";
  return `${card.rank || "?"}${card.suit || ""}`;
}

function formatBlackjackHand(hand, hideHoleCards = false) {
  if (!Array.isArray(hand) || !hand.length) return "Aucune carte";
  return hand
    .map((card, index) => (hideHoleCards && index > 0 ? "🎴" : formatBlackjackCard(card)))
    .join(" ");
}

function getBlackjackHandTotal(hand) {
  let total = 0;
  let aces = 0;
  for (const card of (Array.isArray(hand) ? hand : [])) {
    const rank = String(card?.rank || "").toUpperCase();
    if (rank === "A") {
      total += 11;
      aces += 1;
    } else if (rank === "K" || rank === "Q" || rank === "J") {
      total += 10;
    } else {
      total += Number.parseInt(rank, 10) || 0;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function getBlackjackVisibleDealerTotal(hand) {
  if (!Array.isArray(hand) || !hand.length) return 0;
  return getBlackjackHandTotal(hand.slice(0, 1));
}

function getBlackjackResultColor(outcome) {
  if (outcome === "win" || outcome === "blackjack") return 0x2ecc71;
  if (outcome === "push") return 0xf1c40f;
  if (outcome === "surrender") return 0xe67e22;
  return 0xe74c3c;
}

function chargeBlackjackSettlementFromMemocoin(userId, amount) {
  const safeAmount = Math.max(0, Math.floor(amount || 0));
  const bal = getBalance(userId);
  const totalBefore = getTotalMemocoin(userId);
  let remaining = safeAmount;
  const fromInventory = Math.min(bal.inventory || 0, remaining);
  bal.inventory -= fromInventory;
  remaining -= fromInventory;
  if (remaining > 0) {
    bal.bank -= remaining;
  }
  const totalAfter = totalBefore - safeAmount;
  const sentToPrison = totalBefore < safeAmount || (debtModeEnabled && totalAfter <= PRISON_DEBT_LIMIT);
  if (sentToPrison) {
    sendToPrison(userId);
  }
  return { amount: safeAmount, totalBefore, totalAfter, sentToPrison };
}

function startBlackjackHand(bal, bet) {
  const state = normalizeBlackjackState(bal.blackjack);
  const safeBet = Math.max(0, Math.floor(bet || 0));
  state.active = true;
  state.bet = safeBet;
  state.chips = normalizeBlackjackChipValue(state.chips - safeBet);
  state.playerHand = [];
  state.dealerHand = [];
  if (!state.deck.length) {
    state.deck = createBlackjackDeck();
  }
  const playerFirst = drawBlackjackCard(state);
  const dealerFirst = drawBlackjackCard(state);
  const playerSecond = drawBlackjackCard(state);
  const dealerSecond = drawBlackjackCard(state);
  if (playerFirst) state.playerHand.push(playerFirst);
  if (playerSecond) state.playerHand.push(playerSecond);
  if (dealerFirst) state.dealerHand.push(dealerFirst);
  if (dealerSecond) state.dealerHand.push(dealerSecond);
  return state;
}

function finishBlackjackHand(bal, outcome, message, payoutChips = 0) {
  const state = normalizeBlackjackState(bal.blackjack);
  const bet = Math.max(0, normalizeBlackjackChipValue(state.bet || 0));
  const playerHand = cloneBlackjackCards(state.playerHand);
  const dealerHand = cloneBlackjackCards(state.dealerHand);
  const playerTotal = getBlackjackHandTotal(playerHand);
  const dealerTotal = getBlackjackHandTotal(dealerHand);
  const safePayout = Math.max(0, normalizeBlackjackChipValue(payoutChips));
  state.chips = normalizeBlackjackChipValue(state.chips + safePayout);
  state.handsPlayed = Math.min(BLACKJACK_MAX_HANDS, state.handsPlayed + 1);

  const result = {
    kind: "hand",
    outcome,
    message: String(message || ""),
    payoutChips: safePayout,
    deltaChips: normalizeBlackjackChipValue(safePayout - bet),
    bet,
    playerHand,
    dealerHand,
    playerTotal,
    dealerTotal,
    chipsAfter: state.chips,
    handsPlayed: state.handsPlayed,
    endedAt: Date.now()
  };

  state.lastResult = result;
  state.active = false;
  state.bet = 0;
  state.playerHand = [];
  state.dealerHand = [];

  return { ...result, color: getBlackjackResultColor(outcome) };
}

function settleBlackjackSession(userId, reason = "") {
  const bal = getBalance(userId);
  const state = normalizeBlackjackState(bal.blackjack);
  if (!state.sessionActive || state.active) return null;

  const finalChips = normalizeBlackjackChipValue(state.chips);
  const settlementAmount = chipsToMemocoin(finalChips);
  const sessionNetDelta = settlementAmount - BLACKJACK_BUY_IN_MEMOCOIN;
  let totalAfter = getTotalMemocoin(userId);
  let sentToPrison = false;

  if (settlementAmount >= 0) {
    bal.inventory += settlementAmount;
    totalAfter += settlementAmount;
  } else {
    const charge = chargeBlackjackSettlementFromMemocoin(userId, Math.abs(settlementAmount));
    totalAfter = charge.totalAfter;
    sentToPrison = charge.sentToPrison;
  }

  const prefix = reason ? `${reason} ` : "";
  const settlement = {
    kind: "session",
    reason,
    message:
      `${prefix}Fin de session: ${formatBlackjackChips(finalChips)} jetons -> ` +
      `${formatMemocoinDelta(settlementAmount)} Memocoins. ` +
      `Bilan session: ${formatMemocoinDelta(sessionNetDelta)} Memocoins.` +
      (sentToPrison ? " ⛓️ Solde insuffisant: prison immédiate." : ""),
    finalChips,
    settlementAmount,
    sessionNetDelta,
    totalAfter,
    handsPlayed: state.handsPlayed,
    sentToPrison,
    endedAt: Date.now()
  };

  bal.blackjack = getDefaultBlackjackState();
  bal.blackjack.lastResult = state.lastResult;
  bal.blackjack.lastSettlement = settlement;

  return settlement;
}

function maybeAutoSettleBlackjackSession(userId, reason = "10 mains jouées.") {
  const bal = getBalance(userId);
  const state = normalizeBlackjackState(bal.blackjack);
  if (!state.sessionActive || state.active || state.handsPlayed < BLACKJACK_MAX_HANDS) return null;
  return settleBlackjackSession(userId, reason);
}

function resolveBlackjackDealerRound(bal, reasonText = "") {
  const state = normalizeBlackjackState(bal.blackjack);
  const bet = Math.max(0, normalizeBlackjackChipValue(state.bet || 0));
  const playerTotal = getBlackjackHandTotal(state.playerHand);

  while (getBlackjackHandTotal(state.dealerHand) < 17) {
    const drawn = drawBlackjackCard(state);
    if (!drawn) break;
    state.dealerHand.push(drawn);
  }

  const dealerTotal = getBlackjackHandTotal(state.dealerHand);
  const detailText = reasonText ? `${reasonText} ` : "";
  if (dealerTotal > 21) {
    return finishBlackjackHand(
      bal,
      "win",
      `${detailText}Le croupier dépasse 21 avec ${dealerTotal}. Tu récupères ${formatBlackjackChips(bet * 2)} jetons.`,
      bet * 2
    );
  }
  if (playerTotal > dealerTotal) {
    return finishBlackjackHand(
      bal,
      "win",
      `${detailText}Tu bats le croupier ${playerTotal} à ${dealerTotal}. Tu récupères ${formatBlackjackChips(bet * 2)} jetons.`,
      bet * 2
    );
  }
  if (playerTotal === dealerTotal) {
    return finishBlackjackHand(
      bal,
      "push",
      `${detailText}Égalité ${playerTotal} à ${dealerTotal}. Ta mise de ${formatBlackjackChips(bet)} jetons est rendue.`,
      bet
    );
  }
  return finishBlackjackHand(
    bal,
    "loss",
    `${detailText}Le croupier gagne ${dealerTotal} à ${playerTotal}. Tu perds ${formatBlackjackChips(bet)} jetons.`,
    0
  );
}

function buildBlackjackView(userId, footerText = null) {
  const bal = getBalance(userId);
  const total = getTotalMemocoin(userId);
  const state = normalizeBlackjackState(bal.blackjack);
  const lastResult = state.lastResult;
  const lastSettlement = state.lastSettlement;

  if (state.active) {
    const playerTotal = getBlackjackHandTotal(state.playerHand);
    const canHit = playerTotal < 21;
    const canDouble = state.playerHand.length === 2 && playerTotal < 21;
    const canSurrender = state.playerHand.length === 2;
    const embed = new EmbedBuilder()
      .setTitle("🃏 Blackjack")
      .setColor(0x2980b9)
      .setDescription("Blackjack réel: naturel payé 3:2, le croupier reste sur 17, `Doubler` et `Abandonner` sont limités aux 2 premières cartes.")
      .addFields(
        { name: "🧍 Ta main", value: `${formatBlackjackHand(state.playerHand)}\nTotal: ${playerTotal}`, inline: false },
        { name: "🎩 Croupier", value: `${formatBlackjackHand(state.dealerHand, true)}\nVisible: ${getBlackjackVisibleDealerTotal(state.dealerHand)} + ?`, inline: false },
        { name: "💸 Mise", value: `${formatBlackjackChips(state.bet)} jetons (${chipsToMemocoin(state.bet)}$)`, inline: true },
        { name: "🎟️ Hors mise", value: `${formatBlackjackChips(state.chips)} jetons`, inline: true },
        { name: "🕹️ Main", value: `${Math.min(BLACKJACK_MAX_HANDS, state.handsPlayed + 1)}/${BLACKJACK_MAX_HANDS}`, inline: true },
        { name: "💰 Solde hors table", value: `${total}$`, inline: true }
      )
      .setFooter({ text: footerText || "Seul le propriétaire de ce message peut utiliser ces boutons." })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("blackjack_hit").setLabel("🂠 Tirer").setStyle(ButtonStyle.Success).setDisabled(!canHit),
      new ButtonBuilder().setCustomId("blackjack_stand").setLabel("✋ Rester").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("blackjack_double").setLabel("⏫ Doubler").setStyle(ButtonStyle.Secondary).setDisabled(!canDouble),
      new ButtonBuilder().setCustomId("blackjack_surrender").setLabel("🏳️ Abandonner").setStyle(ButtonStyle.Danger).setDisabled(!canSurrender)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );
    return { embed, components: [row1, row2] };
  }

  if (state.sessionActive) {
    const sessionValue = chipsToMemocoin(state.chips);
    const sessionNetDelta = sessionValue - BLACKJACK_BUY_IN_MEMOCOIN;
    const color = lastResult ? getBlackjackResultColor(lastResult.outcome) : 0x16a085;
    const embed = new EmbedBuilder()
      .setTitle("🃏 Blackjack")
      .setColor(color)
      .setDescription(
        `Session en cours. Choisis une mise en jetons pour la prochaine main.\n` +
        `Le règlement se fait à la fin: 1 jeton = ${BLACKJACK_MEMOCOIN_PER_CHIP} Memocoins, même si tes jetons passent en négatif.`
      )
      .addFields(
        { name: "🎟️ Jetons", value: `${formatBlackjackChips(state.chips)}`, inline: true },
        { name: "🏦 Encaissement", value: `${formatMemocoinDelta(sessionValue)}$`, inline: true },
        { name: "💹 Bilan session", value: `${formatMemocoinDelta(sessionNetDelta)}$`, inline: true },
        { name: "🕹️ Mains", value: `${state.handsPlayed}/${BLACKJACK_MAX_HANDS}`, inline: true },
        { name: "⏳ Restantes", value: `${Math.max(0, BLACKJACK_MAX_HANDS - state.handsPlayed)}`, inline: true },
        { name: "💰 Solde hors table", value: `${total}$`, inline: true }
      )
      .setFooter({ text: footerText || "Seul le propriétaire de ce message peut utiliser ces boutons." })
      .setTimestamp();

    if (lastResult) {
      embed.addFields(
        { name: "📋 Dernière main", value: lastResult.message || "Aucun", inline: false },
        { name: "🧍 Ta main", value: `${formatBlackjackHand(lastResult.playerHand)}\nTotal: ${lastResult.playerTotal}`, inline: true },
        { name: "🎩 Croupier", value: `${formatBlackjackHand(lastResult.dealerHand)}\nTotal: ${lastResult.dealerTotal}`, inline: true },
        { name: "🎟️ Variation", value: `${formatBlackjackChipDelta(lastResult.deltaChips)} jetons`, inline: true }
      );
    }

    const betButtons = BLACKJACK_BET_OPTIONS.map(amount =>
      new ButtonBuilder()
        .setCustomId(`blackjack_bet_${amount}`)
        .setLabel(`Miser ${amount} jetons`)
        .setStyle(ButtonStyle.Success)
    );
    const betRows = [];
    for (let i = 0; i < betButtons.length; i += 5) {
      betRows.push(new ActionRowBuilder().addComponents(...betButtons.slice(i, i + 5)));
    }
    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("blackjack_cashout").setLabel("💰 Encaisser et quitter").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );
    return { embed, components: [...betRows, controls] };
  }

  const canStartSession = !isInPrison(userId) && total >= BLACKJACK_BUY_IN_MEMOCOIN;
  const settlementColor = lastSettlement
    ? (lastSettlement.sessionNetDelta > 0 ? 0x2ecc71 : (lastSettlement.sessionNetDelta === 0 ? 0xf1c40f : 0xe74c3c))
    : 0x16a085;
  const embed = new EmbedBuilder()
    .setTitle("🃏 Blackjack")
    .setColor(settlementColor)
    .setDescription(
      `Paye ${BLACKJACK_BUY_IN_MEMOCOIN} Memocoins pour entrer avec ${BLACKJACK_STARTING_CHIPS} jetons.\n` +
      `Une session dure jusqu'à ${BLACKJACK_MAX_HANDS} mains et ${BLACKJACK_MEMOCOIN_PER_CHIP} Memocoins valent 1 jeton.`
    )
    .addFields(
      { name: "💰 Solde total", value: `${total}$`, inline: true },
      { name: "🎟️ Buy-in", value: `${BLACKJACK_STARTING_CHIPS} jetons`, inline: true },
      { name: "🏦 Conversion", value: `1 jeton = ${BLACKJACK_MEMOCOIN_PER_CHIP}$`, inline: true },
      {
        name: "📘 Règles",
        value:
          "Blackjack naturel payé 3:2, croupier sur 17, double et abandon sur les 2 premières cartes. Les jetons négatifs sont réglés à la fin de la session.",
        inline: false
      }
    )
    .setFooter({ text: footerText || "Seul le propriétaire de ce message peut utiliser ces boutons." })
    .setTimestamp();

  if (lastSettlement) {
    embed.addFields(
      { name: "📋 Dernière session", value: lastSettlement.message || "Aucune", inline: false },
      { name: "🎟️ Jetons finaux", value: `${formatBlackjackChips(lastSettlement.finalChips)}`, inline: true },
      { name: "🏦 Règlement", value: `${formatMemocoinDelta(lastSettlement.settlementAmount)}$`, inline: true },
      { name: "💹 Bilan session", value: `${formatMemocoinDelta(lastSettlement.sessionNetDelta)}$`, inline: true }
    );
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("blackjack_session_start")
      .setLabel(`Entrer (${BLACKJACK_BUY_IN_MEMOCOIN}$)`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canStartSession),
    new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row] };
}

async function syncBlackjackInteraction(interaction, userId, footerText, results = []) {
  saveData();
  const view = buildBlackjackView(userId, footerText);
  await interaction.update({ embeds: [view.embed], components: view.components });
  for (const result of results.filter(Boolean)) {
    await sendBlackjackResultMessage(interaction.channel, userId, result);
  }
}

function buildRouletteView(userId, footerText = null) {
  const bal = getBalance(userId);
  const now = Date.now();
  const cooldownUntil = bal.rouletteCooldownUntil || 0;
  const hasCooldown = cooldownUntil > now;
  const remaining = hasCooldown ? formatShortDuration(cooldownUntil - now) : "Aucun";
  const canUseRouletteReset = (bal.resetRoulettePower || 0) > 0 && hasCooldown;

  const embed = new EmbedBuilder()
    .setTitle("\u{1F3B0} Roulette")
    .setDescription("1 tirage par jour. Reset automatique à 00h00 (Europe/Paris). Minimum 5000$ pour jouer.")
    .addFields(
      { name: "\u{1F381} Gains (environ)", value: "+5 (70%), +10 (30%), +100 (10%), +1000 (5%)", inline: false },
      { name: "\u{1F4A5} Pertes (environ)", value: "-5 (70%), -10 (30%), -100 (10%), -1000 (5%)", inline: false },
      { name: "\u{1F6E1}\u{FE0F} Protections (environ)", value: "+1 (10%), +3 (5%), +10 (1%)", inline: false },
      { name: "\u26A1 Pouvoirs reset", value: "Reset roulette x1 (0.1%), Reset vol x1 (3%), Reset vol x3 (5%), Reset casino x1 (0.02%), Reset casino x3 (0.01%), Reset Slotomania x1 (0.02%), Reset Slotomania x3 (0.01%)", inline: false },
      { name: "\u26A1 Reset roulette", value: String(bal.resetRoulettePower || 0), inline: true },
      { name: "\u23F1\u{FE0F} Cooldown", value: remaining, inline: true }
    )
    .setFooter({ text: footerText || "Seul le propriétaire de ce message peut utiliser ces boutons." })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("roulette_spin").setLabel("\u{1F3B2} Lancer").setStyle(ButtonStyle.Success).setDisabled(hasCooldown),
    new ButtonBuilder().setCustomId("use_reset_roulette_power").setLabel("\u{26A1} Utiliser reset roulette").setStyle(ButtonStyle.Primary).setDisabled(!canUseRouletteReset)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2] };
}

function hasCasinoCooldown(userId) {
  const bal = getBalance(userId);
  return (bal.casinoCooldownUntil || 0) > Date.now();
}

function buildCasinoView(userId, footerText = null) {
  const bal = getBalance(userId);
  const now = Date.now();
  const cooldownUntil = bal.casinoCooldownUntil || 0;
  const hasCooldown = cooldownUntil > now;
  const remaining = hasCooldown ? formatShortDuration(cooldownUntil - now) : "Aucun";
  const canUseCasinoReset = (bal.resetCasinoPower || 0) > 0 && hasCooldown;
  const winPct = `${Math.round(CASINO_WIN_CHANCE * 100)}%`;
  const losePct = `${100 - Math.round(CASINO_WIN_CHANCE * 100)}%`;

  const embed = new EmbedBuilder()
    .setTitle("\u{1F3B2} Casino")
    .setDescription("Chance de gain amelioree. Cooldown: 1h par utilisation. Minimum 5000$ pour jouer.")
    .addFields(
      { name: "\u{1F4C8} Chance de gain", value: winPct, inline: true },
      { name: "\u{1F4C9} Chance de perte", value: losePct, inline: true },
      { name: "\u{1F4B0} Gain", value: `+${CASINO_WIN_REWARD}$`, inline: true },
      { name: "\u23F1\u{FE0F} Cooldown", value: remaining, inline: true },
      { name: "\u26A1 Reset casino", value: String(bal.resetCasinoPower || 0), inline: true }
    )
    .setFooter({ text: footerText || "Seul le propriétaire de ce message peut utiliser ces boutons." })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("casino_play").setLabel("\u{1F3B0} Jouer").setStyle(ButtonStyle.Success).setDisabled(hasCooldown),
    new ButtonBuilder().setCustomId("use_reset_casino_power").setLabel("\u{26A1} Utiliser reset casino").setStyle(ButtonStyle.Primary).setDisabled(!canUseCasinoReset)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2] };
}

function buildSlotomaniaView(userId, footerText = null) {
  const bal = getBalance(userId);
  const now = Date.now();
  const cooldownUntil = bal.slotCooldownUntil || 0;
  const hasCooldown = cooldownUntil > now;
  const remaining = hasCooldown ? formatShortDuration(cooldownUntil - now) : "Aucun";
  const canUseReset = (bal.resetSlotPower || 0) > 0 && hasCooldown;

  const embed = new EmbedBuilder()
    .setTitle("\u{1F3B0} Slotomania")
    .setDescription("Lance 3 symboles. Plusieurs gains sont maintenant beaucoup plus accessibles. Cooldown: 3h par utilisation. Minimum 5000$ pour jouer.")
    .addFields(
      { name: "\u{1F352}\u{1F352}\u{1F352} Jackpot", value: "0.005% -> +1000000$", inline: false },
      { name: "\u{1F34C}\u{1F34C}\u{1F34C} Bonus", value: "6% -> +10000$", inline: false },
      { name: "\u{1F347}\u{1F347}\u{1F347} Petit gain", value: "18% -> +2500$", inline: false },
      { name: "\u{1F345}\u{1F345}\u{1F345} Reset", value: "10% -> +1 reset aleatoire", inline: false },
      { name: "\u23F1\u{FE0F} Cooldown", value: remaining, inline: true },
      { name: "\u26A1 Reset Slotomania", value: String(bal.resetSlotPower || 0), inline: true }
    )
    .setFooter({ text: footerText || "Seul le propriétaire de ce message peut utiliser ces boutons." })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("slot_play").setLabel("\u{1F3B2} Lancer").setStyle(ButtonStyle.Success).setDisabled(hasCooldown),
    new ButtonBuilder().setCustomId("use_reset_slot_power").setLabel("\u{26A1} Utiliser reset Slotomania").setStyle(ButtonStyle.Primary).setDisabled(!canUseReset)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2] };
}

function buildShopComponents(userId) {
  const locked = isInPrison(userId);
  const spendable = getMemocoinSpendCapacity(userId);
  const canBuyResetSlot = !locked && spendable >= 34500;
  const canBuyResetCasino = !locked && spendable >= 34500;
  const canBuyResetSteal = !locked && spendable >= 45000;
  const canBuyResetRoulette = !locked && spendable >= 755000;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop_buy_reset_slot").setLabel("⚡🎰 Reset Slotomania (34500$)").setStyle(ButtonStyle.Primary).setDisabled(!canBuyResetSlot),
    new ButtonBuilder().setCustomId("shop_buy_reset_casino").setLabel("⚡🎲 Reset Casino (34500$)").setStyle(ButtonStyle.Primary).setDisabled(!canBuyResetCasino),
    new ButtonBuilder().setCustomId("shop_buy_reset_steal").setLabel("⚡🗡️ Reset vol (45000$)").setStyle(ButtonStyle.Primary).setDisabled(!canBuyResetSteal)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop_buy_reset_roulette").setLabel("⚡🎯 Reset roulette (755000$)").setStyle(ButtonStyle.Primary).setDisabled(!canBuyResetRoulette)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_shop").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return [row1, row2, row3];
}

function buildStealEmbed(userId) {
  const now = Date.now();
  const pending = pendingStealsMap.get(userId);
  const cooldownUntil = stealCooldownMap.get(userId) || 0;
  const policeRemaining = getPoliceWaitRemainingMs(userId);
  const lines = [];

  if (policeRemaining > 0) {
    lines.push(`🚫 Police: ${formatShortDuration(policeRemaining)}.`);
  }
  if (pending) {
    const executeAt = Number(pending.executeAt || 0);
    if (executeAt > now) {
      lines.push(`🧭 Vol en attente: ${formatShortDuration(executeAt - now)}.`);
    } else {
      lines.push("🧭 Vol en attente.");
    }
  }
  if (cooldownUntil > now) {
    lines.push(`⏱️ Attente vol: ${formatShortDuration(cooldownUntil - now)} (voler de nouveau à ${formatRetryClock(cooldownUntil)}).`);
  } else if (!pending && policeRemaining <= 0) {
    lines.push("✅ Tu peux voler maintenant.");
  }

  const desc = "Sélectionne une victime puis clique sur Voler pour entrer le montant." + (lines.length ? `\n\n${lines.join("\n")}` : "");
  return new EmbedBuilder()
    .setTitle("\u{1F575}\u{FE0F} Voler")
    .setDescription(desc);
}

function buildMoneyShopView(userId) {
  const bal = getBalance(userId);
  const embed = new EmbedBuilder()
    .setTitle("🛒 Boutique Jeux d'argent")
    .setDescription(
      "Objets disponibles :\n" +
      "- ⚡ Reset attente Slotomania : 34500$\n" +
      "- ⚡ Reset attente Casino : 34500$\n" +
      "- ⚡ Reset attente vol : 45000$\n" +
      "- ⚡ Reset attente roulette : 755000$"
    )
    .addFields(
      { name: "💰 Memocoins", value: String(bal.inventory || 0), inline: true },
      { name: "⚡ Reset Slotomania", value: String(bal.resetSlotPower || 0), inline: true },
      { name: "⚡ Reset Casino", value: String(bal.resetCasinoPower || 0), inline: true },
      { name: "⚡ Reset vol", value: String(bal.resetStealPower || 0), inline: true },
      { name: "⚡ Reset roulette", value: String(bal.resetRoulettePower || 0), inline: true }
    )
    .setColor(0xe74c3c);
  return { embed, components: buildShopComponents(userId) };
}

function buildShopHubView() {
  const merchantOpen = isTravelingMerchantOpen();
  const embed = new EmbedBuilder()
    .setTitle("🛒 Boutiques")
    .setDescription(`Choisis une boutique.\nMarchand ambulant: ${merchantOpen ? "Ouvert" : "Fermé"} (14h-16h, heure de Paris).`);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop_cat_jeux_argent").setLabel("💸 Jeux d'argent").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("shop_cat_memocoin").setLabel("🪙 Memocoin").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("shop_cat_minecraft").setLabel("🌍 Minecraft").setStyle(ButtonStyle.Success)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("shop_cat_pokemon").setLabel("🌎 Pokémon").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("shop_cat_donjon").setLabel("🧨 Donjon").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("shop_cat_zombie").setLabel("🧟 Zombie").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("shop_traveling_merchant").setLabel("🧳 Marchand ambulant").setStyle(ButtonStyle.Secondary).setDisabled(!merchantOpen)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row1, row2, row3] };
}

function buildBankMenuView(userId) {
  const bal = getBalance(userId);
  const mc = bal.minecraft || {};
  const pk = bal.pokemon || {};
  const dj = bal.donjon || {};
  const zb = bal.zombie || {};
  const locked = isInPrison(userId);
  const embed = new EmbedBuilder()
    .setTitle("🏦 Banque")
    .setDescription(locked ? "Indisponible pendant la prison." : "Choisis une action.");
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("deposit").setLabel("💳 Déposer").setStyle(ButtonStyle.Primary).setDisabled(locked),
    new ButtonBuilder().setCustomId("withdraw").setLabel("📤 Retirer").setStyle(ButtonStyle.Success).setDisabled(locked)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bank_convert_mc").setLabel("💚 Émeraudes").setStyle(ButtonStyle.Secondary).setDisabled(locked || (mc.emeralds || 0) <= 0),
    new ButtonBuilder().setCustomId("bank_convert_pk").setLabel("💴 Pokédollars").setStyle(ButtonStyle.Secondary).setDisabled(locked || (pk.pokedollars || 0) < PK_POKEDOLLAR_TO_MEMOCOIN)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bank_convert_dg").setLabel("🪙 Pièces d'or").setStyle(ButtonStyle.Secondary).setDisabled(locked || (dj.goldCoins || 0) <= 0),
    new ButtonBuilder().setCustomId("bank_convert_zb").setLabel("🥈 Pièces d'argent").setStyle(ButtonStyle.Secondary).setDisabled(locked || (zb.silverCoins || 0) <= 0)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );
  return { embed, components: [row1, row2, row3, row4] };
}

const HOROSCOPE_DAILY_PRICE = 1000;
const HOROSCOPE_RECENT_HISTORY_LIMIT = 8;
const HOROSCOPE_PREDICTION_ENERGIES = [
  "Tu avances avec une énergie stable et plus lucide que tu ne le crois.",
  "Une envie de reprendre la main sur ce qui traînait revient fortement.",
  "Ton intuition travaille vite, mais elle demande d'être canalisée.",
  "Une phase plus ambitieuse s'ouvre, surtout si tu simplifies tes priorités.",
  "Tu dégages aujourd'hui une présence plus forte que d'habitude.",
  "Le calme apparent cache en réalité une bonne poussée de motivation.",
  "Tu sens qu'il faut bouger, trancher et arrêter d'attendre le moment parfait.",
  "Ton rythme du jour favorise les décisions nettes et les vraies discussions.",
  "Une énergie plus douce t'aide à voir ce qui compte sans te disperser.",
  "Le jour pousse à la reconstruction plus qu'à la vitesse.",
  "Tu captes mieux les signes subtils, surtout dans les échanges humains.",
  "La journée te rend plus audacieux, à condition de rester mesuré."
];
const HOROSCOPE_PREDICTION_FOCUSES = [
  "tes discussions importantes",
  "tes finances du quotidien",
  "une relation qui manque de clarté",
  "ton organisation personnelle",
  "un projet que tu repousses",
  "ta confiance en toi",
  "les proches qui attendent un signe de toi",
  "ta réputation ou ton image",
  "ta fatigue accumulée",
  "une opportunité sociale",
  "la manière dont tu gères ton temps",
  "un choix rapide qui demande plus de recul"
];
const HOROSCOPE_PREDICTION_OPENINGS = [
  "Une ouverture discrète peut apparaître si tu relances la bonne personne.",
  "Un détail que d'autres ignorent peut devenir ton meilleur avantage.",
  "Quelqu'un pourrait revenir avec une proposition plus claire que prévu.",
  "Une réponse arrive mieux si tu poses moins de mots et plus d'intention.",
  "Un retard du matin peut finalement te mettre sur une meilleure piste.",
  "Ce que tu fais en silence aujourd'hui préparera un vrai résultat visible.",
  "Une petite action prise tôt peut débloquer une situation plus grande.",
  "Un échange simple peut produire un effet étonnamment durable.",
  "Le vrai mouvement du jour vient d'un geste concret, pas d'une promesse.",
  "Une occasion utile se présente surtout si tu sors d'une hésitation ancienne.",
  "Une nouvelle favorable se cache derrière quelque chose qui semblait banal.",
  "Le bon déclic arrive quand tu cesses de vouloir tout contrôler."
];
const HOROSCOPE_PREDICTION_VIGILANCES = [
  "Évite de répondre trop vite à ce qui te met sous pression.",
  "Ne confonds pas urgence et importance.",
  "Garde ton énergie pour ce qui progresse vraiment.",
  "Une parole trop sèche pourrait fermer une porte inutilement.",
  "N'accepte pas un compromis qui t'épuise dès le départ.",
  "Fais attention aux promesses floues, surtout si elles semblent trop faciles.",
  "Tu gagneras plus à observer cinq minutes de plus qu'à foncer tout de suite.",
  "N'insiste pas là où l'autre ne suit pas encore ton rythme.",
  "Protège ton temps, car plusieurs petites demandes peuvent te vider.",
  "Laisse retomber la tension avant de prendre une décision sur l'ego.",
  "Si quelque chose te paraît confus, demande une précision au lieu d'imaginer.",
  "La journée récompense la constance, pas les gestes brusques."
];
const HOROSCOPE_PREDICTION_TIMINGS = [
  "Le moment fort arrive plutôt en début d'après-midi.",
  "Le meilleur créneau se joue avant midi, quand tout est encore clair.",
  "Une avancée se dessine surtout en fin de journée.",
  "Le premier message important du jour mérite d'être relu avant envoi.",
  "Après 18H, les choses deviennent plus fluides et plus naturelles.",
  "Le matin pose les bases, mais la vraie réponse arrive plus tard.",
  "Entre 14H et 17H, ton flair sera plus juste qu'à l'habitude.",
  "Ce soir favorise les discussions sincères plutôt que les décisions froides.",
  "La journée commence lentement, puis accélère d'un coup.",
  "Le bon tempo du jour consiste à attendre un signe, puis agir sans traîner."
];
const HOROSCOPE_PREDICTION_LUCKS = [
  { label: "Relationnel", cue: "un message que tu n'attendais plus" },
  { label: "Travail", cue: "une idée simple qui remet tout en ordre" },
  { label: "Argent", cue: "une petite économie ou une opportunité pratique" },
  { label: "Créativité", cue: "un déclic rapide en voyant les choses autrement" },
  { label: "Chance", cue: "une coïncidence utile au bon moment" },
  { label: "Amitié", cue: "un soutien discret mais solide" },
  { label: "Amour", cue: "une parole qui adoucit une tension" },
  { label: "Décision", cue: "le courage de choisir sans te retourner" }
];
const HOROSCOPE_LUCKY_COLORS = ["or", "bleu nuit", "vert sauge", "ivoire", "rouge profond", "argent", "terracotta", "cyan doux", "ambre", "gris perle"];
const HOROSCOPE_LUCKY_NUMBERS = [2, 3, 5, 7, 8, 9, 11, 14, 17, 19, 21, 24, 27, 33];
const HOROSCOPE_ORACLE_CARDS = [
  { name: "La Clé", emoji: "🗝️", domain: "la clarté", upright: "une solution simple se présente si tu vas à l'essentiel", reversed: "la réponse existe déjà, mais tu regardes encore au mauvais endroit" },
  { name: "Le Pont", emoji: "🌉", domain: "la transition", upright: "tu peux passer d'un ancien cycle à un nouveau sans tout casser", reversed: "tu restes entre deux mondes et cela fatigue plus que tu ne l'admets" },
  { name: "Le Phare", emoji: "🌟", domain: "la direction", upright: "un repère fiable revient et t'évite de te disperser", reversed: "tu avances dans le brouillard parce que tu refuses un signal pourtant clair" },
  { name: "La Coupe", emoji: "🏆", domain: "les émotions", upright: "ce que tu ressens devient enfin une force lisible", reversed: "une émotion mal dite brouille tes intentions" },
  { name: "Le Marteau", emoji: "🔨", domain: "la construction", upright: "un effort régulier reconstruit quelque chose de durable", reversed: "tu risques de forcer là où il faudrait ajuster" },
  { name: "La Lune claire", emoji: "🌙", domain: "l'intuition", upright: "ton instinct voit juste, même si tout n'est pas encore expliqué", reversed: "tes peurs parlent plus fort que ton intuition réelle" },
  { name: "L'Ancre", emoji: "⚓", domain: "la stabilité", upright: "une base solide t'empêche de dériver", reversed: "tu t'accroches à une sécurité qui te ralentit" },
  { name: "Le Miroir", emoji: "🪞", domain: "la vérité intérieure", upright: "tu vois enfin ce qui était évident chez toi", reversed: "tu évites encore une vérité qui t'aiderait pourtant" },
  { name: "Le Jardin", emoji: "🌿", domain: "les relations", upright: "les liens vivants se renforcent si tu nourris la bonne connexion", reversed: "trop de bruit autour de toi cache les liens sincères" },
  { name: "Le Feu doux", emoji: "🔥", domain: "le désir", upright: "ton élan revient sans t'aveugler", reversed: "une impatience brûle ton énergie avant le bon moment" },
  { name: "L'Horloge", emoji: "⏰", domain: "le timing", upright: "le temps joue pour toi si tu respectes le rythme naturel", reversed: "vouloir aller trop vite crée un contretemps évitable" },
  { name: "La Porte", emoji: "🚪", domain: "l'opportunité", upright: "une porte s'ouvre dès que tu acceptes d'avancer léger", reversed: "une occasion existe, mais elle demande de fermer autre chose d'abord" },
  { name: "La Couronne", emoji: "👑", domain: "la reconnaissance", upright: "ta valeur est plus visible et mieux reconnue", reversed: "tu cherches encore une validation qui doit d'abord venir de toi" },
  { name: "Le Nœud", emoji: "🪢", domain: "les blocages", upright: "un problème complexe peut enfin être démêlé", reversed: "plus tu tires fort, plus le blocage se resserre" },
  { name: "La Plume", emoji: "🪶", domain: "les messages", upright: "les mots justes circulent facilement aujourd'hui", reversed: "un non-dit continue de peser tant qu'il n'est pas nommé" },
  { name: "Le Sentier", emoji: "🛤️", domain: "les choix", upright: "la bonne voie se confirme pas à pas", reversed: "tu hésites parce que tu veux encore garder toutes les options ouvertes" },
  { name: "La Source", emoji: "💧", domain: "la guérison", upright: "quelque chose en toi se répare en douceur", reversed: "une fatigue ancienne demande enfin ton attention" },
  { name: "Le Coffre", emoji: "🧰", domain: "les ressources", upright: "tu possèdes déjà ce qu'il faut pour avancer", reversed: "tu sous-estimes tes propres moyens ou tu les disperses mal" }
];
const HOROSCOPE_ORACLE_BALANCE_TEXTS = [
  "Le tirage demande un vrai tri: ce que tu forces trop a besoin d'être relâché avant d'avancer.",
  "Le tirage est contrasté: une issue existe, mais elle demande de couper le bruit et de garder le cap.",
  "Le tirage est plutôt porteur: avance avec régularité, car ce que tu construis tient la route.",
  "Le tirage est très ouvert: la vie t'envoie des signes favorables si tu saisis vite l'élan juste."
];

function createSeededRandom(seedText) {
  let seed = hashSeed(seedText);
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeededOrder(length, seedText) {
  const order = Array.from({ length }, (_, index) => index);
  const rng = createSeededRandom(seedText);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function pickSeededIndex(length, recentIndices, seedText) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  const recent = new Set((Array.isArray(recentIndices) ? recentIndices : []).map(v => Number(v)).filter(Number.isInteger));
  const order = buildSeededOrder(length, seedText);
  for (const index of order) {
    if (!recent.has(index)) return index;
  }
  return order[0] ?? 0;
}

function pickDistinctSeededIndices(length, count, recentIndices, seedText) {
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(count) || count <= 0) return [];
  const recent = new Set((Array.isArray(recentIndices) ? recentIndices : []).map(v => Number(v)).filter(Number.isInteger));
  const order = buildSeededOrder(length, seedText);
  const picked = [];
  const pickedSet = new Set();

  for (const index of order) {
    if (recent.has(index) || pickedSet.has(index)) continue;
    picked.push(index);
    pickedSet.add(index);
    if (picked.length >= count) return picked;
  }

  for (const index of order) {
    if (pickedSet.has(index)) continue;
    picked.push(index);
    pickedSet.add(index);
    if (picked.length >= count) break;
  }

  return picked;
}

function pushRecentUniqueValue(list, value, maxSize = HOROSCOPE_RECENT_HISTORY_LIMIT) {
  const base = Array.isArray(list) ? list.filter(item => item !== value) : [];
  base.unshift(value);
  return base.slice(0, maxSize);
}

function getPoolValue(pool, index, fallbackIndex = 0) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const safeIndex = Number.isInteger(index) && index >= 0 && index < pool.length ? index : fallbackIndex;
  return pool[safeIndex] ?? pool[0] ?? null;
}

function getHoroscopeState(userId) {
  return getBalance(userId).horoscope;
}

function getHoroscopePredictionDetails(prediction) {
  return {
    energy: getPoolValue(HOROSCOPE_PREDICTION_ENERGIES, prediction?.energyIndex, 0) || "",
    focus: getPoolValue(HOROSCOPE_PREDICTION_FOCUSES, prediction?.focusIndex, 0) || "",
    opening: getPoolValue(HOROSCOPE_PREDICTION_OPENINGS, prediction?.openingIndex, 0) || "",
    vigilance: getPoolValue(HOROSCOPE_PREDICTION_VIGILANCES, prediction?.vigilanceIndex, 0) || "",
    timing: getPoolValue(HOROSCOPE_PREDICTION_TIMINGS, prediction?.timingIndex, 0) || "",
    lucky: getPoolValue(HOROSCOPE_PREDICTION_LUCKS, prediction?.luckyIndex, 0) || HOROSCOPE_PREDICTION_LUCKS[0],
    color: getPoolValue(HOROSCOPE_LUCKY_COLORS, prediction?.colorIndex, 0) || HOROSCOPE_LUCKY_COLORS[0],
    number: getPoolValue(HOROSCOPE_LUCKY_NUMBERS, prediction?.numberIndex, 0) || HOROSCOPE_LUCKY_NUMBERS[0]
  };
}

function getHoroscopeOracleCard(cardState) {
  const base = getPoolValue(HOROSCOPE_ORACLE_CARDS, cardState?.index, 0) || HOROSCOPE_ORACLE_CARDS[0];
  const reversed = cardState?.reversed === true;
  return {
    ...base,
    reversed,
    orientation: reversed ? "renversée" : "droite",
    meaning: reversed ? base.reversed : base.upright
  };
}

function buildHoroscopeOracleSummary(oracle) {
  const cards = Array.isArray(oracle?.cards) ? oracle.cards.map(getHoroscopeOracleCard) : [];
  const uprightCount = cards.filter(card => !card.reversed).length;
  const tone = HOROSCOPE_ORACLE_BALANCE_TEXTS[uprightCount] || HOROSCOPE_ORACLE_BALANCE_TEXTS[1];
  const domains = [...new Set(cards.map(card => card.domain).filter(Boolean))];
  const areas = domains.length ? `Domaines mis en avant: ${domains.join(", ")}.` : "";
  return `${tone} ${areas}`.trim();
}

function generateHoroscopePrediction(userId, dayKey, state) {
  const baseSeed = `${userId}|${dayKey}|prediction`;
  const prediction = {
    dayKey,
    energyIndex: pickSeededIndex(HOROSCOPE_PREDICTION_ENERGIES.length, state.recentPredictionEnergy, `${baseSeed}|energy`),
    focusIndex: pickSeededIndex(HOROSCOPE_PREDICTION_FOCUSES.length, state.recentPredictionFocus, `${baseSeed}|focus`),
    openingIndex: pickSeededIndex(HOROSCOPE_PREDICTION_OPENINGS.length, state.recentPredictionOpening, `${baseSeed}|opening`),
    vigilanceIndex: pickSeededIndex(HOROSCOPE_PREDICTION_VIGILANCES.length, state.recentPredictionVigilance, `${baseSeed}|vigilance`),
    timingIndex: pickSeededIndex(HOROSCOPE_PREDICTION_TIMINGS.length, state.recentPredictionTiming, `${baseSeed}|timing`),
    luckyIndex: pickSeededIndex(HOROSCOPE_PREDICTION_LUCKS.length, [], `${baseSeed}|lucky`),
    colorIndex: pickSeededIndex(HOROSCOPE_LUCKY_COLORS.length, [], `${baseSeed}|color`),
    numberIndex: pickSeededIndex(HOROSCOPE_LUCKY_NUMBERS.length, [], `${baseSeed}|number`)
  };

  state.recentPredictionEnergy = pushRecentUniqueValue(state.recentPredictionEnergy, prediction.energyIndex);
  state.recentPredictionFocus = pushRecentUniqueValue(state.recentPredictionFocus, prediction.focusIndex);
  state.recentPredictionOpening = pushRecentUniqueValue(state.recentPredictionOpening, prediction.openingIndex);
  state.recentPredictionVigilance = pushRecentUniqueValue(state.recentPredictionVigilance, prediction.vigilanceIndex);
  state.recentPredictionTiming = pushRecentUniqueValue(state.recentPredictionTiming, prediction.timingIndex);

  return prediction;
}

function generateHoroscopeOracle(userId, dayKey, state) {
  const seed = `${userId}|${dayKey}|oracle`;
  const cardIndices = pickDistinctSeededIndices(HOROSCOPE_ORACLE_CARDS.length, 3, state.recentOracleCards, `${seed}|cards`);
  const rng = createSeededRandom(`${seed}|orientation`);
  const cards = cardIndices.map(index => ({
    index,
    reversed: rng() < 0.38
  }));

  for (const index of cardIndices) {
    state.recentOracleCards = pushRecentUniqueValue(state.recentOracleCards, index, HOROSCOPE_RECENT_HISTORY_LIMIT * 2);
  }

  return { dayKey, cards };
}

function ensureHoroscopeDailyPack(userId, options = {}) {
  const payIfNeeded = options.payIfNeeded === true;
  const horoscope = getHoroscopeState(userId);
  const dayKey = getParisDayKey();
  let changed = false;
  let charged = false;

  if (horoscope.accessDayKey !== dayKey) {
    if (!payIfNeeded) {
      return { ok: false, dayKey, needsPayment: true };
    }

    const spent = spendMemocoinInventoryThenBank(userId, HOROSCOPE_DAILY_PRICE);
    if (!spent || spent < HOROSCOPE_DAILY_PRICE) {
      return {
        ok: false,
        dayKey,
        needsPayment: true,
        reason: debtModeEnabled
          ? `❌ Horoscope du jour impossible. Tu as atteint la limite minimale de ${PRISON_DEBT_LIMIT}$.`
          : `❌ Il faut ${HOROSCOPE_DAILY_PRICE} Memocoins pour débloquer l'horoscope du jour.`
      };
    }

    horoscope.accessDayKey = dayKey;
    horoscope.prediction = null;
    horoscope.oracle = null;
    changed = true;
    charged = true;
  }

  if (!horoscope.prediction || horoscope.prediction.dayKey !== dayKey) {
    horoscope.prediction = generateHoroscopePrediction(userId, dayKey, horoscope);
    changed = true;
  }

  if (!horoscope.oracle || horoscope.oracle.dayKey !== dayKey) {
    horoscope.oracle = generateHoroscopeOracle(userId, dayKey, horoscope);
    changed = true;
  }

  if (changed) saveData();

  return {
    ok: true,
    dayKey,
    charged,
    prediction: horoscope.prediction,
    oracle: horoscope.oracle
  };
}

function buildHoroscopeView(userId, section = "menu", notice = "") {
  const bal = getBalance(userId);
  const horoscope = getHoroscopeState(userId);
  const dayKey = getParisDayKey();
  const unlocked = horoscope.accessDayKey === dayKey;
  const total = getTotalMemocoin(userId);
  const resetIn = formatShortDuration(getMsUntilNextParisMidnight());
  const title = section === "prediction"
    ? "🔮 Prédiction du jour"
    : section === "oracle"
      ? "🃏 Oracle du jour"
      : "🔮 Horoscope";
  const color = section === "prediction" ? 0x16a085 : section === "oracle" ? 0xe67e22 : 0xf1c40f;

  const lines = [];
  if (notice) lines.push(notice);
  if (!unlocked) {
    lines.push(`Pack du jour: ${HOROSCOPE_DAILY_PRICE} Memocoins.`);
    lines.push("Le premier tirage débloque la Prédiction et l'Oracle jusqu'à minuit (heure de Paris).");
    lines.push(`Réinitialisation dans ${resetIn}.`);
  } else {
    lines.push("Ton tirage du jour est déjà débloqué.");
    lines.push(`Réinitialisation dans ${resetIn}.`);
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setColor(color)
    .addFields(
      { name: "💰 Solde total", value: `${total}$`, inline: true },
      { name: "🔓 Accès du jour", value: unlocked ? "Débloqué" : "Verrouillé", inline: true },
      { name: "📅 Jour", value: dayKey, inline: true }
    )
    .setFooter({ text: "Chaque utilisateur reçoit un tirage différent, conservé toute la journée." })
    .setTimestamp();

  if (section === "prediction" && unlocked && horoscope.prediction?.dayKey === dayKey) {
    const details = getHoroscopePredictionDetails(horoscope.prediction);
    embed.addFields(
      { name: "✨ Vibration", value: details.energy, inline: false },
      { name: "🎯 Zone clé", value: details.focus, inline: true },
      { name: "📬 Mouvement", value: details.opening, inline: false },
      { name: "⚠️ Vigilance", value: details.vigilance, inline: false },
      { name: "⏰ Timing", value: details.timing, inline: false },
      { name: "🍀 Signe chance", value: `${details.lucky.label} - ${details.lucky.cue}`, inline: false },
      { name: "🎨 Couleur", value: String(details.color), inline: true },
      { name: "🔢 Nombre", value: String(details.number), inline: true }
    );
  } else if (section === "oracle" && unlocked && horoscope.oracle?.dayKey === dayKey) {
    const rawCards = Array.isArray(horoscope.oracle.cards) ? horoscope.oracle.cards : [];
    const cards = [
      getHoroscopeOracleCard(rawCards[0]),
      getHoroscopeOracleCard(rawCards[1]),
      getHoroscopeOracleCard(rawCards[2])
    ];
    embed.addFields(
      { name: "🌱 Fond", value: `${cards[0].emoji} **${cards[0].name}** (${cards[0].orientation})\n${cards[0].meaning}`, inline: false },
      { name: "🧭 Passage", value: `${cards[1].emoji} **${cards[1].name}** (${cards[1].orientation})\n${cards[1].meaning}`, inline: false },
      { name: "🚪 Issue", value: `${cards[2].emoji} **${cards[2].name}** (${cards[2].orientation})\n${cards[2].meaning}`, inline: false },
      { name: "🔮 Lecture", value: buildHoroscopeOracleSummary(horoscope.oracle), inline: false }
    );
  } else if (section === "menu") {
    embed.addFields(
      { name: "🔮 Prédiction", value: "Une lecture quotidienne de l'ambiance, du focus et du meilleur timing du jour.", inline: false },
      { name: "🃏 Oracle", value: "Trois cartes aléatoires pour lire la direction de ta vie sur la journée.", inline: false }
    );
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("horoscope_prediction").setLabel("🔮 Prédiction").setStyle(ButtonStyle.Primary).setDisabled(unlocked && section === "prediction"),
    new ButtonBuilder().setCustomId("horoscope_oracle").setLabel("🃏 Oracle").setStyle(ButtonStyle.Success).setDisabled(unlocked && section === "oracle")
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu_jeux").setLabel("🔙 Retour").setStyle(ButtonStyle.Secondary),
    buildRefreshButton()
  );

  return { embed, components: [row1, row2] };
}

async function refreshBankMenuMessage(userId) {
  const record = bankMenuMessageMap.get(userId);
  if (!record) return;
  try {
    const channel = await zodiClient.channels.fetch(record.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const msg = await channel.messages.fetch(record.messageId).catch(() => null);
    if (!msg) return;
    const view = buildBankMenuView(userId);
    await msg.edit({ embeds: [view.embed], components: view.components }).catch(() => {});
  } catch (e) {}
}

async function sendConversionMessage(channel, userId, label, fromAmount, toAmount) {
  if (!channel || !channel.send) return;
  try {
    await channel.send(`🏦 Conversion: <@${userId}> a converti ${fromAmount} ${label} → ${toAmount} Memocoins (banque).`);
  } catch (e) {}
}

async function deleteMessagesBeforeShutdown(channel, mode = "none", options = {}) {
  if (!channel || !channel.messages || mode === "none") return { deleted: 0, scanned: 0 };
  const skipMessageId = options.skipMessageId || null;
  const preserveBotCommandMessages = options.preserveBotCommandMessages === true;

  let deleted = 0;
  let scanned = 0;
  let before = undefined;

  // Scan channel history in batches (up to 10,000 messages safeguard).
  for (let pass = 0; pass < 100; pass++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const msgs = [...batch.values()];
    scanned += msgs.length;

    for (const m of msgs) {
      if (skipMessageId && m.id === skipMessageId) continue;

      const isBotMsg = m.author?.id === zodiClient.user?.id;
      const isInteractiveCommandMsg = (m.components?.length || 0) > 0;
      const isBotEmbedMsg = (m.embeds?.length || 0) > 0;

      let shoulddelete = false;
      if (mode === "all") {
        shoulddelete = true;
      } else if (mode === "commands_only") {
        shoulddelete = isBotMsg && (isInteractiveCommandMsg || isBotEmbedMsg);
      }

      if (!shoulddelete) continue;
      if (preserveBotCommandMessages) {
        if (isBotMsg && (isInteractiveCommandMsg || isBotEmbedMsg)) continue;
      }
      try {
        await m.delete();
        deleted += 1;
      } catch (e) {}
    }

    before = msgs[msgs.length - 1]?.id;
  }

  return { deleted, scanned };
}

// ==========================

// ==========================
// PRESENCE TRACKING
// ==========================

const PRESENCE_FILE = path.join(__dirname, "presence.json");
const userStatusData = new Map();

// map to track presence display messages: guildId -> Map(userId -> { channelId, messageId })
const presenceDisplayMap = new Map();

function loadPresence() {
  try {
    if (fs.existsSync(PRESENCE_FILE)) {
      const json = JSON.parse(fs.readFileSync(PRESENCE_FILE, "utf8"));
      for (const id in json) userStatusData.set(id, json[id]);
    }
  } catch (e) {
    console.error('Erreur loadPresence:', e);
  }
}
function savePresence() {
  try {
    fs.writeFileSync(PRESENCE_FILE, JSON.stringify(Object.fromEntries(userStatusData), null, 2));
  } catch (e) {
    console.error('Erreur savePresence:', e);
  }
}
loadPresence();

zodiClient.on("presenceUpdate", (oldPresence, newPresence) => {
  if (!newPresence) return;

  const userId = newPresence.userId;
  const status = newPresence.status;
  const now = Date.now();
  const data = ensurePresenceRecord(userId);

  if (!data.currentStatus) {
    data.currentStatus = status;
    data.since = now;
    data.lastChangeAt = now;
    if (status !== "offline") data.lastSeenAt = now;
    data.sessionConnectedSince = status === "offline" ? 0 : now;
    try { savePresence(); } catch (e) { console.error("savePresence error:", e); }
    return;
  }

  if (status === data.currentStatus) return;

  applyPresenceTransition(userId, data.currentStatus, status, now);
  try { savePresence(); } catch (e) { console.error("savePresence error:", e); }
  try {
    for (const [guildId, map] of presenceDisplayMap.entries()) {
      if (map.has(userId)) updatePresenceEmbed(guildId, userId).catch(e => console.error("updatePresenceEmbed error:", e));
    }
  } catch (e) { console.error("presenceUpdate update error:", e); }
});

// build the presence embed for a member (fresh data)
function buildPresenceEmbed(member) {
  const saved = ensurePresenceRecord(member.id);
  const status = member.presence?.status || "offline";

  let sinceText = "Inconnu";
  let lastChange = "Inconnu";
  if (saved.since) {
    const dateFR = new Date(saved.since);
    sinceText = dateFR.toLocaleString("fr-FR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Europe/Paris" });
    lastChange = dateFR.toLocaleString("fr-FR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Europe/Paris" });
  }

  const historyLines = (saved.history || []).slice(0, 10).map((h, i) => {
    const atText = new Date(h.at || Date.now()).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Europe/Paris"
    });
    const durText = formatShortDuration(Math.max(0, Number(h.durationMs || 0)));
    return `${i + 1}. ${formatStatusLabel(h.from)} → ${formatStatusLabel(h.to)} | ${atText} | ${durText}`;
  });
  const previousStatusRaw = historyLines.length ? historyLines.join("\n") : "Aucun changement enregistré.";
  const previousStatus = previousStatusRaw.length > 1000 ? `${previousStatusRaw.slice(0, 997)}...` : previousStatusRaw;

  const isConnectedStatus = status === "online" || status === "idle" || status === "dnd";
  if (isConnectedStatus && !saved.sessionConnectedSince) {
    saved.sessionConnectedSince = saved.since || Date.now();
    savePresence();
  }
  const currentAccumulated = isConnectedStatus && saved.sessionConnectedSince
    ? Math.max(0, Date.now() - saved.sessionConnectedSince)
    : 0;

  let statusText = "⚫ Hors ligne";
  let color = 0x808080;
  if (status === "online") { statusText = "🟢 En ligne"; color = 0x00ff00; }
  else if (status === "idle") { statusText = "🟡 Inactif"; color = 0xffcc00; }
  else if (status === "dnd") { statusText = "🔴 Ne pas déranger"; color = 0xff0000; }

  const lastSeenText = saved.lastSeenAt
    ? new Date(saved.lastSeenAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Europe/Paris" })
    : "Inconnu";

  const embed = new EmbedBuilder()
    .setTitle(`${member.displayName} - ${member.user.username}`)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setColor(color)
    .addFields(
      { name: "État", value: statusText, inline: true },
      { name: "Depuis", value: sinceText, inline: true },
      { name: "Dernier changement", value: lastChange, inline: true },
      { name: "Temps cumulé état actuel", value: formatDuration(currentAccumulated), inline: true },
      { name: "État précédent", value: previousStatus, inline: false },
      { name: "Dernière activité visible", value: lastSeenText, inline: true },
      { name: "ID Utilisateur", value: member.id, inline: true }
    )
    .setFooter({ text: "Zodi Bot - Suivi des présences" })
    .setTimestamp();

  return embed;
}

// update a previously sent presence embed for one user in a guild
async function updatePresenceEmbed(guildId, userId) {
  const guildMap = presenceDisplayMap.get(guildId);
  if (!guildMap) return;
  const entry = guildMap.get(userId);
  if (!entry) return;

  try {
    const channel = await zodiClient.channels.fetch(entry.channelId).catch(() => null);
    if (!channel) { guildMap.delete(userId); return; }
    const message = await channel.messages.fetch(entry.messageId).catch(() => null);
    if (!message) { guildMap.delete(userId); return; }

    const guild = zodiClient.guilds.cache.get(guildId);
    if (!guild) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const newEmbed = buildPresenceEmbed(member);
    await message.edit({ embeds: [newEmbed] }).catch(e => {
      // if message can't be edited, remove from map
      console.error('Failed to edit presence message:', e);
      guildMap.delete(userId);
    });
  } catch (e) {
    console.error('updatePresenceEmbed exception:', e);
  }
}

// periodic refresh of displayed presence embeds
setInterval(() => {
  try {
    for (const [guildId, map] of presenceDisplayMap.entries()) {
      for (const userId of map.keys()) {
        updatePresenceEmbed(guildId, userId).catch(() => {});
      }
    }
  } catch (e) { console.error('Periodic presence refresh error:', e); }
}, 15_000);

setInterval(() => {
  processCyberSecurityTimers().catch(e => console.error("processCyberSecurityTimers error:", e));
}, 60_000);

// ==========================
// READY
// ==========================
zodiClient.once("ready", async () => {
  console.log("Zodi Bot connecte !");
  await clearUiBindingMessage().catch(() => {});
  const savedStatus = loadBotStatus();
  try { await zodiClient.user.setPresence(buildPresencePayload(savedStatus || "online")); } catch (e) {}
  await applyBotProfileSettings().catch(() => {});
  await enforceAllowedGuilds().catch(() => {});
  processCyberSecurityTimers().catch(() => {});
});

zodiClient.on("guildCreate", async guild => {
  await ensureGuildAllowed(guild);
});

// ==========================
// MESSAGE COMMANDS
// ==========================
zodiClient.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;

  try { updateFalseOfflineFlag(msg.author.id, msg.member?.presence?.status || "offline"); } catch (e) {}

  if (!msg.content.startsWith("Zodi ")) return;

  const cmd = msg.content.slice(5).trim().toLowerCase();
  if (maintenanceModeEnabled && !isAdminUser(msg.author.id)) {
    try { await msg.reply("🛠️ Le bot est en maintenance."); } catch (e) {}
    return;
  }

  async function replyAnddelete(response) {
    if (typeof response === "string") {
      await msg.reply(response);
    } else {
      await msg.reply({ embeds: [response] });
    }
    await msg.delete().catch(() => {}); // supprimé le message de commande
  }

  // --------------------------
  // MENU PRINCIPAL ZODI /
  // --------------------------
  if (cmd === "/") {
    const view = buildMainMenuView();
    let menuMsg = null;
    const existing = mainMenuMessageMap.get(msg.author.id);
    if (existing && existing.channelId === msg.channel.id) {
      const oldMsg = await msg.channel.messages.fetch(existing.messageId).catch(() => null);
      if (oldMsg) {
        await oldMsg.edit({ embeds: [view.embed], components: view.components }).catch(() => {});
        menuMsg = oldMsg;
      }
    }
    if (!menuMsg) {
      menuMsg = await msg.reply({ embeds: [view.embed], components: view.components });
      if (menuMsg?.id) mainMenuMessageMap.set(msg.author.id, { channelId: msg.channel.id, messageId: menuMsg.id });
    }
    if (menuMsg?.id) zodiOwnerMap.set(menuMsg.id, msg.author.id);
    return msg.delete().catch(() => {});
  }

  // (Le menu admin texte "/2" a été retiré et utilise le bouton Admin dans le menu principal.)

  // --------------------------
  // VOL
  // --------------------------
  if (cmd.startsWith("steal ")) {
    if (isInPrison(msg.author.id)) {
      await msg.reply("⛓️ Tu es en prison. Vol impossible.");
      return msg.delete().catch(() => {});
    }
    const user = msg.mentions.users.first();
    const amount = parseInt(cmd.split(" ")[2]);
    if (!user || isNaN(amount) || amount <= 0) {
      await msg.reply("❌ Utilisation: `Zodi steal @user <montant>`.");
      return msg.delete().catch(() => {});
    }

    const victim = getBalance(user.id);
    const thief = getBalance(msg.author.id);

    if (hasPoliceLock(msg.author.id)) {
      const remaining = formatShortDuration(getPoliceWaitRemainingMs(msg.author.id));
      await msg.reply(`🚫 Menus de jeux bloques par la police. Temps restant: ${remaining}.`);
      return msg.delete().catch(() => {});
    }

    if (victim.antiStealProtection > 0) {
      victim.antiStealProtection -= 1;
      saveData();
      await msg.reply("\u{26A1} Cette cible est protégée contre le vol. 1 protection consommée.");
      return msg.delete().catch(() => {});
    }

    const policeCatchChance = getPoliceCatchChanceForAmount(amount);
    if (Math.random() < policeCatchChance) {
      if (tryConsumePoliceProtection(msg.author.id)) {
        await msg.reply(`\ud83d\udee1\ufe0f Ta protection anti-police a bloqué l'arrestation (chance: ${formatPercent(policeCatchChance)}). 1 protection consommée.`);
        return msg.delete().catch(() => {});
      }
      triggerPoliceLock(msg.author.id);
      await msg.reply(`👮 Tu t'es fait attraper par la police (chance: ${formatPercent(policeCatchChance)}). Tous les menus de jeux sont bloques pendant 1 jour.`);
      return msg.delete().catch(() => {});
    }

    if (!hasEnoughMemocoin(user.id, amount)) {
      await msg.reply("\u274C Vol refusé: la victime ne possède pas cette somme (inventaire + banque).");
      return msg.delete().catch(() => {});
    }

    const stolen = amount;
    spendMemocoinInventoryThenBank(user.id, stolen);
    thief.inventory += stolen;
    saveData();

    await msg.reply(`\u{1F4B8} Tu as vole ${stolen} Memocoins. Risque police pour ce vol: ${formatPercent(policeCatchChance)}.`);
    return msg.delete().catch(() => {});
  }

  // --------------------------
  // MEMOCOIN ADMIN GIVE/REMOVE
  // Usage: Zodi memocoin give @user 100
  //        Zodi memocoin remove @user 100
  // --------------------------
  if (cmd.startsWith("memocoin ")) {
    const parts = cmd.split(/\s+/);
    const action = parts[1]; // give or remove

    // permission check: manage guild or administrator
    const member = msg.member;
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await msg.reply("❌ Tu n'as pas la permission d'utiliser cette commande (Administrateur requis).");
      return msg.delete().catch(() => {});
    }

    const target = msg.mentions.users.first();
    const amount = parseInt(parts[3]);
    if (!target || isNaN(amount) || amount <= 0) {
      await msg.reply("❌ Utilisation: `Zodi memocoin give @user <montant>` (montant positif).");
      return msg.delete().catch(() => {});
    }

    if (action === "give") {
      addMemocoin(target.id, amount);
      await msg.reply(`\u2705 ${amount} Memocoins ajoutés à ${target.tag}.`);
      return msg.delete().catch(() => {});
    }

    if (action === "remove") {
      initUser(target.id);
      const bal = getBalance(target.id);
      const toRemove = Math.min(bal.inventory, amount);
      bal.inventory -= toRemove;
      saveData();
      await msg.reply(`\u2705 ${toRemove} Memocoins retirés de ${target.tag}.`);
      return msg.delete().catch(() => {});
    }

    await msg.reply("❌ Action inconnue. Utilise `give` ou `remove`.");
    return msg.delete().catch(() => {});
  }

  // --------------------------
  // LISTE OFFLINE (Zodi /2)
  // --------------------------
  if (cmd === "listeoffline") {
    await msg.guild.members.fetch();
    const members = msg.guild.members.cache.filter(m => !m.user.bot);

    for (const member of members.values()) {
      const embed = buildPresenceEmbed(member);
      await msg.channel.send({ embeds: [embed] });
    }

    return msg.delete().catch(() => {});
  }
});

// log bot messages that mention users (actions that concern them)
zodiClient.on("messageCreate", async msg => {
  try {
    if (!msg.guild) return;
    if (msg.author?.id !== zodiClient.user?.id) return;

    const targets = new Set();
    if (msg.mentions?.users?.size) {
      for (const u of msg.mentions.users.values()) targets.add(u.id);
    }
    if (msg.mentions?.repliedUser?.id) targets.add(msg.mentions.repliedUser.id);
    if (!targets.size) return;

    let summary = (msg.content || "").trim();
    if (!summary && msg.embeds?.length) {
      const e = msg.embeds[0];
      const parts = [];
      if (e.title) parts.push(e.title);
      if (e.description) parts.push(e.description);
      summary = parts.join(" — ").trim();
    }
    if (!summary) return;
    const actions = extractActionRowsFromMessage(msg);
    for (const id of targets) addActionLog(id, summary, actions);
  } catch (e) {}
});

// ==========================
// INTERACTIONS
// ==========================
async function handleZodiComponentInteraction(interaction) {
  if (interaction.type !== InteractionType.MessageComponent) return;
  const userId = interaction.user.id;
  const customId = typeof interaction.customId === "string" ? interaction.customId : "";
  if (customId === "ui_presence_prev" || customId === "ui_presence_next") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    if (!uiPresencePages.length) {
      return interaction.reply({ content: "Aucune page de présence disponible.", ephemeral: true });
    }
    if (customId === "ui_presence_prev") {
      uiPresencePageIndex = Math.max(0, uiPresencePageIndex - 1);
    } else {
      uiPresencePageIndex = Math.min(uiPresencePages.length - 1, uiPresencePageIndex + 1);
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ui_presence_prev").setLabel("◀️ Précédent").setStyle(ButtonStyle.Secondary).setDisabled(uiPresencePageIndex <= 0),
      new ButtonBuilder().setCustomId("ui_presence_next").setLabel("Suivant ▶️").setStyle(ButtonStyle.Secondary).setDisabled(uiPresencePageIndex >= uiPresencePages.length - 1),
      new ButtonBuilder().setCustomId("admin_bot_powers").setLabel("🔙 Retour").setStyle(ButtonStyle.Primary)
    );
    return interaction.update({ embeds: [uiPresencePages[uiPresencePageIndex]], components: [row] });
  }
  const originalReply = interaction.reply.bind(interaction);
  interaction.reply = (options) => {
    if (options && typeof options === "object" && typeof options.ephemeral === "undefined") {
      options.ephemeral = false;
    }
    const logText = extractReplyText(options);
    const actions = extractActionRowsFromOptions(options);
    if (logText || actions) addActionLog(userId, logText || "Actions disponibles.", actions);
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.followUp === "function") return interaction.followUp(options);
      if (typeof interaction.editReply === "function") return interaction.editReply(options);
    }
    return originalReply(options);
  };
  if (typeof interaction.followUp === "function") {
    const originalFollowUp = interaction.followUp.bind(interaction);
    interaction.followUp = (options) => {
      if (options && typeof options === "object" && typeof options.ephemeral === "undefined") {
        options.ephemeral = false;
      }
      const logText = extractReplyText(options);
      const actions = extractActionRowsFromOptions(options);
      if (logText || actions) addActionLog(userId, logText || "Actions disponibles.", actions);
      return originalFollowUp(options);
    };
  }
  if (typeof interaction.update === "function") {
    const originalUpdate = interaction.update.bind(interaction);
    interaction.update = async (options) => {
      if (interaction.deferred || interaction.replied) {
        if (interaction.message && typeof interaction.message.edit === "function") {
          return interaction.message.edit(options);
        }
        if (typeof interaction.editReply === "function") return interaction.editReply(options);
        if (typeof interaction.followUp === "function") return interaction.followUp(options);
      }
      const logText = extractReplyText(options);
      const actions = extractActionRowsFromOptions(options);
      if (logText || actions) addActionLog(userId, logText || "Actions disponibles.", actions);
      return originalUpdate(options);
    };
  }
  if (interaction.type === InteractionType.MessageComponent && !isModalTriggerCustomId(customId)) {
    try { await interaction.deferUpdate(); } catch (e) {}
  }
  try { updateFalseOfflineFlag(userId, interaction.member?.presence?.status || "offline"); } catch (e) {}
  if (maintenanceModeEnabled && !isAdminUser(userId)) {
    try { return interaction.reply({ content: "🛠️ Le bot est en maintenance. Seul l'administrateur peut l'utiliser.", ephemeral: true }); } catch (e) { return; }
  }
  if (interaction.type === InteractionType.MessageComponent) {
    const messageId = interaction.message?.id;
    const ownerId = messageId ? zodiOwnerMap.get(messageId) : null;
    if (ownerId && ownerId !== userId) {
      const title = interaction.message?.embeds?.[0]?.title || "";
      const isAdminScreen = title.includes("Menu Admin") || title.includes("Give Objet") || title.includes("Réinitialiser") || title.includes("Pouvoirs du bot") || title.includes("Statut du bot") || title.includes("STOP prison") || title.includes("Prison") || title.includes("Réglage dette") || title.includes("Cybersécurité");
      if (!(userId === ADMIN_ONLY_USER_ID && isAdminScreen)) {
        return interaction.reply({ content: "\u274C Seul l'utilisateur de la commande peut utiliser ces boutons.", ephemeral: true });
      }
    }
  }

  // Modals Minecraft (quantité) désactivées pour éviter les fenêtres supplémentaires.

  if (interaction.customId === "refresh_page") {
    const title = interaction.message?.embeds?.[0]?.title || "";
    const ids = getMessageCustomIds(interaction.message);
    const isGameScreen =
      ids.has("roulette_spin") ||
      ids.has("casino_play") ||
      ids.has("slot_play") ||
      Array.from(ids).some(id => id.startsWith("blackjack_")) ||
      ids.has("steal_execute") ||
      ids.has("shop_buy_reset_slot") ||
      ids.has("shop_buy_reset_casino") ||
      ids.has("shop_buy_reset_steal") ||
      ids.has("shop_buy_reset_roulette") ||
      ids.has("merchant_buy_1") ||
      ids.has("merchant_buy_2") ||
      ids.has("merchant_buy_3") ||
      ids.has("merchant_buy_4") ||
      ids.has("merchant_buy_5") ||
      ids.has("merchant_closed") ||
      ids.has("mc_chop_wood") ||
      ids.has("pk_start") ||
      ids.has("dg_start") ||
      ids.has("zb_start") ||
      title.includes("Jeux") ||
      title.includes("Voler") ||
      title.includes("Casino") ||
      title.includes("Blackjack") ||
      title.includes("Slotomania") ||
      title.includes("Roulette") ||
      title.includes("Horoscope") ||
      title.includes("Prédiction du jour") ||
      title.includes("Oracle du jour") ||
      title.includes("Magasin") ||
      title.includes("Marchand ambulant") ||
      title.includes("Memocoin") ||
      title.includes("Minecraft") ||
      title.includes("Pokémon") ||
      title.includes("Donjon") ||
      title.includes("Apocalypse Zombie") ||
      title.includes("Historique");

    if (isInPrison(userId) && isGameScreen) {
      const blocked = buildPrisonBlockedView(userId);
      return interaction.update({ embeds: [blocked.embed], components: blocked.components });
    }

    if (hasPoliceLock(userId) && isGameScreen) {
      const blocked = buildPoliceBlockedView(userId);
      return interaction.update({ embeds: [blocked.embed], components: blocked.components });
    }

    if (ids.has("roulette_spin") || title.includes("Roulette")) {
      if (!isRouletteOwner(interaction)) {
        return interaction.reply({ content: "\u274C Cette roulette appartient à un autre joueur.", ephemeral: true });
      }
      const view = buildRouletteView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("steal_execute") || ids.has("steal_cancel") || ids.has("steal_select_user") || title.includes("Voler")) {
      const embed = buildStealEmbed(userId);
      return interaction.update({ embeds: [embed], components: buildStealControlComponents(userId) });
    }

    if (ids.has("horoscope_prediction") || ids.has("horoscope_oracle") || title.includes("Horoscope") || title.includes("Prédiction du jour") || title.includes("Oracle du jour")) {
      const section = title.includes("Prédiction du jour")
        ? "prediction"
        : title.includes("Oracle du jour")
          ? "oracle"
          : "menu";
      const view = buildHoroscopeView(userId, section);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (Array.from(ids).some(id => id.startsWith("blackjack_")) || title.includes("Blackjack")) {
      if (!isBlackjackOwner(interaction)) {
        return interaction.reply({ content: "\u274C Ce Blackjack appartient à un autre joueur.", ephemeral: true });
      }
      const view = buildBlackjackView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("casino_play") || title.includes("Casino")) {
      if (!isCasinoOwner(interaction)) {
        return interaction.reply({ content: "\u274C Ce Casino appartient à un autre joueur.", ephemeral: true });
      }
      const view = buildCasinoView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("slot_play") || title.includes("Slotomania")) {
      if (!isSlotOwner(interaction)) {
        return interaction.reply({ content: "\u274C Ce Slotomania appartient à un autre joueur.", ephemeral: true });
      }
      const view = buildSlotomaniaView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("mc_chop_wood") || ids.has("mc_craft_planks") || title.includes("Minecraft")) {
      syncMinecraftMenuFromMessage(userId, interaction.message);
      const view = getMinecraftCurrentView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("pk_throw_ball_poke") || ids.has("pk_throw_ball_super") || ids.has("pk_throw_ball_hyper") || ids.has("pk_throw_ball_dusk") || ids.has("pk_throw_ball_master") || title.includes("Pokéballs")) {
      const view = buildPokemonBallMenuView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("pk_start") || ids.has("pk_attack") || title.includes("Pokémon")) {
      const view = buildPokemonView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("dg_start") || ids.has("dg_attack") || title.includes("Donjon")) {
      const view = buildDonjonView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("zb_start") || ids.has("zb_attack") || title.includes("Apocalypse Zombie")) {
      const view = buildZombieView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("mc_shop_buy_wood") || title.includes("Boutique Minecraft")) {
      const view = buildMinecraftShopView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (ids.has("pk_shop_buy_potion") || title.includes("Boutique Pokémon")) {
      const view = buildPokemonShopView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (ids.has("dg_shop_buy_shield") || title.includes("Boutique Donjon")) {
      const view = buildDonjonShopView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (ids.has("zb_shop_buy_medkit") || title.includes("Boutique Zombie")) {
      const view = buildZombieShopView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (ids.has("mm_shop_buy_anti_steal") || title.includes("Boutique Memocoin")) {
      const view = buildMemocoinShopView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("merchant_buy_1") || ids.has("merchant_buy_2") || ids.has("merchant_buy_3") || ids.has("merchant_buy_4") || ids.has("merchant_buy_5") || ids.has("merchant_closed") || title.includes("Marchand ambulant")) {
      const view = buildTravelingMerchantView(userId, { forceNew: true });
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("shop_cat_jeux_argent") || title.includes("Boutiques")) {
      const view = buildShopHubView();
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("shop_buy_reset_slot") || ids.has("shop_buy_reset_casino") || ids.has("shop_buy_reset_steal") || ids.has("shop_buy_reset_roulette")) {
      const view = buildMoneyShopView(userId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("bank_convert_mc") || ids.has("bank_convert_pk") || ids.has("bank_convert_dg") || ids.has("bank_convert_zb") || title.includes("Banque")) {
      const view = buildBankMenuView(userId);
      if (interaction.message?.id && interaction.channelId) {
        bankMenuMessageMap.set(userId, { channelId: interaction.channelId, messageId: interaction.message.id });
      }
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("status_select_user") || ids.has("status_info") || ids.has("status_classement")) {
      const memberName = interaction.member?.displayName || interaction.user.username;
      const embed = buildStatusEmbed(userId, memberName);
      const userSelect = new UserSelectMenuBuilder()
        .setCustomId("status_select_user")
        .setPlaceholder("Voir le statut d'un membre...")
        .setMinValues(1)
        .setMaxValues(1);
      const row1 = new ActionRowBuilder().addComponents(userSelect);
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("status_info").setLabel("\u{1F4CA} Mon statut").setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId("status_classement").setLabel("\u{1F3C6} Classement").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
        buildRefreshButton(),
      );
      return interaction.update({ embeds: [embed], components: [row1, row2] });
    }

    if (
      ids.has("chatgpt_ask") ||
      ids.has("zodi_chat_topic_free") ||
      ids.has("zodi_chat_topic_mood") ||
      ids.has("zodi_chat_topic_games") ||
      ids.has("zodi_chat_topic_ideas") ||
      ids.has("zodi_chat_topic_help") ||
      title.includes("Discuter avec Zodi") ||
      title.includes("ChatGPT")
    ) {
      const view = buildZodiChatView();
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("reset_select_user")) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const targetId = resetSelectionMap.get(userId) || null;
      const view = buildAdminResetView(targetId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("reset_game_mc") || ids.has("reset_game_pk") || ids.has("reset_game_dg") || ids.has("reset_game_zb") || ids.has("reset_game_all") || ids.has("reset_game_back") || title.includes("Réinitialiser jeux")) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const targetId = resetSelectionMap.get(userId) || null;
      const view = buildAdminResetGamesView(targetId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("admin_presence") || ids.has("admin_purge_messages")) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const view = buildBotPowersView();
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (
      ids.has("bot_status_online") ||
      ids.has("bot_status_idle") ||
      ids.has("bot_status_dnd") ||
      ids.has("bot_status_offline") ||
      title.includes("Statut du bot")
    ) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const view = buildBotStatusView();
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("prison_select_user") || ids.has("prison_release") || title.includes("STOP prison")) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const targetId = prisonSelectionMap.get(userId) || null;
      const view = buildAdminPrisonView(targetId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (ids.has("admin_debt_enable") || ids.has("admin_debt_disable") || title.includes("Réglage dette")) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const view = buildAdminDebtView();
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (
      ids.has("cyber_select_user") ||
      ids.has("cyber_ban_temp") ||
      ids.has("cyber_silence_on") ||
      ids.has("cyber_ban_perm") ||
      ids.has("cyber_ban_ip") ||
      ids.has("cyber_unban_selected") ||
      ids.has("cyber_quarantine_on") ||
      ids.has("cyber_quarantine_off") ||
      ids.has("cyber_warning_on") ||
      ids.has("cyber_warning_off") ||
      ids.has("cyber_list_sanctions") ||
      title.includes("Cybersécurité")
    ) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const targetId = cyberSelectionMap.get(userId) || null;
      const guild = await resolveInteractionGuild(interaction);
      const view = buildAdminCybersecurityView(targetId, null, guild?.id || null);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (title.includes("Prison")) {
      const blocked = buildPrisonBlockedView(userId);
      return interaction.update({ embeds: [blocked.embed], components: blocked.components });
    }

    if (ids.has("admin_memocoin") || ids.has("admin_reset") || ids.has("admin_bot_powers") || ids.has("admin_prison") || ids.has("admin_debt") || ids.has("admin_cybersecurity") || ids.has("admin_stop_bot") || ids.has("admin_restart_bot")) {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true });
      }
      const view = buildAdminMenuView();
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    return interaction.update({ embeds: interaction.message.embeds, components: interaction.message.components });
  }

  if (interaction.customId === "police_reduce_wait") {
    if (isInPrison(userId)) {
      return interaction.reply({ content: "⛓️ Tu es en prison. Paiement indisponible.", ephemeral: true });
    }
    const remaining = getPoliceWaitRemainingMs(userId);
    if (remaining <= 0) {
      return interaction.reply({ content: "✅ Tu n'es plus bloque par la police.", ephemeral: true });
    }
    if (!spendMemocoinInventoryThenBank(userId, POLICE_REDUCE_PRICE)) {
      return interaction.reply({ content: getDebtBlockedReason("Paiement"), ephemeral: true });
    }
    const bal = getBalance(userId);
    bal.policeLockUntil = Math.max(Date.now(), (bal.policeLockUntil || 0) - POLICE_REDUCE_MS);
    saveData();
    const blocked = buildPoliceBlockedView(userId);
    return interaction.update({ embeds: [blocked.embed], components: blocked.components });
  }

  if (isInPrison(userId) && isPrisonRestrictedInteractionId(interaction.customId) && interaction.customId !== "menu_jeux" && interaction.customId !== "menu_jeux_argent") {
    const remaining = formatShortDuration(getPrisonRemainingMs(userId));
    return interaction.reply({ content: `⛓️ Tu es en prison. Temps restant: ${remaining}.`, ephemeral: true });
  }

  if (hasPoliceLock(userId) && isGameInteractionId(interaction.customId) && interaction.customId !== "menu_jeux") {
    const remaining = formatShortDuration(getPoliceWaitRemainingMs(userId));
    return interaction.reply({ content: `🚫 Menus de jeux bloques par la police. Temps restant: ${remaining}. Ouvre le menu Jeux pour payer -1h.`, ephemeral: true });
  }

  // --------------------------
  // MENU ADMIN ZODI /2
  // --------------------------
  if (interaction.customId === "admin_entry") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const view = buildAdminMenuView();
    try { return interaction.update({ embeds: [view.embed], components: view.components }); } catch (e) { try { return interaction.reply({ content: "Impossible d'afficher le menu admin.", ephemeral: true }); } catch(e){} }
  }
  if (interaction.customId === "admin_memocoin") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const embed = new EmbedBuilder()
      .setTitle("\u{1F4B0} Give Objet")
      .setColor(0xff9900)
      .setDescription("Sélectionne un utilisateur puis choisis une action.");

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId("memocoin_select_user")
      .setPlaceholder("Choisir un utilisateur...")
      .setMinValues(1)
      .setMaxValues(1);

    const row1 = new ActionRowBuilder().addComponents(userSelect);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("back_admin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton(),
    );
    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }

  if (interaction.customId === "admin_reset") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const targetId = resetSelectionMap.get(interaction.user.id) || null;
    const view = buildAdminResetView(targetId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "admin_prison") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const targetId = prisonSelectionMap.get(interaction.user.id) || null;
    const view = buildAdminPrisonView(targetId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "admin_debt") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const view = buildAdminDebtView();
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "admin_cybersecurity") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const targetId = cyberSelectionMap.get(interaction.user.id) || null;
    const guild = await resolveInteractionGuild(interaction);
    const view = buildAdminCybersecurityView(targetId, null, guild?.id || null);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId.startsWith("cyber_")) {
    const guild = await resolveInteractionGuild(interaction);
    const processingState = getCyberAlertProcessingState(guild?.id || null);
    if (processingState) {
      return interaction.reply({ content: getCyberAlertProcessingLabel(processingState), ephemeral: true });
    }
  }

  if (interaction.customId === "admin_debt_enable" || interaction.customId === "admin_debt_disable") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    debtModeEnabled = interaction.customId === "admin_debt_enable";
    saveData();
    try {
      await interaction.channel.send(
        debtModeEnabled
          ? `💳 Les dettes sont maintenant activées par <@${interaction.user.id}> (limite: ${PRISON_DEBT_LIMIT}$).`
          : `💳 Les dettes sont maintenant désactivées par <@${interaction.user.id}> (minimum: 0$).`
      );
    } catch (e) {}
    const view = buildAdminDebtView(debtModeEnabled ? "✅ Les dettes sont activées." : "✅ Les dettes sont désactivées.");
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "cyber_ban_temp" || interaction.customId === "cyber_silence_on") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    if (!targetId) {
      return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true });
    }
    if (targetId === ADMIN_ONLY_USER_ID) {
      return interaction.reply({ content: "❌ Action refusée sur le compte administrateur principal.", ephemeral: true });
    }

    const isTempBan = interaction.customId === "cyber_ban_temp";
    const modal = new ModalBuilder()
      .setCustomId(`${isTempBan ? "cyber_modal_tempban" : "cyber_modal_silence"}_${adminId}_${targetId}`)
      .setTitle(isTempBan ? "Ban temporaire" : "Réduire en silence");
    const durationInput = new TextInputBuilder()
      .setCustomId(isTempBan ? "cyber_ban_duration" : "cyber_silence_duration")
      .setLabel("Durée (ex: 30m, 12h, 7j, 1mo)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder("Exemple: 7j");
    const reasonInput = new TextInputBuilder()
      .setCustomId(isTempBan ? "cyber_ban_reason" : "cyber_silence_reason")
      .setLabel("Raison")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder(isTempBan ? "Raison du ban temporaire" : "Raison de la réduction en silence");
    modal.addComponents(
      new ActionRowBuilder().addComponents(durationInput),
      new ActionRowBuilder().addComponents(reasonInput)
    );
    return interaction.showModal(modal);
  }

  if (interaction.customId === "cyber_ban_perm" || interaction.customId === "cyber_ban_ip") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    if (!targetId) {
      return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true });
    }
    if (targetId === ADMIN_ONLY_USER_ID) {
      return interaction.reply({ content: "❌ Action refusée sur le compte administrateur principal.", ephemeral: true });
    }

    const guild = await resolveInteractionGuild(interaction);
    if (!guild) return interaction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

    const type = interaction.customId === "cyber_ban_ip" ? "ip" : "ban";
    try {
      const result = await applyCyberBan(guild, targetId, adminId, {
        type,
        reason: type === "ip" ? "Ban IP simulé (Discord ne fournit pas d'IP)." : "Ban administrateur"
      });
      const label = type === "ip" ? "🌐 Ban IP simulé" : "⛔ Ban définitif";
      const view = buildAdminCybersecurityView(
        targetId,
        `${label} appliqué à <@${targetId}>.${result.expiresAt ? ` Durée: ${formatCyberUntilLabel(result.expiresAt)}.` : ""}`,
        guild.id
      );
      try {
        await interaction.channel.send(
          type === "ip"
            ? `🌐 Cybersécurité: <@${adminId}> a appliqué un **ban IP simulé** à <@${targetId}>.`
            : `⛔ Cybersécurité: <@${adminId}> a banni <@${targetId}> définitivement.`
        );
      } catch (e) {}
      return interaction.update({ embeds: [view.embed], components: view.components });
    } catch (e) {
      return interaction.reply({ content: `❌ Impossible d'appliquer le ban: ${e?.message || e}`, ephemeral: true });
    }
  }

  if (interaction.customId === "cyber_unban_selected") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    if (!targetId) {
      return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true });
    }

    const guild = await resolveInteractionGuild(interaction);
    if (!guild) return interaction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

    const messages = [];
    const silenceEntry = getCyberSilenceEntry(guild.id, targetId);
    const banEntry = getCyberBanEntry(guild.id, targetId);
    const quarantineEntry = getCyberQuarantineEntry(guild.id, targetId);
    if (silenceEntry?.active) {
      const silenceResult = await releaseCyberSilence(guild, targetId, adminId, "Réduction en silence retirée par admin");
      messages.push(silenceResult.ok ? "silence retiré" : "échec retrait silence");
    }
    if (banEntry?.active) {
      const unbanResult = await releaseCyberBan(guild, targetId, adminId, "Sanction retirée par admin");
      messages.push(unbanResult.ok ? "ban retiré" : "échec retrait ban");
    }
    if (quarantineEntry?.active) {
      const released = await releaseCyberQuarantine(guild, targetId, adminId, "Quarantaine retirée par admin");
      messages.push(released.ok ? "quarantaine retirée" : "échec retrait quarantaine");
    }
    if (!messages.length) {
      return interaction.reply({ content: "ℹ️ Aucune sanction active sur cette cible.", ephemeral: true });
    }

    const view = buildAdminCybersecurityView(targetId, `✅ ${messages.join(" / ")}.`, guild.id);
    try {
      await interaction.channel.send(`🔓 Cybersécurité: <@${adminId}> a retiré les sanctions de <@${targetId}> (${messages.join(", ")}).`);
    } catch (e) {}
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "cyber_unban_by_id") {
    return interaction.reply({ content: "ℹ️ Le bouton 'Retirer sanction ID' a été retiré de la cybersécurité.", ephemeral: true });
  }

  if (interaction.customId === "cyber_quarantine_on") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    if (!targetId) {
      return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true });
    }
    if (targetId === ADMIN_ONLY_USER_ID) {
      return interaction.reply({ content: "❌ Action refusée sur le compte administrateur principal.", ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`cyber_modal_quarantine_${adminId}_${targetId}`)
      .setTitle("Mise en quarantaine");
    const durationInput = new TextInputBuilder()
      .setCustomId("cyber_quarantine_duration")
      .setLabel("Durée (ex: 30m, 12h, 7j, 1mo)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder("Exemple: 7j");
    const reasonInput = new TextInputBuilder()
      .setCustomId("cyber_quarantine_reason")
      .setLabel("Raison")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder("Raison de la mise en quarantaine");
    modal.addComponents(
      new ActionRowBuilder().addComponents(durationInput),
      new ActionRowBuilder().addComponents(reasonInput)
    );
    return interaction.showModal(modal);
  }

  if (interaction.customId === "cyber_quarantine_off") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    if (!targetId) {
      return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true });
    }
    const guild = await resolveInteractionGuild(interaction);
    if (!guild) return interaction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

    const result = await releaseCyberQuarantine(guild, targetId, adminId, "Quarantaine retirée par admin");
    if (!result.ok) {
      return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    }
    const view = buildAdminCybersecurityView(targetId, result.note ? `✅ ${result.note}` : "✅ Quarantaine retirée et rôles restaurés.", guild.id);
    try {
      await interaction.channel.send(`🟢 Cybersécurité: <@${adminId}> a retiré la quarantaine de <@${targetId}>.`);
    } catch (e) {}
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "cyber_warning_on") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const guild = await resolveInteractionGuild(interaction);
    if (!guild) return interaction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });
    const alreadyProcessing = getCyberAlertProcessingState(guild.id);
    if (alreadyProcessing) {
      return interaction.reply({ content: getCyberAlertProcessingLabel(alreadyProcessing), ephemeral: true });
    }

    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    setCyberAlertProcessingState(guild.id, "warning_on", adminId);
    const processingView = buildAdminCybersecurityView(
      targetId,
      "⏳ Warning lancé. Le bouton reste bloqué jusqu'à la fin de l'application des rôles.",
      guild.id
    );
    try {
      await interaction.update({ embeds: [processingView.embed], components: processingView.components });
    } catch (e) {
      clearCyberAlertProcessingState(guild.id);
      try { return interaction.reply({ content: "❌ Impossible de verrouiller le menu cybersécurité.", ephemeral: true }); } catch (e2) { return; }
    }

    let statusText = null;
    let followUpText = null;
    let announceText = null;
    try {
      const result = await applyCyberWarningAlert(guild, adminId);
      if (!result.ok) {
        statusText = `❌ ${result.error}`;
        followUpText = `❌ ${result.error}`;
      } else {
        statusText =
          `🌋 Warning activé. ${result.affectedCount} membre(s) mis en quarantaine.` +
          ` ${result.skippedExistingCount} déjà en quarantaine conservé(s).` +
          ` ${result.skippedHierarchyCount} non gérable(s).` +
          ` ${result.skippedSafetyCount} compte(s) protégé(s) ignoré(s).` +
          (result.failedCount ? ` ${result.failedCount} échec(s).` : "");
        announceText = `🌋 Cybersécurité: <@${adminId}> a déclenché le warning global du serveur.`;
      }
    } catch (e) {
      statusText = `❌ Erreur pendant le warning global: ${e?.message || e}`;
      followUpText = statusText;
    } finally {
      clearCyberAlertProcessingState(guild.id);
    }

    const finalView = buildAdminCybersecurityView(targetId, statusText, guild.id);
    try {
      await interaction.message.edit({ embeds: [finalView.embed], components: finalView.components });
    } catch (e) {}
    if (announceText) {
      try { await interaction.channel.send(announceText); } catch (e) {}
    }
    if (followUpText) {
      try { await interaction.followUp({ content: followUpText, ephemeral: true }); } catch (e) {}
    }
    return;
  }

  if (interaction.customId === "cyber_warning_off") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const guild = await resolveInteractionGuild(interaction);
    if (!guild) return interaction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });
    const alreadyProcessing = getCyberAlertProcessingState(guild.id);
    if (alreadyProcessing) {
      return interaction.reply({ content: getCyberAlertProcessingLabel(alreadyProcessing), ephemeral: true });
    }

    const adminId = interaction.user.id;
    const targetId = cyberSelectionMap.get(adminId) || null;
    setCyberAlertProcessingState(guild.id, "warning_off", adminId);
    const processingView = buildAdminCybersecurityView(
      targetId,
      "⏳ Fin d'alerte lancée. Le bouton reste bloqué jusqu'à la restauration complète des rôles.",
      guild.id
    );
    try {
      await interaction.update({ embeds: [processingView.embed], components: processingView.components });
    } catch (e) {
      clearCyberAlertProcessingState(guild.id);
      try { return interaction.reply({ content: "❌ Impossible de verrouiller le menu cybersécurité.", ephemeral: true }); } catch (e2) { return; }
    }

    let statusText = null;
    let followUpText = null;
    let announceText = null;
    try {
      const result = await releaseCyberWarningAlert(guild, adminId);
      if (!result.ok) {
        statusText = `❌ ${result.error}`;
        followUpText = `❌ ${result.error}`;
      } else {
        statusText =
          `📢 Fin d'alerte. ${result.restoredCount} membre(s) restauré(s).` +
          ` ${result.preservedQuarantineCount} quarantaine(s) individuelle(s) conservée(s).` +
          ` ${result.missingCount} absent(s).` +
          (result.failedCount ? ` ${result.failedCount} échec(s) de restauration.` : "");
        announceText = `📢 Cybersécurité: <@${adminId}> a mis fin au warning global du serveur.`;
      }
    } catch (e) {
      statusText = `❌ Erreur pendant la fin d'alerte: ${e?.message || e}`;
      followUpText = statusText;
    } finally {
      clearCyberAlertProcessingState(guild.id);
    }

    const finalView = buildAdminCybersecurityView(targetId, statusText, guild.id);
    try {
      await interaction.message.edit({ embeds: [finalView.embed], components: finalView.components });
    } catch (e) {}
    if (announceText) {
      try { await interaction.channel.send(announceText); } catch (e) {}
    }
    if (followUpText) {
      try { await interaction.followUp({ content: followUpText, ephemeral: true }); } catch (e) {}
    }
    return;
  }

  if (interaction.customId === "cyber_list_sanctions") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
    }
    const guild = await resolveInteractionGuild(interaction);
    if (!guild) return interaction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

    const lines = buildCyberSanctionLinesForGuild(guild.id, 20);
    const statusText = lines.length
      ? `📜 Sanctions actives:\n${lines.join("\n")}`
      : "📜 Aucune sanction active pour ce serveur.";
    const targetId = cyberSelectionMap.get(interaction.user.id) || null;
    const view = buildAdminCybersecurityView(targetId, statusText, guild.id);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  // --------------------------
  // BACK TO ADMIN MENU
  // BACK TO ADMIN MENU
  // --------------------------
  if (interaction.customId === "back_admin") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const view = buildAdminMenuView();

    try {
      return interaction.update({ embeds: [view.embed], components: view.components });
    } catch (e) {
      try { return interaction.reply({ content: 'Impossible de restaurer le menu admin.', ephemeral: true }); } catch(e){}
    }
  }

  if (interaction.customId === "admin_presence") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    await interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F4E1} Suivi des présences").setDescription("Affichage des présences (regroupées) ci-dessous...")], components: [] });
    try {
      const targetGuild = interaction.guild || await getUiPrimaryGuild();
      if (!targetGuild) {
        try { await interaction.channel.send("❌ Impossible d'accéder au serveur pour lire les présences."); } catch (e) {}
        return;
      }
      await targetGuild.members.fetch({ withPresences: true }).catch(() => targetGuild.members.fetch().catch(() => {}));
      const members = targetGuild.members.cache.filter(m => !m.user.bot);

      if (interaction.channel?.id === "local-ui") {
        uiPresencePages = buildPresenceSummaryPages(members);
        uiPresencePageIndex = 0;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ui_presence_prev").setLabel("◀️ Précédent").setStyle(ButtonStyle.Secondary).setDisabled(uiPresencePages.length <= 1),
          new ButtonBuilder().setCustomId("ui_presence_next").setLabel("Suivant ▶️").setStyle(ButtonStyle.Secondary).setDisabled(uiPresencePages.length <= 1),
          new ButtonBuilder().setCustomId("admin_bot_powers").setLabel("🔙 Retour").setStyle(ButtonStyle.Primary)
        );
        const first = uiPresencePages[0] || new EmbedBuilder().setTitle("📡 Suivi des présences").setDescription("Aucun membre trouvé.");
        await interaction.update({ embeds: [first], components: [row] }).catch(() => {});
        return;
      }
      const buckets = { online: [], idle: [], dnd: [], offline: [] };
      let skipped = 0;

      for (const member of members.values()) {
        try {
          const status = member.presence?.status || "offline";
          const embed = buildPresenceEmbed(member);
          if (status === "online") buckets.online.push(embed);
          else if (status === "idle") buckets.idle.push(embed);
          else if (status === "dnd") buckets.dnd.push(embed);
          else buckets.offline.push(embed);
        } catch (e) {
          skipped += 1;
        }
      }

      // send embeds in batches (safer: 5 embeds max per message)
      const sendEmbedsInBatches = async (embedsArray) => {
        const batchSize = 5;
        for (let i = 0; i < embedsArray.length; i += batchSize) {
          const batch = embedsArray.slice(i, i + batchSize);
          try {
            await interaction.channel.send({ embeds: batch });
            await sleep(350);
          } catch (e) {
            // fallback: send one by one and skip broken embeds
            for (const one of batch) {
              try {
                await interaction.channel.send({ embeds: [one] });
                await sleep(350);
              } catch (e2) {}
            }
          }
        }
      };

      // Order: online, idle, dnd, offline
      await sendEmbedsInBatches(buckets.online);
      await sendEmbedsInBatches(buckets.idle);
      await sendEmbedsInBatches(buckets.dnd);
      await sendEmbedsInBatches(buckets.offline);
      if (skipped > 0) {
        try { await interaction.channel.send(`⚠️ ${skipped} profil(s) présence ignoré(s) (données invalides).`); } catch (e) {}
      }

      // restore bot powers menu on the original message so the command remains usable
      try {
        const view = buildBotPowersView();
        await interaction.message.edit({ embeds: [view.embed], components: view.components }).catch(() => {});
      } catch (e) { /* ignore restore errors */ }

    } catch (e) {
      console.error('Erreur admin_presence:', e);
      try { await interaction.channel.send("Erreur lors de l'affichage des présences."); } catch(e){}
    }
    return;
  }

  if (interaction.customId === "admin_bot_powers") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const view = buildBotPowersView();
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "admin_bot_status") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const view = buildBotStatusView();
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (
    interaction.customId === "bot_status_online" ||
    interaction.customId === "bot_status_idle" ||
    interaction.customId === "bot_status_dnd" ||
    interaction.customId === "bot_status_offline"
  ) {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    if (!zodiClient?.user) {
      try { return interaction.reply({ content: "❌ Bot non prêt.", ephemeral: true }); } catch (e) { return; }
    }
    let status = "online";
    if (interaction.customId === "bot_status_idle") status = "idle";
    if (interaction.customId === "bot_status_dnd") status = "dnd";
    if (interaction.customId === "bot_status_offline") status = "invisible";
    try {
      await zodiClient.user.setPresence(buildPresencePayload(status));
      saveBotStatus(status);
    } catch (e) {
      try { return interaction.reply({ content: "❌ Impossible de changer le statut.", ephemeral: true }); } catch (e2) { return; }
    }
    const view = buildBotStatusView(`✅ Statut mis à jour : **${formatBotPresenceLabel(status)}**.`);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "admin_maintenance_on" || interaction.customId === "admin_maintenance_off") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    maintenanceModeEnabled = interaction.customId === "admin_maintenance_on";
    try {
      if (maintenanceModeEnabled) {
        await interaction.channel.send(`🛠️ Maintenance activée par <@${interaction.user.id}>.`);
      } else {
        await interaction.channel.send(`✅ Maintenance arrêtée par <@${interaction.user.id}>.`);
      }
    } catch (e) {}
    const view = buildAdminMenuView();
    return interaction.update({ embeds: [view.embed], components: view.components });
  }


  if (interaction.customId === "admin_purge_messages") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_purge_all_confirm").setLabel("Confirmer la suppression totale").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("admin_purge_all_cancel").setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      content: "⚠️ Cette action supprime tous les messages récents non épinglés du salon actuel. Continuer ?",
      components: [row],
      ephemeral: true
    });
  }

  if (interaction.customId === "admin_purge_all_confirm" || interaction.customId === "admin_purge_all_cancel") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    if (interaction.customId === "admin_purge_all_cancel") {
      return interaction.update({ content: "✅ Suppression annulée.", components: [] });
    }
    clearActionLogs(ADMIN_ONLY_USER_ID);
    await interaction.update({ content: "🧹 Suppression des messages en cours...", components: [] }).catch(() => {});
    const skipMessageId = interaction.message?.id || null;
    const result = await deleteMessagesBeforeShutdown(interaction.channel, "all", {
      skipMessageId
    }).catch(() => ({ deleted: 0, scanned: 0 }));
    try {
      await interaction.channel.send(`🧹 Purge terminée par <@${interaction.user.id}>. Messages supprimés: ${result.deleted || 0}.`);
    } catch (e) {}
    return;
  }

  if (interaction.customId === "admin_stop_bot") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_stop_none").setLabel("Ne rien supprimer").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_stop_commands").setLabel("Supprimer les commandes").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_stop_all").setLabel("Supprimer tout").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("admin_stop_cancel").setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      content: "🛑 Choisis quoi supprimer avant l'arrêt du bot (salon actuel).",
      components: [row],
      ephemeral: true
    });
  }

  if (interaction.customId === "admin_restart_bot") {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_restart_reset").setLabel("Reset + redémarrer").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("admin_restart_normal").setLabel("Redémarrage normal").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("admin_restart_cancel").setLabel("Annuler").setStyle(ButtonStyle.Secondary)
    );
    return interaction.reply({
      content: "⚠️ Choisis le type de redémarrage.",
      components: [row],
      ephemeral: true
    });
  }

  if (
    interaction.customId === "admin_restart_reset" ||
    interaction.customId === "admin_restart_normal" ||
    interaction.customId === "admin_restart_cancel"
  ) {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }

    if (interaction.customId === "admin_restart_cancel") {
      return interaction.reply({ content: "✅ Redémarrage annulé.", ephemeral: true });
    }

    if (interaction.customId === "admin_restart_reset") {
      clearActionLogs(ADMIN_ONLY_USER_ID);
      await interaction.update({ components: [] }).catch(() => {});
      const skipMessageId = interaction.message?.id || null;
      const result = await deleteMessagesBeforeShutdown(interaction.channel, "all", { skipMessageId }).catch(() => ({ deleted: 0, scanned: 0 }));
      try {
        await interaction.followUp({
          content: `🧹 Reset effectué. Messages supprimés: ${result.deleted || 0}. Redémarrage en cours...`,
          ephemeral: true
        });
      } catch (e) {}
      persistRestartNotice(interaction.channel?.id, interaction.user.id);
      setTimeout(() => {
        triggerRestart().catch(e => console.error("triggerRestart error:", e));
      }, 500);
      return;
    }

    await interaction.update({ components: [] }).catch(() => {});
    try { await interaction.followUp({ content: "🔄 Redémarrage normal en cours...", ephemeral: true }); } catch (e) {}
    persistRestartNotice(interaction.channel?.id, interaction.user.id);
    setTimeout(() => {
      triggerRestart().catch(e => console.error("triggerRestart error:", e));
    }, 500);
    return;
  }

  if (
    interaction.customId === "admin_stop_none" ||
    interaction.customId === "admin_stop_commands" ||
    interaction.customId === "admin_stop_all" ||
    interaction.customId === "admin_stop_cancel"
  ) {
    if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }

    if (interaction.customId === "admin_stop_cancel") {
      return interaction.reply({ content: "✅ Arrêt annulé.", ephemeral: true });
    }

    let mode = "none";
    if (interaction.customId === "admin_stop_commands") mode = "commands_only";
    if (interaction.customId === "admin_stop_all") {
      mode = "all";
      clearActionLogs(ADMIN_ONLY_USER_ID);
    }

    await interaction.update({ components: [] }).catch(() => {});

    let deleted = 0;
    if (mode !== "none") {
      const result = await deleteMessagesBeforeShutdown(interaction.channel, mode).catch(() => ({ deleted: 0, scanned: 0 }));
      deleted = result.deleted || 0;
    }

    try {
      const modeText = mode === "none" ? "" : (mode === "commands_only" ? ` Messages de commande supprimés: ${deleted}.` : ` Tous les messages supprimés: ${deleted}.`);
      await interaction.followUp({ content: `🛑 Arrêt du bot en cours.${modeText}`, ephemeral: true });
    } catch (e) {}

    try {
      await interaction.channel.send(`🛑 Le bot a été arrêté par <@${interaction.user.id}>.`);
    } catch (e) {}

    setTimeout(() => {
      stopBotViaPm2().catch(e => console.error("stopBotViaPm2 error:", e));
    }, 500);
    return;
  }

  if (interaction.customId === "menu_zodi_chat" || interaction.customId === "menu_chatgpt") {
    const modal = buildZodiChatModal(userId, "free");
    return interaction.showModal(modal);
  }


  if (interaction.customId === "chatgpt_ask" || interaction.customId.startsWith("zodi_chat_topic_")) {
    const modal = buildZodiChatModal(userId, "free");
    return interaction.showModal(modal);
  }

  // --------------------------
  // MENU JEUX
  // --------------------------
  if (interaction.customId === "menu_jeux") {
    if (isInPrison(userId)) {
      const blocked = buildPrisonBlockedView(userId);
      return interaction.update({ embeds: [blocked.embed], components: blocked.components });
    }
    if (hasPoliceLock(userId)) {
      const blocked = buildPoliceBlockedView(userId);
      return interaction.update({ embeds: [blocked.embed], components: blocked.components });
    }
    const embed = new EmbedBuilder()
      .setTitle("\u{1F3AE} Jeux")
      .setDescription("Choisis un jeu.")
      .setColor(0x3498db);

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("\u{1FA99} Memocoin").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("jeu_shop").setLabel("\u{1F6D2} Magasin").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("status_info").setLabel("\u{1F4CA} Statut").setStyle(ButtonStyle.Success)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_minecraft").setLabel("\ud83c\udf0f Minecraft").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("jeu_pokemon").setLabel("\ud83c\udf0e Pokemon").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("jeu_dongon").setLabel("\ud83e\udde8 Donjon").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("jeu_calcule").setLabel("\u{1F9EE} Calcul").setStyle(ButtonStyle.Success)
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("\u{1F4B8} Jeux d'argent").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("jeu_apocalipse_zombi").setLabel("\ud83e\udddf\u200d\u2642\ufe0f Apocalypse Zombie").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("jeu_horoscope").setLabel("🔮 Horoscope").setStyle(ButtonStyle.Secondary)
    );
    const row4 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_back").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );

    return interaction.update({ embeds: [embed], components: [row1, row2, row3, row4] });
  }

  if (interaction.customId === "jeu_minecraft") {
    const mc = getMinecraft(userId);
    mc.lastMenu = "main";
    const view = buildMinecraftView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "mc_menu_craft" ||
      interaction.customId === "mc_menu_craft_items" ||
      interaction.customId === "mc_menu_craft_tools" ||
      interaction.customId === "mc_menu_craft_weapons" ||
      interaction.customId === "mc_menu_craft_armors" ||
      interaction.customId === "mc_menu_craft_swords" ||
      interaction.customId === "mc_menu_craft_pickaxes" ||
      interaction.customId === "mc_menu_craft_axes" ||
      interaction.customId === "mc_menu_craft_portals" ||
      interaction.customId === "mc_menu_repair" ||
      interaction.customId === "mc_menu_explore" ||
      interaction.customId === "mc_menu_portals" ||
      interaction.customId === "mc_menu_biome" ||
      interaction.customId === "mc_menu_world" ||
      interaction.customId === "mc_menu_food" ||
      interaction.customId === "mc_menu_furnace" ||
      interaction.customId === "mc_menu_farm" ||
      interaction.customId === "mc_menu_farm_harvest" ||
      interaction.customId === "mc_menu_rest" ||
      interaction.customId === "mc_menu_equip_pickaxe" ||
      interaction.customId === "mc_menu_equip_sword" ||
      interaction.customId === "mc_menu_equip_axe" ||
      interaction.customId === "mc_menu_travel" ||
      interaction.customId === "mc_menu_trade" ||
      interaction.customId === "mc_menu_build" ||
      interaction.customId === "mc_menu_mob") {
    const map = {
      mc_menu_craft: "craft",
      mc_menu_craft_items: "craft_items",
      mc_menu_craft_tools: "craft_tools",
      mc_menu_craft_weapons: "craft_swords",
      mc_menu_craft_swords: "craft_swords",
      mc_menu_craft_pickaxes: "craft_pickaxes",
      mc_menu_craft_axes: "craft_axes",
      mc_menu_craft_armors: "craft_armors",
      mc_menu_craft_portals: "craft_portals",
      mc_menu_repair: "repair",
      mc_menu_explore: "explore",
      mc_menu_portals: "biome",
      mc_menu_biome: "biome",
      mc_menu_world: "world",
      mc_menu_furnace: "furnace",
      mc_menu_farm: "farm",
      mc_menu_food: "food",
      mc_menu_farm_harvest: "farm_harvest",
      mc_menu_rest: "rest",
      mc_menu_equip_pickaxe: "equip_pickaxe",
      mc_menu_equip_sword: "equip_sword",
      mc_menu_equip_axe: "equip_axe",
      mc_menu_travel: "biome",
      mc_menu_trade: "trade",
      mc_menu_build: "build",
      mc_menu_mob: "mob"
    };
    const mc = getMinecraft(userId);
    mc.lastMenu = map[interaction.customId];
    const view = buildMinecraftSubmenuView(userId, map[interaction.customId]);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "mc_chop_wood" ||
      interaction.customId === "mc_find_structure" ||
      interaction.customId === "mc_find_cave" ||
      interaction.customId === "mc_cave_mine" ||
      interaction.customId === "mc_cave_continue" ||
      interaction.customId === "mc_cave_exit" ||
      interaction.customId === "mc_craft_planks" ||
      interaction.customId === "mc_craft_table" ||
      interaction.customId === "mc_craft_sticks" ||
      interaction.customId === "mc_craft_flint_steel" ||
      interaction.customId === "mc_craft_pickaxe" ||
      interaction.customId === "mc_craft_stone_pickaxe" ||
      interaction.customId === "mc_craft_iron_pickaxe" ||
      interaction.customId === "mc_craft_diamond_pickaxe" ||
      interaction.customId === "mc_craft_netherite_pickaxe" ||
      interaction.customId === "mc_craft_axe_wood" ||
      interaction.customId === "mc_craft_axe_stone" ||
      interaction.customId === "mc_craft_axe_iron" ||
      interaction.customId === "mc_craft_axe_diamond" ||
      interaction.customId === "mc_craft_axe_netherite" ||
      interaction.customId === "mc_mine_stone" ||
      interaction.customId === "mc_craft_furnace" ||
      interaction.customId === "mc_smelt_iron" ||
      interaction.customId === "mc_smelt_gold" ||
      interaction.customId === "mc_smelt_netherite" ||
      interaction.customId === "mc_smelt_beef" ||
      interaction.customId === "mc_smelt_mutton" ||
      interaction.customId === "mc_smelt_pork" ||
      interaction.customId === "mc_smelt_chicken" ||
      interaction.customId === "mc_mine_diamond" ||
      interaction.customId === "mc_explore" ||
      interaction.customId === "mc_change_biome" ||
      interaction.customId === "mc_world_overworld" ||
      interaction.customId === "mc_world_nether" ||
      interaction.customId === "mc_world_end" ||
      interaction.customId === "mc_build_nether_portal" ||
      interaction.customId === "mc_enter_nether" ||
      interaction.customId === "mc_craft_eye" ||
      interaction.customId === "mc_open_end_portal" ||
      interaction.customId === "mc_enter_end" ||
      interaction.customId === "mc_trade_sell" ||
      interaction.customId === "mc_trade_buy" ||
      interaction.customId === "mc_build_house" ||
      interaction.customId === "mc_mob_attack" ||
      interaction.customId === "mc_mob_flee" ||
      interaction.customId === "mc_eat_beef" ||
      interaction.customId === "mc_eat_pork" ||
      interaction.customId === "mc_eat_mutton" ||
      interaction.customId === "mc_eat_chicken" ||
      interaction.customId === "mc_rest" ||
      interaction.customId === "mc_rest_sleep" ||
      interaction.customId === "mc_rest_awake" ||
      interaction.customId.startsWith("mc_select_pickaxe_") ||
      interaction.customId.startsWith("mc_select_sword_") ||
      interaction.customId.startsWith("mc_select_axe_") ||
      interaction.customId === "mc_repair_tool" ||
      interaction.customId === "mc_repair_tool_wood" ||
      interaction.customId === "mc_repair_tool_stone" ||
      interaction.customId === "mc_repair_tool_iron" ||
      interaction.customId === "mc_repair_tool_diamond" ||
      interaction.customId === "mc_repair_tool_netherite" ||
      interaction.customId === "mc_repair_axe_wood" ||
      interaction.customId === "mc_repair_axe_stone" ||
      interaction.customId === "mc_repair_axe_iron" ||
      interaction.customId === "mc_repair_axe_diamond" ||
      interaction.customId === "mc_repair_axe_netherite" ||
      interaction.customId === "mc_repair_sword_wood" ||
      interaction.customId === "mc_repair_sword_stone" ||
      interaction.customId === "mc_repair_sword_iron" ||
      interaction.customId === "mc_repair_sword_diamond" ||
      interaction.customId === "mc_repair_sword_netherite" ||
      interaction.customId === "mc_repair_armor_iron" ||
      interaction.customId === "mc_repair_armor_diamond" ||
      interaction.customId === "mc_repair_armor_netherite" ||
      interaction.customId === "mc_convert_emerald" ||
      interaction.customId === "mc_craft_sword_wood" ||
      interaction.customId === "mc_craft_sword_stone" ||
      interaction.customId === "mc_craft_sword_iron" ||
      interaction.customId === "mc_craft_sword_diamond" ||
      interaction.customId === "mc_craft_sword_netherite" ||
      interaction.customId === "mc_craft_armor_iron_helmet" ||
      interaction.customId === "mc_craft_armor_iron_chest" ||
      interaction.customId === "mc_craft_armor_iron_legs" ||
      interaction.customId === "mc_craft_armor_iron_boots" ||
      interaction.customId === "mc_craft_armor_diamond_helmet" ||
      interaction.customId === "mc_craft_armor_diamond_chest" ||
      interaction.customId === "mc_craft_armor_diamond_legs" ||
      interaction.customId === "mc_craft_armor_diamond_boots" ||
      interaction.customId === "mc_craft_armor_netherite_helmet" ||
      interaction.customId === "mc_craft_armor_netherite_chest" ||
      interaction.customId === "mc_craft_armor_netherite_legs" ||
      interaction.customId === "mc_craft_armor_netherite_boots" ||
      interaction.customId === "mc_plant_wheat" ||
      interaction.customId === "mc_plant_potato" ||
      interaction.customId === "mc_plant_pumpkin" ||
      interaction.customId === "mc_plant_carrot" ||
      interaction.customId === "mc_plant_beetroot" ||
      interaction.customId === "mc_harvest_crops") {
    let mc = getMinecraft(userId);
    normalizeMinecraftWorld(mc);
    let notice = "Action Minecraft effectuée.";
    let conversionInfo = null;
    let died = false;
    const now = Date.now();
    const isMobAction = interaction.customId === "mc_mob_attack" || interaction.customId === "mc_mob_flee";
    const isFoodAction = interaction.customId.startsWith("mc_eat_");
    const isSelectAction = interaction.customId.startsWith("mc_select_pickaxe_") ||
      interaction.customId.startsWith("mc_select_sword_") ||
      interaction.customId.startsWith("mc_select_axe_");
    const deathWaitMs = Math.max(0, (mc.deadUntil || 0) - now);
    if (deathWaitMs > 0) {
      return interaction.reply({ content: `💀 Tu es mort. Réapparition dans ${formatShortDuration(deathWaitMs)}.`, ephemeral: true });
    }
    if (mc.encounter && !(isMobAction || isFoodAction || isSelectAction)) {
      return interaction.reply({ content: "❌ Un combat est en cours. Utilise Attaquer, Fuite ou Manger.", ephemeral: true });
    }

    if (interaction.customId === "mc_explore") {
      const wait = Math.max(0, (mc.exploreCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Exploration en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId === "mc_find_structure") {
      const wait = Math.max(0, (mc.structureCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Recherche de structure en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId === "mc_find_cave") {
      const wait = Math.max(0, (mc.caveSearchCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Recherche de grotte en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId === "mc_cave_mine") {
      const wait = Math.max(0, (mc.caveMineCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `⏱️ Minage en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId === "mc_cave_continue") {
      const wait = Math.max(0, (mc.caveContinueCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Exploration de grotte en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId === "mc_cave_exit") {
      const wait = Math.max(0, (mc.caveExitCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Sortie de grotte en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if ((interaction.customId === "mc_change_biome" ||
         interaction.customId === "mc_world_overworld" ||
         interaction.customId === "mc_world_nether" ||
         interaction.customId === "mc_world_end") && mc.inCave) {
      return interaction.reply({ content: "❌ Impossible de changer de biome dans une grotte.", ephemeral: true });
    }
    if (interaction.customId === "mc_change_biome") {
      const wait = Math.max(0, (mc.biomeCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Changement de biome en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId === "mc_world_overworld" || interaction.customId === "mc_world_nether" || interaction.customId === "mc_world_end") {
      const wait = Math.max(0, (mc.biomeCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Changement de monde en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }
    if (interaction.customId.startsWith("mc_plant_")) {
      const wait = Math.max(0, (mc.plantCooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `❌ Plantation en recharge. Attends ${formatShortDuration(wait)}.`, ephemeral: true });
    }

    if (!isSelectAction &&
        interaction.customId !== "mc_rest" &&
        interaction.customId !== "mc_rest_sleep" &&
        interaction.customId !== "mc_rest_awake" &&
        interaction.customId !== "mc_change_biome" &&
        interaction.customId !== "mc_world_overworld" &&
        interaction.customId !== "mc_world_nether" &&
        interaction.customId !== "mc_world_end" &&
        interaction.customId !== "mc_convert_emerald" &&
        interaction.customId !== "mc_mob_attack" &&
        interaction.customId !== "mc_mob_flee" &&
        !interaction.customId.startsWith("mc_eat_")) {
      if ((mc.energy || 0) <= 0) return interaction.reply({ content: "❌ Plus d'énergie. Utilise Repos.", ephemeral: true });
      mc.energy = Math.max(0, (mc.energy || 0) - 8);
    }

    if (interaction.customId.startsWith("mc_select_pickaxe_")) {
      const choice = interaction.customId.replace("mc_select_pickaxe_", "");
      if (choice === "auto") {
        mc.selectedPickaxe = "auto";
        notice = "🧰 Pioche sélectionnée: Auto.";
      } else {
        const def = getPickaxeDef(choice);
        if (!def || !mc[def.key] || (mc[def.durKey] || 0) <= 0) {
          return interaction.reply({ content: "❌ Tu n'as pas cette pioche.", ephemeral: true });
        }
        mc.selectedPickaxe = choice;
        notice = `🧰 Pioche sélectionnée: ${def.label}.`;
      }
    } else if (interaction.customId.startsWith("mc_select_sword_")) {
      const choice = interaction.customId.replace("mc_select_sword_", "");
      if (choice === "fist") {
        mc.selectedSword = "fist";
        notice = "🗡️ Arme sélectionnée: Poings.";
      } else if (choice === "auto") {
        mc.selectedSword = "auto";
        notice = "🗡️ Arme sélectionnée: Auto.";
      } else {
        const def = MC_SWORD_DEFS.find(d => d.id === choice);
        if (!def || !mc[def.key] || (mc[def.durKey] || 0) <= 0) {
          return interaction.reply({ content: "❌ Tu n'as pas cette épée.", ephemeral: true });
        }
        mc.selectedSword = choice;
        notice = `🗡️ Arme sélectionnée: ${def.label}.`;
      }
    } else if (interaction.customId.startsWith("mc_select_axe_")) {
      const choice = interaction.customId.replace("mc_select_axe_", "");
      if (choice === "auto") {
        mc.selectedAxe = "auto";
        notice = "🪓 Hache sélectionnée: Auto.";
      } else {
        const def = MC_AXE_DEFS.find(d => d.id === choice);
        if (!def || !mc[def.key] || (mc[def.durKey] || 0) <= 0) {
          return interaction.reply({ content: "❌ Tu n'as pas cette hache.", ephemeral: true });
        }
        mc.selectedAxe = choice;
        notice = `🪓 Hache sélectionnée: ${def.label}.`;
      }
    } else if (interaction.customId === "mc_chop_wood") {
      if (mc.world !== "overworld" || mc.inCave) return interaction.reply({ content: "❌ Tu dois être à la surface pour couper du bois.", ephemeral: true });
      if (!mc.chopAvailable) return interaction.reply({ content: "❌ Coupe déjà effectuée. Explore de nouveau pour réessayer.", ephemeral: true });
      const axe = getSelectedAxeStats(mc);
      const baseGain = 1 + Math.floor(Math.random() * 10);
      const bonus = axe ? (axe.bonus || 0) : 0;
      const gain = baseGain + bonus;
      mc.wood += gain;
      mc.xp += gain;
      mc.chopAvailable = false;
      let farmLoot = "";
      const roll = Math.random();
      if (roll < 0.15) { mc.wheatSeeds += 1; farmLoot = " +1 graine de blé"; }
      else if (roll < 0.24) { mc.pumpkinSeeds += 1; farmLoot = " +1 graine de citrouille"; }
      else if (roll < 0.32) { mc.potatoes += 1; farmLoot = " +1 pomme de terre"; }
      const breakNote = axe ? applyAxeDamage(mc, 4, axe) : "";
      const axeNote = axe ? (bonus > 0 ? ` (bonus ${axe.label})` : ` (hache ${axe.label})`) : "";
        notice = `🪓 Coupe: +${gain} bois${axeNote}.${farmLoot ? ` Butin: ${farmLoot}.` : ""}${breakNote ? ` ${breakNote}` : ""}`;
    } else if (interaction.customId === "mc_find_structure") {
      const world = mc.world || "overworld";
      const biome = mc.currentBiome;
      const biomeKey = world === "overworld" ? getMinecraftBiomeCategory(biome) : world;
      let chance = 0;
      let structure = "";
      if (world === "overworld" && biomeKey === "plaine") { chance = 0.25; structure = "Village"; }
      else if (world === "overworld" && biomeKey === "océan") { chance = 0.05; structure = "Temple sous-marin"; }
      else if (world === "overworld" && biomeKey === "forêt") { chance = 0.01; structure = "Manoir"; }
      else if (world === "nether") { chance = 0.0025; structure = "Cité du Nether"; }
      else if (world === "end") { chance = 0.00001; structure = "Bateau volant"; }

      if (chance > 0 && Math.random() < chance) {
        mc.structuresFound = (mc.structuresFound || 0) + 1;
        mc.lastStructure = structure;
        if (structure === "Village") {
          mc.currentBiome = "village";
          mc.villagerReady = true;
          mc.emeralds += 2;
        } else if (structure === "Temple sous-marin") {
          mc.goldOre = (mc.goldOre || 0) + 1;
          mc.emeralds += 1;
        } else if (structure === "Manoir") {
          mc.totems += 1;
        } else if (structure === "Cité du Nether") {
          mc.netheriteScrap += 1;
          mc.blazeRods += 1;
        } else if (structure === "Bateau volant") {
          mc.enderPearls += 2;
          mc.diamonds += 1;
        }
        mc.xp += 15;
        notice = `🏛️ Structure trouvée: ${structure}.`;
      } else {
        const waitMs = getRandomCooldownMs(MC_STRUCTURE_FAIL_COOLDOWN_MS);
        mc.structureCooldownUntil = now + waitMs;
        notice = `❌ Aucune structure trouvée. Attends ${formatShortDuration(waitMs)}.`;
      }
    } else if (interaction.customId === "mc_find_cave") {
      if (mc.inCave) return interaction.reply({ content: "❌ Tu es déjà dans une grotte.", ephemeral: true });
      if (Math.random() < 0.75) {
        mc.inCave = true;
        mc.caveVein = rollMinecraftCaveVein(mc.world || "overworld");
        mc.caveMineRemaining = mc.caveVein.remaining;
        mc.caveContinueCooldownUntil = 0;
        mc.caveExitCooldownUntil = 0;
        notice = `🕳️ Grotte trouvée. Veine: ${mc.caveVein.label} (${mc.caveMineRemaining} disponibles).`;
      } else {
        const waitMs = getRandomCooldownMs(MC_CAVE_FAIL_COOLDOWN_MS);
        mc.caveSearchCooldownUntil = now + waitMs;
        notice = `❌ Pas de grotte trouvée. Attends ${formatShortDuration(waitMs)}.`;
      }
    } else if (interaction.customId === "mc_cave_mine") {
      if (!mc.inCave || !mc.caveVein || (mc.caveMineRemaining || 0) <= 0) return interaction.reply({ content: "❌ Aucune veine à miner. Continue l'exploration.", ephemeral: true });
      const pick = getSelectedPickaxeDef(mc);
      if (!pick) return interaction.reply({ content: "❌ Tu dois d'abord craft une pioche.", ephemeral: true });
      const tier = pick.tier || 0;
      if (tier < (mc.caveVein.required || 1)) return interaction.reply({ content: "❌ Outil insuffisant pour ce minerai.", ephemeral: true });
      const mineCooldown = MC_CAVE_MINE_COOLDOWN_MIN_MS + Math.floor(Math.random() * (MC_CAVE_MINE_COOLDOWN_MAX_MS - MC_CAVE_MINE_COOLDOWN_MIN_MS + 1));
      const foundNothing = Math.random() < 0.2;
      mc.caveMineRemaining -= 1;
      const breakNote = applyPickaxeDamage(mc, 6, pick);
      mc.caveMineCooldownUntil = now + mineCooldown;
      if (foundNothing) {
        mc.xp += 2;
        notice = "⛏️ Minage: rien trouvé cette fois.";
      } else {
        const amount = mc.caveVein.min + Math.floor(Math.random() * (mc.caveVein.max - mc.caveVein.min + 1));
        if (mc.caveVein.id === "stone") mc.stone += amount;
        else if (mc.caveVein.id === "coal") mc.coal += amount;
        else if (mc.caveVein.id === "ironOre") mc.ironOre += amount;
        else if (mc.caveVein.id === "goldOre") mc.goldOre = (mc.goldOre || 0) + amount;
        else if (mc.caveVein.id === "diamonds") mc.diamonds += amount;
        else if (mc.caveVein.id === "ancientDebris") mc.ancientDebris += amount;
        else if (mc.caveVein.id === "enderPearls") mc.enderPearls += amount;
        else if (mc.caveVein.id === "obsidian") mc.obsidian += amount;
        mc.xp += 6 + amount;
        notice = `⛏️ Minage: +${amount} ${mc.caveVein.label}.`;
      }
      if (breakNote) notice += ` ${breakNote}`;
      notice += ` ⏱️ Prochain minage: ${formatShortDuration(mineCooldown)}.`;
      if (mc.caveMineRemaining <= 0) notice += " Veine épuisée, continue l'exploration.";
    } else if (interaction.customId === "mc_cave_continue") {
      if (!mc.inCave) return interaction.reply({ content: "❌ Tu n'es pas dans une grotte.", ephemeral: true });
      const waitMs = getRandomCooldownMs(MC_CAVE_CONTINUE_COOLDOWN_MS);
      mc.caveContinueCooldownUntil = now + waitMs;
      mc.caveVein = rollMinecraftCaveVein(mc.world || "overworld");
      mc.caveMineRemaining = mc.caveVein.remaining;
      notice = `🧭 Exploration de grotte: nouvelle veine ${mc.caveVein.label} (${mc.caveMineRemaining}). ⏱️ Prochaine exploration: ${formatShortDuration(waitMs)}.`;
      const caveEncounter = maybeStartMinecraftEncounter(mc);
      if (caveEncounter) notice = `${notice} ${caveEncounter}`;
    } else if (interaction.customId === "mc_cave_exit") {
      if (!mc.inCave) return interaction.reply({ content: "❌ Tu n'es pas dans une grotte.", ephemeral: true });
      if (Math.random() < 0.9) {
        mc.inCave = false;
        mc.caveVein = null;
        mc.caveMineRemaining = 0;
        notice = "🚪 Tu sors de la grotte.";
      } else {
        const waitMs = getRandomCooldownMs(MC_CAVE_EXIT_FAIL_COOLDOWN_MS);
        mc.caveExitCooldownUntil = now + waitMs;
        notice = `❌ Tu n'as pas trouvé la sortie. Attends ${formatShortDuration(waitMs)}.`;
      }
    } else if (interaction.customId === "mc_craft_planks") {
      if (mc.wood < 1) return interaction.reply({ content: "❌ Il faut au moins 1 bois.", ephemeral: true });
      mc.wood -= 1;
      mc.planks += 4;
      mc.xp += 2;
      notice = "🧱 Tu as transformé 1 bois en 4 planches.";
    } else if (interaction.customId === "mc_craft_table") {
      if (mc.planks < 4 || mc.hasCraftingTable) return interaction.reply({ content: "❌ Craft impossible.", ephemeral: true });
      mc.planks -= 4;
      mc.hasCraftingTable = true;
      mc.xp += 10;
      notice = "🛠️ Table de craft fabriquée.";
    } else if (interaction.customId === "mc_craft_sticks") {
      if (!mc.hasCraftingTable || mc.planks < 2) return interaction.reply({ content: "❌ Il faut une table de craft et 2 planches.", ephemeral: true });
      mc.planks -= 2;
      mc.sticks += 4;
      mc.xp += 3;
      notice = "🪵 Tu as crafté 4 bâtons.";
    } else if (interaction.customId === "mc_craft_flint_steel") {
      if (mc.hasFlintAndSteel) return interaction.reply({ content: "❌ Tu as déjà un briquet.", ephemeral: true });
      if ((mc.flint || 0) < 1 || mc.ironIngot < 1) {
        return interaction.reply({ content: "❌ Il faut 1 silex + 1 lingot de fer.", ephemeral: true });
      }
      mc.flint -= 1;
      mc.ironIngot -= 1;
      mc.hasFlintAndSteel = true;
      mc.xp += 8;
      notice = "🔥 Briquet fabriqué.";
    } else if (interaction.customId === "mc_craft_pickaxe") {
      if (!mc.hasCraftingTable || mc.planks < 3 || mc.sticks < 2 || mc.hasWoodPickaxe) {
        return interaction.reply({ content: "❌ Il faut 3 planches + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.planks -= 3;
      mc.sticks -= 2;
      mc.hasWoodPickaxe = true;
      mc.woodPickaxeDurability = Math.max(mc.woodPickaxeDurability || 0, 100);
      mc.xp += 20;
      mc.emeralds += 4;
      notice = "⛏️ Pioche en bois craftée. Bonus: +4 émeraudes.";
    } else if (interaction.customId === "mc_craft_axe_wood") {
      if (!mc.hasCraftingTable || mc.planks < 3 || mc.sticks < 2 || mc.hasWoodAxe) {
        return interaction.reply({ content: "❌ Il faut 3 planches + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.planks -= 3;
      mc.sticks -= 2;
      mc.hasWoodAxe = true;
      mc.woodAxeDurability = 80;
      mc.xp += 12;
      notice = "🪓 Hache en bois craftée.";
    } else if (interaction.customId === "mc_craft_axe_stone") {
      if (!mc.hasCraftingTable || mc.stone < 3 || mc.sticks < 2 || mc.hasStoneAxe) {
        return interaction.reply({ content: "❌ Il faut 3 pierres + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.stone -= 3;
      mc.sticks -= 2;
      mc.hasStoneAxe = true;
      mc.stoneAxeDurability = 120;
      mc.xp += 16;
      notice = "🪓 Hache en pierre craftée.";
    } else if (interaction.customId === "mc_craft_axe_iron") {
      if (!mc.hasCraftingTable || mc.ironIngot < 3 || mc.sticks < 2 || mc.hasIronAxe) {
        return interaction.reply({ content: "❌ Il faut 3 lingots de fer + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.ironIngot -= 3;
      mc.sticks -= 2;
      mc.hasIronAxe = true;
      mc.ironAxeDurability = 180;
      mc.xp += 22;
      notice = "🪓 Hache en fer craftée.";
    } else if (interaction.customId === "mc_craft_axe_diamond") {
      if (!mc.hasCraftingTable || mc.diamonds < 3 || mc.sticks < 2 || mc.hasDiamondAxe) {
        return interaction.reply({ content: "❌ Il faut 3 diamants + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.diamonds -= 3;
      mc.sticks -= 2;
      mc.hasDiamondAxe = true;
      mc.diamondAxeDurability = 240;
      mc.xp += 30;
      notice = "🪓 Hache en diamant craftée.";
    } else if (interaction.customId === "mc_craft_axe_netherite") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.sticks < 2 || mc.hasNetheriteAxe) {
        return interaction.reply({ content: "❌ Il faut 2 fragments de netherite + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.netheriteScrap -= 2;
      mc.sticks -= 2;
      mc.hasNetheriteAxe = true;
      mc.netheriteAxeDurability = 300;
      mc.xp += 40;
      notice = "🪓 Hache en netherite craftée.";
    } else if (interaction.customId === "mc_craft_sword_wood") {
      if (!mc.hasCraftingTable || mc.planks < 2 || mc.sticks < 1 || mc.woodSword) return interaction.reply({ content: "❌ Il faut 2 planches + 1 bâton + table de craft.", ephemeral: true });
      mc.planks -= 2;
      mc.sticks -= 1;
      mc.woodSword = true;
      mc.woodSwordDurability = 60;
      mc.xp += 6;
      notice = "🗡️ Épée en bois craftée.";
    } else if (interaction.customId === "mc_craft_sword_stone") {
      if (!mc.hasCraftingTable || mc.stone < 2 || mc.sticks < 1 || mc.stoneSword) return interaction.reply({ content: "❌ Il faut 2 pierres + 1 bâton + table de craft.", ephemeral: true });
      mc.stone -= 2;
      mc.sticks -= 1;
      mc.stoneSword = true;
      mc.stoneSwordDurability = 90;
      mc.xp += 10;
      notice = "🗡️ Épée en pierre craftée.";
    } else if (interaction.customId === "mc_craft_sword_iron") {
      if (!mc.hasCraftingTable || mc.ironIngot < 2 || mc.sticks < 1 || mc.ironSword) return interaction.reply({ content: "❌ Il faut 2 lingots de fer + 1 bâton + table de craft.", ephemeral: true });
      mc.ironIngot -= 2;
      mc.sticks -= 1;
      mc.ironSword = true;
      mc.ironSwordDurability = 140;
      mc.xp += 18;
      notice = "🗡️ Épée en fer craftée.";
    } else if (interaction.customId === "mc_craft_sword_diamond") {
      if (!mc.hasCraftingTable || mc.diamonds < 2 || mc.sticks < 1 || mc.diamondSword) return interaction.reply({ content: "❌ Il faut 2 diamants + 1 bâton + table de craft.", ephemeral: true });
      mc.diamonds -= 2;
      mc.sticks -= 1;
      mc.diamondSword = true;
      mc.diamondSwordDurability = 200;
      mc.xp += 26;
      notice = "🗡️ Épée en diamant craftée.";
    } else if (interaction.customId === "mc_craft_sword_netherite") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.sticks < 1 || mc.netheriteSword) return interaction.reply({ content: "❌ Il faut 2 fragments de netherite + 1 bâton + table de craft.", ephemeral: true });
      mc.netheriteScrap -= 2;
      mc.sticks -= 1;
      mc.netheriteSword = true;
      mc.netheriteSwordDurability = 260;
      mc.xp += 40;
      notice = "🗡️ Épée en netherite craftée.";
    } else if (interaction.customId === "mc_craft_armor_iron_helmet") {
      if (!mc.hasCraftingTable || mc.ironIngot < 5 || mc.ironHelmet) return interaction.reply({ content: "❌ Il faut 5 lingots de fer + table de craft.", ephemeral: true });
      mc.ironIngot -= 5;
      mc.ironHelmet = true;
      mc.ironHelmetDurability = 160;
      mc.xp += 22;
      notice = "🥽 Casque en fer crafté.";
    } else if (interaction.customId === "mc_craft_armor_iron_chest") {
      if (!mc.hasCraftingTable || mc.ironIngot < 8 || mc.ironChestplate) return interaction.reply({ content: "❌ Il faut 8 lingots de fer + table de craft.", ephemeral: true });
      mc.ironIngot -= 8;
      mc.ironChestplate = true;
      mc.ironChestplateDurability = 180;
      mc.xp += 28;
      notice = "🛡️ Plastron en fer crafté.";
    } else if (interaction.customId === "mc_craft_armor_iron_legs") {
      if (!mc.hasCraftingTable || mc.ironIngot < 7 || mc.ironLeggings) return interaction.reply({ content: "❌ Il faut 7 lingots de fer + table de craft.", ephemeral: true });
      mc.ironIngot -= 7;
      mc.ironLeggings = true;
      mc.ironLeggingsDurability = 170;
      mc.xp += 26;
      notice = "👖 Jambières en fer craftées.";
    } else if (interaction.customId === "mc_craft_armor_iron_boots") {
      if (!mc.hasCraftingTable || mc.ironIngot < 4 || mc.ironBoots) return interaction.reply({ content: "❌ Il faut 4 lingots de fer + table de craft.", ephemeral: true });
      mc.ironIngot -= 4;
      mc.ironBoots = true;
      mc.ironBootsDurability = 150;
      mc.xp += 18;
      notice = "🥾 Bottes en fer craftées.";
    } else if (interaction.customId === "mc_craft_armor_diamond_helmet") {
      if (!mc.hasCraftingTable || mc.diamonds < 5 || mc.diamondHelmet) return interaction.reply({ content: "❌ Il faut 5 diamants + table de craft.", ephemeral: true });
      mc.diamonds -= 5;
      mc.diamondHelmet = true;
      mc.diamondHelmetDurability = 220;
      mc.xp += 34;
      notice = "🥽 Casque en diamant crafté.";
    } else if (interaction.customId === "mc_craft_armor_diamond_chest") {
      if (!mc.hasCraftingTable || mc.diamonds < 8 || mc.diamondChestplate) return interaction.reply({ content: "❌ Il faut 8 diamants + table de craft.", ephemeral: true });
      mc.diamonds -= 8;
      mc.diamondChestplate = true;
      mc.diamondChestplateDurability = 240;
      mc.xp += 42;
      notice = "🛡️ Plastron en diamant crafté.";
    } else if (interaction.customId === "mc_craft_armor_diamond_legs") {
      if (!mc.hasCraftingTable || mc.diamonds < 7 || mc.diamondLeggings) return interaction.reply({ content: "❌ Il faut 7 diamants + table de craft.", ephemeral: true });
      mc.diamonds -= 7;
      mc.diamondLeggings = true;
      mc.diamondLeggingsDurability = 230;
      mc.xp += 38;
      notice = "👖 Jambières en diamant craftées.";
    } else if (interaction.customId === "mc_craft_armor_diamond_boots") {
      if (!mc.hasCraftingTable || mc.diamonds < 4 || mc.diamondBoots) return interaction.reply({ content: "❌ Il faut 4 diamants + table de craft.", ephemeral: true });
      mc.diamonds -= 4;
      mc.diamondBoots = true;
      mc.diamondBootsDurability = 210;
      mc.xp += 30;
      notice = "🥾 Bottes en diamant craftées.";
    } else if (interaction.customId === "mc_craft_armor_netherite_helmet") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.netheriteHelmet) return interaction.reply({ content: "❌ Il faut 2 fragments netherite + table de craft.", ephemeral: true });
      mc.netheriteScrap -= 2;
      mc.netheriteHelmet = true;
      mc.netheriteHelmetDurability = 300;
      mc.xp += 52;
      notice = "🥽 Casque en netherite crafté.";
    } else if (interaction.customId === "mc_craft_armor_netherite_chest") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.netheriteChestplate) return interaction.reply({ content: "❌ Il faut 2 fragments netherite + table de craft.", ephemeral: true });
      mc.netheriteScrap -= 2;
      mc.netheriteChestplate = true;
      mc.netheriteChestplateDurability = 320;
      mc.xp += 60;
      notice = "🛡️ Plastron en netherite crafté.";
    } else if (interaction.customId === "mc_craft_armor_netherite_legs") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.netheriteLeggings) return interaction.reply({ content: "❌ Il faut 2 fragments netherite + table de craft.", ephemeral: true });
      mc.netheriteScrap -= 2;
      mc.netheriteLeggings = true;
      mc.netheriteLeggingsDurability = 310;
      mc.xp += 56;
      notice = "👖 Jambières en netherite craftées.";
    } else if (interaction.customId === "mc_craft_armor_netherite_boots") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.netheriteBoots) return interaction.reply({ content: "❌ Il faut 2 fragments netherite + table de craft.", ephemeral: true });
      mc.netheriteScrap -= 2;
      mc.netheriteBoots = true;
      mc.netheriteBootsDurability = 290;
      mc.xp += 46;
      notice = "🥾 Bottes en netherite craftées.";
    } else if (interaction.customId === "mc_plant_wheat") {
      if (mc.wheatSeeds < 1) return interaction.reply({ content: "❌ Il faut 1 graine de blé.", ephemeral: true });
      mc.wheatSeeds -= 1;
      mc.plantedWheat += 1;
      mc.plantCooldownUntil = now + 10 * 60 * 1000;
      mc.harvestReadyAt = Math.max(mc.harvestReadyAt || 0, now + 7 * 24 * 60 * 60 * 1000);
      mc.xp += 6;
      notice = "🌾 Plantation: 1 blé planté. Récolte dans 7 jours.";
    } else if (interaction.customId === "mc_plant_potato") {
      if (mc.potatoes < 1) return interaction.reply({ content: "❌ Il faut 1 pomme de terre.", ephemeral: true });
      mc.potatoes -= 1;
      mc.plantedPotatoes += 1;
      mc.plantCooldownUntil = now + 10 * 60 * 1000;
      mc.harvestReadyAt = Math.max(mc.harvestReadyAt || 0, now + 7 * 24 * 60 * 60 * 1000);
      mc.xp += 6;
      notice = "🥔 Plantation: 1 pomme de terre plantée. Récolte dans 7 jours.";
    } else if (interaction.customId === "mc_plant_pumpkin") {
      if (mc.pumpkinSeeds < 1) return interaction.reply({ content: "❌ Il faut 1 graine de citrouille.", ephemeral: true });
      mc.pumpkinSeeds -= 1;
      mc.plantedPumpkins += 1;
      mc.plantCooldownUntil = now + 10 * 60 * 1000;
      mc.harvestReadyAt = Math.max(mc.harvestReadyAt || 0, now + 7 * 24 * 60 * 60 * 1000);
      mc.xp += 7;
      notice = "🎃 Plantation: 1 citrouille plantée. Récolte dans 7 jours.";
    } else if (interaction.customId === "mc_plant_carrot") {
      if (mc.carrots < 1) return interaction.reply({ content: "❌ Il faut 1 carotte.", ephemeral: true });
      mc.carrots -= 1;
      mc.plantedCarrots += 1;
      mc.plantCooldownUntil = now + 10 * 60 * 1000;
      mc.harvestReadyAt = Math.max(mc.harvestReadyAt || 0, now + 7 * 24 * 60 * 60 * 1000);
      mc.xp += 6;
      notice = "🥕 Plantation: 1 carotte plantée. Récolte dans 7 jours.";
    } else if (interaction.customId === "mc_plant_beetroot") {
      if (mc.beetrootSeeds < 1) return interaction.reply({ content: "❌ Il faut 1 graine de betterave.", ephemeral: true });
      mc.beetrootSeeds -= 1;
      mc.plantedBeetroots += 1;
      mc.plantCooldownUntil = now + 10 * 60 * 1000;
      mc.harvestReadyAt = Math.max(mc.harvestReadyAt || 0, now + 7 * 24 * 60 * 60 * 1000);
      mc.xp += 7;
      notice = "🌱 Plantation: 1 betterave plantée. Récolte dans 7 jours.";
    } else if (interaction.customId === "mc_harvest_crops") {
      if (!mc.harvestReadyAt || mc.harvestReadyAt > now) {
        const wait = mc.harvestReadyAt ? formatShortDuration(mc.harvestReadyAt - now) : "indisponible";
        return interaction.reply({ content: `❌ Récolte pas prête. Attends ${wait}.`, ephemeral: true });
      }
      const totalPlanted = (mc.plantedWheat || 0) + (mc.plantedPotatoes || 0) + (mc.plantedPumpkins || 0) + (mc.plantedCarrots || 0) + (mc.plantedBeetroots || 0);
      if (totalPlanted <= 0) return interaction.reply({ content: "❌ Rien à récolter.", ephemeral: true });
      const wheatGain = mc.plantedWheat * (2 + Math.floor(Math.random() * 3));
      const potatoGain = mc.plantedPotatoes * (2 + Math.floor(Math.random() * 2));
      const pumpkinGain = mc.plantedPumpkins * (1 + Math.floor(Math.random() * 2));
      const carrotGain = mc.plantedCarrots * (2 + Math.floor(Math.random() * 2));
      const beetGain = mc.plantedBeetroots * (2 + Math.floor(Math.random() * 2));
      mc.wheat += wheatGain;
      mc.potatoes += potatoGain;
      mc.pumpkins += pumpkinGain;
      mc.carrots += carrotGain;
      mc.beetroots += beetGain;
      mc.plantedWheat = 0;
      mc.plantedPotatoes = 0;
      mc.plantedPumpkins = 0;
      mc.plantedCarrots = 0;
      mc.plantedBeetroots = 0;
      mc.harvestReadyAt = 0;
      mc.xp += 12;
      notice = `🪓 Récolte: +${wheatGain} blé, +${potatoGain} patate(s), +${pumpkinGain} citrouille(s), +${carrotGain} carotte(s), +${beetGain} betterave(s).`;
    } else if (interaction.customId === "mc_mine_stone") {
      if (!mc.inCave) return interaction.reply({ content: "❌ Utilise la grotte pour miner.", ephemeral: true });
      const pick = getSelectedPickaxeDef(mc);
      const tier = pick ? pick.tier : 0;
      if (tier <= 0) return interaction.reply({ content: "❌ Tu dois d'abord craft une pioche.", ephemeral: true });
      const stoneMax = tier >= 5 ? 6 : tier >= 4 ? 5 : tier >= 3 ? 5 : tier >= 2 ? 4 : 3;
      const stoneGain = 1 + Math.floor(Math.random() * stoneMax);
      const coalChance = tier >= 4 ? 0.6 : tier >= 3 ? 0.5 : 0.45;
      const coalGain = Math.random() < coalChance ? (1 + Math.floor(Math.random() * 2)) : 0;
      const ironChance = tier >= 4 ? 0.45 : tier >= 3 ? 0.35 : 0.25;
      const ironGain = tier >= 2 && Math.random() < ironChance ? (1 + Math.floor(Math.random() * 2)) : 0;
      const debrisGain = (mc.world === "nether" && tier >= 4 && Math.random() < 0.18) ? 1 : 0;
      const totemGain = (mc.world === "nether" && Math.random() < 0.03) ? 1 : 0;
      let farmLoot = "";
      const farmRoll = Math.random();
      if (farmRoll < 0.1) { mc.carrots += 1; farmLoot = " +1 carotte"; }
      else if (farmRoll < 0.18) { mc.beetrootSeeds += 1; farmLoot = " +1 graine de betterave"; }
      mc.stone += stoneGain;
      mc.coal += coalGain;
      mc.ironOre += ironGain;
      mc.ancientDebris += debrisGain;
      mc.totems += totemGain;
      mc.xp += (stoneGain * 2) + (coalGain * 3) + (ironGain * 5);
      const emeraldReward = Math.max(1, Math.floor(((stoneGain * 120) + (coalGain * 180) + (ironGain * 300)) / 240));
      mc.emeralds += emeraldReward;
      const breakNote = applyPickaxeDamage(mc, 6, pick);
      notice = `🪨 Minage: +${stoneGain} pierre, +${coalGain} charbon, +${ironGain} fer${debrisGain ? `, +${debrisGain} débris ancien` : ""}${totemGain ? ", +1 totem" : ""}.${farmLoot ? ` Butin: ${farmLoot}.` : ""} Récompense: +${emeraldReward} émeraude(s).${breakNote ? ` ${breakNote}` : ""}`;
    } else if (interaction.customId === "mc_craft_furnace") {
      if (!mc.hasCraftingTable || mc.stone < 8 || mc.hasFurnace) return interaction.reply({ content: "❌ Il faut une table de craft et 8 pierres.", ephemeral: true });
      mc.stone -= 8;
      mc.hasFurnace = true;
      mc.xp += 18;
      notice = "🔥 Four fabriqué.";
    } else if (interaction.customId === "mc_smelt_iron") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if (mc.ironOre < 1 || mc.coal < 1) return interaction.reply({ content: "❌ Il faut 1 minerai de fer + 1 charbon + un four.", ephemeral: true });
      mc.ironOre -= 1;
      mc.coal -= 1;
      mc.ironIngot += 1;
      mc.xp += 8;
      notice = "🔩 Tu as fondu 1 lingot de fer.";
    } else if (interaction.customId === "mc_smelt_gold") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if (mc.goldOre < 1 || mc.coal < 1) return interaction.reply({ content: "❌ Il faut 1 minerai d'or + 1 charbon + un four.", ephemeral: true });
      mc.goldOre -= 1;
      mc.coal -= 1;
      mc.goldIngot += 1;
      mc.xp += 10;
      notice = "🪙 Tu as fondu 1 lingot d'or.";
    } else if (interaction.customId === "mc_smelt_netherite") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if (mc.world !== "nether") return interaction.reply({ content: "❌ La netherite se fond uniquement dans le Nether.", ephemeral: true });
      if ((mc.ancientDebris || 0) < 1 || (mc.coal || 0) < 2) return interaction.reply({ content: "❌ Il faut 1 débris ancien + 2 charbon + un four.", ephemeral: true });
      mc.ancientDebris -= 1;
      mc.coal -= 2;
      mc.netheriteScrap += 1;
      mc.xp += 20;
      notice = "🔥 Fusion Nether: 1 débris ancien → 1 fragment de netherite (coût: 2 charbon).";
    } else if (interaction.customId === "mc_smelt_beef") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if ((mc.rawBeef || 0) < 1 || (mc.coal || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 bœuf cru + 1 charbon + un four.", ephemeral: true });
      mc.rawBeef -= 1;
      mc.coal -= 1;
      mc.cookedBeef += 1;
      mc.xp += 4;
      notice = "🍖 Bœuf cuit: +1.";
    } else if (interaction.customId === "mc_smelt_mutton") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if ((mc.rawMutton || 0) < 1 || (mc.coal || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 mouton cru + 1 charbon + un four.", ephemeral: true });
      mc.rawMutton -= 1;
      mc.coal -= 1;
      mc.cookedMutton += 1;
      mc.xp += 4;
      notice = "🍖 Mouton cuit: +1.";
    } else if (interaction.customId === "mc_smelt_pork") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if ((mc.rawPork || 0) < 1 || (mc.coal || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 porc cru + 1 charbon + un four.", ephemeral: true });
      mc.rawPork -= 1;
      mc.coal -= 1;
      mc.cookedPork += 1;
      mc.xp += 4;
      notice = "🍖 Porc cuit: +1.";
    } else if (interaction.customId === "mc_smelt_chicken") {
      if (!mc.hasFurnace) return interaction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      if ((mc.rawChicken || 0) < 1 || (mc.coal || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 poulet cru + 1 charbon + un four.", ephemeral: true });
      mc.rawChicken -= 1;
      mc.coal -= 1;
      mc.cookedChicken += 1;
      mc.xp += 4;
      notice = "🍖 Poulet cuit: +1.";
    } else if (interaction.customId === "mc_craft_stone_pickaxe") {
      if (!mc.hasCraftingTable || mc.stone < 3 || mc.sticks < 2 || mc.hasStonePickaxe) return interaction.reply({ content: "❌ Il faut 3 pierres + 2 bâtons + table de craft.", ephemeral: true });
      mc.stone -= 3;
      mc.sticks -= 2;
      mc.hasStonePickaxe = true;
      mc.stonePickaxeDurability = Math.max(mc.stonePickaxeDurability || 0, 150);
      mc.xp += 28;
      notice = "⛏️ Pioche en pierre craftée.";
    } else if (interaction.customId === "mc_craft_iron_pickaxe") {
      if (!mc.hasCraftingTable || mc.ironIngot < 3 || mc.sticks < 2 || mc.hasIronPickaxe) return interaction.reply({ content: "❌ Il faut 3 lingots de fer + 2 bâtons + table de craft.", ephemeral: true });
      mc.ironIngot -= 3;
      mc.sticks -= 2;
      mc.hasIronPickaxe = true;
      mc.ironPickaxeDurability = Math.max(mc.ironPickaxeDurability || 0, 220);
      if ((mc.netheriteScrap || 0) >= 2) {
        mc.netheriteScrap -= 2;
        mc.ironPickaxeDurability += 120;
        mc.xp += 30;
        notice = "⛏️ Pioche en fer craftée et renforcée Netherite (+durabilité).";
      }
      mc.xp += 45;
      if (!notice || notice === "Action Minecraft effectuée.") notice = "⛏️ Pioche en fer craftée.";
    } else if (interaction.customId === "mc_craft_diamond_pickaxe") {
      if (!mc.hasCraftingTable || mc.diamonds < 3 || mc.sticks < 2 || mc.hasDiamondPickaxe) {
        return interaction.reply({ content: "❌ Il faut 3 diamants + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.diamonds -= 3;
      mc.sticks -= 2;
      mc.hasDiamondPickaxe = true;
      mc.diamondPickaxeDurability = Math.max(mc.diamondPickaxeDurability || 0, 280);
      mc.xp += 60;
      notice = "⛏️ Pioche en diamant craftée.";
    } else if (interaction.customId === "mc_craft_netherite_pickaxe") {
      if (!mc.hasCraftingTable || mc.netheriteScrap < 2 || mc.sticks < 2 || mc.hasNetheritePickaxe) {
        return interaction.reply({ content: "❌ Il faut 2 fragments de netherite + 2 bâtons + table de craft.", ephemeral: true });
      }
      mc.netheriteScrap -= 2;
      mc.sticks -= 2;
      mc.hasNetheritePickaxe = true;
      mc.netheritePickaxeDurability = Math.max(mc.netheritePickaxeDurability || 0, 360);
      mc.xp += 75;
      notice = "⛏️ Pioche en netherite craftée.";
    } else if (interaction.customId === "mc_mine_diamond") {
      if (!mc.inCave) return interaction.reply({ content: "❌ Utilise la grotte pour miner.", ephemeral: true });
      const pick = getSelectedPickaxeDef(mc);
      if (!pick || pick.tier < 3) return interaction.reply({ content: "❌ Il faut une pioche en fer (ou mieux).", ephemeral: true });
      const diamonds = Math.random() < 0.55 ? 1 : 2;
      mc.diamonds += diamonds;
      mc.xp += diamonds * 25;
      const emeraldReward = diamonds * 12;
      mc.emeralds += emeraldReward;
      notice = `💎 Tu as miné ${diamonds} diamant(s). Récompense: +${emeraldReward} émeraude(s).`;
      const breakNote = applyPickaxeDamage(mc, 10, pick);
      if (breakNote) notice += ` ${breakNote}`;
    } else if (interaction.customId === "mc_repair_tool_wood") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasWoodPickaxe) return interaction.reply({ content: "❌ Tu n'as pas de pioche en bois.", ephemeral: true });
      if (mc.wood < 3) return interaction.reply({ content: "❌ Il faut 3 bois.", ephemeral: true });
      mc.wood -= 3;
      mc.woodPickaxeDurability = 100;
      notice = "🛠️ Pioche en bois réparée à 100 % (coût: 3 bois).";
    } else if (interaction.customId === "mc_repair_tool_stone") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasStonePickaxe) return interaction.reply({ content: "❌ Tu n'as pas de pioche en pierre.", ephemeral: true });
      if (mc.stone < 6) return interaction.reply({ content: "❌ Il faut 6 pierres.", ephemeral: true });
      mc.stone -= 6;
      mc.stonePickaxeDurability = 150;
      notice = "🛠️ Pioche en pierre réparée à 100 % (coût: 6 pierres).";
    } else if (interaction.customId === "mc_repair_tool_iron") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasIronPickaxe) return interaction.reply({ content: "❌ Tu n'as pas de pioche en fer.", ephemeral: true });
      if ((mc.netheriteScrap || 0) >= 1) {
        mc.netheriteScrap -= 1;
        mc.ironPickaxeDurability = 340;
        notice = "🛠️ Pioche en fer renforcée (netherite) réparée à 100 % (coût: 1 fragment).";
      } else if (mc.ironIngot >= 3) {
        mc.ironIngot -= 3;
        mc.ironPickaxeDurability = 220;
        notice = "🛠️ Pioche en fer réparée à 100 % (coût: 3 lingots de fer).";
      } else {
        return interaction.reply({ content: "❌ Ressources insuffisantes pour réparer la pioche en fer.", ephemeral: true });
      }
    } else if (interaction.customId === "mc_repair_tool_diamond") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasDiamondPickaxe) return interaction.reply({ content: "❌ Tu n'as pas de pioche en diamant.", ephemeral: true });
      if (mc.diamonds < 2) return interaction.reply({ content: "❌ Il faut 2 diamants.", ephemeral: true });
      mc.diamonds -= 2;
      mc.diamondPickaxeDurability = 280;
      notice = "🛠️ Pioche en diamant réparée.";
    } else if (interaction.customId === "mc_repair_tool_netherite") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasNetheritePickaxe) return interaction.reply({ content: "❌ Tu n'as pas de pioche en netherite.", ephemeral: true });
      if ((mc.netheriteScrap || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 fragment de netherite.", ephemeral: true });
      mc.netheriteScrap -= 1;
      mc.netheritePickaxeDurability = 360;
      notice = "🛠️ Pioche en netherite réparée.";
    } else if (interaction.customId === "mc_repair_axe_wood") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasWoodAxe) return interaction.reply({ content: "❌ Tu n'as pas de hache en bois.", ephemeral: true });
      if (mc.wood < 2) return interaction.reply({ content: "❌ Il faut 2 bois.", ephemeral: true });
      mc.wood -= 2;
      mc.woodAxeDurability = 80;
      notice = "🛠️ Hache en bois réparée.";
    } else if (interaction.customId === "mc_repair_axe_stone") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasStoneAxe) return interaction.reply({ content: "❌ Tu n'as pas de hache en pierre.", ephemeral: true });
      if (mc.stone < 4) return interaction.reply({ content: "❌ Il faut 4 pierres.", ephemeral: true });
      mc.stone -= 4;
      mc.stoneAxeDurability = 120;
      notice = "🛠️ Hache en pierre réparée.";
    } else if (interaction.customId === "mc_repair_axe_iron") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasIronAxe) return interaction.reply({ content: "❌ Tu n'as pas de hache en fer.", ephemeral: true });
      if (mc.ironIngot < 2) return interaction.reply({ content: "❌ Il faut 2 lingots de fer.", ephemeral: true });
      mc.ironIngot -= 2;
      mc.ironAxeDurability = 180;
      notice = "🛠️ Hache en fer réparée.";
    } else if (interaction.customId === "mc_repair_axe_diamond") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasDiamondAxe) return interaction.reply({ content: "❌ Tu n'as pas de hache en diamant.", ephemeral: true });
      if (mc.diamonds < 2) return interaction.reply({ content: "❌ Il faut 2 diamants.", ephemeral: true });
      mc.diamonds -= 2;
      mc.diamondAxeDurability = 240;
      notice = "🛠️ Hache en diamant réparée.";
    } else if (interaction.customId === "mc_repair_axe_netherite") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.hasNetheriteAxe) return interaction.reply({ content: "❌ Tu n'as pas de hache en netherite.", ephemeral: true });
      if ((mc.netheriteScrap || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 fragment de netherite.", ephemeral: true });
      mc.netheriteScrap -= 1;
      mc.netheriteAxeDurability = 300;
      notice = "🛠️ Hache en netherite réparée.";
    } else if (interaction.customId === "mc_repair_tool") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (mc.hasIronPickaxe && (mc.netheriteScrap || 0) >= 1) {
        mc.netheriteScrap -= 1;
        mc.ironPickaxeDurability = 340;
        notice = "🛠️ Pioche en fer renforcée (netherite) réparée à 100 % (coût: 1 fragment).";
      } else if (mc.hasIronPickaxe && mc.ironIngot >= 3) {
        mc.ironIngot -= 3;
        mc.ironPickaxeDurability = 220;
        notice = "🛠️ Pioche en fer réparée à 100 % (coût: 3 lingots de fer).";
      } else if (mc.hasStonePickaxe && mc.stone >= 6) {
        mc.stone -= 6;
        mc.stonePickaxeDurability = 150;
        notice = "🛠️ Pioche en pierre réparée à 100 % (coût: 6 pierres).";
      } else if (mc.hasWoodPickaxe && mc.wood >= 3) {
        mc.wood -= 3;
        mc.woodPickaxeDurability = 100;
        notice = "🛠️ Pioche en bois réparée à 100 % (coût: 3 bois).";
      } else {
        return interaction.reply({ content: "❌ Ressources insuffisantes pour réparer.", ephemeral: true });
      }
    } else if (interaction.customId === "mc_repair_sword_wood") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.woodSword) return interaction.reply({ content: "❌ Tu n'as pas d'épée en bois.", ephemeral: true });
      if (mc.planks < 2) return interaction.reply({ content: "❌ Il faut 2 planches.", ephemeral: true });
      mc.planks -= 2;
      mc.woodSwordDurability = 60;
      notice = "🛠️ Épée en bois réparée.";
    } else if (interaction.customId === "mc_repair_sword_stone") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.stoneSword) return interaction.reply({ content: "❌ Tu n'as pas d'épée en pierre.", ephemeral: true });
      if (mc.stone < 2) return interaction.reply({ content: "❌ Il faut 2 pierres.", ephemeral: true });
      mc.stone -= 2;
      mc.stoneSwordDurability = 90;
      notice = "🛠️ Épée en pierre réparée.";
    } else if (interaction.customId === "mc_repair_sword_iron") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.ironSword) return interaction.reply({ content: "❌ Tu n'as pas d'épée en fer.", ephemeral: true });
      if (mc.ironIngot < 2) return interaction.reply({ content: "❌ Il faut 2 lingots de fer.", ephemeral: true });
      mc.ironIngot -= 2;
      mc.ironSwordDurability = 140;
      notice = "🛠️ Épée en fer réparée.";
    } else if (interaction.customId === "mc_repair_sword_diamond") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.diamondSword) return interaction.reply({ content: "❌ Tu n'as pas d'épée en diamant.", ephemeral: true });
      if (mc.diamonds < 1) return interaction.reply({ content: "❌ Il faut 1 diamant.", ephemeral: true });
      mc.diamonds -= 1;
      mc.diamondSwordDurability = 200;
      notice = "🛠️ Épée en diamant réparée.";
    } else if (interaction.customId === "mc_repair_sword_netherite") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (!mc.netheriteSword) return interaction.reply({ content: "❌ Tu n'as pas d'épée en netherite.", ephemeral: true });
      if ((mc.netheriteScrap || 0) < 1) return interaction.reply({ content: "❌ Il faut 1 fragment de netherite.", ephemeral: true });
      mc.netheriteScrap -= 1;
      mc.netheriteSwordDurability = 260;
      notice = "🛠️ Épée en netherite réparée.";
    } else if (interaction.customId === "mc_repair_armor_iron") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (mc.ironIngot < 4) return interaction.reply({ content: "❌ Il faut 4 lingots de fer.", ephemeral: true });
      mc.ironIngot -= 4;
      if (mc.ironHelmet) mc.ironHelmetDurability = 160;
      if (mc.ironChestplate) mc.ironChestplateDurability = 180;
      if (mc.ironLeggings) mc.ironLeggingsDurability = 170;
      if (mc.ironBoots) mc.ironBootsDurability = 150;
      notice = "🛠️ Armure en fer réparée.";
    } else if (interaction.customId === "mc_repair_armor_diamond") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if (mc.diamonds < 2) return interaction.reply({ content: "❌ Il faut 2 diamants.", ephemeral: true });
      mc.diamonds -= 2;
      if (mc.diamondHelmet) mc.diamondHelmetDurability = 220;
      if (mc.diamondChestplate) mc.diamondChestplateDurability = 240;
      if (mc.diamondLeggings) mc.diamondLeggingsDurability = 230;
      if (mc.diamondBoots) mc.diamondBootsDurability = 210;
      notice = "🛠️ Armure en diamant réparée.";
    } else if (interaction.customId === "mc_repair_armor_netherite") {
      if (!mc.hasCraftingTable) return interaction.reply({ content: "❌ Il faut une table de craft pour réparer.", ephemeral: true });
      if ((mc.netheriteScrap || 0) < 2) return interaction.reply({ content: "❌ Il faut 2 fragments de netherite.", ephemeral: true });
      mc.netheriteScrap -= 2;
      if (mc.netheriteHelmet) mc.netheriteHelmetDurability = 300;
      if (mc.netheriteChestplate) mc.netheriteChestplateDurability = 320;
      if (mc.netheriteLeggings) mc.netheriteLeggingsDurability = 310;
      if (mc.netheriteBoots) mc.netheriteBootsDurability = 290;
      notice = "🛠️ Armure en netherite réparée.";
    } else if (interaction.customId === "mc_rest" ||
               interaction.customId === "mc_rest_sleep" ||
               interaction.customId === "mc_rest_awake") {
      const restWait = Math.max(0, (mc.restCooldownUntil || 0) - Date.now());
      if (restWait > 0) return interaction.reply({ content: `❌ Repos indisponible. Attends encore ${formatShortDuration(restWait)}.`, ephemeral: true });
      const sleepMode = interaction.customId !== "mc_rest_awake";
      if (sleepMode && !mc.isNight) {
        return interaction.reply({ content: "❌ Tu peux dormir uniquement la nuit.", ephemeral: true });
      }
      const wasNight = mc.isNight;
      mc.energy = Math.min(100, (mc.energy || 0) + 45);
      let healed = 0;
      if (sleepMode) {
        const before = mc.hp || 0;
        mc.hp = Math.min(100, before + 5);
        healed = mc.hp - before;
        if (wasNight) {
          const cycleBase = Math.floor((mc.actionCount || 0) / MC_ACTIONS_PER_CYCLE) * MC_ACTIONS_PER_CYCLE;
          mc.actionCount = cycleBase;
          mc.isNight = false;
        }
      }
      mc.restCooldownUntil = Date.now() + (10 * 60 * 1000);
      if (sleepMode) {
        notice = `🛌 Tu dors. Énergie: ${mc.energy}/100. +${healed} PV.${wasNight ? " Nuit passée." : ""} Prochain repos dans ${formatShortDuration(10 * 60 * 1000)}.`;
      } else {
        notice = `🛌 Tu te reposes sans dormir. Énergie: ${mc.energy}/100. Prochain repos dans ${formatShortDuration(10 * 60 * 1000)}.`;
      }
    } else if (interaction.customId === "mc_convert_emerald") {
      if ((mc.emeralds || 0) <= 0) return interaction.reply({ content: "❌ Aucune émeraude à convertir.", ephemeral: true });
      const amount = mc.emeralds;
      const converted = amount * MC_EMERALD_TO_MEMOCOIN;
      mc.emeralds = 0;
      getBalance(userId).bank += converted;
      notice = `🏦 Conversion Minecraft: ${amount} émeraude(s) → ${converted} Memocoins en banque.`;
      conversionInfo = { label: "émeraude(s)", from: amount, to: converted };
    } else if (interaction.customId === "mc_change_biome") {
      if (mc.world !== "overworld") return interaction.reply({ content: "❌ Le changement de biome est disponible uniquement dans l'Overworld.", ephemeral: true });
      const previousBiome = mc.currentBiome;
      if ((mc.energy || 0) < 12) return interaction.reply({ content: "❌ Pas assez d'énergie pour voyager (12 requis).", ephemeral: true });
      mc.energy = Math.max(0, (mc.energy || 0) - 12);
      const possible = MC_OVERWORLD_BIOMES.filter(b => b !== previousBiome);
      mc.currentBiome = pickRandom(possible);
      mc.villagerReady = mc.currentBiome === "village";
      const travelEvent = pickRandom([
        "🌬️ Voyage calme.",
        "🧭 Tu repères un meilleur chemin.",
        "🌧️ Tu traverses une zone hostile.",
        "🏕️ Tu trouves un camp abandonné."
      ]);
      const travelCooldown = getRandomCooldownMs(MC_BIOME_COOLDOWN_MS);
      mc.biomeCooldownUntil = now + travelCooldown;
      notice = `🗺️ Déplacement: ${previousBiome} → ${mc.currentBiome}. ${travelEvent} (-12 énergie). ⏱️ Prochain voyage: ${formatShortDuration(travelCooldown)}.`;
    } else if (interaction.customId === "mc_world_overworld") {
      if ((mc.energy || 0) < 12) return interaction.reply({ content: "❌ Pas assez d'énergie pour voyager (12 requis).", ephemeral: true });
      mc.energy = Math.max(0, (mc.energy || 0) - 12);
      mc.world = "overworld";
      if (!MC_OVERWORLD_BIOMES.includes(mc.currentBiome)) mc.currentBiome = "forêt";
      mc.villagerReady = mc.currentBiome === "village";
      {
        const travelCooldown = getRandomCooldownMs(MC_BIOME_COOLDOWN_MS);
        mc.biomeCooldownUntil = now + travelCooldown;
        notice = `🌍 Retour dans l'Overworld. ⏱️ Prochain voyage: ${formatShortDuration(travelCooldown)}.`;
      }
    } else if (interaction.customId === "mc_world_nether") {
      if (!mc.hasNetherPortal) return interaction.reply({ content: "❌ Tu dois d'abord construire le portail du Nether.", ephemeral: true });
      if ((mc.energy || 0) < 12) return interaction.reply({ content: "❌ Pas assez d'énergie pour voyager (12 requis).", ephemeral: true });
      mc.energy = Math.max(0, (mc.energy || 0) - 12);
      mc.world = "nether";
      mc.villagerReady = false;
      {
        const travelCooldown = getRandomCooldownMs(MC_BIOME_COOLDOWN_MS);
        mc.biomeCooldownUntil = now + travelCooldown;
        notice = `🔥 Tu voyages vers le Nether. ⏱️ Prochain voyage: ${formatShortDuration(travelCooldown)}.`;
      }
    } else if (interaction.customId === "mc_world_end") {
      if (!mc.hasEndPortal) return interaction.reply({ content: "❌ Tu dois d'abord activer le portail de l'End.", ephemeral: true });
      if ((mc.energy || 0) < 12) return interaction.reply({ content: "❌ Pas assez d'énergie pour voyager (12 requis).", ephemeral: true });
      mc.energy = Math.max(0, (mc.energy || 0) - 12);
      mc.world = "end";
      mc.villagerReady = false;
      {
        const travelCooldown = getRandomCooldownMs(MC_BIOME_COOLDOWN_MS);
        mc.biomeCooldownUntil = now + travelCooldown;
        notice = `✨ Tu voyages vers l'End. ⏱️ Prochain voyage: ${formatShortDuration(travelCooldown)}.`;
      }
    } else if (interaction.customId === "mc_build_nether_portal") {
      if (mc.hasNetherPortal) return interaction.reply({ content: "❌ Le portail du Nether est déjà construit.", ephemeral: true });
      if (!mc.hasFlintAndSteel) return interaction.reply({ content: "❌ Il faut un briquet (silex + lingot de fer).", ephemeral: true });
      if (mc.obsidian < 12) return interaction.reply({ content: "❌ Il faut 12 obsidiennes.", ephemeral: true });
      mc.obsidian -= 12;
      mc.hasNetherPortal = true;
      mc.xp += 55;
      notice = "🧱 Portail du Nether construit. Le briquet permet de l'activer.";
    } else if (interaction.customId === "mc_enter_nether") {
      if (!mc.hasNetherPortal) return interaction.reply({ content: "❌ Construis d'abord le portail du Nether.", ephemeral: true });
      mc.world = "nether";
      mc.villagerReady = false;
      {
        const travelCooldown = getRandomCooldownMs(MC_BIOME_COOLDOWN_MS);
        mc.biomeCooldownUntil = now + travelCooldown;
        notice = `🔥 Tu entres dans le Nether. ⏱️ Prochain voyage: ${formatShortDuration(travelCooldown)}.`;
      }
    } else if (interaction.customId === "mc_craft_eye") {
      if (mc.blazeRods < 1 || mc.enderPearls < 1) return interaction.reply({ content: "❌ Il faut 1 bâton de blaze + 1 perle de l'End.", ephemeral: true });
      mc.blazeRods -= 1;
      mc.enderPearls -= 1;
      mc.eyesOfEnder += 1;
      mc.xp += 12;
      notice = "👁️ Tu as crafté 1 œil de l'End.";
    } else if (interaction.customId === "mc_open_end_portal") {
      if (mc.eyesOfEnder < 12 || mc.hasEndPortal) return interaction.reply({ content: "❌ Il faut 12 yeux de l'End.", ephemeral: true });
      mc.eyesOfEnder -= 12;
      mc.hasEndPortal = true;
      mc.xp += 90;
      notice = "🌀 Portail de l'End activé.";
    } else if (interaction.customId === "mc_enter_end") {
      if (!mc.hasEndPortal) return interaction.reply({ content: "❌ Le portail de l'End n'est pas actif.", ephemeral: true });
      mc.world = "end";
      mc.villagerReady = false;
      {
        const travelCooldown = getRandomCooldownMs(MC_BIOME_COOLDOWN_MS);
        mc.biomeCooldownUntil = now + travelCooldown;
        notice = `✨ Tu entres dans l'End. ⏱️ Prochain voyage: ${formatShortDuration(travelCooldown)}.`;
      }
    } else if (interaction.customId === "mc_trade_sell") {
      if (!(mc.world === "overworld" && mc.currentBiome === "village" && mc.villagerReady)) return interaction.reply({ content: "❌ Pas de villageois prêt à échanger.", ephemeral: true });
      if (mc.ironIngot >= 4) {
        mc.ironIngot -= 4;
        mc.emeralds += 3;
        notice = "💱 Échange: 4 lingots de fer → 3 émeraudes.";
        mc.lastSale = "4 lingots de fer vendus pour 3 émeraudes.";
      } else if (mc.stone >= 16) {
        mc.stone -= 16;
        mc.emeralds += 1;
        notice = "💱 Échange: 16 pierres → 1 émeraude.";
        mc.lastSale = "16 pierres vendues pour 1 émeraude.";
      } else if (mc.wood >= 20) {
        mc.wood -= 20;
        mc.emeralds += 1;
        notice = "💱 Échange: 20 bois → 1 émeraude.";
        mc.lastSale = "20 bois vendus pour 1 émeraude.";
      } else {
        return interaction.reply({ content: "❌ Tu n'as pas assez de ressources à vendre.", ephemeral: true });
      }
      mc.xp += 5;
    } else if (interaction.customId === "mc_trade_buy") {
      if (!(mc.world === "overworld" && mc.currentBiome === "village" && mc.villagerReady)) return interaction.reply({ content: "❌ Pas de villageois prêt à échanger.", ephemeral: true });
      if (mc.emeralds < 5) return interaction.reply({ content: "❌ Il faut 5 émeraudes.", ephemeral: true });
      mc.emeralds -= 5;
      const offers = [
        { kind: "iron", label: "5 lingots de fer", apply: () => { mc.ironIngot += 5; } },
        { kind: "obsidian", label: "2 obsidiennes", apply: () => { mc.obsidian += 2; } },
        { kind: "ender", label: "1 perle de l'End", apply: () => { mc.enderPearls += 1; } },
        { kind: "blaze", label: "1 bâton de blaze", apply: () => { mc.blazeRods += 1; } },
        { kind: "bundle", label: "Kit mineur (+20 pierre, +10 charbon)", apply: () => { mc.stone += 20; mc.coal += 10; } }
      ];
      const offer = pickRandom(offers);
      offer.apply();
      notice = `🛒 Villageois: 5 émeraudes → ${offer.label}.`;
      mc.lastPurchase = `Achat villageois: ${offer.label} pour 5 émeraudes.`;
      mc.xp += 7;
    } else if (interaction.customId === "mc_build_house") {
      if (mc.houseBuilt) return interaction.reply({ content: "❌ Ta maison est déjà construite.", ephemeral: true });
      if (mc.wood < 40 || mc.stone < 20 || mc.planks < 10) {
        return interaction.reply({ content: "❌ Il faut 40 bois, 20 pierres et 10 planches.", ephemeral: true });
      }
      mc.wood -= 40;
      mc.stone -= 20;
      mc.planks -= 10;
      mc.houseBuilt = true;
      mc.xp += 30;
      notice = "🏠 Maison construite.";
    } else if (interaction.customId === "mc_mob_attack") {
      if (!mc.encounter) return interaction.reply({ content: "❌ Aucun mob à combattre.", ephemeral: true });
      const mob = mc.encounter;
      const sword = getSelectedSwordStats(mc);
      const playerDamage = sword
        ? (sword.min + Math.floor(Math.random() * (sword.max - sword.min + 1)))
        : (3 + Math.floor(Math.random() * 4));
      mob.hp = Math.max(0, (mob.hp || 0) - playerDamage);
      let breakNote = "";
      if (sword) {
        mc[sword.durKey] = Math.max(0, (mc[sword.durKey] || 0) - 1);
        if (mc[sword.durKey] <= 0) {
          mc[sword.key] = false;
          breakNote = " Épée cassée.";
        }
      }
      if (mob.hp <= 0) {
        if (mob.type === "animal") {
          const drops = mob.drops || {};
          let dropText = "";
          if (drops.rawMutton) {
            const qty = drops.rawMutton[0] + Math.floor(Math.random() * (drops.rawMutton[1] - drops.rawMutton[0] + 1));
            mc.rawMutton += qty;
            dropText = ` +${qty} mouton cru`;
          }
          if (drops.rawBeef) {
            const qty = drops.rawBeef[0] + Math.floor(Math.random() * (drops.rawBeef[1] - drops.rawBeef[0] + 1));
            mc.rawBeef += qty;
            dropText = ` +${qty} bœuf cru`;
          }
          mc.xp += 8;
          notice = `✅ ${mob.name} vaincu.${dropText ? ` Butin:${dropText}.` : ""}${breakNote}`;
        } else {
          const reward = 1 + Math.floor(Math.random() * 3);
          mc.emeralds += reward;
          mc.xp += 12;
          notice = `✅ ${mob.name} vaincu. +${reward} émeraude(s).${breakNote}`;
        }
        mc.encounter = null;
      } else if (mob.type === "monster") {
        const enemyDamage = (mob.atkMin || 5) + Math.floor(Math.random() * ((mob.atkMax || 8) - (mob.atkMin || 5) + 1));
        const result = applyMinecraftDamage(mc, enemyDamage);
        const brokenText = result.broken.length ? ` Armure brisée: ${result.broken.join(", ")}.` : "";
        notice = `⚔️ Tu infliges ${playerDamage} dégâts à ${mob.name}. Il te blesse (-${result.finalDamage} PV).${brokenText}${breakNote}`;
        if (mc.hp <= 0) {
          mc.hp = 0;
          mc.encounter = null;
          notice += " Tu es mort.";
          died = true;
        }
      } else {
        notice = `🐾 ${mob.name} est blessé (${mob.hp} PV).${breakNote}`;
      }
    } else if (interaction.customId === "mc_mob_flee") {
      if (!mc.encounter) return interaction.reply({ content: "❌ Aucun mob à fuir.", ephemeral: true });
      const mob = mc.encounter;
      if (mob.type === "animal") {
        mc.encounter = null;
        notice = `🐾 ${mob.name} s'enfuit.`;
      } else if (Math.random() < 0.8) {
        mc.encounter = null;
        notice = "🏃 Fuite réussie.";
      } else {
        const enemyDamage = (mob.atkMin || 5) + Math.floor(Math.random() * ((mob.atkMax || 8) - (mob.atkMin || 5) + 1));
        const result = applyMinecraftDamage(mc, enemyDamage);
        const brokenText = result.broken.length ? ` Armure brisée: ${result.broken.join(", ")}.` : "";
        notice = `❌ Fuite ratée. ${mob.name} te blesse (-${result.finalDamage} PV).${brokenText}`;
        if (mc.hp <= 0) {
          mc.hp = 0;
          mc.encounter = null;
          notice += " Tu es mort.";
          died = true;
        }
      }
    } else if (interaction.customId.startsWith("mc_eat_")) {
      const food = MC_FOOD_DEFS.find(def => interaction.customId === `mc_eat_${def.id}`);
      if (!food) return interaction.reply({ content: "❌ Nourriture inconnue.", ephemeral: true });
      if ((mc[food.key] || 0) <= 0) return interaction.reply({ content: "❌ Tu n'as pas cette nourriture.", ephemeral: true });
      if ((mc.hp || 0) >= 100) return interaction.reply({ content: "❌ Tes PV sont déjà au maximum.", ephemeral: true });
      mc[food.key] -= 1;
      const before = mc.hp || 0;
      const healed = Math.min(100, before + food.heal) - before;
      mc.hp = Math.min(100, before + food.heal);
      notice = `🍽️ Tu manges ${food.label.toLowerCase()}. +${healed} PV.`;
    } else if (interaction.customId === "mc_explore") {
      const biome = mc.world === "overworld" ? getMinecraftBiomeCategory(mc.currentBiome) : mc.world;
      const exploreCooldown = getRandomCooldownMs(MC_EXPLORE_COOLDOWN_MS);
      mc.exploreCooldownUntil = now + exploreCooldown;
      mc.chopAvailable = true;
      const tryStructureEvent = () => {
        const roll = Math.random();
        if (biome === "forêt" && roll < 0.16) {
          const gain = 2 + Math.floor(Math.random() * 3);
          mc.emeralds += gain;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Temple de la jungle";
          mc.xp += 14;
          return `🏛️ Structure: Temple de la jungle découvert. +${gain} émeraude(s).`;
        }
        if (biome === "plaine" && roll < 0.14) {
          const wood = 10 + Math.floor(Math.random() * 8);
          mc.wood += wood;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Avant-poste";
          mc.xp += 10;
          return `🏛️ Structure: Avant-poste abandonné. +${wood} bois.`;
        }
        if (biome === "désert" && roll < 0.2) {
          const obs = 1 + Math.floor(Math.random() * 2);
          mc.obsidian += obs;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Temple du désert";
          mc.xp += 16;
          return `🏛️ Structure: Temple du désert pillé. +${obs} obsidienne(s).`;
        }
        if (biome === "montagne" && roll < 0.13) {
          const dia = Math.random() < 0.45 ? 1 : 0;
          mc.diamonds += dia;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Mine abandonnée";
          mc.xp += 18;
          return dia ? "🏛️ Structure: Mine abandonnée. +1 diamant." : "🏛️ Structure: Mine abandonnée fouillée (pas de diamant).";
        }
        if (biome === "village" && roll < 0.18) {
          const e = 2 + Math.floor(Math.random() * 3);
          mc.emeralds += e;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Maison de marchand";
          mc.xp += 9;
          return `🏛️ Structure: Maison de marchand. +${e} émeraude(s).`;
        }
        if (biome === "nether" && roll < 0.22) {
          const b = 1 + Math.floor(Math.random() * 2);
          const o = Math.random() < 0.5 ? 1 : 0;
          mc.blazeRods += b;
          mc.obsidian += o;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Forteresse du Nether";
          mc.xp += 20;
          return `🏛️ Structure: Forteresse du Nether. +${b} blaze${o ? ", +1 obsidienne" : ""}.`;
        }
        if (biome === "end" && roll < 0.24) {
          const p = 1 + Math.floor(Math.random() * 2);
          mc.enderPearls += p;
          mc.structuresFound = (mc.structuresFound || 0) + 1;
          mc.lastStructure = "Cité de l'End";
          mc.xp += 24;
          return `🏛️ Structure: Cité de l'End. +${p} perle(s) de l'End.`;
        }
        return "";
      };

      const structureNotice = tryStructureEvent();
      if (structureNotice) {
        notice = structureNotice;
      } else if (biome === "forêt") {
        const events = [
          () => { const w = 3 + Math.floor(Math.random() * 5); mc.wood += w; mc.xp += 6; return `🌲 Forêt: tu coupes ${w} bois.`; },
          () => { const s = 2 + Math.floor(Math.random() * 4); mc.stone += s; mc.xp += 5; return `🪨 Forêt: tu trouves ${s} pierres.`; },
          () => { const p = Math.random() < 0.25 ? 1 : 0; mc.enderPearls += p; mc.xp += 8; return p ? "✨ Forêt: un Enderman lâche 1 perle." : "🌿 Forêt: aucune perle cette fois."; },
          () => { const seed = 1 + Math.floor(Math.random() * 2); mc.wheatSeeds += seed; mc.xp += 4; return `🌿 Forêt: +${seed} graines de blé.`; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "plaine") {
        const events = [
          () => { const w = 1 + Math.floor(Math.random() * 3); const s = 1 + Math.floor(Math.random() * 3); mc.wood += w; mc.stone += s; mc.xp += 5; return `🌾 Plaine: +${w} bois, +${s} pierre.`; },
          () => { mc.currentBiome = "village"; mc.villagerReady = true; mc.xp += 6; return "🏘️ Plaine: tu découvres un village."; },
          () => { const e = 1; mc.emeralds += e; mc.xp += 6; return "🐎 Plaine: un marchand te donne 1 émeraude."; },
          () => { const c = 1 + Math.floor(Math.random() * 2); mc.carrots += c; mc.xp += 4; return `🥕 Plaine: +${c} carotte(s).`; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "désert") {
        const events = [
          () => { const o = 1; mc.obsidian += o; mc.xp += 8; return "🏜️ Désert: tu trouves 1 obsidienne dans des ruines."; },
          () => { const e = 4 + Math.floor(Math.random() * 5); mc.emeralds += e; mc.xp += 8; return `🏺 Désert: temple pillé, +${e} émeraude(s).`; },
          () => { const e = 1 + Math.floor(Math.random() * 2); mc.emeralds += e; mc.xp += 7; return `💚 Désert: butin rare, +${e} émeraude(s).`; },
          () => { const p = 1; mc.pumpkinSeeds += p; mc.xp += 4; return "🎃 Désert: tu trouves 1 graine de citrouille."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "montagne") {
        const events = [
          () => { const i = 2 + Math.floor(Math.random() * 3); const c = 1 + Math.floor(Math.random() * 2); mc.ironOre += i; mc.coal += c; mc.xp += 10; return `⛰️ Montagne: +${i} fer, +${c} charbon.`; },
          () => { const s = 3 + Math.floor(Math.random() * 4); mc.stone += s; mc.xp += 6; return `🪨 Montagne: +${s} pierre.`; },
          () => { const d = Math.random() < 0.25 ? 1 : 0; mc.diamonds += d; mc.xp += 12; return d ? "💎 Montagne: tu trouves 1 diamant brut." : "🧭 Montagne: pas de diamant cette fois."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "océan") {
        const events = [
          () => { const w = 2 + Math.floor(Math.random() * 4); mc.wood += w; mc.xp += 5; return `🌊 Océan: épave repérée, +${w} bois.`; },
          () => { const g = 1; mc.goldOre = (mc.goldOre || 0) + g; mc.xp += 6; return "🐚 Océan: +1 minerai d'or."; },
          () => { const e = 1 + Math.floor(Math.random() * 2); mc.emeralds += e; mc.xp += 7; return `💎 Océan: trésor trouvé, +${e} émeraude(s).`; },
          () => { const p = Math.random() < 0.3 ? 1 : 0; mc.enderPearls += p; mc.xp += 6; return p ? "🫧 Océan: tu trouves 1 perle de l'End." : "🌊 Océan: exploration tranquille."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "village") {
        const events = [
          () => { mc.villagerReady = true; mc.xp += 4; return "👨‍🌾 Village: un villageois veut commercer."; },
          () => { mc.emeralds += 1; mc.xp += 5; return "💚 Village: récompense locale, +1 émeraude."; },
          () => { const w = 5; mc.wood += w; mc.xp += 4; return `🪵 Village: on te donne ${w} bois.`; },
          () => { const b = 1; mc.beetrootSeeds += b; mc.xp += 4; return "🌱 Village: +1 graine de betterave."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "jungle") {
        const events = [
          () => { const w = 4 + Math.floor(Math.random() * 5); mc.wood += w; mc.xp += 6; return `🌴 Jungle: +${w} bois.`; },
          () => { const p = 1 + Math.floor(Math.random() * 2); mc.pumpkins += p; mc.xp += 5; return `🎃 Jungle: +${p} citrouille(s).`; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "marais") {
        const events = [
          () => { const s = 2 + Math.floor(Math.random() * 3); mc.wheatSeeds += s; mc.xp += 4; return `🌾 Marais: +${s} graines.`; },
          () => { const p = 1; mc.potatoes += p; mc.xp += 5; return "🥔 Marais: +1 pomme de terre."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "taiga") {
        const events = [
          () => { const w = 3 + Math.floor(Math.random() * 4); mc.wood += w; mc.xp += 5; return `🌲 Taïga: +${w} bois.`; },
          () => { const c = 1 + Math.floor(Math.random() * 2); mc.carrots += c; mc.xp += 4; return `🥕 Taïga: +${c} carotte(s).`; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "savane") {
        const events = [
          () => { const w = 2 + Math.floor(Math.random() * 4); mc.wood += w; mc.xp += 5; return `🌾 Savane: +${w} bois.`; },
          () => { const s = 2 + Math.floor(Math.random() * 3); mc.stone += s; mc.xp += 4; return `🪨 Savane: +${s} pierre.`; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "mesa") {
        const events = [
          () => { const i = 1 + Math.floor(Math.random() * 2); mc.ironOre += i; mc.xp += 6; return `🏜️ Mesa: +${i} minerai de fer.`; },
          () => { const g = 1; mc.goldOre = (mc.goldOre || 0) + g; mc.xp += 6; return "🪙 Mesa: +1 minerai d'or."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "nether") {
        const events = [
          () => { const b = 1 + Math.floor(Math.random() * 2); mc.blazeRods += b; mc.xp += 14; return `🔥 Nether: +${b} bâton(s) de blaze.`; },
          () => { const o = 1; mc.obsidian += o; mc.xp += 10; return "🟪 Nether: +1 obsidienne."; },
          () => { const e = 6 + Math.floor(Math.random() * 7); mc.emeralds += e; mc.xp += 12; return `💰 Nether: coffre maudit, +${e} émeraude(s).`; },
          () => { const d = Math.random() < 0.25 ? 1 : 0; mc.ancientDebris += d; mc.xp += 16; return d ? "⛏️ Nether: +1 débris ancien." : "🌋 Nether: lave instable, aucun débris."; }
        ];
        notice = pickRandom(events)();
      } else if (biome === "end") {
        const events = [
          () => { const d = 1 + Math.floor(Math.random() * 2); mc.diamonds += d; mc.xp += 20; return `✨ End: +${d} diamant(s).`; },
          () => { const p = 1; mc.enderPearls += p; mc.xp += 14; return "🫧 End: +1 perle de l'End."; },
          () => { const e = 10 + Math.floor(Math.random() * 11); mc.emeralds += e; mc.xp += 18; return `🏆 End: relique vendue, +${e} émeraude(s).`; },
          () => {
            const canFightDragon = mc.hasIronPickaxe && (mc.ironPickaxeDurability || 0) > 30;
            if (!canFightDragon) return "🐉 End: l'ombre du dragon te force à fuir (équipement insuffisant).";
            const win = Math.random() < 0.35;
            if (!win) return "🐉 End: combat du dragon raté, il s'enfuit dans le vide.";
            const reward = 40 + Math.floor(Math.random() * 41);
            mc.emeralds += reward;
            mc.netherStars += 1;
            mc.dragonKills = (mc.dragonKills || 0) + 1;
            mc.lastStructure = "Île du dragon";
            mc.xp += 80;
            return `🐉 Boss vaincu: Ender Dragon. +${reward} émeraude(s), +1 étoile du Nether.`;
          }
        ];
        notice = pickRandom(events)();
      }

      if (mc.world === "overworld" && Math.random() < MC_FLINT_FIND_CHANCE) {
        mc.flint += 1;
        notice = notice ? `${notice} 🪨 Tu trouves 1 silex.` : "🪨 Tu trouves 1 silex.";
      }

      if (["désert", "montagne", "nether", "end"].includes(biome) && Math.random() < 0.18) {
        const extraLoss = 8 + Math.floor(Math.random() * 10);
        if ((mc.totems || 0) > 0) {
          mc.totems -= 1;
          notice = `${notice} 🛡️ Piège mortel évité grâce à un totem (-1).`;
        } else {
          mc.energy = Math.max(0, (mc.energy || 0) - extraLoss);
          notice = `${notice} ⚠️ Zone dangereuse: -${extraLoss} énergie supplémentaire.`;
        }
      }
      if (!notice || notice === "Action Minecraft effectuée.") notice = "🧭 Exploration terminée.";
      notice = `${notice} ⏱️ Prochaine exploration: ${formatShortDuration(exploreCooldown)}.`;
    }

    if (!died && !isSelectAction && interaction.customId !== "mc_convert_emerald") {
      const phaseNote = advanceMinecraftAction(mc);
      if (phaseNote) notice = `${notice} ${phaseNote}`;
    }
    const encounterEligible = [
      "mc_explore",
      "mc_find_structure",
      "mc_find_cave",
      "mc_cave_continue",
      "mc_cave_mine",
      "mc_chop_wood"
    ].includes(interaction.customId);
    if (!died && encounterEligible) {
      const encounterNote = maybeStartMinecraftEncounter(mc);
      if (encounterNote) {
        if (encounterNote.startsWith("💥 Creeper")) {
          notice = encounterNote;
        } else {
          notice = `${notice} ${encounterNote}`;
        }
      }
    }

    if (died || (mc.hp || 0) <= 0) {
      mc = resetMinecraftAfterDeath(userId, now);
      notice = "💀 Tu es mort. Réapparition dans 3 jours. Tous tes objets ont été perdus.";
    }

    mc.lastEvent = notice || mc.lastEvent;
    saveData();
    const view = getMinecraftCurrentView(userId);
    await interaction.update({ embeds: [view.embed], components: view.components });
    if (notice && notice !== "Action Minecraft effectuée." && !conversionInfo) {
      try { await interaction.channel.send(`🌍 <@${userId}> ${notice}`); } catch (e) {}
    }
    if (conversionInfo) {
      sendConversionMessage(interaction.channel, userId, conversionInfo.label, conversionInfo.from, conversionInfo.to);
    }
    return;
  }

  if (interaction.customId === "jeu_pokemon") {
    const view = buildPokemonView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "pk_ball_menu") {
    const pk = getPokemon(userId);
    if (!pk.battle) return interaction.reply({ content: "❌ Aucun combat actif.", ephemeral: true });
    const view = buildPokemonBallMenuView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "pk_start" || interaction.customId === "pk_attack" || interaction.customId === "pk_defend" || interaction.customId === "pk_flee" || interaction.customId === "pk_potion" || interaction.customId === "pk_special" || interaction.customId === "pk_capture" || interaction.customId.startsWith("pk_throw_ball_") || interaction.customId === "pk_convert_pokedollar") {
    const pk = getPokemon(userId);
    let notice = "";
    let conversionInfo = null;
    const now = Date.now();

    if (interaction.customId === "pk_convert_pokedollar") {
      if (pk.battle) return interaction.reply({ content: "❌ Termine le combat avant de convertir.", ephemeral: true });
      if ((pk.pokedollars || 0) < PK_POKEDOLLAR_TO_MEMOCOIN) return interaction.reply({ content: "❌ Il faut au moins 1000 Pokédollars.", ephemeral: true });
      const converted = Math.floor((pk.pokedollars || 0) / PK_POKEDOLLAR_TO_MEMOCOIN);
      const consumed = converted * PK_POKEDOLLAR_TO_MEMOCOIN;
      pk.pokedollars -= consumed;
      getBalance(userId).bank += converted;
      notice = `🏦 Conversion Pokémon: ${consumed} Pokédollars → ${converted} Memocoins en banque.`;
      conversionInfo = { label: "Pokédollars", from: consumed, to: converted };
    } else if (interaction.customId === "pk_start") {
      const wait = Math.max(0, (pk.cooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `⏱️ Attends encore ${formatShortDuration(wait)}.`, ephemeral: true });
      const enemies = [
        { name: "Pikachu sauvage", hp: 70 },
        { name: "Dracaufeu sauvage", hp: 95 },
        { name: "Ectoplasma sauvage", hp: 80 },
      ];
      const enemy = pickRandom(enemies);
      pk.enemyStatus = "";
      pk.battle = { enemyName: enemy.name, playerHp: 100, enemyHp: enemy.hp, enemyMaxHp: enemy.hp, defending: false };
      notice = `⚔️ Combat lancé contre ${enemy.name}.`;
    } else {
      if (!pk.battle) return interaction.reply({ content: "❌ Aucun combat actif.", ephemeral: true });

      if (interaction.customId === "pk_flee") {
        pk.battle = null;
        pk.cooldownUntil = now + 2 * 60 * 1000;
        notice = `🏃 Tu t'es enfui. ⏱️ Attente: ${formatShortDuration(2 * 60 * 1000)}.`;
      } else {
        const battle = pk.battle;
        let playerHit = 0;
        let enemyHit = 0;
        let battleFinished = false;

        if (interaction.customId === "pk_attack") {
          playerHit = 12 + Math.floor(Math.random() * 17);
          if (Math.random() < 0.18) playerHit = Math.floor(playerHit * 1.7);
          battle.enemyHp -= playerHit;
        } else if (interaction.customId === "pk_capture" || interaction.customId.startsWith("pk_throw_ball_")) {
          const ballId = interaction.customId === "pk_capture"
            ? "poke"
            : interaction.customId.replace("pk_throw_ball_", "");
          const defs = getPokemonBallDefs(pk);
          const ball = defs.find(d => d.id === ballId);
          if (!ball) return interaction.reply({ content: "❌ Pokéball inconnue.", ephemeral: true });
          if ((ball.count || 0) <= 0) return interaction.reply({ content: `❌ Plus de ${ball.label}.`, ephemeral: true });

          if (ball.id === "poke") pk.pokeballs -= 1;
          else if (ball.id === "super") pk.superballs -= 1;
          else if (ball.id === "hyper") pk.hyperballs -= 1;
          else if (ball.id === "dusk") pk.duskballs -= 1;
          else if (ball.id === "master") pk.masterballs -= 1;

          const chance = getPokemonCaptureChance(pk, battle, ball);
          if (Math.random() < chance) {
            const capturedName = String(battle.enemyName || "Pokémon sauvage");
            const captureReward = 900 + Math.floor(Math.random() * 1601);
            pk.caughtCount = (pk.caughtCount || 0) + 1;
            if (!Array.isArray(pk.collection)) pk.collection = [];
            if (!pk.collection.includes(capturedName)) pk.collection.push(capturedName);
            pk.pokedollars = (pk.pokedollars || 0) + captureReward;
            pk.wins += 1;
            pk.battle = null;
            pk.cooldownUntil = now + POKEMON_BASE_COOLDOWN_MS;
            notice = `${ball.emoji} Capture réussie: ${capturedName}. Récompense: +${captureReward} Pokédollars. ⏱️ Attente: ${formatShortDuration(POKEMON_BASE_COOLDOWN_MS)}.`;
            battleFinished = true;
          } else {
            notice = `${ball.emoji} Capture ratée sur ${battle.enemyName}.`;
          }
        } else if (interaction.customId === "pk_special") {
          if ((pk.specialCooldownUntil || 0) > now) return interaction.reply({ content: "❌ Attaque spéciale en recharge.", ephemeral: true });
          playerHit = 30 + Math.floor(Math.random() * 21);
          battle.enemyHp -= playerHit;
          pk.specialCooldownUntil = now + 12 * 60 * 1000;
          if (Math.random() < 0.35) pk.enemyStatus = pickRandom(["Brûlure", "Poison", "Paralysie"]);
        } else if (interaction.customId === "pk_potion") {
          if ((pk.potions || 0) <= 0) return interaction.reply({ content: "❌ Plus de potion.", ephemeral: true });
          pk.potions -= 1;
          battle.playerHp = Math.min(100, battle.playerHp + 28);
        } else if (interaction.customId === "pk_defend") {
          battle.defending = true;
        }

        if (!battleFinished && battle.enemyHp <= 0) {
          const reward = 2800 + Math.floor(Math.random() * 5201);
          const potionDrop = Math.random() < 0.2 ? 1 : 0;
          pk.pokedollars = (pk.pokedollars || 0) + reward;
          if (potionDrop) pk.potions += 1;
          pk.wins += 1;
          pk.battle = null;
          pk.cooldownUntil = now + POKEMON_BASE_COOLDOWN_MS;
          notice = `✅ Tu as gagné contre ${battle.enemyName}. Récompense: +${reward} Pokédollars${potionDrop ? " et +1 potion" : ""}. ⏱️ Attente: ${formatShortDuration(POKEMON_BASE_COOLDOWN_MS)}.`;
        } else if (!battleFinished) {
          if (pk.enemyStatus === "Brûlure") battle.enemyHp -= 6;
          if (pk.enemyStatus === "Poison") battle.enemyHp -= 5;
          enemyHit = 8 + Math.floor(Math.random() * 15);
          if (battle.defending) {
            enemyHit = Math.floor(enemyHit * 0.45);
            battle.defending = false;
          }
          battle.playerHp -= enemyHit;

          if (battle.playerHp <= 0) {
            if ((pk.revives || 0) > 0) {
              pk.revives -= 1;
              battle.playerHp = 35;
              notice = `❤️ Rappel utilisé automatiquement. Tu repars avec 35 PV.`;
            } else {
              const penalty = 1200 + Math.floor(Math.random() * 1801);
              const removed = Math.min(pk.pokedollars || 0, penalty);
              pk.pokedollars = Math.max(0, (pk.pokedollars || 0) - removed);
              pk.losses += 1;
              pk.battle = null;
              pk.cooldownUntil = now + 30 * 60 * 1000;
              notice = `💀 Tu as perdu contre ${battle.enemyName}. Perte: -${removed} Pokédollars. ⏱️ Attente: ${formatShortDuration(30 * 60 * 1000)}.`;
            }
          } else {
            notice = interaction.customId === "pk_attack"
              ? `💥 Tu infliges ${playerHit} dégâts. ${battle.enemyName} inflige ${enemyHit} dégâts.`
              : (interaction.customId === "pk_special"
                ? `✨ Attaque spéciale: ${playerHit} dégâts. ${pk.enemyStatus ? `Statut appliqué: ${pk.enemyStatus}. ` : ""}${battle.enemyName} inflige ${enemyHit} dégâts.`
                : ((interaction.customId === "pk_capture" || interaction.customId.startsWith("pk_throw_ball_"))
                ? `${notice} ${battle.enemyName} inflige ${enemyHit} dégâts.`
                : (interaction.customId === "pk_potion"
                ? `🧪 Potion utilisée. ${battle.enemyName} inflige ${enemyHit} dégâts.`
                : `🛡️ Tu te défends. ${battle.enemyName} inflige ${enemyHit} dégâts réduits.`)));
          }
        }
      }
    }

    saveData();
    const view = buildPokemonView(userId);
    await interaction.update({ embeds: [view.embed], components: view.components });
    if (notice && !conversionInfo) {
      try { await interaction.channel.send(`🌎 <@${userId}> ${notice}`); } catch (e) {}
    }
    if (conversionInfo) {
      sendConversionMessage(interaction.channel, userId, conversionInfo.label, conversionInfo.from, conversionInfo.to);
    }
    return;
  }

  if (interaction.customId === "jeu_dongon") {
    const view = buildDonjonView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "dg_start" || interaction.customId === "dg_attack" || interaction.customId === "dg_defend" || interaction.customId === "dg_flee" || interaction.customId === "dg_ration" || interaction.customId === "dg_skill" || interaction.customId === "dg_power" || interaction.customId === "dg_change_class" || interaction.customId === "dg_convert_gold" || interaction.customId === "dg_continue" || interaction.customId === "dg_explore" || interaction.customId === "dg_upgrade_skill" || interaction.customId === "dg_upgrade_power" || interaction.customId === "dg_activity") {
    const dj = getDonjon(userId);
    const now = Date.now();
    let notice = "";
    let conversionInfo = null;
    let eventMessage = "";

    if (interaction.customId === "dg_convert_gold") {
      if (dj.battle) return interaction.reply({ content: "❌ Termine le combat avant de convertir.", ephemeral: true });
      if ((dj.goldCoins || 0) <= 0) return interaction.reply({ content: "❌ Aucune pièce d'or à convertir.", ephemeral: true });
      const amount = dj.goldCoins;
      const converted = amount * DG_GOLD_TO_MEMOCOIN;
      dj.goldCoins = 0;
      getBalance(userId).bank += converted;
      notice = `🏦 Conversion Donjon: ${amount} pièce(s) d'or → ${converted} Memocoins en banque.`;
      conversionInfo = { label: "pièce(s) d'or", from: amount, to: converted };
    } else if (interaction.customId === "dg_change_class") {
      const classWait = Math.max(0, (dj.classChangeCooldownUntil || 0) - now);
      if (classWait > 0) {
        return interaction.reply({ content: `⏱️ Changement de classe possible dans ${formatShortDuration(classWait)}.`, ephemeral: true });
      }
      const classes = ["guerrier", "tank", "mage", "assassin"];
      const idx = classes.indexOf(dj.classType || "guerrier");
      dj.classType = classes[(idx + 1) % classes.length];
      dj.classChangeCooldownUntil = now + getMsUntilNextParisMidnight();
      saveData();
      const view = buildDonjonView(userId);
      await interaction.update({ embeds: [view.embed], components: view.components });
      try { await interaction.channel.send(`🧭 <@${userId}> Classe changee: ${getDonjonClassLabel(dj.classType)}. Prochain changement demain.`); } catch (e) {}
      return;
    } else if (interaction.customId === "dg_upgrade_skill") {
      if (dj.battle) return interaction.reply({ content: "❌ Termine le combat avant d'améliorer ta compétence.", ephemeral: true });
      const skillLevel = Math.max(0, Number(dj.skillLevel || 0));
      if (skillLevel >= DONJON_MAX_SKILL_LEVEL) return interaction.reply({ content: "❌ Ta compétence est déjà au niveau maximum.", ephemeral: true });
      const cost = getDonjonSkillUpgradeCost(skillLevel);
      if ((dj.goldCoins || 0) < cost.gold || (dj.essence || 0) < cost.essence) {
        return interaction.reply({ content: `❌ Il faut ${cost.gold} pieces d'or et ${cost.essence} essence(s).`, ephemeral: true });
      }
      dj.goldCoins -= cost.gold;
      dj.essence -= cost.essence;
      dj.skillLevel = skillLevel + 1;
      notice = `📘 Compétence améliorée au niveau ${dj.skillLevel}. Coût: -${cost.gold} or et -${cost.essence} essence.`;
    } else if (interaction.customId === "dg_upgrade_power") {
      if (dj.battle) return interaction.reply({ content: "❌ Termine le combat avant d'améliorer ton pouvoir.", ephemeral: true });
      const powerLevel = Math.max(0, Number(dj.powerLevel || 0));
      if (powerLevel >= DONJON_MAX_POWER_LEVEL) return interaction.reply({ content: "❌ Ton pouvoir est déjà au niveau maximum.", ephemeral: true });
      const cost = getDonjonPowerUpgradeCost(powerLevel);
      if ((dj.goldCoins || 0) < cost.gold || (dj.essence || 0) < cost.essence) {
        return interaction.reply({ content: `❌ Il faut ${cost.gold} pieces d'or et ${cost.essence} essence(s).`, ephemeral: true });
      }
      dj.goldCoins -= cost.gold;
      dj.essence -= cost.essence;
      dj.powerLevel = powerLevel + 1;
      notice = `🔥 Pouvoir ${getDonjonPowerName(dj.classType)} ameliore au niveau ${dj.powerLevel}. Cout: -${cost.gold} or et -${cost.essence} essence.`;
    } else if (interaction.customId === "dg_activity") {
      if (dj.battle) return interaction.reply({ content: "❌ Les activites ne sont pas disponibles pendant un combat.", ephemeral: true });
      const activityWait = Math.max(0, (dj.activityCooldownUntil || 0) - now);
      if (activityWait > 0) {
        return interaction.reply({ content: `⏱️ Activite disponible dans ${formatShortDuration(activityWait)}.`, ephemeral: true });
      }
      dj.activityCooldownUntil = now + DONJON_ACTIVITY_COOLDOWN_MS;
      notice = `🏕️ ${runDonjonActivity(dj)}`;
    }

    if (interaction.customId === "dg_start") {
      const wait = Math.max(0, (dj.cooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `⏱️ Donjon bloque: ${formatShortDuration(wait)}.`, ephemeral: true });
      dj.nextEncounter = null;
      if (!dj.run || typeof dj.run !== "object") {
        const firstRun = (Number(dj.wins || 0) + Number(dj.losses || 0)) === 0;
        dj.run = { stage: 1, total: 10, easy: firstRun };
      } else if (!Number.isFinite(dj.run.stage) || dj.run.stage <= 0) {
        dj.run.stage = 1;
        dj.run.total = 10;
        if (typeof dj.run.easy !== "boolean") {
          dj.run.easy = (Number(dj.wins || 0) + Number(dj.losses || 0)) === 0;
        }
      }
      if (typeof dj.run.easy !== "boolean") {
        dj.run.easy = (Number(dj.wins || 0) + Number(dj.losses || 0)) === 0;
      }
      const isBossStage = dj.run.stage >= (dj.run.total || 10);
      const easyRun = Boolean(dj.run.easy);
      const tier = getDonjonTierForProgress(dj, dj.run.stage, { easyRun });
      const pool = buildDonjonMonsterPoolByTier(tier);
      const forceVariant = easyRun && (dj.run.stage || 1) <= 3 ? "normal" : null;
      const m = isBossStage ? pickDonjonBoss() : pickDonjonMonster({ pool, forceVariant });
      const chargesBefore = Number(dj.powerCharges || 0);
      gainDonjonPowerCharges(dj, 1);
      const chargeGainText = Number(dj.powerCharges || 0) > chargesBefore ? ` +1 charge de pouvoir.` : "";
      dj.battle = {
        monsterName: m.name,
        playerHp: 110,
        enemyHp: m.hp,
        enemyMaxHp: m.hp,
        atkMin: m.atkMin,
        atkMax: m.atkMax,
        rewardMin: m.rewardMin,
        rewardMax: m.rewardMax,
        losePenalty: m.losePenalty,
        defending: false,
        powerGuard: 0,
        variant: m.variant || "normal"
      };
      let startNote = "";
      const roomRoll = Math.random();
      if (roomRoll < 0.18) {
        dj.battle.playerHp = Math.min(110, dj.battle.playerHp + 20);
        startNote = " Sanctuaire: +20 PV.";
      } else if (roomRoll < 0.32) {
        dj.battle.playerHp = Math.max(60, dj.battle.playerHp - 10);
        startNote = " Piege: -10 PV.";
      }
      notice = `🚪 Donjon lance. Etape ${dj.run.stage}/${dj.run.total}. Ennemi: ${m.name}.${chargeGainText}${startNote}`;
    } else if (interaction.customId === "dg_continue" || interaction.customId === "dg_explore") {
      if (!dj.nextEncounter || !dj.nextEncounter.monster) {
        return interaction.reply({ content: "❌ Aucun choix en attente.", ephemeral: true });
      }
      const nextMonster = dj.nextEncounter.monster;
      let playerHp = Number(dj.nextEncounter.playerHp || 110);
      let exploreNote = "";
      if (interaction.customId === "dg_explore") {
        const exploreEvents = [
          { weight: 20, text: "🕯️ Sanctuaire: +20 PV.", apply: () => { playerHp = Math.min(110, playerHp + 20); } },
          { weight: 16, text: "⚠️ Piege: -10 PV.", apply: () => { playerHp = Math.max(1, playerHp - 10); } },
          { weight: 12, text: "🌿 Herbes medicinales: +10 PV.", apply: () => { playerHp = Math.min(110, playerHp + 10); } },
          { weight: 10, text: "🪙 Bourse oubliee: +3 pieces d'or.", apply: () => { dj.goldCoins = (dj.goldCoins || 0) + 3; } },
          { weight: 9, text: "🥖 Rations abandonnées: +1 ration.", apply: () => { dj.rations = (dj.rations || 0) + 1; } },
          { weight: 8, text: "🛡️ Bouclier rouillé: +1 bouclier.", apply: () => { dj.shields = (dj.shields || 0) + 1; } },
          { weight: 7, text: "💎 Éclat ancien: +1 pierre de résurrection.", apply: () => { dj.reviveStones = (dj.reviveStones || 0) + 1; } },
          { weight: 7, text: "✨ Cristal d'âme: +2 essences.", apply: () => { dj.essence = (dj.essence || 0) + 2; } },
          { weight: 6, text: "🔥 Feu runique: +1 charge de pouvoir.", apply: () => { gainDonjonPowerCharges(dj, 1); } },
          { weight: 5, text: "📚 Fresque tactique: comp?tence recharg?e.", apply: () => { dj.skillCooldownUntil = 0; } },
          { weight: 4, text: "🏺 Relique cachee: +1 relique.", apply: () => { dj.relics = (dj.relics || 0) + 1; } },
          { weight: 4, text: "🎁 Coffre rare: +12 pieces d'or et +1 essence.", apply: () => { dj.goldCoins = (dj.goldCoins || 0) + 12; dj.essence = (dj.essence || 0) + 1; } },
          { weight: 6, text: "🧭 Couloir tranquille: rien ne se passe.", apply: () => {} }
        ];
        const picked = weightedPick(exploreEvents);
        if (picked?.apply) picked.apply();
        exploreNote = picked?.text || "";
        eventMessage = `<@${userId}> ${exploreNote || "🧭 Couloir tranquille: rien ne se passe."}`;
      }
      dj.battle = {
        monsterName: nextMonster.name,
        playerHp,
        enemyHp: nextMonster.hp,
        enemyMaxHp: nextMonster.hp,
        atkMin: nextMonster.atkMin,
        atkMax: nextMonster.atkMax,
        rewardMin: nextMonster.rewardMin,
        rewardMax: nextMonster.rewardMax,
        losePenalty: nextMonster.losePenalty,
        defending: false,
        powerGuard: 0,
        variant: nextMonster.variant || "normal"
      };
      dj.nextEncounter = null;
      notice = `${exploreNote ? `${exploreNote} ` : ""}➡️ Etape ${dj.run?.stage || 0}/${dj.run?.total || 0}: ${nextMonster.name}.`;
    } else if (["dg_convert_gold", "dg_upgrade_skill", "dg_upgrade_power", "dg_activity"].includes(interaction.customId)) {
      // Action de preparation deja appliquee.
    } else {
      if (!dj.battle) return interaction.reply({ content: "❌ Aucun donjon actif.", ephemeral: true });
      const battle = dj.battle;

      if (interaction.customId === "dg_flee") {
        dj.battle = null;
        dj.nextEncounter = null;
        const waitMs = getMsUntilNextParisMidnight();
        dj.cooldownUntil = now + waitMs;
        dj.winStreak = 0;
        dj.run = null;
        notice = `🏃 Tu as fui le donjon. ⏱️ Attente: ${formatShortDuration(waitMs)} (jusqu'a demain).`;
      } else {
        let playerHit = 0;
        let enemyHit = 0;
        let actionNote = "";
        const skillLevel = Math.max(0, Number(dj.skillLevel || 0));
        const powerLevel = Math.max(0, Number(dj.powerLevel || 0));

        if (interaction.customId === "dg_attack") {
          playerHit = 14 + Math.floor(Math.random() * 18);
          if (dj.classType === "assassin" && Math.random() < 0.28) {
            playerHit = Math.floor(playerHit * 1.8);
            actionNote = " Coup critique.";
          }
          battle.enemyHp -= playerHit;
        } else if (interaction.customId === "dg_skill") {
          if ((dj.skillCooldownUntil || 0) > now) return interaction.reply({ content: "❌ Compétence en recharge.", ephemeral: true });
          if (dj.classType === "guerrier") {
            playerHit = 28 + Math.floor(Math.random() * 10) + (skillLevel * 6);
            battle.enemyHp -= playerHit;
            if (skillLevel >= 3 && Math.random() < 0.35) {
              dj.shields = (dj.shields || 0) + 1;
              actionNote = " +1 bouclier.";
            }
          } else if (dj.classType === "tank") {
            const heal = 12 + (skillLevel * 4);
            battle.defending = true;
            battle.playerHp = Math.min(110, battle.playerHp + heal);
            battle.powerGuard = Math.max(Number(battle.powerGuard || 0), 0.2 + Math.min(0.2, skillLevel * 0.03));
            actionNote = ` +${heal} PV.`;
          } else if (dj.classType === "mage") {
            playerHit = 22 + Math.floor(Math.random() * 15) + (skillLevel * 7);
            battle.enemyHp -= playerHit;
            battle.powerGuard = Math.max(Number(battle.powerGuard || 0), 0.15 + Math.min(0.2, skillLevel * 0.02));
            actionNote = " Bouclier arcanique actif.";
          } else {
            playerHit = 18 + Math.floor(Math.random() * 12) + (skillLevel * 5);
            if (Math.random() < Math.min(0.55, 0.18 + (skillLevel * 0.04))) {
              playerHit = Math.floor(playerHit * 1.6);
              actionNote = " Coup critique.";
            }
            battle.enemyHp -= playerHit;
          }
          dj.skillCooldownUntil = now + Math.max(25 * 1000, (60 * 1000) - (skillLevel * 3000));
        } else if (interaction.customId === "dg_power") {
          if ((dj.powerCharges || 0) <= 0) return interaction.reply({ content: "❌ Aucune charge de pouvoir disponible.", ephemeral: true });
          dj.powerCharges = Math.max(0, Number(dj.powerCharges || 0) - 1);
          if (dj.classType === "guerrier") {
            playerHit = 42 + Math.floor(Math.random() * 16) + (powerLevel * 8);
            battle.enemyHp -= playerHit;
            if (powerLevel >= 2) {
              dj.shields = (dj.shields || 0) + 1;
              actionNote = " +1 bouclier.";
            }
          } else if (dj.classType === "tank") {
            const heal = 22 + (powerLevel * 6);
            battle.playerHp = Math.min(110, battle.playerHp + heal);
            battle.defending = true;
            battle.powerGuard = Math.max(Number(battle.powerGuard || 0), 0.45 + Math.min(0.2, powerLevel * 0.03));
            if (powerLevel >= 3) dj.shields = (dj.shields || 0) + 1;
            actionNote = ` +${heal} PV${powerLevel >= 3 ? " et +1 bouclier" : ""}.`;
          } else if (dj.classType === "mage") {
            playerHit = 34 + Math.floor(Math.random() * 18) + (powerLevel * 9);
            battle.enemyHp -= playerHit;
            battle.powerGuard = Math.max(Number(battle.powerGuard || 0), 0.3);
            if (powerLevel >= 4) {
              dj.skillCooldownUntil = 0;
              actionNote = " Compétence rechargée.";
            }
          } else {
            playerHit = 26 + Math.floor(Math.random() * 20) + (powerLevel * 7);
            const threshold = Math.ceil((battle.enemyMaxHp || battle.enemyHp || 1) * 0.45);
            if (battle.enemyHp <= threshold) {
              playerHit += 18 + (powerLevel * 4);
              actionNote = " Execution renforcee.";
            } else if (Math.random() < Math.min(0.65, 0.25 + (powerLevel * 0.03))) {
              playerHit = Math.floor(playerHit * 1.5);
              actionNote = " Frappe critique.";
            }
            battle.enemyHp -= playerHit;
          }
        } else if (interaction.customId === "dg_ration") {
          if ((dj.rations || 0) <= 0) return interaction.reply({ content: "❌ Aucune ration.", ephemeral: true });
          dj.rations -= 1;
          battle.playerHp = Math.min(110, battle.playerHp + 24);
        } else {
          battle.defending = true;
        }

        if (battle.enemyHp <= 0) {
          const baseReward = battle.rewardMin + Math.floor(Math.random() * (battle.rewardMax - battle.rewardMin + 1));
          const relicBonusPct = Math.min(25, dj.relics || 0);
          const streakBonusPct = Math.min(25, (dj.winStreak || 0) * 2);
          const totalBonusPct = relicBonusPct + streakBonusPct;
          const reward = Math.floor(baseReward * (1 + (totalBonusPct / 100)));
          const jackpot = Math.random() < 0.12 ? (180 + Math.floor(Math.random() * 221)) : 0;
          const dropRation = Math.random() < 0.22 ? 1 : 0;
          const dropShield = Math.random() < 0.14 ? 1 : 0;
          const dropRevive = Math.random() < 0.06 ? 1 : 0;
          const dropRelic = Math.random() < 0.12 ? 1 : 0;
          const essenceGain = 1 + (Math.random() < 0.35 ? 1 : 0);
          const powerChargeGain = Math.random() < 0.18 ? 1 : 0;
          dj.goldCoins = (dj.goldCoins || 0) + reward;
          dj.essence = (dj.essence || 0) + essenceGain;
          if (jackpot > 0) dj.goldCoins += jackpot;
          if (dropRation) dj.rations += dropRation;
          if (dropShield) dj.shields += dropShield;
          if (dropRevive) dj.reviveStones += dropRevive;
          if (dropRelic) dj.relics = (dj.relics || 0) + dropRelic;
          if (powerChargeGain) gainDonjonPowerCharges(dj, powerChargeGain);
          dj.wins += 1;
          dj.winStreak = (dj.winStreak || 0) + 1;
          dj.bestStreak = Math.max(dj.bestStreak || 0, dj.winStreak || 0);
          const lootParts = [`+${essenceGain} essence`];
          if (dropRation) lootParts.push("+1 ration");
          if (dropShield) lootParts.push("+1 bouclier");
          if (dropRevive) lootParts.push("+1 pierre de résurrection");
          if (dropRelic) lootParts.push("+1 relique");
          if (powerChargeGain) lootParts.push("+1 charge de pouvoir");
          const lootText = lootParts.length ? ` | Butin: ${lootParts.join(", ")}` : "";
          const bonusText = totalBonusPct > 0 ? ` (bonus +${totalBonusPct}%)` : "";

          const runStage = dj.run?.stage || 1;
          const runTotal = dj.run?.total || 10;
          if (runStage >= runTotal) {
            dj.battle = null;
            dj.run = null;
            dj.nextEncounter = null;
            dj.cooldownUntil = now + 90 * 60 * 1000;
            const bossExtra = 10 + Math.floor(Math.random() * 41);
            const bossEssence = 2 + Math.floor(Math.random() * 2);
            dj.goldCoins += bossExtra;
            dj.essence += bossEssence;
            dj.relics = (dj.relics || 0) + 1;
            gainDonjonPowerCharges(dj, 1);
            notice = `👑 Boss vaincu: ${battle.monsterName}. Récompense: +${reward} pièce(s) d'or${bonusText}${jackpot > 0 ? ` + coffre bonus ${jackpot}` : ""}${lootText} +${bossExtra} or (bonus boss) +${bossEssence} essence +1 relique +1 charge. ⏱️ Attente: ${formatShortDuration(90 * 60 * 1000)}.`;
            eventMessage = `👑 <@${userId}> a vaincu ${battle.monsterName}. Récompense: +${reward} pièce(s) d'or${bonusText}${jackpot > 0 ? ` + coffre bonus ${jackpot}` : ""}${lootText} +${bossExtra} or (bonus boss) +${bossEssence} essence +1 relique +1 charge.`;
          } else {
            dj.run.stage = runStage + 1;
            const easyRun = Boolean(dj.run?.easy);
            const tier = getDonjonTierForProgress(dj, dj.run.stage, { easyRun });
            const pool = buildDonjonMonsterPoolByTier(tier);
            const forceVariant = easyRun && (dj.run.stage || 1) <= 3 ? "normal" : null;
            const nextMonster = dj.run.stage >= runTotal ? pickDonjonBoss() : pickDonjonMonster({ pool, forceVariant });
            dj.battle = null;
            dj.nextEncounter = {
              monster: nextMonster,
              playerHp: Math.max(1, battle.playerHp)
            };
            notice = `✅ Victoire contre ${battle.monsterName}. Récompense: +${reward} pièce(s) d'or${bonusText}${jackpot > 0 ? ` + coffre bonus ${jackpot}` : ""}${lootText}.\nChoisis: continuer à combattre ou explorer.`;
            eventMessage = `✅ <@${userId}> a vaincu ${battle.monsterName}. Récompense: +${reward} pièce(s) d'or${bonusText}${jackpot > 0 ? ` + coffre bonus ${jackpot}` : ""}${lootText}.`;
          }
        } else {
          enemyHit = battle.atkMin + Math.floor(Math.random() * (battle.atkMax - battle.atkMin + 1));
          if (dj.classType === "tank") enemyHit = Math.floor(enemyHit * 0.85);
          if ((dj.shields || 0) > 0) {
            dj.shields -= 1;
            enemyHit = Math.floor(enemyHit * 0.65);
          }
          const powerGuard = Math.max(0, Number(battle.powerGuard || 0));
          if (powerGuard > 0) {
            enemyHit = Math.floor(enemyHit * Math.max(0.15, 1 - powerGuard));
            battle.powerGuard = 0;
          }
          if (battle.defending) {
            enemyHit = Math.floor(enemyHit * 0.5);
            battle.defending = false;
          }
          battle.playerHp -= enemyHit;

          if (battle.playerHp <= 0) {
            if ((dj.reviveStones || 0) > 0) {
              dj.reviveStones -= 1;
              battle.playerHp = 40;
              notice = "💎 Pierre de résurrection utilisée. Tu repars avec 40 PV.";
            } else {
              const removed = Math.min(dj.goldCoins || 0, battle.losePenalty);
              dj.goldCoins = Math.max(0, (dj.goldCoins || 0) - removed);
              dj.losses += 1;
              dj.winStreak = 0;
              dj.battle = null;
              dj.run = null;
              dj.cooldownUntil = now + DONJON_LOSE_COOLDOWN_MS;
              notice = `💀 Tu as perdu contre ${battle.monsterName}. Perte: -${removed} pièce(s) d'or. ⏱️ Attente: ${formatShortDuration(DONJON_LOSE_COOLDOWN_MS)}.`;
              eventMessage = `💀 <@${userId}> a perdu contre ${battle.monsterName}. Perte: -${removed} pièce(s) d'or.`;
            }
          } else {
            if (interaction.customId === "dg_attack") {
              notice = `⚔️ Tu infliges ${playerHit} dégâts.${actionNote} ${battle.monsterName} t'inflige ${enemyHit} dégâts.`;
            } else if (interaction.customId === "dg_skill") {
              notice = `✨ Compétence ${getDonjonClassLabel(dj.classType)} utilisée${playerHit ? `: ${playerHit} dégâts.` : "."}${actionNote} ${battle.monsterName} t'inflige ${enemyHit} dégâts.`;
            } else if (interaction.customId === "dg_power") {
              notice = `🔥 Pouvoir ${getDonjonPowerName(dj.classType)} utilisé${playerHit ? `: ${playerHit} dégâts.` : "."}${actionNote} Charges restantes: ${dj.powerCharges || 0}. ${battle.monsterName} t'inflige ${enemyHit} dégâts.`;
            } else if (interaction.customId === "dg_ration") {
              notice = `🥖 Ration utilisée. ${battle.monsterName} t'inflige ${enemyHit} dégâts.`;
            } else {
              notice = `🛡️ Tu te défends. ${battle.monsterName} t'inflige ${enemyHit} dégâts réduits.`;
            }
          }
        }
      }
    }

    saveData();
    const view = buildDonjonView(userId);
    await interaction.update({ embeds: [view.embed], components: view.components });
    if (notice && !conversionInfo) {
      try { await interaction.channel.send(`🧨 <@${userId}> ${notice}`); } catch (e) {}
    }
    if (conversionInfo) {
      sendConversionMessage(interaction.channel, userId, conversionInfo.label, conversionInfo.from, conversionInfo.to);
    }
    if (eventMessage) {
      try {
        await interaction.channel?.send(eventMessage);
      } catch {}
    }
    return;
  }

  if (interaction.customId === "jeu_apocalipse_zombi") {
    const view = buildZombieView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "mc_shop_menu") {
    const view = buildMinecraftShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }
  if (interaction.customId === "pk_shop_menu") {
    const view = buildPokemonShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }
  if (interaction.customId === "dg_shop_menu") {
    const view = buildDonjonShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }
  if (interaction.customId === "zb_shop_menu") {
    const view = buildZombieShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (
    interaction.customId === "mc_shop_buy_wood" ||
    interaction.customId === "mc_shop_buy_stone" ||
    interaction.customId === "mc_shop_buy_coal" ||
    interaction.customId === "mc_shop_buy_ironore" ||
    interaction.customId === "mc_shop_buy_obsidian" ||
    interaction.customId === "mc_shop_buy_pearl" ||
    interaction.customId === "mc_shop_buy_blazerod" ||
    interaction.customId === "pk_shop_buy_potion" ||
    interaction.customId === "pk_shop_buy_pack" ||
    interaction.customId === "pk_shop_buy_revive" ||
    interaction.customId === "pk_shop_buy_ball" ||
    interaction.customId === "pk_shop_buy_superball" ||
    interaction.customId === "pk_shop_buy_hyperball" ||
    interaction.customId === "pk_shop_buy_duskball" ||
    interaction.customId === "pk_shop_buy_masterball" ||
    interaction.customId === "dg_shop_buy_shield" ||
    interaction.customId === "dg_shop_buy_ration" ||
    interaction.customId === "dg_shop_buy_revive" ||
    interaction.customId === "zb_shop_buy_medkit" ||
    interaction.customId === "zb_shop_buy_armor" ||
    interaction.customId === "zb_shop_buy_antidote" ||
    interaction.customId === "mm_shop_buy_anti_steal" ||
    interaction.customId === "mm_shop_buy_police" ||
    interaction.customId === "mm_shop_buy_reset_steal"
  ) {
    const itemMap = {
      mc_shop_buy_wood: { game: "mc", id: "wood", label: "Bois x20", price: 25, currency: "emerald" },
      mc_shop_buy_stone: { game: "mc", id: "stone", label: "Pierre x20", price: 40, currency: "emerald" },
      mc_shop_buy_coal: { game: "mc", id: "coal", label: "Charbon x10", price: 75, currency: "emerald" },
      mc_shop_buy_ironore: { game: "mc", id: "ironore", label: "Minerai de fer x8", price: 110, currency: "emerald" },
      mc_shop_buy_obsidian: { game: "mc", id: "obsidian", label: "Obsidienne x1", price: 180, currency: "emerald" },
      mc_shop_buy_pearl: { game: "mc", id: "pearl", label: "Perle de l'End x1", price: 240, currency: "emerald" },
      mc_shop_buy_blazerod: { game: "mc", id: "blazerod", label: "Bâton de blaze x1", price: 320, currency: "emerald" },
      pk_shop_buy_potion: { game: "pk", id: "potion", label: "Potion x1", price: 900, currency: "pokedollar" },
      pk_shop_buy_pack: { game: "pk", id: "pack", label: "Pack potion x3", price: 2400, currency: "pokedollar" },
      pk_shop_buy_revive: { game: "pk", id: "revive", label: "Rappel x1", price: 5000, currency: "pokedollar" },
      pk_shop_buy_ball: { game: "pk", id: "ball", label: "Pokéball x1", price: 700, currency: "pokedollar" },
      pk_shop_buy_superball: { game: "pk", id: "superball", label: "Superball x1", price: 1400, currency: "pokedollar" },
      pk_shop_buy_hyperball: { game: "pk", id: "hyperball", label: "Hyperball x1", price: 2500, currency: "pokedollar" },
      pk_shop_buy_duskball: { game: "pk", id: "duskball", label: "Sombreball x1", price: 3200, currency: "pokedollar" },
      pk_shop_buy_masterball: { game: "pk", id: "masterball", label: "Masterball x1", price: 15000, currency: "pokedollar" },
      dg_shop_buy_shield: { game: "dg", id: "shield", label: "Bouclier x1", price: 30, currency: "gold" },
      dg_shop_buy_ration: { game: "dg", id: "ration", label: "Ration x1", price: 5, currency: "gold" },
      dg_shop_buy_revive: { game: "dg", id: "revive", label: "Pierre de résurrection x1", price: 90, currency: "gold" },
      zb_shop_buy_medkit: { game: "zb", id: "medkit", label: "Kit de soin x1", price: 120, currency: "silver" },
      zb_shop_buy_armor: { game: "zb", id: "armor", label: "Armure x1", price: 260, currency: "silver" },
      zb_shop_buy_antidote: { game: "zb", id: "antidote", label: "Antidote x1", price: 340, currency: "silver" },
      mm_shop_buy_anti_steal: { game: "mm", id: "anti_steal", label: "Protection de vol x1", price: 150000 },
      mm_shop_buy_police: { game: "mm", id: "police", label: "Protection anti-police x1", price: SHOP_PRICE_POLICE_PROTECTION },
      mm_shop_buy_reset_steal: { game: "mm", id: "reset_steal", label: "Reset vol x1", price: 45000 }
    };
    const item = itemMap[interaction.customId];
    if (!item) {
      return silentInteraction(interaction);
    }
    const bal = getBalance(userId);
    const wallet = getWalletAmountByCurrency(bal, item.currency || "memocoin");
    if (wallet < item.price) {
      return silentInteraction(interaction);
    }
    const maxQty = item.currency === "memocoin"
      ? getMaxAffordableQuantity(getMemocoinSpendCapacity(userId), item.price, 999)
      : getMaxAffordableQuantity(wallet, item.price, 999);
    const modal = new ModalBuilder()
      .setCustomId(`game_shop_qty_modal_${userId}_${item.game}_${item.id}`)
      .setTitle("Quantité à acheter");
    const qtyInput = new TextInputBuilder()
      .setCustomId("game_shop_qty")
      .setLabel("Quantité")
      .setPlaceholder(`Max: ${maxQty}`)
      .setRequired(true)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(4);
    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
    return interaction.showModal(modal);
  }

  if (interaction.customId === "zb_start" || interaction.customId === "zb_attack" || interaction.customId === "zb_defend" || interaction.customId === "zb_medkit" || interaction.customId === "zb_flee" || interaction.customId === "zb_upgrade_base" || interaction.customId === "zb_scavenge" || interaction.customId === "zb_convert_silver") {
    const zb = getZombie(userId);
    const now = Date.now();
    let notice = "";

    if (interaction.customId === "zb_convert_silver") {
      if (zb.battle) return interaction.reply({ content: "❌ Termine le combat avant de convertir.", ephemeral: true });
      if ((zb.silverCoins || 0) <= 0) return interaction.reply({ content: "❌ Aucune pièce d'argent à convertir.", ephemeral: true });
      const amount = zb.silverCoins;
      const converted = amount * ZB_SILVER_TO_MEMOCOIN;
      zb.silverCoins = 0;
      getBalance(userId).bank += converted;
      saveData();
      const view = buildZombieView(userId);
      await interaction.update({ embeds: [view.embed], components: view.components });
      sendConversionMessage(interaction.channel, userId, "pièce(s) d'argent", amount, converted);
      return;
    }

    if (interaction.customId === "zb_upgrade_base") {
      const price = 500 * Math.max(1, zb.baseLevel || 1);
      if ((zb.silverCoins || 0) < price) return interaction.reply({ content: `❌ Il faut ${price} pièces d'argent.`, ephemeral: true });
      zb.silverCoins -= price;
      zb.baseLevel = (zb.baseLevel || 1) + 1;
      zb.fortification = Math.min(60, (zb.fortification || 0) + 5);
      saveData();
      const view = buildZombieView(userId);
      await interaction.update({ embeds: [view.embed], components: view.components });
      try { await interaction.channel.send(`🧟 <@${userId}> Base améliorée au niveau ${zb.baseLevel}. Fortification: ${zb.fortification}% (coût: ${price} pièces d'argent).`); } catch (e) {}
      return;
    }

    if (interaction.customId === "zb_scavenge") {
      const coins = 260 + Math.floor(Math.random() * 441);
      const med = Math.random() < 0.22 ? 1 : 0;
      const arm = Math.random() < 0.15 ? 1 : 0;
      const ant = Math.random() < 0.12 ? 1 : 0;
      zb.silverCoins = (zb.silverCoins || 0) + coins;
      zb.medkits += med;
      zb.armorPlates += arm;
      zb.antidotes += ant;
      saveData();
      const view = buildZombieView(userId);
      await interaction.update({ embeds: [view.embed], components: view.components });
      try { await interaction.channel.send(`🧟 <@${userId}> 📦 Fouille: +${coins} pièce(s) d'argent${med ? ", +1 medkit" : ""}${arm ? ", +1 armure" : ""}${ant ? ", +1 antidote" : ""}.`); } catch (e) {}
      return;
    }

    if (interaction.customId === "zb_medkit" && !zb.battle) {
      if ((zb.medkits || 0) <= 0) return interaction.reply({ content: "❌ Aucun medkit.", ephemeral: true });
      if ((zb.hp || 0) >= 100) return interaction.reply({ content: "✅ Santé déjà pleine.", ephemeral: true });
      zb.medkits -= 1;
      zb.hp = Math.min(100, (zb.hp || 0) + 35);
      notice = `🩹 Soin appliqué. Santé: ${zb.hp}/100.`;
      saveData();
      const view = buildZombieView(userId);
      await interaction.update({ embeds: [view.embed], components: view.components });
      try { await interaction.channel.send(`🧟 <@${userId}> ${notice}`); } catch (e) {}
      return;
    }

    if (interaction.customId === "zb_start") {
      const wait = Math.max(0, (zb.cooldownUntil || 0) - now);
      if (wait > 0) return interaction.reply({ content: `⏱️ Zone dangereuse: encore ${formatShortDuration(wait)}.`, ephemeral: true });
      const enemies = [
        { name: "Walker", hp: 55, atkMin: 7, atkMax: 15, rewardMin: 220, rewardMax: 460 },
        { name: "Runner", hp: 75, atkMin: 10, atkMax: 18, rewardMin: 380, rewardMax: 700 },
        { name: "Tank mutant", hp: 110, atkMin: 14, atkMax: 24, rewardMin: 650, rewardMax: 1200 }
      ];
      const enemy = weightedPick(enemies.map(e => ({ ...e, weight: e.name === "Walker" ? 55 : e.name === "Runner" ? 30 : 15 })));
      zb.battle = { enemyName: enemy.name, enemyHp: enemy.hp, playerHp: Math.max(20, zb.hp || 100), atkMin: enemy.atkMin, atkMax: enemy.atkMax, rewardMin: enemy.rewardMin, rewardMax: enemy.rewardMax, defending: false };
      notice = `🚨 Menace détectée: ${enemy.name}.`;
    } else {
      if (!zb.battle) return interaction.reply({ content: "❌ Aucun combat zombie actif.", ephemeral: true });
      const battle = zb.battle;

      if (interaction.customId === "zb_medkit") {
        if ((zb.medkits || 0) <= 0) return interaction.reply({ content: "❌ Aucun medkit.", ephemeral: true });
        zb.medkits -= 1;
        battle.playerHp = Math.min(100, battle.playerHp + 30);
        notice = `🩹 Kit de soin utilisé en combat. PV: ${battle.playerHp}/100.`;
      } else if (interaction.customId === "zb_flee") {
        zb.battle = null;
        zb.cooldownUntil = now + 15 * 60 * 1000;
        zb.hp = Math.max(20, battle.playerHp);
        notice = `🏃 Retraite réussie. ⏱️ Attente: ${formatShortDuration(15 * 60 * 1000)}.`;
      } else {
        let playerHit = 0;
        if (interaction.customId === "zb_attack") {
          playerHit = 11 + Math.floor(Math.random() * 16);
          battle.enemyHp -= playerHit;
        } else {
          battle.defending = true;
        }

        if (battle.enemyHp <= 0) {
          const reward = battle.rewardMin + Math.floor(Math.random() * (battle.rewardMax - battle.rewardMin + 1));
          const medkitDrop = Math.random() < 0.25 ? 1 : 0;
          const crate = Math.random() < 0.2 ? (220 + Math.floor(Math.random() * 361)) : 0;
          zb.silverCoins = (zb.silverCoins || 0) + reward;
          if (crate > 0) zb.silverCoins += crate;
          if (medkitDrop) zb.medkits += medkitDrop;
          zb.wins += 1;
          zb.battle = null;
          zb.cooldownUntil = now + ZOMBIE_BASE_COOLDOWN_MS;
          zb.hp = Math.min(100, battle.playerHp);
          notice = `✅ Menace éliminée. Récompense: +${reward} pièce(s) d'argent${crate > 0 ? ` + caisse ${crate}` : ""}${medkitDrop ? " et +1 medkit" : ""}. ⏱️ Attente: ${formatShortDuration(ZOMBIE_BASE_COOLDOWN_MS)}.`;
        } else {
          let enemyHit = battle.atkMin + Math.floor(Math.random() * (battle.atkMax - battle.atkMin + 1));
          enemyHit = Math.max(1, Math.floor(enemyHit * (1 - Math.min(0.6, (zb.fortification || 0) / 100))));
          if ((zb.armorPlates || 0) > 0) {
            zb.armorPlates -= 1;
            enemyHit = Math.floor(enemyHit * 0.6);
          }
          if (battle.defending) {
            enemyHit = Math.floor(enemyHit * 0.5);
            battle.defending = false;
          }
          battle.playerHp -= enemyHit;

          if (battle.playerHp <= 0) {
            if ((zb.antidotes || 0) > 0) {
              zb.antidotes -= 1;
              battle.playerHp = 30;
              zb.hp = 30;
              notice = `🧴 Antidote utilisé. Tu survies avec 30 PV.`;
            } else {
              const penalty = 180 + Math.floor(Math.random() * 261);
              const removed = Math.min(zb.silverCoins || 0, penalty);
              zb.silverCoins = Math.max(0, (zb.silverCoins || 0) - removed);
              zb.losses += 1;
              zb.battle = null;
              zb.cooldownUntil = now + 2 * 60 * 60 * 1000;
              zb.hp = 45;
              notice = `💀 Tu as été submergé. Perte: -${removed} pièce(s) d'argent. ⏱️ Attente: ${formatShortDuration(2 * 60 * 60 * 1000)}.`;
            }
          } else {
            zb.hp = battle.playerHp;
            notice = interaction.customId === "zb_attack"
              ? `🔫 Tu infliges ${playerHit} dégâts. ${battle.enemyName} inflige ${enemyHit} dégâts.`
              : `🧱 Tu te couvres. ${battle.enemyName} inflige ${enemyHit} dégâts réduits.`;
          }
        }
      }
    }

    saveData();
    const view = buildZombieView(userId);
    await interaction.update({ embeds: [view.embed], components: view.components });
    if (notice) {
      try { await interaction.channel.send(`🧟 <@${userId}> ${notice}`); } catch (e) {}
    }
    return;
  }

  if (interaction.customId === "menu_jeux_argent") {
    if (isInPrison(userId)) {
      const blocked = buildPrisonBlockedView(userId);
      return interaction.update({ embeds: [blocked.embed], components: blocked.components });
    }
    const embed = new EmbedBuilder()
      .setTitle("\u{1F4B8} Jeux d'argent")
      .setDescription("Choisis ton jeu d'argent.")
      .setColor(0xe74c3c);

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_roulette").setLabel("\u{1F3AF} Roulette").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("jeu_casino").setLabel("\u{1F3B2} Casino").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("jeu_blackjack").setLabel("🃏 Blackjack").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("jeu_slotomania").setLabel("\u{1F3B0} Slotomania").setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );
    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }

  // --------------------------
  // Blackjack
  // --------------------------
  if (interaction.customId === "jeu_blackjack") {
    if (!isBlackjackOwner(interaction)) {
      return interaction.reply({ content: "\u274C Ce Blackjack appartient à un autre joueur.", ephemeral: true });
    }
    const view = buildBlackjackView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "blackjack_session_start") {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (state.sessionActive) {
      const view = buildBlackjackView(userId, "❌ Une session est déjà en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (getTotalMemocoin(userId) < BLACKJACK_BUY_IN_MEMOCOIN) {
      return interaction.reply({
        content: `❌ Il faut ${BLACKJACK_BUY_IN_MEMOCOIN} Memocoins pour entrer au Blackjack.`,
        ephemeral: true
      });
    }
    if (!spendMemocoinInventoryThenBank(userId, BLACKJACK_BUY_IN_MEMOCOIN)) {
      return interaction.reply({
        content: `❌ Impossible de payer les ${BLACKJACK_BUY_IN_MEMOCOIN} Memocoins du buy-in.`,
        ephemeral: true
      });
    }

    bal.blackjack = getDefaultBlackjackState();
    bal.blackjack.sessionActive = true;
    bal.blackjack.chips = BLACKJACK_STARTING_CHIPS;
    bal.blackjack.deck = createBlackjackDeck();

    await syncBlackjackInteraction(
      interaction,
      userId,
      `✅ Session lancée: ${BLACKJACK_STARTING_CHIPS} jetons achetés pour ${BLACKJACK_BUY_IN_MEMOCOIN} Memocoins.`
    );
    return;
  }

  if (interaction.customId.startsWith("blackjack_bet_")) {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (!state.sessionActive) {
      const view = buildBlackjackView(userId, "❌ Lance d'abord une session.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (state.active) {
      const view = buildBlackjackView(userId, "❌ Une main est déjà en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    const bet = Number.parseInt(interaction.customId.split("_").pop(), 10) || 0;
    if (!BLACKJACK_BET_OPTIONS.includes(bet) || bet <= 0 || bet > BLACKJACK_MAX_BET) {
      return silentInteraction(interaction);
    }

    startBlackjackHand(bal, bet);
    let footerText = `✅ Main lancée avec une mise de ${bet} jetons.`;
    let finishedResult = null;
    let settlementResult = null;
    if (isBlackjackNatural(bal.blackjack.playerHand) || isBlackjackNatural(bal.blackjack.dealerHand)) {
      if (isBlackjackNatural(bal.blackjack.playerHand) && isBlackjackNatural(bal.blackjack.dealerHand)) {
        finishedResult = finishBlackjackHand(
          bal,
          "push",
          `Double blackjack. Ta mise de ${formatBlackjackChips(bet)} jetons est rendue.`,
          bet
        );
      } else if (isBlackjackNatural(bal.blackjack.playerHand)) {
        const blackjackPayout = bet * 2.5;
        finishedResult = finishBlackjackHand(
          bal,
          "blackjack",
          `Blackjack naturel ! Tu récupères ${formatBlackjackChips(blackjackPayout)} jetons.`,
          blackjackPayout
        );
      } else {
        finishedResult = finishBlackjackHand(
          bal,
          "loss",
          `Le croupier a un blackjack naturel. Tu perds ${formatBlackjackChips(bet)} jetons.`,
          0
        );
      }
      footerText = finishedResult.message;
      settlementResult = maybeAutoSettleBlackjackSession(userId);
      if (settlementResult) footerText = settlementResult.message;
    }

    await syncBlackjackInteraction(interaction, userId, footerText, [finishedResult, settlementResult]);
    return;
  }

  if (interaction.customId === "blackjack_hit") {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (!state.active) {
      const view = buildBlackjackView(userId, "❌ Aucune main en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    const currentBet = normalizeBlackjackChipValue(state.bet);
    const drawn = drawBlackjackCard(state);
    if (drawn) {
      state.playerHand.push(drawn);
    }

    let footerText = `🂠 Carte tirée: ${drawn ? formatBlackjackCard(drawn) : "?"}.`;
    let finishedResult = null;
    let settlementResult = null;
    const playerTotal = getBlackjackHandTotal(state.playerHand);

    if (playerTotal > 21) {
      finishedResult = finishBlackjackHand(
        bal,
        "loss",
        `Tu dépasses 21 avec ${playerTotal}. Tu perds ${formatBlackjackChips(currentBet)} jetons.`,
        0
      );
      footerText = finishedResult.message;
    } else if (playerTotal === 21) {
      finishedResult = resolveBlackjackDealerRound(
        bal,
        `21 atteint${drawn ? ` avec ${formatBlackjackCard(drawn)}` : ""}.`
      );
      footerText = finishedResult.message;
    }

    if (finishedResult) {
      settlementResult = maybeAutoSettleBlackjackSession(userId);
      if (settlementResult) footerText = settlementResult.message;
    }
    await syncBlackjackInteraction(interaction, userId, footerText, [finishedResult, settlementResult]);
    return;
  }

  if (interaction.customId === "blackjack_stand") {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (!state.active) {
      const view = buildBlackjackView(userId, "❌ Aucune main en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    const result = resolveBlackjackDealerRound(bal, "Tu restes.");
    const settlementResult = maybeAutoSettleBlackjackSession(userId);
    await syncBlackjackInteraction(
      interaction,
      userId,
      settlementResult ? settlementResult.message : result.message,
      [result, settlementResult]
    );
    return;
  }

  if (interaction.customId === "blackjack_double") {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (!state.active) {
      const view = buildBlackjackView(userId, "❌ Aucune main en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (state.playerHand.length !== 2) {
      const view = buildBlackjackView(userId, "❌ Doubler n'est possible que sur les 2 premières cartes.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    const baseBet = normalizeBlackjackChipValue(state.bet);
    state.chips = normalizeBlackjackChipValue(state.chips - baseBet);
    state.bet = normalizeBlackjackChipValue(baseBet * 2);
    const drawn = drawBlackjackCard(state);
    if (drawn) {
      state.playerHand.push(drawn);
    }

    const playerTotal = getBlackjackHandTotal(state.playerHand);
    let result = null;
    if (playerTotal > 21) {
      result = finishBlackjackHand(
        bal,
        "loss",
        `Tu doubles, tires ${drawn ? formatBlackjackCard(drawn) : "?"} et dépasses 21 avec ${playerTotal}. Tu perds ${formatBlackjackChips(state.bet)} jetons.`,
        0
      );
    } else {
      result = resolveBlackjackDealerRound(
        bal,
        `Tu doubles et tires ${drawn ? formatBlackjackCard(drawn) : "?"}.`
      );
    }
    const settlementResult = maybeAutoSettleBlackjackSession(userId);
    await syncBlackjackInteraction(
      interaction,
      userId,
      settlementResult ? settlementResult.message : result.message,
      [result, settlementResult]
    );
    return;
  }

  if (interaction.customId === "blackjack_surrender") {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (!state.active) {
      const view = buildBlackjackView(userId, "❌ Aucune main en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (state.playerHand.length !== 2) {
      const view = buildBlackjackView(userId, "❌ L'abandon n'est possible qu'avant de tirer.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    const refund = normalizeBlackjackChipValue((state.bet || 0) / 2);
    const result = finishBlackjackHand(
      bal,
      "surrender",
      `Tu abandonnes la main et récupères ${formatBlackjackChips(refund)} jetons sur ${formatBlackjackChips(state.bet)}.`,
      refund
    );
    const settlementResult = maybeAutoSettleBlackjackSession(userId);
    await syncBlackjackInteraction(
      interaction,
      userId,
      settlementResult ? settlementResult.message : result.message,
      [result, settlementResult]
    );
    return;
  }

  if (interaction.customId === "blackjack_cashout") {
    if (!isBlackjackOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const state = normalizeBlackjackState(bal.blackjack);
    if (!state.sessionActive) {
      const view = buildBlackjackView(userId, "❌ Aucune session en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    if (state.active) {
      const view = buildBlackjackView(userId, "❌ Termine d'abord la main en cours.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    const settlement = settleBlackjackSession(userId, "Session arrêtée par le joueur.");
    await syncBlackjackInteraction(
      interaction,
      userId,
      settlement ? settlement.message : "✅ Session encaissée.",
      [settlement]
    );
    return;
  }

  // --------------------------
  // ROULETTE
  // ROULETTE
  // --------------------------
  if (interaction.customId === "jeu_roulette") {
    if (!isRouletteOwner(interaction)) {
      return interaction.reply({ content: "\u274C Cette roulette appartient à un autre joueur.", ephemeral: true });
    }
    const view = buildRouletteView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "use_reset_roulette_power") {
    if (!isRouletteOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const now = Date.now();
    const hasCooldown = (bal.rouletteCooldownUntil || 0) > now;
    if ((bal.resetRoulettePower || 0) <= 0) {
      return silentInteraction(interaction);
    }
    if (!hasCooldown) {
      return silentInteraction(interaction);
    }
    bal.resetRoulettePower -= 1;
    bal.rouletteCooldownUntil = 0;
    bal.rouletteLastPlayDay = null;
    saveData();

    const view = buildRouletteView(userId, `\u2705 Pouvoir utilisé. Reset roulette restant: ${bal.resetRoulettePower}`);
    await interaction.update({ embeds: [view.embed], components: view.components });
    await sendPowerUsedMessage(interaction.channel, userId, "un reset roulette", bal.resetRoulettePower);
    return;
  }

  if (interaction.customId === "roulette_spin") {
    if (!isRouletteOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const totalBefore = getTotalMemocoin(userId);
    const now = Date.now();
    if ((bal.rouletteCooldownUntil || 0) > now) {
      return silentInteraction(interaction);
    }
    if (!canSpendMemocoinAmount(userId, 1000)) {
      return interaction.reply({ content: getDebtBlockedReason("Roulette"), ephemeral: true });
    }

    let resultText = "";
    let color = 0xffcc00;
    const specialRoll = Math.random() * 100;

    // requested absolute odds for reset powers
    if (specialRoll < 0.1) {
      bal.resetRoulettePower = (bal.resetRoulettePower || 0) + 1;
      resultText = "\u{1F389} Gain: +1 pouvoir reset roulette";
      color = 0x9966ff;
    } else if (specialRoll < 3.1) {
      bal.resetStealPower = (bal.resetStealPower || 0) + 1;
      resultText = "\u{1F389} Gain: +1 pouvoir reset vol";
      color = 0x9966ff;
    } else if (specialRoll < 8.1) {
      bal.resetStealPower = (bal.resetStealPower || 0) + 3;
      resultText = "\u{1F389} Gain: +3 pouvoirs reset vol";
      color = 0x9966ff;
    } else if (specialRoll < 8.12) {
      bal.resetCasinoPower = (bal.resetCasinoPower || 0) + 1;
      resultText = "\u{1F389} Gain: +1 pouvoir reset casino";
      color = 0x9966ff;
    } else if (specialRoll < 8.13) {
      bal.resetCasinoPower = (bal.resetCasinoPower || 0) + 3;
      resultText = "\u{1F389} Gain: +3 pouvoirs reset casino";
      color = 0x9966ff;
    } else if (specialRoll < 8.15) {
      bal.resetSlotPower = (bal.resetSlotPower || 0) + 1;
      resultText = "\u{1F389} Gain: +1 pouvoir reset Slotomania";
      color = 0x9966ff;
    } else if (specialRoll < 8.16) {
      bal.resetSlotPower = (bal.resetSlotPower || 0) + 3;
      resultText = "\u{1F389} Gain: +3 pouvoirs reset Slotomania";
      color = 0x9966ff;
    } else {
      const category = weightedPick([
        { kind: "gain", weight: 45 },
        { kind: "loss", weight: 45 },
        { kind: "protection", weight: 10 }
      ]);

      if (category.kind === "gain") {
        const gain = weightedPick([
          { value: 5, weight: 70 },
          { value: 10, weight: 30 },
          { value: 100, weight: 10 },
          { value: 1000, weight: 5 }
        ]);
        bal.inventory += gain.value;
        resultText = `\u{1F4B8} Tu as gagne ${gain.value} Memocoins.`;
        color = 0x00cc66;
      } else if (category.kind === "loss") {
        const loss = weightedPick([
          { value: 5, weight: 70 },
          { value: 10, weight: 30 },
          { value: 100, weight: 10 },
          { value: 1000, weight: 5 }
        ]);
        if (!spendMemocoinInventoryThenBank(userId, loss.value)) {
          return interaction.reply({ content: getDebtBlockedReason("Perte"), ephemeral: true });
        }
        resultText = `\u274C Tu as perdu ${loss.value} Memocoins.`;
        color = 0xff3333;
      } else {
        const prot = weightedPick([
          { value: 1, weight: 10 },
          { value: 3, weight: 5 },
          { value: 10, weight: 1 }
        ]);
        bal.antiStealProtection += prot.value;
        resultText = `\u{1F6E1}\u{FE0F} Gain: +${prot.value} protection(s) de vol`;
        color = 0x3399ff;
      }
    }

    const msToMidnight = msUntilParisMidnight(new Date());
    bal.rouletteCooldownUntil = now + msToMidnight;
    bal.rouletteLastPlayDay = getParisDayKey(new Date());
    saveData();
    const totalAfter = getTotalMemocoin(userId);

    const embed = new EmbedBuilder()
      .setTitle("\u{1F3B0} Roulette")
      .setColor(color)
      .setDescription(`${resultText}`)
      .addFields(
        { name: "\u{1F4E6} Inventaire", value: String(bal.inventory), inline: true },
        { name: "\u23F1\u{FE0F} Cooldown", value: formatShortDuration(Math.max(1, (bal.rouletteCooldownUntil || 0) - Date.now())), inline: true },
        { name: "\u26A1 Reset roulette", value: String(bal.resetRoulettePower || 0), inline: true }
      )
      .setFooter({ text: "Roulette rejouable à 00h00 (Europe/Paris) ou avec un reset roulette." })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("roulette_spin").setLabel("\u{1F3B2} Lancer").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId("use_reset_roulette_power").setLabel("\u{26A1} Utiliser reset roulette").setStyle(ButtonStyle.Primary).setDisabled((bal.resetRoulettePower || 0) <= 0 || (bal.rouletteCooldownUntil || 0) <= Date.now())
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
    await sendMoneyGameResultMessage(interaction.channel, userId, "Roulette", totalAfter - totalBefore, bal.rouletteCooldownUntil || 0, resultText);
    return;
  }

  // --------------------------
  // Casino
  // --------------------------
  if (interaction.customId === "jeu_casino") {
    if (!isCasinoOwner(interaction)) {
      return interaction.reply({ content: "\u274C Ce Casino appartient à un autre joueur.", ephemeral: true });
    }
    const view = buildCasinoView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "use_reset_casino_power") {
    if (!isCasinoOwner(interaction)) {
      return silentInteraction(interaction);
    }
    const bal = getBalance(userId);
    if ((bal.resetCasinoPower || 0) <= 0) {
      return silentInteraction(interaction);
    }
    if (!hasCasinoCooldown(userId)) {
      return silentInteraction(interaction);
    }

    bal.resetCasinoPower -= 1;
    bal.casinoCooldownUntil = 0;
    saveData();

    const view = buildCasinoView(userId, `\u2705 Pouvoir utilisé. Reset casino restant: ${bal.resetCasinoPower}`);
    await interaction.update({ embeds: [view.embed], components: view.components });
    await sendPowerUsedMessage(interaction.channel, userId, "un reset casino", bal.resetCasinoPower);
    return;
  }

  if (interaction.customId === "casino_play") {
    if (!isCasinoOwner(interaction)) {
      return silentInteraction(interaction);
    }

    const bal = getBalance(userId);
    const totalBefore = getTotalMemocoin(userId);
    const now = Date.now();
    if ((bal.casinoCooldownUntil || 0) > now) {
      return silentInteraction(interaction);
    }
    const loss = 5000;
    if (!canSpendMemocoinAmount(userId, loss)) {
      return interaction.reply({ content: getDebtBlockedReason("Casino"), ephemeral: true });
    }

    let message = "";
    if (Math.random() < CASINO_WIN_CHANCE) {
      const gain = CASINO_WIN_REWARD;
      bal.inventory += gain;
      message = `\u{1F389} Tu as gagne ${gain} Memocoins.`;
    } else {
      if (!spendMemocoinInventoryThenBank(userId, loss)) {
        return interaction.reply({ content: getDebtBlockedReason("Casino"), ephemeral: true });
      }
      message = `\u274C Tu as perdu ${loss} Memocoins.`;
    }

    bal.casinoCooldownUntil = now + (60 * 60 * 1000); // 1 hour
    saveData();
    const totalAfter = getTotalMemocoin(userId);

    const view = buildCasinoView(userId, `${message}`);
    await interaction.update({ embeds: [view.embed], components: view.components });
    await sendMoneyGameResultMessage(interaction.channel, userId, "Casino", totalAfter - totalBefore, bal.casinoCooldownUntil || 0, message);
    return;
  }

  // --------------------------
  // Slotomania
  // --------------------------
  if (interaction.customId === "jeu_slotomania") {
    if (!isSlotOwner(interaction)) {
      return interaction.reply({ content: "\u274C Ce Slotomania appartient à un autre joueur.", ephemeral: true });
    }
    const view = buildSlotomaniaView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "use_reset_slot_power") {
    if (!isSlotOwner(interaction)) {
      return silentInteraction(interaction);
    }
    const bal = getBalance(userId);
    if ((bal.resetSlotPower || 0) <= 0) {
      return silentInteraction(interaction);
    }
    if ((bal.slotCooldownUntil || 0) <= Date.now()) {
      return silentInteraction(interaction);
    }

    bal.resetSlotPower -= 1;
    bal.slotCooldownUntil = 0;
    saveData();

    const view = buildSlotomaniaView(userId, `\u2705 Pouvoir utilisé. Reset Slotomania restant: ${bal.resetSlotPower}`);
    await interaction.update({ embeds: [view.embed], components: view.components });
    await sendPowerUsedMessage(interaction.channel, userId, "un reset Slotomania", bal.resetSlotPower);
    return;
  }

  if (interaction.customId === "slot_play") {
    if (!isSlotOwner(interaction)) {
      return silentInteraction(interaction);
    }
    const bal = getBalance(userId);
    const totalBefore = getTotalMemocoin(userId);
    const now = Date.now();
    if ((bal.slotCooldownUntil || 0) > now) {
      return silentInteraction(interaction);
    }
    const baseLoss = 5000;
    if (!canSpendMemocoinAmount(userId, baseLoss)) {
      return interaction.reply({ content: getDebtBlockedReason("Slotomania"), ephemeral: true });
    }

    const roll = Math.random();
    const symbols = ["\u{1F352}", "\u{1F34C}", "\u{1F345}", "\u{1F347}", "\u{1F34B}", "\u2B50", "\u{1F4A0}", "7"];

    let reels = ["\u2753", "\u2753", "\u2753"];
    let resultText = "";
    let color = 0xff3333;

    if (roll < SLOT_JACKPOT_CHANCE) {
      reels = ["\u{1F352}", "\u{1F352}", "\u{1F352}"];
      bal.inventory += SLOT_JACKPOT_REWARD;
      resultText = `Tu as gagne ${SLOT_JACKPOT_REWARD} Memocoins.`;
      color = 0xffd700;
    } else if (roll < SLOT_JACKPOT_CHANCE + SLOT_BONUS_CHANCE) {
      reels = ["\u{1F34C}", "\u{1F34C}", "\u{1F34C}"];
      bal.inventory += SLOT_BONUS_REWARD;
      resultText = `Tu as gagne ${SLOT_BONUS_REWARD} Memocoins.`;
      color = 0x66cc33;
    } else if (roll < SLOT_JACKPOT_CHANCE + SLOT_BONUS_CHANCE + SLOT_RESET_CHANCE) {
      reels = ["\u{1F345}", "\u{1F345}", "\u{1F345}"];
      const resetKinds = ["roulette", "steal", "slot"];
      const picked = resetKinds[Math.floor(Math.random() * resetKinds.length)];
      if (picked === "roulette") {
        bal.resetRoulettePower = (bal.resetRoulettePower || 0) + 1;
        resultText = "Gain spécial: +1 reset roulette";
      } else if (picked === "steal") {
        bal.resetStealPower = (bal.resetStealPower || 0) + 1;
        resultText = "Gain spécial: +1 reset vol";
      } else {
        bal.resetSlotPower = (bal.resetSlotPower || 0) + 1;
        resultText = "Gain spécial: +1 reset Slotomania";
      }
      color = 0x3399ff;
    } else if (roll < SLOT_JACKPOT_CHANCE + SLOT_BONUS_CHANCE + SLOT_RESET_CHANCE + SLOT_SMALL_WIN_CHANCE) {
      reels = ["\u{1F347}", "\u{1F347}", "\u{1F347}"];
      bal.inventory += SLOT_SMALL_WIN_REWARD;
      resultText = `Tu as gagne ${SLOT_SMALL_WIN_REWARD} Memocoins.`;
      color = 0x4caf50;
    } else {
      reels = Array.from({ length: 3 }, () => symbols[Math.floor(Math.random() * symbols.length)]);
      if (!spendMemocoinInventoryThenBank(userId, baseLoss)) {
        return interaction.reply({ content: getDebtBlockedReason("Slotomania"), ephemeral: true });
      }
      resultText = `Tu as perdu ${baseLoss} Memocoins.`;
    }

    bal.slotCooldownUntil = now + (3 * 60 * 60 * 1000);
    saveData();
    const totalAfter = getTotalMemocoin(userId);

    const embed = new EmbedBuilder()
      .setTitle("\u{1F3B0} Slotomania")
      .setColor(color)
      .setDescription(`${reels.join(" | ")}\n${resultText}`)
      .addFields(
        { name: "\u{1FA99} Memocoin", value: `${bal.inventory}$`, inline: true },
        { name: "\u23F1\u{FE0F} Cooldown", value: formatShortDuration(Math.max(1, (bal.slotCooldownUntil || 0) - Date.now())), inline: true },
        { name: "\u26A1 Reset Slotomania", value: String(bal.resetSlotPower || 0), inline: true }
      )
      .setFooter({ text: "Slotomania rejouable après 3h ou avec un reset Slotomania." })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("slot_play").setLabel("\u{1F3B2} Lancer").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId("use_reset_slot_power").setLabel("\u{26A1} Utiliser reset Slotomania").setStyle(ButtonStyle.Primary).setDisabled((bal.resetSlotPower || 0) <= 0)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_jeux_argent").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
    await sendMoneyGameResultMessage(interaction.channel, userId, "Slotomania", totalAfter - totalBefore, bal.slotCooldownUntil || 0, resultText);
    return;
  }

  // --------------------------
  // MAGASIN
  // --------------------------
  if (interaction.customId === "jeu_shop") {
    const view = buildShopHubView();
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "shop_cat_jeux_argent") {
    const view = buildMoneyShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "shop_cat_memocoin") {
    const view = buildMemocoinShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "shop_cat_minecraft") {
    const view = buildMinecraftShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }
  if (interaction.customId === "shop_cat_pokemon") {
    const view = buildPokemonShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }
  if (interaction.customId === "shop_cat_donjon") {
    const view = buildDonjonShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }
  if (interaction.customId === "shop_cat_zombie") {
    const view = buildZombieShopView(userId);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "shop_traveling_merchant") {
    const view = buildTravelingMerchantView(userId, { forceNew: true });
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  const merchantMatch = interaction.customId.match(/^merchant_buy_([1-5])$/);
  if (merchantMatch) {
    if (!isTravelingMerchantOpen()) {
      return silentInteraction(interaction);
    }
    const slot = Number(merchantMatch[1]);
    const record = travelingMerchantMap.get(userId);
    if (!record || !Array.isArray(record.offers)) {
      const view = buildTravelingMerchantView(userId, { forceNew: true });
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    const offer = record.offers.find(o => o.slot === slot);
    if (!offer) {
      const view = buildTravelingMerchantView(userId, { forceNew: true });
      return interaction.update({ embeds: [view.embed], components: view.components });
    }
    const maxQty = getMaxAffordableQuantity(getMemocoinSpendCapacity(userId), offer.memocoinPrice, 999);
    const modal = new ModalBuilder()
      .setCustomId(`merchant_qty_modal_${userId}_${slot}`)
      .setTitle("Marchand ambulant");
    const qtyInput = new TextInputBuilder()
      .setCustomId("merchant_qty")
      .setLabel("Quantité")
      .setPlaceholder(`Max: ${maxQty}`)
      .setRequired(true)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(4);
    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
    return interaction.showModal(modal);
  }

  if (
    interaction.customId === "shop_buy_reset_roulette" ||
    interaction.customId === "shop_buy_reset_steal" ||
    interaction.customId === "shop_buy_reset_casino" ||
    interaction.customId === "shop_buy_reset_slot"
  ) {
    const item = getShopItemByCustomId(interaction.customId);
    if (!item) return silentInteraction(interaction);
    if (isInPrison(userId)) {
      return interaction.reply({ content: "⛓️ Tu es en prison. Achats indisponibles.", ephemeral: true });
    }
    const maxQty = getMaxAffordableQuantity(getMemocoinSpendCapacity(userId), item.price, 999);
    const modal = new ModalBuilder()
      .setCustomId(`shop_qty_modal_${userId}_${item.id}`)
      .setTitle("Quantité à acheter");
    const qtyInput = new TextInputBuilder()
      .setCustomId("shop_qty")
      .setLabel("Quantité")
      .setPlaceholder(`Max: ${maxQty}`)
      .setRequired(true)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(4);
    modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
    return interaction.showModal(modal);
  }

  // --------------------------
  // delete EMBED
  // --------------------------
  if (interaction.customId === "delete_embed") {
    // restrict deletion of admin-related embeds to the admin user
    const title = interaction.message?.embeds?.[0]?.title || "";
    const adminRelated = title.includes("Menu Admin") || title.includes("Give Objet") || title.includes("Suivi") || title.includes("Suivi des présences") || title.includes("Suivi lance") || title.includes("Pouvoirs du bot") || title.includes("Statut du bot") || title.includes("Classement global") || title.includes("Prison") || title.includes("Réglage dette") || title.includes("Cybersécurité");
    if (adminRelated && interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }

    try {
      await interaction.message.delete();
      try { await interaction.reply({ content: '✅ Message supprimé.', ephemeral: true }); } catch (e) {}
      return;
    } catch (e) {
      try { await interaction.reply({ content: 'Impossible de supprimer le message (permissions).', ephemeral: true }); } catch (e) {}
      return;
    }

  }

    // --------------------------
    // MEMOCOIN ADMIN - select user from menu
    // --------------------------
    if (interaction.customId === "memocoin_select_user") {
      if (interaction.user.id !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      try {
        const adminId = interaction.user.id;
        const targetId = getSelectedUserIdFromInteraction(interaction);
        if (!targetId) {
          return interaction.reply({ content: "\u274C Aucun utilisateur sélectionne.", ephemeral: true });
        }
        const check = await ensureUserInInteractionGuild(targetId, interaction);
        if (!check.ok) {
          return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
        }
        memocoinSelectionMap.set(adminId, targetId);

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("memocoin_give").setLabel("\u{1FA99} Donner Memocoin").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_remove").setLabel("\u{1FA99} Retirer Memocoin").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_give_bank").setLabel("\u{2795} Ajouter memocoin banque").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_remove_bank").setLabel("\u{2796} Retirer memocoin banque").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_give_protection").setLabel("\u{1F6E1}\u{FE0F} Donner protection vol").setStyle(ButtonStyle.Success).setDisabled(false)
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("memocoin_remove_protection").setLabel("\u{1F6E1}\u{FE0F} Retirer protection vol").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_give_police_protection").setLabel("\ud83d\udee1\ufe0f Donner protection police").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_remove_police_protection").setLabel("\ud83d\udee1\ufe0f Retirer protection police").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_give_reset_roulette").setLabel("\u26A1 Donner reset roulette").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_remove_reset_roulette").setLabel("\u26A1 Retirer reset roulette").setStyle(ButtonStyle.Danger).setDisabled(false)
        );
        const row3 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("memocoin_give_reset_steal").setLabel("\u26A1 Donner reset vol").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_remove_reset_steal").setLabel("\u26A1 Retirer reset vol").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_give_reset_casino").setLabel("\u26A1 Donner reset casino").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_remove_reset_casino").setLabel("\u26A1 Retirer reset casino").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("memocoin_give_reset_slot").setLabel("\u26A1 Donner reset Slotomania").setStyle(ButtonStyle.Success).setDisabled(false)
        );
        const row4 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("memocoin_remove_reset_slot").setLabel("\u26A1 Retirer reset Slotomania").setStyle(ButtonStyle.Danger).setDisabled(false),
          new ButtonBuilder().setCustomId("back_admin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
          buildRefreshButton(),
        );
        await interaction.update({ components: [row1, row2, row3, row4] });
        return;
      } catch (e) {
        console.error('memocoin_select_user error:', e);
        try { return interaction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
      }
    }

    if (interaction.customId === "reset_select_user") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      try {
        const targetId = getSelectedUserIdFromInteraction(interaction);
        if (!targetId) {
          return interaction.reply({ content: "\u274C Aucun utilisateur sélectionne.", ephemeral: true });
        }
        const check = await ensureUserInInteractionGuild(targetId, interaction);
        if (!check.ok) {
          return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
        }
        resetSelectionMap.set(adminId, targetId);
        const view = buildAdminResetView(targetId, "✅ Cible sélectionnee.");
        await interaction.update({ embeds: [view.embed], components: view.components });
        return;
      } catch (e) {
        console.error('reset_select_user error:', e);
        try { return interaction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
      }
    }

    if (interaction.customId === "prison_select_user") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      try {
        const targetId = getSelectedUserIdFromInteraction(interaction);
        if (!targetId) {
          return interaction.reply({ content: "❌ Aucun utilisateur sélectionné.", ephemeral: true });
        }
        const check = await ensureUserInInteractionGuild(targetId, interaction);
        if (!check.ok) {
          return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
        }
        prisonSelectionMap.set(adminId, targetId);
        const view = buildAdminPrisonView(targetId, "✅ Cible sélectionnée.");
        await interaction.update({ embeds: [view.embed], components: view.components });
        return;
      } catch (e) {
        console.error('prison_select_user error:', e);
        try { return interaction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
      }
    }

    if (interaction.customId === "cyber_select_user") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: "❌ Accès réservé (admin unique).", ephemeral: true }); } catch (e) { return; }
      }
      try {
        const targetId = getSelectedUserIdFromInteraction(interaction);
        if (!targetId) {
          return interaction.reply({ content: "❌ Aucun utilisateur sélectionné.", ephemeral: true });
        }
        if (targetId === ADMIN_ONLY_USER_ID) {
          return interaction.reply({ content: "❌ Action refusée sur le compte administrateur principal.", ephemeral: true });
        }
        const check = await ensureUserInInteractionGuild(targetId, interaction);
        if (!check.ok) {
          return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
        }
        cyberSelectionMap.set(adminId, targetId);
        const view = buildAdminCybersecurityView(targetId, "✅ Cible sélectionnée.", check.guild?.id || null);
        await interaction.update({ embeds: [view.embed], components: view.components });
        return;
      } catch (e) {
        console.error("cyber_select_user error:", e);
        try { return interaction.reply({ content: "Erreur interne.", ephemeral: true }); } catch (e2) {}
      }
    }

    if (interaction.customId === "prison_release") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      const targetId = prisonSelectionMap.get(adminId);
      if (!targetId) {
        try { return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true }); } catch (e) { return; }
      }
      const bal = getBalance(targetId);
      bal.prisonUntil = 0;
      saveData();
      const view = buildAdminPrisonView(targetId, "✅ Prison levée.");
      try { await interaction.channel.send(`🟢 <@${adminId}> a libéré <@${targetId}> de la prison.`); } catch (e) {}
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (interaction.customId === "reset_game_menu") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      const targetId = resetSelectionMap.get(adminId) || null;
      if (!targetId) {
        try { return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true }); } catch (e) { return; }
      }
      const view = buildAdminResetGamesView(targetId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (interaction.customId === "reset_game_back") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      const targetId = resetSelectionMap.get(adminId) || null;
      const view = buildAdminResetView(targetId);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    if (
      interaction.customId === "reset_game_mc" ||
      interaction.customId === "reset_game_pk" ||
      interaction.customId === "reset_game_dg" ||
      interaction.customId === "reset_game_zb" ||
      interaction.customId === "reset_game_all"
    ) {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      const targetId = resetSelectionMap.get(adminId);
      if (!targetId) {
        try { return interaction.reply({ content: "❌ Sélectionne d'abord un utilisateur.", ephemeral: true }); } catch(e){}
      }
      initUser(targetId);
      const bal = getBalance(targetId);
      let status = "";
      if (interaction.customId === "reset_game_all") {
        bal.minecraft = {};
        bal.pokemon = {};
        bal.donjon = {};
        bal.zombie = {};
        initUser(targetId);
        saveData();
        status = "✅ Tous les jeux ont été réinitialisés.";
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé tous les jeux pour <@${targetId}>.`); } catch (e) {}
      } else if (interaction.customId === "reset_game_mc") {
        bal.minecraft = {};
        initUser(targetId);
        saveData();
        status = "✅ Minecraft a été réinitialisé.";
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé Minecraft pour <@${targetId}>.`); } catch (e) {}
      } else if (interaction.customId === "reset_game_pk") {
        bal.pokemon = {};
        initUser(targetId);
        saveData();
        status = "✅ Pokémon a été réinitialisé.";
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé Pokémon pour <@${targetId}>.`); } catch (e) {}
      } else if (interaction.customId === "reset_game_dg") {
        bal.donjon = {};
        initUser(targetId);
        saveData();
        status = "✅ Donjon a été réinitialisé.";
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé Donjon pour <@${targetId}>.`); } catch (e) {}
      } else if (interaction.customId === "reset_game_zb") {
        bal.zombie = {};
        initUser(targetId);
        saveData();
        status = "✅ Apocalypse zombie a été réinitialisée.";
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé Apocalypse zombie pour <@${targetId}>.`); } catch (e) {}
      }

      const view = buildAdminResetGamesView(targetId, status);
      return interaction.update({ embeds: [view.embed], components: view.components });
    }

    // --------------------------
    // RESET ADMIN - apply reset
    // RESET ADMIN - apply reset
    // --------------------------
    if (interaction.customId === "reset_steal_wait" || interaction.customId === "reset_roulette_wait" || interaction.customId === "reset_casino_wait" || interaction.customId === "reset_slot_wait" || interaction.customId === "reset_police_wait" || interaction.customId === "reset_inventory") {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }

      const targetId = resetSelectionMap.get(adminId);
      if (!targetId) {
        try { return interaction.reply({ content: "\u274C Sélectionne d'abord un utilisateur.", ephemeral: true }); } catch(e){}
      }
      initUser(targetId);
      const bal = getBalance(targetId);

      if (interaction.customId === "reset_steal_wait") {
        const pending = pendingStealsMap.get(targetId);
        if (pending?.timer) {
          try { clearTimeout(pending.timer); } catch (e) {}
          pendingStealsMap.delete(targetId);
        }
        stealCooldownMap.delete(targetId);
        saveData();
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé l'attente de vol pour <@${targetId}>.`); } catch (e) {}
        const view = buildAdminResetView(targetId, "✅ Attente/cooldown de vol réinitialisé.");
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (interaction.customId === "reset_roulette_wait") {
        bal.rouletteCooldownUntil = 0;
        bal.rouletteLastPlayDay = null;
        saveData();
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé l'attente roulette pour <@${targetId}>.`); } catch (e) {}
        const view = buildAdminResetView(targetId, "✅ Attente roulette réinitialisée.");
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (interaction.customId === "reset_casino_wait") {
        bal.casinoCooldownUntil = 0;
        saveData();
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé l'attente casino pour <@${targetId}>.`); } catch (e) {}
        const view = buildAdminResetView(targetId, "✅ Attente casino réinitialisée.");
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      if (interaction.customId === "reset_slot_wait") {
        bal.slotCooldownUntil = 0;
        saveData();
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé l'attente Slotomania pour <@${targetId}>.`); } catch (e) {}
        const view = buildAdminResetView(targetId, "✅ Attente Slotomania réinitialisée.");
        return interaction.update({ embeds: [view.embed], components: view.components });
      }
      if (interaction.customId === "reset_police_wait") {
        bal.policeLockUntil = 0;
        saveData();
        try { await interaction.channel.send(`🔄 <@${adminId}> a réinitialisé l'attente police pour <@${targetId}>.`); } catch (e) {}
        const view = buildAdminResetView(targetId, "✅ Attente police réinitialisée.");
        return interaction.update({ embeds: [view.embed], components: view.components });
      }

      bal.inventory = 0;
      bal.bank = 0;
      bal.antiStealProtection = 0;
      bal.antiPoliceProtection = 0;
      bal.resetRoulettePower = 0;
      bal.resetStealPower = 0;
      bal.resetCasinoPower = 0;
      bal.resetSlotPower = 0;
      bal.policeLockUntil = 0;
      bal.rouletteCooldownUntil = 0;
      bal.rouletteLastPlayDay = null;
      bal.casinoCooldownUntil = 0;
      bal.slotCooldownUntil = 0;
      const pending = pendingStealsMap.get(targetId);
      if (pending?.timer) {
        try { clearTimeout(pending.timer); } catch (e) {}
      }
      pendingStealsMap.delete(targetId);
      stealCooldownMap.delete(targetId);
      saveData();
      try { await interaction.channel.send(`🧹 <@${adminId}> a effectué une réinitialisation totale sur <@${targetId}> (inventaire, banque, pouvoirs, cooldowns).`); } catch (e) {}
      const view = buildAdminResetView(targetId, "✅ Reset total effectue.");
      return interaction.update({ embeds: [view.embed], components: view.components });
    }


    // --------------------------
    // MEMOCOIN ADMIN - open modal to give/remove
    // --------------------------
    if (
      interaction.customId === "memocoin_give" ||
      interaction.customId === "memocoin_remove" ||
      interaction.customId === "memocoin_give_protection" ||
      interaction.customId === "memocoin_remove_protection" ||
      interaction.customId === "memocoin_give_reset_roulette" ||
      interaction.customId === "memocoin_remove_reset_roulette" ||
      interaction.customId === "memocoin_give_reset_steal" ||
      interaction.customId === "memocoin_remove_reset_steal" ||
      interaction.customId === "memocoin_give_reset_casino" ||
      interaction.customId === "memocoin_remove_reset_casino" ||
      interaction.customId === "memocoin_give_reset_slot" ||
      interaction.customId === "memocoin_remove_reset_slot" ||
      interaction.customId === "memocoin_give_police_protection" ||
      interaction.customId === "memocoin_remove_police_protection" ||
      interaction.customId === "memocoin_give_bank" ||
      interaction.customId === "memocoin_remove_bank"
    ) {
      const adminId = interaction.user.id;
      if (adminId !== ADMIN_ONLY_USER_ID) {
        try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
      }
      let action = "give";
      if (interaction.customId === "memocoin_remove") action = "remove";
      if (interaction.customId === "memocoin_give_protection") action = "giveprot";
      if (interaction.customId === "memocoin_remove_protection") action = "removeprot";
      if (interaction.customId === "memocoin_give_reset_roulette") action = "giveresetroulette";
      if (interaction.customId === "memocoin_remove_reset_roulette") action = "removeresetroulette";
      if (interaction.customId === "memocoin_give_reset_steal") action = "giveresetsteal";
      if (interaction.customId === "memocoin_remove_reset_steal") action = "removeresetsteal";
      if (interaction.customId === "memocoin_give_reset_casino") action = "giveresetcasino";
      if (interaction.customId === "memocoin_remove_reset_casino") action = "removeresetcasino";
      if (interaction.customId === "memocoin_give_reset_slot") action = "giveresetslot";
      if (interaction.customId === "memocoin_remove_reset_slot") action = "removeresetslot";
      if (interaction.customId === "memocoin_give_police_protection") action = "givepoliceprot";
      if (interaction.customId === "memocoin_remove_police_protection") action = "removepoliceprot";
      if (interaction.customId === "memocoin_give_bank") action = "givebank";
      if (interaction.customId === "memocoin_remove_bank") action = "removebank";
      const targetId = memocoinSelectionMap.get(adminId);
      if (!targetId) {
        try { return interaction.reply({ content: "\u274C Sélectionne d'abord un utilisateur.", ephemeral: true }); } catch(e){}
      }

      const titleMap = {
        give: 'Donner des Memocoins',
        remove: 'Retirer des Memocoins',
        giveprot: 'Donner des protections de vol',
        removeprot: 'Retirer des protections de vol',
        giveresetroulette: 'Donner des resets roulette',
        removeresetroulette: 'Retirer des resets roulette',
        giveresetsteal: 'Donner des resets vol',
        removeresetsteal: 'Retirer des resets vol',
        giveresetcasino: 'Donner des resets casino',
        removeresetcasino: 'Retirer des resets casino',
        giveresetslot: 'Donner des resets Slotomania',
        removeresetslot: 'Retirer des resets Slotomania',
        givepoliceprot: 'Donner des protections police',
        removepoliceprot: 'Retirer des protections police',
        givebank: 'Ajouter des Memocoins en banque',
        removebank: 'Retirer des Memocoins de la banque'
      };
      const modal = new ModalBuilder()
        .setCustomId(`memocoin_modal_${action}_${adminId}_${targetId}`)
        .setTitle(titleMap[action] || 'Action admin');

      const amountInput = new TextInputBuilder()
        .setCustomId('memocoin_amount')
        .setLabel('Montant (nombre entier)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('100')
        .setRequired(true);

      const row = new ActionRowBuilder().addComponents(amountInput);
      modal.addComponents(row);

      try {
        return interaction.showModal(modal);
      } catch (e) {
        console.error('showModal error:', e);
        try { return interaction.reply({ content: "Impossible d'afficher le formulaire.", ephemeral: true }); } catch(e){}
      }
    }

    // --------------------------
    // STEAL - select + execute
    // --------------------------
    if (interaction.customId === "steal_select_user") {
      try {
        const thiefId = interaction.user.id;
        const values = interaction.values || [];
        if (!values.length) return interaction.reply({ content: "\u274C Aucun utilisateur sélectionne.", ephemeral: true });
        const targetId = values[0];
        const check = await ensureUserInInteractionGuild(targetId, interaction);
        if (!check.ok) {
          return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
        }
        if (targetId === thiefId) return interaction.reply({ content: "\u274C Tu ne peux pas te voler toi-même.", ephemeral: true });
        stealSelectionMap.set(thiefId, targetId);
        return interaction.update({ components: buildStealControlComponents(thiefId) }).catch(() => {});
      } catch (e) {
        console.error('steal_select_user error:', e);
        try { return interaction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
      }
    }

    // --------------------------
    // DONATE - select + execute
    // --------------------------
    if (interaction.customId === "donate_select_user") {
      try {
        const giverId = interaction.user.id;
        const values = interaction.values || [];
        if (!values.length) return interaction.reply({ content: "\u274C Aucun utilisateur sélectionne.", ephemeral: true });
        const targetId = values[0];
        const check = await ensureUserInInteractionGuild(targetId, interaction);
        if (!check.ok) {
          return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
        }
        if (targetId === giverId) return interaction.reply({ content: "\u274C Tu ne peux pas te donner des Memocoins à toi-même.", ephemeral: true });
        donateSelectionMap.set(giverId, targetId);

        const userSelect = new UserSelectMenuBuilder().setCustomId("donate_select_user").setPlaceholder("Choisir un destinataire...").setMinValues(1).setMaxValues(1);
        const row1 = new ActionRowBuilder().addComponents(userSelect);
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("donate_execute").setLabel("\u{1F381} Donner").setStyle(ButtonStyle.Success).setDisabled(false),
          new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
        );

        return interaction.update({ components: [row1, row2] }).catch(() => {});
      } catch (e) {
        console.error('donate_select_user error:', e);
        try { return interaction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
      }
    }

    if (interaction.customId === "donate_execute") {
      const giverId = interaction.user.id;
      const targetId = donateSelectionMap.get(giverId);
      if (!targetId) return interaction.reply({ content: "\u274C Sélectionne d'abord un destinataire.", ephemeral: true });
      const maxDonate = Math.max(0, Math.floor(getTotalMemocoin(giverId)));

      const modal = new ModalBuilder().setCustomId(`donate_modal_${giverId}_${targetId}`).setTitle('Donner des Memocoins');
      const amountInput = new TextInputBuilder().setCustomId('donate_amount').setLabel('Montant à donner').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`Max: ${maxDonate}`);
      const r = new ActionRowBuilder().addComponents(amountInput);
      modal.addComponents(r);
      try { return interaction.showModal(modal); } catch (e) { console.error('showModal donate error:', e); try { return interaction.reply({ content: "Impossible d'afficher le formulaire.", ephemeral: true }); } catch(e){} }
    }

    if (interaction.customId === "steal_execute") {
      const thiefId = interaction.user.id;
      const targetId = stealSelectionMap.get(thiefId);
      if (!targetId) return interaction.reply({ content: "\u274C Sélectionne d'abord une victime.", ephemeral: true });
      if (pendingStealsMap.has(thiefId)) {
        return interaction.reply({ content: "❌ Tu as déjà un vol en attente.", ephemeral: true });
      }
      if (hasPoliceLock(thiefId)) {
        const remaining = formatShortDuration(getPoliceWaitRemainingMs(thiefId));
        return interaction.reply({ content: `🚫 Menus de jeux bloques par la police. Temps restant: ${remaining}.`, ephemeral: true });
      }
      const nextAllowedAt = stealCooldownMap.get(thiefId) || 0;
      if (nextAllowedAt > Date.now()) {
        const msgCooldown = formatRetryMessage(nextAllowedAt, "voler de nouveau");
        return interaction.reply({ content: `⏱️ Tu ne peux plus voler.\n${msgCooldown}`, ephemeral: true });
      }
      const thiefTotal = Math.max(0, Math.floor(getTotalMemocoin(thiefId)));
      const victimTotal = Math.max(0, Math.floor(getTotalMemocoin(targetId)));
      const maxSteal = Math.max(0, Math.min(thiefTotal, victimTotal));

      const modal = new ModalBuilder().setCustomId(`steal_modal_${thiefId}_${targetId}`).setTitle('Voler des Memocoins');
      const amountInput = new TextInputBuilder().setCustomId('steal_amount').setLabel('Montant à voler').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`Max: ${maxSteal}`);
      const r = new ActionRowBuilder().addComponents(amountInput);
      modal.addComponents(r);
      try { return interaction.showModal(modal); } catch (e) { console.error('showModal steal error:', e); try { return interaction.reply({ content: "Impossible d'afficher le formulaire.", ephemeral: true }); } catch(e){} }
    }

    if (interaction.customId === "steal_cancel") {
      const thiefId = interaction.user.id;
      const pending = pendingStealsMap.get(thiefId);
      if (!pending) {
        return interaction.reply({ content: "\u274C Tu n'as aucun vol en attente à annuler.", ephemeral: true });
      }

      try { clearTimeout(pending.timer); } catch (e) {}
      pendingStealsMap.delete(thiefId);
      const cooldownUntil = Date.now() + STEAL_CANCEL_COOLDOWN_MS;
      stealCooldownMap.set(thiefId, cooldownUntil);
      saveData();

      const remaining = formatShortDuration(STEAL_CANCEL_COOLDOWN_MS);
      await interaction.update({ components: buildStealControlComponents(thiefId) }).catch(() => {});
      return interaction.followUp({ content: `✅ Vol annulé. Cooldown appliqué: ${remaining}.\n${formatRetryMessage(cooldownUntil, "voler de nouveau")}`, ephemeral: true });
    }

    if (interaction.customId === "use_reset_steal_power") {
      const bal = getBalance(userId);
      if ((bal.resetStealPower || 0) <= 0) {
        return interaction.reply({ content: "\u274C Tu n'as pas de pouvoir de reset attente vol.", ephemeral: true });
      }
      if (!hasActiveStealWait(userId)) {
        return interaction.reply({ content: "\u2139\u{FE0F} Inutile maintenant: tu n'as aucune attente de vol à réinitialiser.", ephemeral: true });
      }
      bal.resetStealPower -= 1;
      const pending = pendingStealsMap.get(userId);
      if (pending?.timer) {
        try { clearTimeout(pending.timer); } catch (e) {}
        pendingStealsMap.delete(userId);
      }
      stealCooldownMap.delete(userId);
      saveData();
      await interaction.update({ components: buildStealControlComponents(userId) }).catch(() => {});
      await sendPowerUsedMessage(interaction.channel, userId, "un reset vol", bal.resetStealPower);
      return interaction.followUp({ content: `\u2705 Pouvoir utilisé. Attente de vol réinitialisée. (Restant: ${bal.resetStealPower})`, ephemeral: true });
    }

  // --------------------------
  // RETOUR MENU PRINCIPAL
  // --------------------------
  if (interaction.customId === "back_main" || interaction.customId === "jeu_back") {
    // If this back button is on an admin-related message, restrict it to the admin user
    const title = interaction.message?.embeds?.[0]?.title || "";
    const adminRelated = title.includes("Menu Admin") || title.includes("Give Objet") || title.includes("Suivi") || title.includes("Pouvoirs du bot") || title.includes("Statut du bot") || title.includes("Classement global") || title.includes("Prison") || title.includes("Réglage dette") || title.includes("Cybersécurité");
    if (adminRelated && interaction.user.id !== ADMIN_ONLY_USER_ID) {
      try { return interaction.reply({ content: '❌ Accès réservé (admin unique).', ephemeral: true }); } catch (e) { return; }
    }

    const embed = new EmbedBuilder()
      .setTitle("\u{1F916} Zodi - Menu Principal")
      .setDescription("\u{1F4AC} Discuter avec Zodi\n\u{1F3AE} Jeux");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_zodi_chat").setLabel("\u{1F4AC} Discuter avec Zodi").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F3AE} Jeux").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("admin_entry").setLabel("\u{1F512} Admin").setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("delete_embed").setLabel("\u{1F5D1}\u{FE0F} Supprimer").setStyle(ButtonStyle.Danger),
      buildRefreshButton()
    );
    return interaction.update({ embeds: [embed], components: [row, row2] });
  }

  // --------------------------
  // MEMOCOIN
  // --------------------------
  if (interaction.customId === "jeu_memocoin") {
    const embed = new EmbedBuilder()
      .setTitle("\u{1FA99} Memocoin")
      .setDescription("Gestion des Memocoins");

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bank").setLabel("\u{1F3E6} Banque").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("donate_info").setLabel("\u{1F381} Donner").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("steal_info").setLabel("\u{1F4B0} Voler").setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton()
    );

    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }

  if (interaction.customId === "jeu_horoscope") {
    const view = buildHoroscopeView(userId, "menu");
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "horoscope_prediction" || interaction.customId === "horoscope_oracle") {
    const section = interaction.customId === "horoscope_prediction" ? "prediction" : "oracle";
    const result = ensureHoroscopeDailyPack(userId, { payIfNeeded: true });
    if (!result.ok) {
      return interaction.reply({
        content: result.reason || `❌ Il faut ${HOROSCOPE_DAILY_PRICE} Memocoins pour débloquer l'horoscope du jour.`,
        ephemeral: true
      });
    }

    const notice = result.charged ? `✅ Pack du jour débloqué pour ${HOROSCOPE_DAILY_PRICE} Memocoins.` : "";
    const view = buildHoroscopeView(userId, section, notice);
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  // --------------------------
  // INVENTAIRE
  // --------------------------
  if (interaction.customId === "inv") {
    const memberName = interaction.member?.displayName || interaction.user.username;
    return interaction.update({
      embeds: [buildStatusEmbed(userId, memberName)],
      components: interaction.message.components
    });
  }

  // --------------------------
  // CALCULE - ouvre un clavier pour construire l'expression
  // --------------------------
  if (interaction.customId === "jeu_calcule") {
    try {
      calcInputMap.set(userId, "");

      const rows = [];

      // Row 1: 7 8 9 + -
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("cnum_7").setLabel("7").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_8").setLabel("8").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_9").setLabel("9").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cop_+").setLabel("+").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("cop_-").setLabel("-").setStyle(ButtonStyle.Primary)
      ));

      // Row 2: 4 5 6 x /
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("cnum_4").setLabel("4").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_5").setLabel("5").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_6").setLabel("6").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cop_mul").setLabel("x").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("cop_div").setLabel("/").setStyle(ButtonStyle.Primary)
      ));

      // Row 3: 1 2 3 ( )
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("cnum_1").setLabel("1").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_2").setLabel("2").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_3").setLabel("3").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cpar_open").setLabel("(").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cpar_close").setLabel(")").setStyle(ButtonStyle.Secondary)
      ));

      // Row 4: 0 . S C
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("cnum_0").setLabel("0").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cnum_.").setLabel(".").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("cback").setLabel("\u232B").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("cclear").setLabel("C").setStyle(ButtonStyle.Danger)
      ));

      // Row 5: Evaluer - Retour
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ceval").setLabel("\u2705 Evaluer").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary)
      ));

      return interaction.update({
        embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription("( )")],
        components: rows
      });
    } catch (err) {
      console.error('Erreur lors de l ouverture du clavier calcule:', err);
      try { await interaction.reply({ content: 'Erreur interne (voir console).', ephemeral: true }); } catch(e){}
      return;
    }
  }

  // --------------------------
  // VOL INFO (interactive)
  // --------------------------
  if (interaction.customId === "steal_info") {
    const embed = buildStealEmbed(userId);
    return interaction.update({ embeds: [embed], components: buildStealControlComponents(userId) });
  }

  // --------------------------
  // STATUS (interactive)
  // --------------------------
  if (interaction.customId === "status_info") {
    const memberName = interaction.member?.displayName || interaction.user.username;
    const embed = buildStatusEmbed(userId, memberName);

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId("status_select_user")
      .setPlaceholder("Voir le statut d'un membre...")
      .setMinValues(1)
      .setMaxValues(1);

    const row1 = new ActionRowBuilder().addComponents(userSelect);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("status_info").setLabel("\u{1F4CA} Mon statut").setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId("status_classement").setLabel("\u{1F3C6} Classement").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton(),
    );

    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }

  if (interaction.customId === "status_classement") {
    const embed = buildGlobalClassementEmbed(25);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("status_info").setLabel("\u{1F4CA} Mon statut").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton(),
    );
    return interaction.update({ embeds: [embed], components: [row] });
  }

  if (interaction.customId === "status_select_user") {
    const values = interaction.values || [];
    if (!values.length) return interaction.reply({ content: "\u274C Aucun membre sélectionne.", ephemeral: true });

    const targetId = values[0];
    const check = await ensureUserInInteractionGuild(targetId, interaction);
    if (!check.ok) return interaction.reply({ content: `❌ ${check.error}`, ephemeral: true });
    const member = check.member;
    const targetName = member?.displayName || member?.user?.username || `Utilisateur ${targetId}`;
    const embed = buildStatusEmbed(targetId, targetName);
    const isOwnStatus = targetId === userId;

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId("status_select_user")
      .setPlaceholder("Voir le statut d'un membre...")
      .setMinValues(1)
      .setMaxValues(1);

    const row1 = new ActionRowBuilder().addComponents(userSelect);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("status_info").setLabel("\u{1F4CA} Mon statut").setStyle(ButtonStyle.Primary).setDisabled(isOwnStatus),
      new ButtonBuilder().setCustomId("status_classement").setLabel("\u{1F3C6} Classement").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("menu_jeux").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
      buildRefreshButton(),
    );

    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }

  // --------------------------
  // DONATE (Doner) - interactive
  // --------------------------
  if (interaction.customId === "donate_info") {
    const embed = new EmbedBuilder()
      .setTitle("\u{1F381} Donner")
      .setDescription("Sélectionne un utilisateur puis clique sur Donner pour entrer le montant.");

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId("donate_select_user")
      .setPlaceholder("Choisir un destinataire...")
      .setMinValues(1)
      .setMaxValues(1);

    const row1 = new ActionRowBuilder().addComponents(userSelect);
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("donate_execute").setLabel("\u{1F381} Donner").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    );

    return interaction.update({ embeds: [embed], components: [row1, row2] });
  }

  // --------------------------
  // BANQUE MENU
  // --------------------------
  if (interaction.customId === "bank") {
    const view = buildBankMenuView(userId);
    if (interaction.message?.id && interaction.channelId) {
      bankMenuMessageMap.set(userId, { channelId: interaction.channelId, messageId: interaction.message.id });
    }
    return interaction.update({ embeds: [view.embed], components: view.components });
  }

  if (interaction.customId === "bank_convert_mc" || interaction.customId === "bank_convert_pk" || interaction.customId === "bank_convert_dg" || interaction.customId === "bank_convert_zb") {
    if (interaction.message?.id && interaction.channelId) {
      bankMenuMessageMap.set(userId, { channelId: interaction.channelId, messageId: interaction.message.id });
    }
    const bal = getBalance(userId);
    const mc = bal.minecraft || {};
    const pk = bal.pokemon || {};
    const dj = bal.donjon || {};
    const zb = bal.zombie || {};
    const type = interaction.customId.replace("bank_convert_", "");
    let placeholder = "Ex: 10";
    let title = "Conversion";
    if (type === "mc") {
      if ((mc.emeralds || 0) <= 0) return interaction.reply({ content: "❌ Aucune émeraude à convertir.", ephemeral: true });
      title = "Conversion Émeraudes";
      placeholder = `Max: ${mc.emeralds}`;
    } else if (type === "pk") {
      if ((pk.pokedollars || 0) < PK_POKEDOLLAR_TO_MEMOCOIN) return interaction.reply({ content: "❌ Il faut au moins 1000 Pokédollars.", ephemeral: true });
      title = "Conversion Pokédollars";
      placeholder = `Max: ${pk.pokedollars} (multiple de 1000)`;
    } else if (type === "dg") {
      if ((dj.goldCoins || 0) <= 0) return interaction.reply({ content: "❌ Aucune pièce d'or à convertir.", ephemeral: true });
      title = "Conversion Pièces d'or";
      placeholder = `Max: ${dj.goldCoins}`;
    } else if (type === "zb") {
      if ((zb.silverCoins || 0) <= 0) return interaction.reply({ content: "❌ Aucune pièce d'argent à convertir.", ephemeral: true });
      title = "Conversion Pièces d'argent";
      placeholder = `Max: ${zb.silverCoins}`;
    } else {
      return interaction.reply({ content: "❌ Type de conversion inconnu.", ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`bank_convert_modal_${userId}_${type}`)
      .setTitle(title);
    const input = new TextInputBuilder()
      .setCustomId("bank_convert_qty")
      .setLabel("Quantité à convertir")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder(placeholder)
      .setMaxLength(12);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }


  // --------------------------
  // CLAVIER NUMERIQUE BANQUE
  // --------------------------
  if (interaction.customId.startsWith("deposit") || interaction.customId.startsWith("withdraw")) {
    bankActionMap.set(userId, interaction.customId);
    bankInputMap.set(userId, "");

    const rows = [];
    const numbers = [["1","2","3"],["4","5","6"],["7","8","9"],["0"]];

    numbers.forEach(line => {
      const row = new ActionRowBuilder();
      line.forEach(n => row.addComponents(
        new ButtonBuilder().setCustomId("num_"+n).setLabel(n).setStyle(ButtonStyle.Secondary)
      ));
      rows.push(row);
    });

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("valider").setLabel("\u2705 Valider").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("suppr").setLabel("\u232B").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary)
      )
    );

    // compute description string (avoid passing a function to setDescription)
    let initDesc = 'Montant : 0';
    try {
      const bal = getBalance(userId);
      if (interaction.customId === 'deposit') initDesc = `Disponible : ${bal.inventory}\nMontant : 0`;
      else initDesc = `Banque : ${bal.bank}\nMontant : 0`;
    } catch (e) { initDesc = 'Montant : 0'; }

    return interaction.update({
      embeds: [new EmbedBuilder().setTitle("\u{1F4B5} Montant").setDescription(initDesc)],
      components: rows
    });
  }

  // --------------------------
  // NUM
  // --------------------------
  if (interaction.customId.startsWith("num_")) {
    const current = bankInputMap.get(userId) || "";
    const value = interaction.customId.split("_")[1];
    bankInputMap.set(userId, current + value);

    // show current typed amount and available balance depending on action
    const typed = bankInputMap.get(userId) || "0";
    const action = bankActionMap.get(userId);
    const bal = getBalance(userId);
    const desc = action === 'deposit' ? `Disponible : ${bal.inventory}\nMontant : ${typed}` : `Banque : ${bal.bank}\nMontant : ${typed}`;

    return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F4B5} Montant").setDescription(desc)], components: interaction.message.components });
  }

  // --------------------------
  // SUPPR (BACKSPACE) - enleve dernier chiffre saisi
  // --------------------------
  if (interaction.customId === "suppr") {
    const current = bankInputMap.get(userId) || "";
    const next = current.slice(0, -1);
    bankInputMap.set(userId, next);

    const typed = bankInputMap.get(userId) || "0";
    const action = bankActionMap.get(userId);
    const bal = getBalance(userId);
    const desc = action === 'deposit' ? `Disponible : ${bal.inventory}\nMontant : ${typed}` : `Banque : ${bal.bank}\nMontant : ${typed}`;

    return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F4B5} Montant").setDescription(desc)], components: interaction.message.components });
  }

  // --------------------------
  // CALC KEYPAD HANDLERS
  // --------------------------
  if (interaction.customId.startsWith("cnum_")) {
    const val = interaction.customId.split("_")[1];
    const cur = calcInputMap.get(userId) || "";
    const next = cur + val;
    calcInputMap.set(userId, next);
    return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription(next || "( )")], components: interaction.message.components });
  }

  if (interaction.customId.startsWith("cop_")) {
    const op = interaction.customId.split("_")[1];
    const cur = calcInputMap.get(userId) || "";
    let mapped;
    if (op === 'mul') mapped = '*';
    else if (op === 'div') mapped = '/';
    else mapped = op; // + or -
    const next = cur + mapped;
    calcInputMap.set(userId, next);
    return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription(next || "( )")], components: interaction.message.components });
  }

  if (interaction.customId === "cpar_open" || interaction.customId === "cpar_close" || interaction.customId === "cback" || interaction.customId === "cclear") {
    const cur = calcInputMap.get(userId) || "";
    if (interaction.customId === "cpar_open") calcInputMap.set(userId, cur + "(");
    if (interaction.customId === "cpar_close") calcInputMap.set(userId, cur + ")");
    if (interaction.customId === "cback") calcInputMap.set(userId, cur.slice(0, -1));
    if (interaction.customId === "cclear") calcInputMap.set(userId, "");
    const next = calcInputMap.get(userId) || "";
    return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription(next || "( )")], components: interaction.message.components });
  }

  if (interaction.customId === "ceval") {
    const expr = (calcInputMap.get(userId) || "");
    if (!expr) {
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription("Rien à évaluer")], components: interaction.message.components });
    }

    // securite: n'autorise que chiffres, operateurs et parentheses
    if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
      calcInputMap.set(userId, "");
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription("\u274C Expression invalide")], components: interaction.message.components });
    }

    try {
      // evaluer de maniere restreinte
      const result = Function('"use strict"; return (' + expr + ')')();
      calcInputMap.set(userId, String(result));

      // update original interaction with result
      await interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription(`${expr} = ${result}`)], components: interaction.message.components });

      // award memocoin and send a separate embed reporting the reward
      addMemocoin(userId, 1);
      const bal = getBalance(userId);
      const rewardEmbed = new EmbedBuilder()
        .setTitle('\u{1FA99} Memocoin')
        .setDescription(`<@${userId}> a gagné +1 Memocoin !\nSolde : ${bal.inventory} | Banque : ${bal.bank}`)
        .setColor(0xffcc00)
        .setTimestamp();

      try { await interaction.channel.send({ embeds: [rewardEmbed] }); } catch (e) { /* ignore send errors */ }
      return;
    } catch (e) {
      calcInputMap.set(userId, "");
      return interaction.update({ embeds: [new EmbedBuilder().setTitle("\u{1F9EE} Calcul").setDescription("\u274C Erreur lors du calcul")], components: interaction.message.components });
    }
  }

  // --------------------------
  // VALIDER
  // --------------------------
  if (interaction.customId === "valider") {
    const amount = parseInt(bankInputMap.get(userId)) || 0;
    const action = bankActionMap.get(userId);

    let success = false;
    if (action === "deposit") success = depositBank(userId, amount);
    if (action === "withdraw") success = withdrawBank(userId, amount);

    const bal = getBalance(userId);

    // clear temporary input/action
    bankInputMap.delete(userId);
    bankActionMap.delete(userId);

    // build result embed then return to bank menu so user can continue
    const resultEmbed = new EmbedBuilder()
      .setTitle("\u{1F3E6} Banque")
      .setColor(success ? 0x00cc66 : 0xff3333)
      .setDescription(`${success ? "✅ Operation réussie" : "❌ Opération impossible"}`)
      .addFields(
        { name: 'Montant execute', value: String(amount), inline: true },
        { name: 'Inventaire', value: String(bal.inventory), inline: true },
        { name: 'Banque', value: String(bal.bank), inline: true }
      )
      .setFooter({ text: 'Tu peux déposer/retirer un autre montant ou revenir.' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("jeu_memocoin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
    );

    if (success && amount > 0) {
      try {
        if (action === "deposit") {
          await interaction.channel.send(`🏦 Banque: <@${userId}> a déposé ${amount} Memocoins.`);
        } else if (action === "withdraw") {
          await interaction.channel.send(`🏦 Banque: <@${userId}> a retiré ${amount} Memocoins.`);
        }
      } catch (e) {}
    }

    return interaction.update({ embeds: [resultEmbed], components: [row] });
  }

  // (le bouton "Annuler" a été retiré du clavier numérique)
}

zodiClient.on("interactionCreate", handleZodiComponentInteraction);

// handle modal submit for memocoin and steal actions
async function handleZodiModalInteraction(modalInteraction) {
  if (modalInteraction.type !== InteractionType.ModalSubmit) return;
  const modalUserId = modalInteraction.user?.id;
  const originalModalReply = modalInteraction.reply.bind(modalInteraction);
  modalInteraction.reply = (options) => {
    const logText = extractReplyText(options);
    const actions = extractActionRowsFromOptions(options);
    if ((logText || actions) && modalUserId) addActionLog(modalUserId, logText || "Actions disponibles.", actions);
    return originalModalReply(options);
  };
  if (typeof modalInteraction.followUp === "function") {
    const originalFollowUp = modalInteraction.followUp.bind(modalInteraction);
    modalInteraction.followUp = (options) => {
      const logText = extractReplyText(options);
      const actions = extractActionRowsFromOptions(options);
      if ((logText || actions) && modalUserId) addActionLog(modalUserId, logText || "Actions disponibles.", actions);
      return originalFollowUp(options);
    };
  }
  if (maintenanceModeEnabled && !isAdminUser(modalInteraction.user.id)) {
    try { return modalInteraction.reply({ content: "🛠️ Le bot est en maintenance. Seul l'administrateur peut l'utiliser.", ephemeral: true }); } catch (e) { return; }
  }
  const cid = modalInteraction.customId || '';
  if (!(cid.startsWith('memocoin_modal_') || cid.startsWith('steal_modal_') || cid.startsWith('donate_modal_') || cid.startsWith('chatgpt_modal_') || cid.startsWith('zodi_chat_modal_') || cid.startsWith('shop_qty_modal_') || cid.startsWith('game_shop_qty_modal_') || cid.startsWith('merchant_qty_modal_') || cid.startsWith('bank_convert_modal_') || cid.startsWith('mc_craft_qty_modal_') || cid.startsWith('mc_smelt_qty_modal_') || cid.startsWith('cyber_modal_'))) return;

  if (cid.startsWith("cyber_modal_tempban_") || cid.startsWith("cyber_modal_silence_")) {
    try {
      const parts = cid.split("_");
      const adminId = parts[3];
      const targetId = parts[4];
      if (modalInteraction.user.id !== adminId || adminId !== ADMIN_ONLY_USER_ID) {
        return modalInteraction.reply({ content: "❌ Accès refusé.", ephemeral: true });
      }
      if (!targetId || targetId === ADMIN_ONLY_USER_ID) {
        return modalInteraction.reply({ content: "❌ Cible invalide.", ephemeral: true });
      }

      const isTempBan = cid.startsWith("cyber_modal_tempban_");
      const durationFieldId = isTempBan ? "cyber_ban_duration" : "cyber_silence_duration";
      const reasonFieldId = isTempBan ? "cyber_ban_reason" : "cyber_silence_reason";
      const durationRaw = modalInteraction.fields.getTextInputValue(durationFieldId);
      const durationMs = parseCyberDurationMs(durationRaw);
      const maxDuration = isTempBan ? CYBER_MAX_BAN_DURATION_MS : CYBER_MAX_SILENCE_DURATION_MS;
      if (!durationMs || durationMs < 60 * 1000 || durationMs > maxDuration) {
        return modalInteraction.reply({
          content: isTempBan
            ? "❌ Durée invalide. Utilise par exemple: 30m, 12h, 7j ou 1mo (maximum 365 jours)."
            : "❌ Durée invalide. Utilise par exemple: 30m, 12h, 7j ou 1mo (maximum 28 jours).",
          ephemeral: true
        });
      }
      const reasonRaw = modalInteraction.fields.getTextInputValue(reasonFieldId);
      const reason = sanitizeCyberReason(reasonRaw, isTempBan ? "Ban temporaire administrateur" : "Réduction au silence administrateur");

      const guild = await resolveInteractionGuild(modalInteraction);
      if (!guild) return modalInteraction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

      if (isTempBan) {
        await applyCyberBan(guild, targetId, adminId, { type: "ban", reason, durationMs });
        const view = buildAdminCybersecurityView(
          targetId,
          `⏳ Ban temporaire appliqué (${formatShortDuration(durationMs)}).`,
          guild.id
        );
        try {
          await modalInteraction.message?.edit({ embeds: [view.embed], components: view.components });
        } catch (e) {}
        await modalInteraction.reply({
          content: `✅ <@${targetId}> est banni temporairement pendant ${formatShortDuration(durationMs)}.`,
          ephemeral: true
        });
        try {
          await modalInteraction.channel.send(`⏳ Cybersécurité: <@${adminId}> a banni temporairement <@${targetId}> pendant ${formatShortDuration(durationMs)}.`);
        } catch (e) {}
        return;
      }

      const result = await applyCyberSilence(guild, targetId, adminId, { reason, durationMs });
      if (!result.ok) {
        return modalInteraction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      }
      const view = buildAdminCybersecurityView(
        targetId,
        `✅ Réduction en silence appliquée (${formatShortDuration(durationMs)}).`,
        guild.id
      );
      try {
        await modalInteraction.message?.edit({ embeds: [view.embed], components: view.components });
      } catch (e) {}
      await modalInteraction.reply({
        content: `✅ <@${targetId}> est réduit en silence pendant ${formatShortDuration(durationMs)}.`,
        ephemeral: true
      });
      try {
        await modalInteraction.channel.send(`🔇 Cybersécurité: <@${adminId}> a réduit <@${targetId}> en silence pendant ${formatShortDuration(durationMs)}.`);
      } catch (e) {}
      return;
    } catch (e) {
      console.error("cyber sanction modal error:", e);
      try { return modalInteraction.reply({ content: "❌ Erreur pendant l'application de la sanction.", ephemeral: true }); } catch (e2) { return; }
    }
  }

  if (cid.startsWith("cyber_modal_quarantine_")) {
    try {
      const parts = cid.split("_");
      const adminId = parts[3];
      const targetId = parts[4];
      if (modalInteraction.user.id !== adminId || adminId !== ADMIN_ONLY_USER_ID) {
        return modalInteraction.reply({ content: "❌ Accès refusé.", ephemeral: true });
      }
      if (!targetId || targetId === ADMIN_ONLY_USER_ID) {
        return modalInteraction.reply({ content: "❌ Cible invalide.", ephemeral: true });
      }

      const durationRaw = modalInteraction.fields.getTextInputValue("cyber_quarantine_duration");
      const durationMs = parseCyberDurationMs(durationRaw);
      if (!durationMs || durationMs < 60 * 1000 || durationMs > CYBER_MAX_QUARANTINE_DURATION_MS) {
        return modalInteraction.reply({ content: "❌ Durée invalide. Utilise par exemple: 30m, 12h, 7j ou 1mo.", ephemeral: true });
      }
      const reasonRaw = modalInteraction.fields.getTextInputValue("cyber_quarantine_reason");
      const reason = sanitizeCyberReason(reasonRaw, "Quarantaine administrateur");

      const guild = await resolveInteractionGuild(modalInteraction);
      if (!guild) return modalInteraction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

      const result = await applyCyberQuarantine(guild, targetId, adminId, { reason, durationMs });
      if (!result.ok) {
        return modalInteraction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      }

      const view = buildAdminCybersecurityView(
        targetId,
        `🧱 <@${targetId}> est en quarantaine pour ${formatShortDuration(durationMs)}. Les rôles seront restaurés à la levée.`,
        guild.id
      );
      try {
        await modalInteraction.message?.edit({ embeds: [view.embed], components: view.components });
      } catch (e) {}
      await modalInteraction.reply({
        content: `✅ <@${targetId}> est en quarantaine pendant ${formatShortDuration(durationMs)}.`,
        ephemeral: true
      });
      try {
        await modalInteraction.channel.send(`🧱 Cybersécurité: <@${adminId}> a placé <@${targetId}> en quarantaine pendant ${formatShortDuration(durationMs)}.`);
      } catch (e) {}
      return;
    } catch (e) {
      console.error("cyber quarantine modal error:", e);
      try { return modalInteraction.reply({ content: "❌ Erreur pendant la mise en quarantaine.", ephemeral: true }); } catch (e2) { return; }
    }
  }

  if (cid.startsWith("cyber_modal_unban_")) {
    try {
      const parts = cid.split("_");
      const adminId = parts[3];
      if (modalInteraction.user.id !== adminId || adminId !== ADMIN_ONLY_USER_ID) {
        return modalInteraction.reply({ content: "❌ Accès refusé.", ephemeral: true });
      }
      const raw = modalInteraction.fields.getTextInputValue("cyber_user_id");
      const targetId = parseUserIdFromInput(raw);
      if (!targetId) {
        return modalInteraction.reply({ content: "❌ ID utilisateur invalide.", ephemeral: true });
      }

      const guild = await resolveInteractionGuild(modalInteraction);
      if (!guild) return modalInteraction.reply({ content: "❌ Serveur introuvable.", ephemeral: true });

      let unbanOk = false;
      try {
        await guild.members.unban(targetId, `Sanction retirée par ${adminId}`);
        unbanOk = true;
      } catch (e) {
        unbanOk = false;
      }

      const key = getCyberEntryKey(guild.id, targetId);
      const entry = cyberSecurityState.bans[key];
      if (entry?.active) {
        entry.active = false;
        entry.liftedAt = Date.now();
        entry.liftedBy = adminId;
      }
      saveData();

      const selectedTarget = cyberSelectionMap.get(adminId) || null;
      const view = buildAdminCybersecurityView(
        selectedTarget,
        unbanOk
          ? `✅ Sanction retirée pour l'ID ${targetId}.`
          : `⚠️ Aucun ban Discord actif trouvé pour ${targetId}, mais l'état interne a été nettoyé.`,
        guild.id
      );
      try {
        await modalInteraction.message?.edit({ embeds: [view.embed], components: view.components });
      } catch (e) {}

      await modalInteraction.reply({
        content: unbanOk
          ? `✅ L'utilisateur ${targetId} a été débanni.`
          : `⚠️ Aucun ban Discord actif pour ${targetId}.`,
        ephemeral: true
      });
      try {
        await modalInteraction.channel.send(`🔓 Cybersécurité: <@${adminId}> a retiré la sanction de l'ID ${targetId}.`);
      } catch (e) {}
      return;
    } catch (e) {
      console.error("cyber unban modal error:", e);
      try { return modalInteraction.reply({ content: "❌ Erreur pendant le retrait de sanction.", ephemeral: true }); } catch (e2) { return; }
    }
  }

  if (cid.startsWith("mc_craft_qty_modal_")) {
    try {
      const parts = cid.split("_");
      const ownerId = parts[4];
      const craftType = parts[5];
      if (ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette fenêtre ne t'appartient pas.", ephemeral: true });
      }
      const qtyRaw = modalInteraction.fields.getTextInputValue("mc_craft_qty");
      const qty = parseInt(qtyRaw, 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 999) {
        return modalInteraction.reply({ content: "❌ Quantité invalide (1 à 999).", ephemeral: true });
      }
      const mc = getMinecraft(ownerId);
      const energyCost = 8 * qty;
      if ((mc.energy || 0) < energyCost) {
        return modalInteraction.reply({ content: `❌ Pas assez d'énergie (${energyCost} requis).`, ephemeral: true });
      }
      let notice = "";
      if (craftType === "planks") {
        if ((mc.wood || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de bois.", ephemeral: true });
        mc.wood -= qty;
        mc.planks += qty * 4;
        mc.xp += qty * 2;
        notice = `🧱 Tu as transformé ${qty} bois en ${qty * 4} planches.`;
      } else if (craftType === "sticks") {
        if (!mc.hasCraftingTable) return modalInteraction.reply({ content: "❌ Il faut une table de craft.", ephemeral: true });
        const planksNeeded = qty * 2;
        if ((mc.planks || 0) < planksNeeded) return modalInteraction.reply({ content: "❌ Pas assez de planches.", ephemeral: true });
        mc.planks -= planksNeeded;
        mc.sticks += qty * 4;
        mc.xp += qty * 3;
        notice = `🪵 Tu as crafté ${qty * 4} bâtons.`;
      } else {
        return modalInteraction.reply({ content: "❌ Type de craft inconnu.", ephemeral: true });
      }
      mc.energy = Math.max(0, (mc.energy || 0) - energyCost);
      const phaseNote = advanceMinecraftAction(mc);
      if (phaseNote) notice = `${notice} ${phaseNote}`;
      mc.lastEvent = notice;
      saveData();
      const view = getMinecraftCurrentView(ownerId);
      await modalInteraction.reply({ embeds: [view.embed], components: view.components });
      if (notice) {
        try { await modalInteraction.channel.send(`🌍 <@${ownerId}> ${notice}`); } catch (e) {}
      }
      return;
    } catch (e) {
      console.error("mc craft modal error:", e);
      try { return modalInteraction.reply({ content: "❌ Erreur pendant le craft.", ephemeral: true }); } catch (e2) { return; }
    }
  }

  if (cid.startsWith("mc_smelt_qty_modal_")) {
    try {
      const parts = cid.split("_");
      const ownerId = parts[4];
      const smeltType = parts[5];
      if (ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette fenêtre ne t'appartient pas.", ephemeral: true });
      }
      const qtyRaw = modalInteraction.fields.getTextInputValue("mc_smelt_qty");
      const qty = parseInt(qtyRaw, 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 999) {
        return modalInteraction.reply({ content: "❌ Quantité invalide (1 à 999).", ephemeral: true });
      }
      const mc = getMinecraft(ownerId);
      if (!mc.hasFurnace) return modalInteraction.reply({ content: "❌ Il faut un four.", ephemeral: true });
      const energyCost = 8 * qty;
      if ((mc.energy || 0) < energyCost) {
        return modalInteraction.reply({ content: `❌ Pas assez d'énergie (${energyCost} requis).`, ephemeral: true });
      }
      let notice = "";
      if (smeltType === "iron") {
        if ((mc.ironOre || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de minerai de fer.", ephemeral: true });
        if ((mc.coal || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de charbon.", ephemeral: true });
        mc.ironOre -= qty;
        mc.coal -= qty;
        mc.ironIngot += qty;
        mc.xp += qty * 8;
        notice = `🔩 Tu as fondu ${qty} lingot(s) de fer.`;
      } else if (smeltType === "gold") {
        if ((mc.goldOre || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de minerai d'or.", ephemeral: true });
        if ((mc.coal || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de charbon.", ephemeral: true });
        mc.goldOre -= qty;
        mc.coal -= qty;
        mc.goldIngot += qty;
        mc.xp += qty * 10;
        notice = `🪙 Tu as fondu ${qty} lingot(s) d'or.`;
      } else if (smeltType === "netherite") {
        if (mc.world !== "nether") return modalInteraction.reply({ content: "❌ La netherite se fond uniquement dans le Nether.", ephemeral: true });
        if ((mc.ancientDebris || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de débris anciens.", ephemeral: true });
        const coalNeeded = qty * 2;
        if ((mc.coal || 0) < coalNeeded) return modalInteraction.reply({ content: "❌ Pas assez de charbon (2 par débris).", ephemeral: true });
        mc.ancientDebris -= qty;
        mc.coal -= coalNeeded;
        mc.netheriteScrap += qty;
        mc.xp += qty * 20;
        notice = `🔥 Fusion Nether: ${qty} débris → ${qty} fragments de netherite.`;
      } else if (smeltType === "beef") {
        if ((mc.rawBeef || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de bœuf cru.", ephemeral: true });
        if ((mc.coal || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de charbon.", ephemeral: true });
        mc.rawBeef -= qty;
        mc.coal -= qty;
        mc.cookedBeef += qty;
        mc.xp += qty * 4;
        notice = `🍖 Tu as cuit ${qty} bœuf(s).`;
      } else if (smeltType === "mutton") {
        if ((mc.rawMutton || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de mouton cru.", ephemeral: true });
        if ((mc.coal || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de charbon.", ephemeral: true });
        mc.rawMutton -= qty;
        mc.coal -= qty;
        mc.cookedMutton += qty;
        mc.xp += qty * 4;
        notice = `🍖 Tu as cuit ${qty} mouton(s).`;
      } else if (smeltType === "pork") {
        if ((mc.rawPork || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de porc cru.", ephemeral: true });
        if ((mc.coal || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de charbon.", ephemeral: true });
        mc.rawPork -= qty;
        mc.coal -= qty;
        mc.cookedPork += qty;
        mc.xp += qty * 4;
        notice = `🍖 Tu as cuit ${qty} porc(s).`;
      } else if (smeltType === "chicken") {
        if ((mc.rawChicken || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de poulet cru.", ephemeral: true });
        if ((mc.coal || 0) < qty) return modalInteraction.reply({ content: "❌ Pas assez de charbon.", ephemeral: true });
        mc.rawChicken -= qty;
        mc.coal -= qty;
        mc.cookedChicken += qty;
        mc.xp += qty * 4;
        notice = `🍖 Tu as cuit ${qty} poulet(s).`;
      } else {
        return modalInteraction.reply({ content: "❌ Type de fusion inconnu.", ephemeral: true });
      }
      mc.energy = Math.max(0, (mc.energy || 0) - energyCost);
      const phaseNote = advanceMinecraftAction(mc);
      if (phaseNote) notice = `${notice} ${phaseNote}`;
      mc.lastEvent = notice;
      saveData();
      const view = getMinecraftCurrentView(ownerId);
      await modalInteraction.reply({ embeds: [view.embed], components: view.components });
      if (notice) {
        try { await modalInteraction.channel.send(`🌍 <@${ownerId}> ${notice}`); } catch (e) {}
      }
      return;
    } catch (e) {
      console.error("mc smelt modal error:", e);
      try { return modalInteraction.reply({ content: "❌ Erreur pendant la fusion.", ephemeral: true }); } catch (e2) { return; }
    }
  }

  if (cid.startsWith("bank_convert_modal_")) {
    try {
      const parts = cid.split("_");
      const ownerId = parts[3];
      const type = parts[4];
      if (ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette fenêtre ne t'appartient pas.", ephemeral: true });
      }
      if (isInPrison(ownerId)) {
        return modalInteraction.reply({ content: "⛓️ Tu es en prison. Conversion indisponible.", ephemeral: true });
      }

      const qtyRaw = modalInteraction.fields.getTextInputValue("bank_convert_qty");
      const qty = parseInt(String(qtyRaw).trim(), 10);
      if (!Number.isFinite(qty) || qty <= 0) {
        return modalInteraction.reply({ content: "❌ Quantité invalide.", ephemeral: true });
      }

      const bal = getBalance(ownerId);
      const mc = bal.minecraft || {};
      const pk = bal.pokemon || {};
      const dj = bal.donjon || {};
      const zb = bal.zombie || {};
      let msg = "❌ Conversion impossible.";
      let conversionLabel = "";
      let conversionFrom = 0;
      let conversionTo = 0;

      if (type === "mc") {
        if (qty > (mc.emeralds || 0)) return modalInteraction.reply({ content: "❌ Quantité trop grande (émeraudes).", ephemeral: true });
        const converted = qty * MC_EMERALD_TO_MEMOCOIN;
        mc.emeralds -= qty;
        bal.bank = (bal.bank || 0) + converted;
        msg = `✅ Minecraft: ${qty} émeraude(s) → ${converted} Memocoins (banque).`;
        conversionLabel = "émeraude(s)";
        conversionFrom = qty;
        conversionTo = converted;
      } else if (type === "pk") {
        if (qty > (pk.pokedollars || 0)) return modalInteraction.reply({ content: "❌ Quantité trop grande (Pokédollars).", ephemeral: true });
        if (qty < PK_POKEDOLLAR_TO_MEMOCOIN || qty % PK_POKEDOLLAR_TO_MEMOCOIN !== 0) {
          return modalInteraction.reply({ content: "❌ La quantité de Pokédollars doit être un multiple de 1000.", ephemeral: true });
        }
        const converted = Math.floor(qty / PK_POKEDOLLAR_TO_MEMOCOIN);
        pk.pokedollars -= qty;
        bal.bank = (bal.bank || 0) + converted;
        msg = `✅ Pokémon: ${qty} Pokédollars → ${converted} Memocoins (banque).`;
        conversionLabel = "Pokédollars";
        conversionFrom = qty;
        conversionTo = converted;
      } else if (type === "dg") {
        if (qty > (dj.goldCoins || 0)) return modalInteraction.reply({ content: "❌ Quantité trop grande (pièces d'or).", ephemeral: true });
        const converted = qty * DG_GOLD_TO_MEMOCOIN;
        dj.goldCoins -= qty;
        bal.bank = (bal.bank || 0) + converted;
        msg = `✅ Donjon: ${qty} pièce(s) d'or → ${converted} Memocoins (banque).`;
        conversionLabel = "pièce(s) d'or";
        conversionFrom = qty;
        conversionTo = converted;
      } else if (type === "zb") {
        if (qty > (zb.silverCoins || 0)) return modalInteraction.reply({ content: "❌ Quantité trop grande (pièces d'argent).", ephemeral: true });
        const converted = qty * ZB_SILVER_TO_MEMOCOIN;
        zb.silverCoins -= qty;
        bal.bank = (bal.bank || 0) + converted;
        msg = `✅ Zombie: ${qty} pièce(s) d'argent → ${converted} Memocoins (banque).`;
        conversionLabel = "pièce(s) d'argent";
        conversionFrom = qty;
        conversionTo = converted;
      } else {
        return modalInteraction.reply({ content: "❌ Type de conversion inconnu.", ephemeral: true });
      }

      saveData();
      await refreshBankMenuMessage(ownerId);
      await modalInteraction.reply({ content: msg, ephemeral: true });
      if (conversionTo > 0 && conversionFrom > 0 && conversionLabel) {
        sendConversionMessage(modalInteraction.channel, ownerId, conversionLabel, conversionFrom, conversionTo);
      }
      return;
    } catch (e) {
      console.error("bank convert modal error:", e);
      try { return modalInteraction.reply({ content: "❌ Erreur pendant la conversion.", ephemeral: true }); } catch (e2) { return; }
    }
  }

  if (cid.startsWith('chatgpt_modal_') || cid.startsWith('zodi_chat_modal_')) {
    try {
      let ownerId = "";
      let requestedTopic = "free";
      if (cid.startsWith("zodi_chat_modal_")) {
        const parts = cid.split("_");
        ownerId = parts[3];
        requestedTopic = parts.slice(4).join("_") || "free";
      } else {
        ownerId = cid.split("_")[2];
      }
      if (ownerId && ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette question ne t'appartient pas.", ephemeral: true });
      }
      let prompt = "";
      try {
        prompt = String(modalInteraction.fields.getTextInputValue("zodi_chat_prompt") || "").trim();
      } catch (e) {}
      if (!prompt) {
        try {
          prompt = String(modalInteraction.fields.getTextInputValue("chatgpt_prompt") || "").trim();
        } catch (e) {}
      }
      if (!prompt) return modalInteraction.reply({ content: "❌ Question vide.", ephemeral: true });

      await modalInteraction.reply({ content: "💬 Zodi prépare une réponse...", ephemeral: true });
      const answer = await buildZodiChatReply({
        userId: modalInteraction.user.id,
        prompt,
        requestedTopic
      });
      const chunks = [];
      let text = answer;
      while (text.length > 0) {
        chunks.push(text.slice(0, 1900));
        text = text.slice(1900);
      }
      await modalInteraction.followUp({ content: `💬 **Message de <@${modalInteraction.user.id}>** :\n${prompt.slice(0, 500)}` });
      for (const c of chunks) {
        await modalInteraction.followUp({ content: c });
      }
    } catch (e) {
      try {
        await modalInteraction.followUp({ content: `❌ Discussion indisponible: ${e.message || e}` , ephemeral: true });
      } catch (e2) {}
    }
    return;
  }

  if (cid.startsWith("shop_qty_modal_")) {
    try {
      const parts = cid.split("_");
      const ownerId = parts[3];
      const shopItemId = parts.slice(4).join("_");
      if (ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette fenêtre d'achat ne t'appartient pas.", ephemeral: true });
      }

      const qtyRaw = modalInteraction.fields.getTextInputValue("shop_qty");
      const qty = parseInt(String(qtyRaw).trim(), 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 999) {
        return modalInteraction.reply({ content: "❌ Quantité invalide (1 à 999).", ephemeral: true });
      }

      const item = {
        reset_slot: { price: 34500, label: "Reset Slotomania" },
        reset_casino: { price: 34500, label: "Reset Casino" },
        reset_steal: { price: 45000, label: "Reset vol" },
        anti_steal: { price: 150000, label: "Protection de vol" },
        police_protection: { price: SHOP_PRICE_POLICE_PROTECTION, label: "Protection anti-police" },
        reset_roulette: { price: 755000, label: "Reset roulette" }
      }[shopItemId];
      if (!item) return modalInteraction.reply({ content: "❌ Objet inconnu.", ephemeral: true });

      const bal = getBalance(ownerId);
      const maxQty = getMaxAffordableQuantity(getMemocoinSpendCapacity(ownerId), item.price, 999);
      if (qty > maxQty) {
        return modalInteraction.reply({ content: `❌ Quantité trop grande. Max: ${maxQty}.`, ephemeral: true });
      }
      const totalPrice = item.price * qty;
      if (isInPrison(ownerId)) {
        return modalInteraction.reply({ content: "⛓️ Tu es en prison. Achats indisponibles.", ephemeral: true });
      }
      if (!spendMemocoinInventoryThenBank(ownerId, totalPrice)) {
        return modalInteraction.reply({ content: getDebtBlockedReason("Achat"), ephemeral: true });
      }
      const purchaseText = applyShopPurchase(bal, shopItemId, qty);
      saveData();

      const shopEmbed = new EmbedBuilder()
        .setTitle("🛒 Magasin")
        .setDescription(
          "Objets disponibles :\n" +
          "- ⚡ Reset attente Slotomania : 34500$\n" +
          "- ⚡ Reset attente Casino : 34500$\n" +
          "- ⚡ Reset attente vol : 45000$\n" +
          "- 🛡️ Protection de vol : 150000$\n" +
          `- 👮🛡️ Protection contre la police : ${SHOP_PRICE_POLICE_PROTECTION}$\n` +
          "- ⚡ Reset attente roulette : 755000$"
        )
        .addFields(
          { name: "🛒 Achat", value: `${purchaseText}\nTotal payé: ${totalPrice}.`, inline: false },
          { name: "💰 Solde", value: `${bal.inventory}`, inline: true },
          { name: "🛡️ Protections de vol", value: `${bal.antiStealProtection}`, inline: true },
          { name: "👮🛡️ Protections police", value: `${bal.antiPoliceProtection || 0}`, inline: true },
          { name: "⚡ Reset Casino", value: `${bal.resetCasinoPower || 0}`, inline: true },
          { name: "⚡ Reset roulette", value: `${bal.resetRoulettePower || 0}`, inline: true },
          { name: "⚡ Reset vol", value: `${bal.resetStealPower || 0}`, inline: true }
        );

      await modalInteraction.reply({ embeds: [shopEmbed], components: buildShopComponents(ownerId) });
      try {
        await modalInteraction.channel.send(`🛒 <@${ownerId}> a acheté **${qty}x ${item.label}** pour ${totalPrice} Memocoins.`);
      } catch (e) {}
    } catch (e) {
      console.error("shop qty modal error:", e);
      try { await modalInteraction.reply({ content: "❌ Erreur pendant l'achat.", ephemeral: true }); } catch (e2) {}
    }
    return;
  }

  if (cid.startsWith("game_shop_qty_modal_")) {
    try {
      const parts = cid.split("_");
      const ownerId = parts[4];
      const game = parts[5];
      const item = parts.slice(6).join("_");
      if (ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette fenêtre d'achat ne t'appartient pas.", ephemeral: true });
      }

      const qtyRaw = modalInteraction.fields.getTextInputValue("game_shop_qty");
      const qty = parseInt(String(qtyRaw).trim(), 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 999) {
        return modalInteraction.reply({ content: "❌ Quantité invalide (1 à 999).", ephemeral: true });
      }

      const def = getGameShopDef(game, item);
      if (!def) return modalInteraction.reply({ content: "❌ Objet de boutique inconnu.", ephemeral: true });

      const bal = getBalance(ownerId);
      const mc = bal.minecraft;
      const total = def.price * qty;
      const currency = def.currency || "memocoin";
      const currencyLabel = getCurrencyLabel(currency);
      if (currency === "memocoin") {
        const maxQty = getMaxAffordableQuantity(getMemocoinSpendCapacity(ownerId), def.price, 999);
        if (qty > maxQty) {
          return modalInteraction.reply({ content: `❌ Quantité trop grande. Max: ${maxQty}.`, ephemeral: true });
        }
        if (isInPrison(ownerId)) {
          return modalInteraction.reply({ content: "⛓️ Tu es en prison. Achats indisponibles.", ephemeral: true });
        }
        if (!spendMemocoinInventoryThenBank(ownerId, total)) {
          return modalInteraction.reply({ content: getDebtBlockedReason("Achat"), ephemeral: true });
        }
      } else {
        const wallet = getWalletAmountByCurrency(bal, currency);
        const maxQty = getMaxAffordableQuantity(wallet, def.price, 999);
        if (qty > maxQty) {
          return modalInteraction.reply({ content: `❌ Quantité trop grande. Max: ${maxQty}.`, ephemeral: true });
        }
        if (wallet < total) {
          return modalInteraction.reply({ content: `❌ Fonds insuffisants. Total: ${total} ${currencyLabel}.`, ephemeral: true });
        }
        if (currency === "emerald") bal.minecraft.emeralds -= total;
        else if (currency === "pokedollar") bal.pokemon.pokedollars -= total;
        else if (currency === "gold") bal.donjon.goldCoins -= total;
        else if (currency === "silver") bal.zombie.silverCoins -= total;
      }
      def.apply(bal, mc, qty);
      if (game === "mc") {
        mc.lastPurchase = `${qty}x ${def.label} (boutique, ${total} ${currencyLabel}).`;
      }
      saveData();

      let view;
      if (game === "mc") view = buildMinecraftShopView(ownerId);
      else if (game === "pk") view = buildPokemonShopView(ownerId);
      else if (game === "dg") view = buildDonjonShopView(ownerId);
      else if (game === "zb") view = buildZombieShopView(ownerId);
      else view = buildMemocoinShopView(ownerId);

      view.embed.addFields({ name: "✅ Achat", value: `${qty}x ${def.label} acheté(s) pour ${total} ${currencyLabel}.` });
      await modalInteraction.reply({ embeds: [view.embed], components: view.components });
      try {
        let shopLabel = "Boutique";
        if (game === "mc") shopLabel = "Boutique Minecraft";
        else if (game === "pk") shopLabel = "Boutique Pokémon";
        else if (game === "dg") shopLabel = "Boutique Donjon";
        else if (game === "zb") shopLabel = "Boutique Zombie";
        else if (game === "mm") shopLabel = "Boutique Memocoin";
        await modalInteraction.channel.send(`🛒 <@${ownerId}> a acheté **${qty}x ${def.label}** dans **${shopLabel}** pour ${total} ${currencyLabel}.`);
      } catch (e) {}
    } catch (e) {
      console.error("game shop qty modal error:", e);
      try { await modalInteraction.reply({ content: "❌ Erreur pendant l'achat du jeu.", ephemeral: true }); } catch (e2) {}
    }
    return;
  }

  if (cid.startsWith("merchant_qty_modal_")) {
    try {
      const parts = cid.split("_");
      const ownerId = parts[3];
      const slot = Number(parts[4]);
      if (ownerId !== modalInteraction.user.id) {
        return modalInteraction.reply({ content: "❌ Cette fenêtre d'achat ne t'appartient pas.", ephemeral: true });
      }
      if (!isTravelingMerchantOpen()) {
        return modalInteraction.reply({ content: "⏰ Le marchand ambulant est fermé (14h-16h, heure de Paris).", ephemeral: true });
      }

      const qtyRaw = modalInteraction.fields.getTextInputValue("merchant_qty");
      const qty = parseInt(String(qtyRaw).trim(), 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 999) {
        return modalInteraction.reply({ content: "❌ Quantité invalide (1 à 999).", ephemeral: true });
      }

      const record = travelingMerchantMap.get(ownerId);
      const offer = record?.offers?.find(o => o.slot === slot);
      if (!offer) {
        return modalInteraction.reply({ content: "❌ Offre expirée. Ouvre le marchand ambulant à nouveau.", ephemeral: true });
      }

      const bal = getBalance(ownerId);
      const maxQty = getMaxAffordableQuantity(getMemocoinSpendCapacity(ownerId), offer.memocoinPrice, 999);
      if (qty > maxQty) {
        return modalInteraction.reply({ content: `❌ Quantité trop grande. Max: ${maxQty}.`, ephemeral: true });
      }
      const total = offer.memocoinPrice * qty;
      if (isInPrison(ownerId)) {
        return modalInteraction.reply({ content: "⛓️ Tu es en prison. Achats indisponibles.", ephemeral: true });
      }
      if (!spendMemocoinInventoryThenBank(ownerId, total)) {
        return modalInteraction.reply({ content: getDebtBlockedReason("Achat"), ephemeral: true });
      }
      offer.apply(bal, qty);
      saveData();

      const view = buildTravelingMerchantView(ownerId, { forceNew: false });
      view.embed.addFields({ name: "✅ Achat", value: `${qty}x ${offer.label} acheté(s) pour ${total} Memocoins.` });
      await modalInteraction.reply({ embeds: [view.embed], components: view.components });
      try {
        await modalInteraction.channel.send(`🧳 <@${ownerId}> a acheté **${qty}x ${offer.label}** chez le marchand ambulant pour ${total} Memocoins.`);
      } catch (e) {}
    } catch (e) {
      console.error("merchant qty modal error:", e);
      try { await modalInteraction.reply({ content: "❌ Erreur pendant l'achat chez le marchand ambulant.", ephemeral: true }); } catch (e2) {}
    }
    return;
  }

  // MEMOCOIN MODAL
  if (cid.startsWith('memocoin_modal_')) {
    try {
      const parts = cid.split('_');
      const action = parts[2];
      const adminId = parts[3];
      const targetId = parts[4];

      if (modalInteraction.user.id !== adminId) {
        return modalInteraction.reply({ content: "❌ Tu n'es pas l'administrateur attendu pour cette action.", ephemeral: true });
      }

      const amountStr = modalInteraction.fields.getTextInputValue('memocoin_amount');
      const amount = parseInt(amountStr);
      if (isNaN(amount) || amount <= 0) {
        return modalInteraction.reply({ content: '❌ Montant invalide (doit etre un entier positif).', ephemeral: true });
      }

      initUser(targetId);
      const bal = getBalance(targetId);

      if (action === 'give') {
        addMemocoin(targetId, amount);
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a donné ${amount} Memocoins à <@${targetId}>. Solde : ${newBal.inventory} | Banque : ${newBal.bank} | Protections : ${newBal.antiStealProtection || 0}` });
      } else if (action === 'remove') {
        const removed = Math.min(bal.inventory, amount);
        bal.inventory -= removed;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} Memocoins de <@${targetId}>. Solde : ${newBal.inventory} | Banque : ${newBal.bank} | Protections : ${newBal.antiStealProtection || 0}` });
      } else if (action === 'giveprot') {
        bal.antiStealProtection = (bal.antiStealProtection || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a ajouté ${amount} protection(s) de vol à <@${targetId}>. Protections : ${newBal.antiStealProtection}` });
      } else if (action === 'removeprot') {
        const removed = Math.min((bal.antiStealProtection || 0), amount);
        bal.antiStealProtection = Math.max(0, (bal.antiStealProtection || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} protection(s) de vol de <@${targetId}>. Protections : ${newBal.antiStealProtection}` });
      } else if (action === 'giveresetroulette') {
        bal.resetRoulettePower = (bal.resetRoulettePower || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a donné ${amount} reset(s) roulette à <@${targetId}>. Reset roulette : ${newBal.resetRoulettePower || 0}` });
      } else if (action === 'removeresetroulette') {
        const removed = Math.min((bal.resetRoulettePower || 0), amount);
        bal.resetRoulettePower = Math.max(0, (bal.resetRoulettePower || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} reset(s) roulette de <@${targetId}>. Reset roulette : ${newBal.resetRoulettePower || 0}` });
      } else if (action === 'giveresetsteal') {
        bal.resetStealPower = (bal.resetStealPower || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a donné ${amount} reset(s) vol à <@${targetId}>. Reset vol : ${newBal.resetStealPower || 0}` });
      } else if (action === 'removeresetsteal') {
        const removed = Math.min((bal.resetStealPower || 0), amount);
        bal.resetStealPower = Math.max(0, (bal.resetStealPower || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} reset(s) vol de <@${targetId}>. Reset vol : ${newBal.resetStealPower || 0}` });
      } else if (action === 'giveresetcasino') {
        bal.resetCasinoPower = (bal.resetCasinoPower || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a donné ${amount} reset(s) casino à <@${targetId}>. Reset casino : ${newBal.resetCasinoPower || 0}` });
      } else if (action === 'removeresetcasino') {
        const removed = Math.min((bal.resetCasinoPower || 0), amount);
        bal.resetCasinoPower = Math.max(0, (bal.resetCasinoPower || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} reset(s) casino de <@${targetId}>. Reset casino : ${newBal.resetCasinoPower || 0}` });
      } else if (action === 'giveresetslot') {
        bal.resetSlotPower = (bal.resetSlotPower || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a donné ${amount} reset(s) Slotomania à <@${targetId}>. Reset Slotomania : ${newBal.resetSlotPower || 0}` });
      } else if (action === 'removeresetslot') {
        const removed = Math.min((bal.resetSlotPower || 0), amount);
        bal.resetSlotPower = Math.max(0, (bal.resetSlotPower || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} reset(s) Slotomania de <@${targetId}>. Reset Slotomania : ${newBal.resetSlotPower || 0}` });
      } else if (action === 'givepoliceprot') {
        bal.antiPoliceProtection = (bal.antiPoliceProtection || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a ajouté ${amount} protection(s) anti-police à <@${targetId}>. Protections anti-police : ${newBal.antiPoliceProtection || 0}` });
      } else if (action === 'removepoliceprot') {
        const removed = Math.min((bal.antiPoliceProtection || 0), amount);
        bal.antiPoliceProtection = Math.max(0, (bal.antiPoliceProtection || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} protection(s) anti-police de <@${targetId}>. Protections anti-police : ${newBal.antiPoliceProtection || 0}` });
      } else if (action === 'givebank') {
        bal.bank = (bal.bank || 0) + amount;
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a ajouté ${amount} Memocoins à la banque de <@${targetId}>. Banque : ${newBal.bank}` });
      } else if (action === 'removebank') {
        const removed = Math.min((bal.bank || 0), amount);
        bal.bank = Math.max(0, (bal.bank || 0) - removed);
        saveData();
        const newBal = getBalance(targetId);
        await modalInteraction.reply({ content: `✅ <@${adminId}> a retiré ${removed} Memocoins de la banque de <@${targetId}>. Banque : ${newBal.bank}` });
      } else {
        return modalInteraction.reply({ content: '❌ Action inconnue.', ephemeral: true });
      }

      try {
        const msg = modalInteraction.message;
        if (msg && msg.edit) {
          const adminEmbed = new EmbedBuilder()
            .setTitle("\u{1F4B0} Give Objet")
            .setColor(0xff9900)
            .setDescription("Utilisateur conserve. Tu peux enchainer plusieurs actions.");
          const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("memocoin_give").setLabel("\u{1FA99} Donner Memocoin").setStyle(ButtonStyle.Success).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_remove").setLabel("\u{1FA99} Retirer Memocoin").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_give_bank").setLabel("\u{2795} Ajouter memocoin banque").setStyle(ButtonStyle.Success).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_remove_bank").setLabel("\u{2796} Retirer memocoin banque").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_give_protection").setLabel("\u{1F6E1}\u{FE0F} Donner protection vol").setStyle(ButtonStyle.Success).setDisabled(false)
          );
          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("memocoin_remove_protection").setLabel("\u{1F6E1}\u{FE0F} Retirer protection vol").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_give_police_protection").setLabel("\ud83d\udee1\ufe0f Donner protection police").setStyle(ButtonStyle.Success).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_remove_police_protection").setLabel("\ud83d\udee1\ufe0f Retirer protection police").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_give_reset_roulette").setLabel("\u26A1 Donner reset roulette").setStyle(ButtonStyle.Success).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_remove_reset_roulette").setLabel("\u26A1 Retirer reset roulette").setStyle(ButtonStyle.Danger).setDisabled(false)
          );
          const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("memocoin_give_reset_steal").setLabel("\u26A1 Donner reset vol").setStyle(ButtonStyle.Success).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_remove_reset_steal").setLabel("\u26A1 Retirer reset vol").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_give_reset_casino").setLabel("\u26A1 Donner reset casino").setStyle(ButtonStyle.Success).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_remove_reset_casino").setLabel("\u26A1 Retirer reset casino").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("memocoin_give_reset_slot").setLabel("\u26A1 Donner reset Slotomania").setStyle(ButtonStyle.Success).setDisabled(false)
          );
          const row4 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("memocoin_remove_reset_slot").setLabel("\u26A1 Retirer reset Slotomania").setStyle(ButtonStyle.Danger).setDisabled(false),
            new ButtonBuilder().setCustomId("back_admin").setLabel("\u{1F519} Retour").setStyle(ButtonStyle.Secondary),
            buildRefreshButton(),
          );
          await msg.edit({ embeds: [adminEmbed], components: [row1, row2, row3, row4] }).catch(() => {});
        }
      } catch (e) {}

    } catch (e) {
      console.error('memocoin modal submit error:', e);
      try { await modalInteraction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
    }
    return;
  }

  // STEAL MODAL
  if (cid.startsWith('steal_modal_')) {
    try {
      const parts = cid.split('_');
      const thiefId = parts[2];
      const targetId = parts[3];

      if (modalInteraction.user.id !== thiefId) {
        return modalInteraction.reply({ content: "❌ Tu n'es pas l'utilisateur attendu pour cette action.", ephemeral: true });
      }
      if (isInPrison(thiefId)) {
        return modalInteraction.reply({ content: "⛓️ Tu es en prison. Vol impossible.", ephemeral: true });
      }
      if (hasPoliceLock(thiefId)) {
        const remaining = formatShortDuration(getPoliceWaitRemainingMs(thiefId));
        return modalInteraction.reply({ content: `🚫 Menus de jeux bloques par la police. Temps restant: ${remaining}.`, ephemeral: true });
      }

      const amountStr = modalInteraction.fields.getTextInputValue('steal_amount');
      const amount = parseInt(amountStr);
      if (isNaN(amount) || amount <= 0) {
        return modalInteraction.reply({ content: '❌ Montant invalide (doit etre un entier positif).', ephemeral: true });
      }

      if (thiefId === targetId) return modalInteraction.reply({ content: '❌ Impossible de te voler toi-même.', ephemeral: true });

      // prevent scheduling multiple steals at once
      if (pendingStealsMap.has(thiefId)) {
        return modalInteraction.reply({ content: '❌ Tu as déjà un vol en attente.', ephemeral: true });
      }

      // enforce cooldown between each steal (1m to 1h, set after each new steal)
      const now = Date.now();
      const nextAllowedAt = stealCooldownMap.get(thiefId) || 0;
      if (nextAllowedAt > now) {
        return modalInteraction.reply({ content: `⏱️ Tu ne peux plus voler.\n${formatRetryMessage(nextAllowedAt, "voler de nouveau")}`, ephemeral: true });
      }

      initUser(targetId);
      initUser(thiefId);
      const victimNow = getBalance(targetId);
      const thiefNow = getBalance(thiefId);
      const victimTotalNow = (victimNow.inventory || 0) + (victimNow.bank || 0);
      const thiefTotalNow = (thiefNow.inventory || 0) + (thiefNow.bank || 0);
      if (victimTotalNow < amount) {
        return modalInteraction.reply({ content: "\u274C Vol refusé: la victime ne possède pas cette somme (inventaire + banque).", ephemeral: true });
      }
      if (thiefTotalNow < amount) {
        return modalInteraction.reply({ content: "\u274C Vol refusé: fonds insuffisants pour dédommager la victime en cas d'échec.", ephemeral: true });
      }

      // success chance by progressive tiers (interpolated between points)
      const STEAL_TIERS = [
        { amount: 1, success: 0.99, cooldownMs: 1 * 60 * 1000 },
        { amount: 10, success: 0.90, cooldownMs: 3 * 60 * 1000 },
        { amount: 100, success: 0.75, cooldownMs: 25 * 60 * 1000 },
        { amount: 1000, success: 0.50, cooldownMs: 45 * 60 * 1000 },
        { amount: 10000, success: 0.25, cooldownMs: 55 * 60 * 1000 }
      ];

      const safeAmount = Math.max(1, amount);
      let lowerTier = STEAL_TIERS[0];
      let upperTier = STEAL_TIERS[STEAL_TIERS.length - 1];

      for (let i = 0; i < STEAL_TIERS.length - 1; i++) {
        const a = STEAL_TIERS[i];
        const b = STEAL_TIERS[i + 1];
        if (safeAmount >= a.amount && safeAmount <= b.amount) {
          lowerTier = a;
          upperTier = b;
          break;
        }
      }

      let successChance;
      let cooldownMs;
      if (safeAmount <= STEAL_TIERS[0].amount) {
        successChance = STEAL_TIERS[0].success;
        cooldownMs = STEAL_TIERS[0].cooldownMs;
      } else if (safeAmount >= STEAL_TIERS[STEAL_TIERS.length - 1].amount) {
        successChance = STEAL_TIERS[STEAL_TIERS.length - 1].success;
        cooldownMs = STEAL_TIERS[STEAL_TIERS.length - 1].cooldownMs;
      } else {
        // interpolate in log scale so progression feels smooth between decades (10, 100, 1000...)
        const lowLog = Math.log10(lowerTier.amount);
        const upLog = Math.log10(upperTier.amount);
        const amountLog = Math.log10(safeAmount);
        const t = (amountLog - lowLog) / (upLog - lowLog);
        successChance = lowerTier.success + (upperTier.success - lowerTier.success) * t;
        cooldownMs = Math.floor(lowerTier.cooldownMs + (upperTier.cooldownMs - lowerTier.cooldownMs) * t);
      }

      // cooldown requested:
      // 1..9 => 10m | 10..100 => 30m | 101+ => 1h
      if (amount <= 9) cooldownMs = 10 * 60 * 1000;
      else if (amount <= 100) cooldownMs = 30 * 60 * 1000;
      else cooldownMs = 60 * 60 * 1000;

      const failChance = 1 - successChance;
      const policeCatchChance = getPoliceCatchChanceForAmount(amount);

      // execution delay for the scheduled steal: max 1 minute
      const MIN_EXEC_DELAY = 1000; // 1 second
      const MAX_EXEC_DELAY = 60 * 1000; // 1 minute
      const delayMs = MIN_EXEC_DELAY + Math.floor(Math.random() * (MAX_EXEC_DELAY - MIN_EXEC_DELAY + 1));

      // cooldown between steals is computed from amount above
      stealCooldownMap.set(thiefId, now + cooldownMs);

      // reply to thief with scheduled info
      const humanDelay = formatShortDuration(delayMs);
      const humanCooldown = formatShortDuration(cooldownMs);
      await modalInteraction.reply({ content: `✅ Vol planifié dans ${humanDelay}. Cooldown avant le prochain vol: ${humanCooldown}. Tu pourras voler de nouveau à ${formatRetryClock(now + cooldownMs)}. Chance de réussite: ${Math.round(successChance * 100)} % | Échec: ${Math.round(failChance * 100)} % | Police: ${formatPercent(policeCatchChance)}.`, ephemeral: true });

      // store pending steal so user can't schedule multiple
      const timer = setTimeout(async () => {
        try {
          // refresh balances at resolution time
          initUser(targetId);
          initUser(thiefId);
          const victim = getBalance(targetId);
          const thief = getBalance(thiefId);
          const thiefTotal = (thief.inventory || 0) + (thief.bank || 0);

          if (thiefTotal < amount) {
            try { await modalInteraction.channel.send(`<@${thiefId}> ne peut plus dédommager la victime: vol refusé.`); } catch (e) {}
            return;
          }

          if ((victim.inventory + victim.bank) < amount) {
            try { await modalInteraction.channel.send(`<@${thiefId}> a tenté de voler <@${targetId}>, mais la somme demandée n'était plus disponible (inventaire + banque).`); } catch (e) {}
            return;
          }

          if (Math.random() < policeCatchChance) {
            if (tryConsumePoliceProtection(thiefId)) {
              try { await modalInteraction.channel.send(`\ud83d\udee1\ufe0f <@${thiefId}> a évité la police (chance: ${formatPercent(policeCatchChance)}) grâce à une protection anti-police (1 consommée).`); } catch (e) {}
              return;
            }
            triggerPoliceLock(thiefId);
            try { await modalInteraction.channel.send(`👮 <@${thiefId}> s'est fait attraper par la police (chance: ${formatPercent(policeCatchChance)}). Menus de jeux bloques pendant 1 jour.`); } catch (e) {}
            return;
          }

          // protection is consumed on any steal attempt
          if (victim.antiStealProtection > 0) {
            victim.antiStealProtection -= 1;
            // compensation: transfer from thief to victim when protection blocks the steal
            const compensation = amount;
            spendMemocoinInventoryThenBank(thiefId, compensation);
            victim.inventory += compensation;
            saveData();
            try {
              if (compensation > 0) {
                await modalInteraction.channel.send(
                  `🛡️ Vol bloqué: <@${targetId}> a bloqué la tentative de <@${thiefId}>.\n` +
                  `Compensation: +${compensation} pour <@${targetId}> | -${compensation} pour <@${thiefId}>.`
                );
              } else {
                await modalInteraction.channel.send(`🛡️ Vol bloqué: <@${targetId}> a bloqué la tentative de <@${thiefId}>. Aucune compensation.`);
              }
            } catch (e) {}
            return;
          }

          const success = Math.random() > failChance;
          if (success) {
            spendMemocoinInventoryThenBank(targetId, amount);
            thief.inventory += amount;
            saveData();
            try {
              await modalInteraction.channel.send(
                `💸 Vol réussi: <@${thiefId}> -> <@${targetId}>.\n` +
                `Montant: ${amount} Memocoins | +${amount} pour <@${thiefId}> | -${amount} pour <@${targetId}>.`
              );
            } catch (e) {}
          } else {
            // failure penalty: thief pays a small fine (20% of attempted amount) to the victim if possible
            const penalty = Math.min((thief.inventory + thief.bank), Math.ceil(amount * 0.2));
            if (penalty > 0) {
              spendMemocoinInventoryThenBank(thiefId, penalty);
              victim.inventory += penalty;
              saveData();
            }
            try {
              if (penalty > 0) {
                await modalInteraction.channel.send(
                  `❌ Vol echoue: <@${thiefId}> n'a pas pu voler <@${targetId}>.\n` +
                  `Penalite: ${penalty} Memocoins | +${penalty} pour <@${targetId}> | -${penalty} pour <@${thiefId}>.`
                );
              } else {
                await modalInteraction.channel.send(`❌ Vol echoue: <@${thiefId}> n'a pas pu voler <@${targetId}>. Aucune penalite.`);
              }
            } catch (e) {}
          }
        } catch (e) {
          console.error('Erreur lors de l execution du Vol planifié:', e);
        } finally {
          pendingStealsMap.delete(thiefId);
          try {
            if (modalInteraction.message?.edit) {
              await modalInteraction.message.edit({ components: buildStealControlComponents(thiefId) }).catch(() => {});
            }
          } catch (e) {}
        }
      }, delayMs);

      pendingStealsMap.set(thiefId, { timer, giver: thiefId, target: targetId, amount, executeAt: Date.now() + delayMs });
      try {
        if (modalInteraction.message?.edit) {
          await modalInteraction.message.edit({ components: buildStealControlComponents(thiefId) }).catch(() => {});
        }
      } catch (e) {}
    } catch (e) {
      console.error('steal modal submit error:', e);
      try { await modalInteraction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
    }
    return;
  }

  // DONATE MODAL
  if (cid.startsWith('donate_modal_')) {
    try {
      const parts = cid.split('_');
      const giverId = parts[2];
      const targetId = parts[3];

      if (modalInteraction.user.id !== giverId) {
        return modalInteraction.reply({ content: "❌ Tu n'es pas l'utilisateur attendu pour cette action.", ephemeral: true });
      }
      if (isInPrison(giverId)) {
        return modalInteraction.reply({ content: "⛓️ Tu es en prison. Don impossible.", ephemeral: true });
      }

      const amountStr = modalInteraction.fields.getTextInputValue('donate_amount');
      const amount = parseInt(amountStr);
      if (isNaN(amount) || amount <= 0) {
        return modalInteraction.reply({ content: '❌ Montant invalide (doit etre un entier positif).', ephemeral: true });
      }

      if (giverId === targetId) return modalInteraction.reply({ content: '❌ Impossible de te donner à toi-même.', ephemeral: true });

      initUser(giverId);
      initUser(targetId);
      const giver = getBalance(giverId);
      const recipient = getBalance(targetId);

      const transfer = Math.min(giver.inventory, amount);
      if (transfer <= 0) {
        return modalInteraction.reply({ content: "❌ Tu n'as pas assez de Memocoins.", ephemeral: true });
      }

      giver.inventory -= transfer;
      recipient.inventory += transfer;
      saveData();

      await modalInteraction.reply({ content: `✅ Tu as donné ${transfer} Memocoins à <@${targetId}>. Ton solde : ${giver.inventory} | Banque : ${giver.bank}`, ephemeral: true });
      try {
        await modalInteraction.channel.send(
          `🎁 Don effectue: <@${giverId}> -> <@${targetId}>.\n` +
          `Montant: ${transfer} Memocoins | +${transfer} pour <@${targetId}> | -${transfer} pour <@${giverId}>.`
        );
      } catch (e) {}

      // keep selected target so user can chain multiple donations without reselecting
    } catch (e) {
      console.error('donate modal submit error:', e);
      try { await modalInteraction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch(e){}
    }
    return;
  }
}

zodiClient.on("interactionCreate", handleZodiModalInteraction);

// ==========================
// FORMAT DUREE
// ==========================
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  return `${days}j ${hours}h ${minutes}m ${seconds}s`;
}

function formatShortDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}j ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatRetryClock(untilTs) {
  const d = new Date(untilTs);
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(d);
  const hh = parts.find(p => p.type === "hour")?.value || "00";
  const mm = parts.find(p => p.type === "minute")?.value || "00";
  if (mm === "00") return `${hh}H`;
  return `${hh}H${mm}`;
}

function formatRetryMessage(untilTs, action = "rejouer") {
  const remaining = formatShortDuration(Math.max(1, untilTs - Date.now()));
  return `Tu dois attendre ${remaining} avant de ${action}.\nTu pourras ${action} à ${formatRetryClock(untilTs)}.`;
}

function getMsUntilNextParisMidnight(date = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = t => Number(parts.find(p => p.type === t)?.value || 0);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  const nowParis = Date.UTC(y, m - 1, d, hh, mm, ss);
  const nextParis = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  return Math.max(1000, nextParis - nowParis);
}

function pickDonjonMonster(options = {}) {
  const pool = Array.isArray(options.pool) ? options.pool : DONJON_MONSTERS;
  const pick = weightedPick(pool);
  const forceVariant = options.forceVariant || null;
  const roll = Math.random();
  let variant = "normal";
  let hpMult = 1;
  let atkMult = 1;
  let rewardMult = 1;
  let lossMult = 1;
  if (forceVariant) {
    variant = forceVariant;
  } else if (roll < 0.05) {
    variant = "boss";
  } else if (roll < 0.2) {
    variant = "elite";
  }
  if (variant === "boss") {
    hpMult = 1.6;
    atkMult = 1.35;
    rewardMult = 1.8;
    lossMult = 1.3;
  } else if (variant === "elite") {
    hpMult = 1.25;
    atkMult = 1.15;
    rewardMult = 1.3;
    lossMult = 1.15;
  }
  const baseHp = pick.hpMin + Math.floor(Math.random() * (pick.hpMax - pick.hpMin + 1));
  const baseLose = pick.losePenaltyMin + Math.floor(Math.random() * (pick.losePenaltyMax - pick.losePenaltyMin + 1));
  const hp = Math.floor(baseHp * hpMult);
  const atkMin = Math.max(1, Math.floor(pick.atkMin * atkMult));
  const atkMax = Math.max(atkMin, Math.floor(pick.atkMax * atkMult));
  const rewardMin = Math.floor(pick.rewardMin * rewardMult);
  const rewardMax = Math.floor(pick.rewardMax * rewardMult);
  const losePenalty = Math.floor(baseLose * lossMult);
  const name = variant === "normal" ? pick.name : `${variant === "boss" ? "Boss" : "Élite"} ${pick.name}`;
  return { name, hp, atkMin, atkMax, rewardMin, rewardMax, losePenalty, variant };
}

function pickDonjonBoss() {
  return pickDonjonMonster({ pool: DONJON_BOSS_POOL, forceVariant: "boss" });
}

function normalizeZodiChatText(text = "") {
  const normalized = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const typoMap = {
    coman: "comment",
    comen: "comment",
    coment: "comment",
    komen: "comment",
    pourkoi: "pourquoi",
    pourqoi: "pourquoi",
    koi: "quoi",
    qoi: "quoi",
    kel: "quel",
    kelle: "quelle",
    qe: "que",
    fair: "faire",
    modale: "modal",
    discorde: "discord",
    discrod: "discord",
    roulete: "roulette",
    capital: "capitale",
    ortografe: "orthographe",
    phote: "faute",
    sujer: "sujet"
  };
  return normalized
    .split(" ")
    .filter(Boolean)
    .map(token => typoMap[token] || token)
    .join(" ");
}

function zodiChatTokenize(text = "") {
  return normalizeZodiChatText(text).split(" ").filter(Boolean);
}

function zodiChatLevenshtein(a = "", b = "") {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array(b.length + 1);
  const next = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(
        next[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }

  return prev[b.length];
}

function zodiChatAllowedDistance(word = "") {
  if (word.length >= 9) return 2;
  if (word.length >= 6) return 1;
  return 0;
}

function zodiChatWordMatches(keywordWord = "", textWord = "") {
  const key = normalizeZodiChatText(keywordWord);
  const token = normalizeZodiChatText(textWord);
  if (!key || !token) return false;
  if (key === token) return true;
  const allowed = zodiChatAllowedDistance(key);
  if (!allowed) return false;
  if (Math.abs(key.length - token.length) > allowed) return false;
  return zodiChatLevenshtein(key, token) <= allowed;
}

function zodiChatPhraseMatches(textTokens, keyword) {
  const keyTokens = zodiChatTokenize(keyword);
  if (!keyTokens.length) return false;
  if (keyTokens.length === 1) {
    return textTokens.some(token => zodiChatWordMatches(keyTokens[0], token));
  }
  return keyTokens.every(keyToken => textTokens.some(token => zodiChatWordMatches(keyToken, token)));
}

function zodiChatIncludes(text, keywords) {
  const normalizedText = normalizeZodiChatText(text);
  const textTokens = zodiChatTokenize(normalizedText);
  return keywords.some(keyword => {
    const normalizedKeyword = normalizeZodiChatText(keyword);
    if (!normalizedKeyword) return false;
    if (normalizedText.includes(normalizedKeyword)) return true;
    return zodiChatPhraseMatches(textTokens, normalizedKeyword);
  });
}

function zodiChatWordCount(text = "") {
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

function createFreshZodiChatMemory() {
  return {
    lastTopic: "free",
    lastPrompt: "",
    lastReply: "",
    lastIntent: "statement",
    lastEntities: [],
    pendingQuestion: null,
    history: [],
    choiceCursor: {},
    updatedAt: Date.now()
  };
}

function getZodiChatMemory(userId) {
  if (!userId) return createFreshZodiChatMemory();
  const existing = zodiChatMemoryMap.get(userId);
  if (!existing) {
    const fresh = createFreshZodiChatMemory();
    zodiChatMemoryMap.set(userId, fresh);
    return fresh;
  }
  if ((Date.now() - (existing.updatedAt || 0)) > ZODI_CHAT_MEMORY_TTL_MS) {
    const fresh = createFreshZodiChatMemory();
    zodiChatMemoryMap.set(userId, fresh);
    return fresh;
  }
  if (!Array.isArray(existing.history)) existing.history = [];
  if (!existing.choiceCursor || typeof existing.choiceCursor !== "object") existing.choiceCursor = {};
  if (typeof existing.pendingQuestion === "undefined") existing.pendingQuestion = null;
  if (!Array.isArray(existing.lastEntities)) existing.lastEntities = [];
  return existing;
}

function pickZodiChatVariant(memory, key, variants) {
  if (!Array.isArray(variants) || !variants.length) return "";
  if (!memory.choiceCursor || typeof memory.choiceCursor !== "object") memory.choiceCursor = {};
  const previousIndex = Number(memory.choiceCursor[key]);
  const nextIndex = Number.isFinite(previousIndex) ? (previousIndex + 1) % variants.length : 0;
  memory.choiceCursor[key] = nextIndex;
  return variants[nextIndex];
}

function extractZodiChatEntities(text = "") {
  const defs = [
    { id: "minecraft", label: "Minecraft", topic: "games", keywords: ["minecraft", "nether", "end", "redstone", "creeper", "biome"] },
    { id: "pokemon", label: "Pokemon", topic: "games", keywords: ["pokemon", "pikachu", "pokeball", "pokeballs", "arene", "arene", "type"] },
    { id: "donjon", label: "le Donjon", topic: "games", keywords: ["donjon", "dungeon", "boss", "monstre", "monstres"] },
    { id: "zombie", label: "le mode zombie", topic: "games", keywords: ["zombie", "apocalypse", "infecte", "infectes", "survivant", "survivants"] },
    { id: "casino", label: "les jeux d'argent", topic: "games", keywords: ["roulette", "casino", "blackjack", "slot", "memocoin", "memocoins"] },
    { id: "discord", label: "Discord", topic: "ideas", keywords: ["discord", "serveur", "server", "salon", "salons", "role", "roles", "moderation"] },
    { id: "bot", label: "ton bot", topic: "ideas", keywords: ["bot", "commande", "commandes", "bouton", "boutons", "menu", "menus", "feature", "fonction", "fonctions"] },
    { id: "code", label: "le code", topic: "help", keywords: ["code", "script", "javascript", "node", "nodejs", "discordjs", "discord js", "fonctionne pas", "marche pas", "crash"] },
    { id: "bug", label: "le bug", topic: "help", keywords: ["bug", "erreur", "probleme", "problemes", "blocage", "bloque", "stack", "exception"] },
    { id: "organisation", label: "l'organisation", topic: "help", keywords: ["organisation", "planning", "priorite", "priorites", "retard", "temps", "procrastination"] },
    { id: "work", label: "le travail", topic: "mood", keywords: ["travail", "boulot", "job", "patron", "collegue", "collegues", "deadline"] },
    { id: "school", label: "les cours", topic: "mood", keywords: ["ecole", "cours", "examen", "examens", "devoir", "devoirs", "controle", "college", "lycee", "fac", "universite"] },
    { id: "relation", label: "une relation", topic: "mood", keywords: ["copine", "copain", "amour", "relation", "famille", "ami", "amis", "parent", "parents"] },
    { id: "stress", label: "le stress", topic: "mood", keywords: ["stress", "stresse", "angoisse", "pression", "anxieux", "anxieuse"] },
    { id: "sadness", label: "un coup de mou", topic: "mood", keywords: ["triste", "deprime", "deprimee", "vide", "mal", "seul", "seule", "pleure"] },
    { id: "fatigue", label: "la fatigue", topic: "mood", keywords: ["fatigue", "fatiguee", "epuise", "epuisee", "creve", "crevee"] }
  ];

  const out = [];
  for (const def of defs) {
    if (zodiChatIncludes(text, def.keywords)) out.push(def);
  }
  return out;
}

function hasZodiChatEntity(entities, id) {
  return Array.isArray(entities) && entities.some(entity => entity.id === id);
}

function detectZodiChatIntent(rawPrompt = "", text = "") {
  if (!text) return "empty";
  if (/^(oui|ouais|yes|ok|okay|d accord|daccord|vas y|go)\b/.test(text)) return "yes";
  if (/^(non|nan|nope|pas vraiment|bof)\b/.test(text)) return "no";
  if (zodiChatIncludes(text, ["merci", "thanks", "thx"])) return "thanks";
  if (zodiChatIncludes(text, ["bonjour", "salut", "hello", "coucou", "yo", "cc"])) return "greeting";
  if (zodiChatIncludes(text, ["encore", "continue", "developpe", "detaille", "developpe un peu", "vas plus loin"])) return "continue";
  if (zodiChatIncludes(text, ["je sais pas", "jsp", "aucune idee"])) return "uncertain";
  if (zodiChatIncludes(text, ["que faire", "quoi faire", "aide moi", "besoin d aide", "conseil", "tu ferais quoi"])) return "advice";
  if (rawPrompt.includes("?") || zodiChatIncludes(text, ["comment", "pourquoi", "quoi", "quel", "quelle", "quels", "quelles", "est ce que", "c est quoi"])) {
    return "question";
  }
  return "statement";
}

function isZodiContinuationMessage(text, intent, memory, entities) {
  if (!memory?.lastTopic) return false;
  if (["yes", "no", "continue", "uncertain"].includes(intent)) return true;
  if (zodiChatWordCount(text) <= 4 && (!entities || !entities.length)) return true;
  if (zodiChatIncludes(text, ["et toi", "pourquoi", "comment ca", "vas y", "ok", "d accord", "dac"])) return true;
  return false;
}

function detectZodiChatTopic(prompt = "", requestedTopic = "free", memory = null, intent = "statement", entities = []) {
  if (requestedTopic && requestedTopic !== "free") return requestedTopic;
  const text = normalizeZodiChatText(prompt);

  if (!text) return memory?.lastTopic || "free";
  if (memory?.pendingQuestion?.topic && !["greeting", "thanks"].includes(intent) && zodiChatWordCount(text) <= 12) {
    return memory.pendingQuestion.topic;
  }
  if (isZodiContinuationMessage(text, intent, memory, entities)) return memory?.lastTopic || "free";

  const scores = { free: 1, mood: 1, games: 1, ideas: 1, help: 1 };

  for (const entity of (entities || [])) {
    if (entity.topic === "mood") scores.mood += 3;
    if (entity.topic === "games") scores.games += 3;
    if (entity.topic === "ideas") scores.ideas += 2;
    if (entity.topic === "help") scores.help += 3;
    if (entity.id === "discord" || entity.id === "bot") {
      scores.ideas += 2;
      scores.help += 1;
    }
    if (entity.id === "work" || entity.id === "school") {
      scores.mood += 1;
      scores.help += 1;
    }
  }

  if (zodiChatIncludes(text, ["stress", "stresse", "angoisse", "triste", "fatigue", "fatiguee", "deprime", "deprimee", "moral", "heureux", "heureuse", "content", "contente", "colere", "anxieux", "anxieuse"])) {
    scores.mood += 3;
  }
  if (zodiChatIncludes(text, ["jeu", "jeux", "gaming", "minecraft", "pokemon", "donjon", "zombie", "roulette", "casino", "blackjack", "slot"])) {
    scores.games += 3;
  }
  if (zodiChatIncludes(text, ["idee", "projet", "creer", "creation", "concept", "imagine", "inventer", "ajouter", "ameliorer"])) {
    scores.ideas += 3;
  }
  if (zodiChatIncludes(text, ["aide", "help", "bug", "erreur", "probleme", "bloque", "blocage", "code", "dev", "organisation", "comment", "pourquoi", "marche pas", "fonctionne pas", "fix"])) {
    scores.help += 3;
  }
  if (zodiChatIncludes(text, ["avis", "parler", "discussion", "discuter"])) {
    scores.free += 2;
  }

  const orderedTopics = ["help", "mood", "games", "ideas", "free"];
  let bestTopic = "free";
  let bestScore = -Infinity;
  for (const topic of orderedTopics) {
    if (scores[topic] > bestScore) {
      bestScore = scores[topic];
      bestTopic = topic;
    }
  }

  if (bestScore <= 2 && memory?.lastTopic && zodiChatWordCount(text) <= 7) return memory.lastTopic;
  return bestTopic;
}

function getPrimaryZodiEntity(topic, entities) {
  if (!Array.isArray(entities) || !entities.length) return null;
  const sameTopic = entities.find(entity => entity.topic === topic);
  return sameTopic || entities[0] || null;
}

function extractZodiChoiceNumber(text = "") {
  if (/\b1\b|\bpremier\b|\bpremiere\b/.test(text)) return 1;
  if (/\b2\b|\bdeuxieme\b|\bseconde\b/.test(text)) return 2;
  if (/\b3\b|\btroisieme\b/.test(text)) return 3;
  return null;
}

function extractZodiQuestionSubject(text = "") {
  const normalized = normalizeZodiChatText(text);
  const patterns = [
    /^c est quoi (.+)$/,
    /^c quoi (.+)$/,
    /^qu est ce que (.+)$/,
    /^qui est (.+)$/,
    /^quel est (.+)$/,
    /^quelle est (.+)$/,
    /^comment (.+)$/,
    /^pourquoi (.+)$/
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function setZodiPendingQuestion(memory, topic, key, meta = {}) {
  memory.pendingQuestion = { topic, key, ...meta };
}

function getZodiOllamaHost() {
  let host = String(process.env.OLLAMA_HOST || "http://127.0.0.1:11434").trim();
  if (!host) host = "http://127.0.0.1:11434";
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
  return host.replace(/\/+$/, "");
}

function getZodiOllamaModel() {
  const model = String(process.env.OLLAMA_MODEL || "llama3.2:3b").trim();
  return model || "llama3.2:3b";
}

function getZodiOpenAIModel() {
  const configured = String(process.env.OPENAI_MODEL || "").trim();
  if (configured) return configured;
  if (isZodiOpenRouterConfig()) return "openai/gpt-5";
  return "gpt-5.5";
}

function isZodiOpenRouterConfig() {
  const key = String(process.env.OPENAI_API_KEY || "").trim();
  const base = String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || "").trim();
  return /^sk-or-/i.test(key) || /openrouter\.ai/i.test(base);
}

function getZodiOpenAIBaseUrl() {
  let base = String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE_URL || "").trim();
  if (!base && isZodiOpenRouterConfig()) base = "https://openrouter.ai/api/v1";
  if (!base) base = "https://api.openai.com/v1";
  if (!base) base = "https://api.openai.com/v1";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, "");
}

function isZodiOpenRouterBaseUrl(base = getZodiOpenAIBaseUrl()) {
  return /openrouter\.ai/i.test(String(base || ""));
}

function getZodiOpenAICandidateModels() {
  const primary = getZodiOpenAIModel();
  const models = [primary];
  if (isZodiOpenRouterBaseUrl()) {
    models.push("openrouter/free");
  }
  return [...new Set(models.filter(Boolean))];
}

function getZodiAiProvider() {
  const raw = String(process.env.ZODI_AI_PROVIDER || "").trim().toLowerCase();
  if (raw) return raw;
  return process.env.OPENAI_API_KEY ? "openai" : "ollama";
}

function shouldUseZodiOpenAI() {
  const provider = getZodiAiProvider();
  return Boolean(process.env.OPENAI_API_KEY) && !["ollama", "local", "offline", "none"].includes(provider);
}

function getZodiTimeZone() {
  return String(process.env.ZODI_TIME_ZONE || "Europe/Paris").trim() || "Europe/Paris";
}

function formatZodiDate(date, options = {}) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: getZodiTimeZone(),
    weekday: options.weekday === false ? undefined : "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: options.time ? "2-digit" : undefined,
    minute: options.time ? "2-digit" : undefined,
    second: options.seconds ? "2-digit" : undefined,
    hour12: false
  }).format(date);
}

function getCurrentParisYear() {
  const year = new Intl.DateTimeFormat("fr-FR", {
    timeZone: getZodiTimeZone(),
    year: "numeric"
  }).format(new Date());
  return Number(year) || new Date().getFullYear();
}

function getZodiCurrentDateContext() {
  return `Date actuelle (${getZodiTimeZone()}): ${formatZodiDate(new Date(), { time: true })}. Si l'utilisateur demande la date ou le jour, utilise cette date actuelle.`;
}

function createZodiDateFromParts(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function extractZodiDateFromPrompt(rawPrompt = "") {
  const raw = String(rawPrompt || "");
  const iso = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return createZodiDateFromParts(iso[3], iso[2], iso[1]);

  const numeric = raw.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (numeric) {
    let year = numeric[3] ? Number(numeric[3]) : getCurrentParisYear();
    if (year < 100) year += 2000;
    return createZodiDateFromParts(numeric[1], numeric[2], year);
  }

  const normalized = normalizeZodiChatText(raw);
  const months = {
    janvier: 1,
    fevrier: 2,
    mars: 3,
    avril: 4,
    mai: 5,
    juin: 6,
    juillet: 7,
    aout: 8,
    septembre: 9,
    octobre: 10,
    novembre: 11,
    decembre: 12
  };
  const monthNames = Object.keys(months).join("|");
  const named = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})(?:\\s+(\\d{2,4}))?\\b`));
  if (!named) return null;
  let year = named[3] ? Number(named[3]) : getCurrentParisYear();
  if (year < 100) year += 2000;
  return createZodiDateFromParts(named[1], months[named[2]], year);
}

function isZodiDateQuestion(signals) {
  const text = signals?.text || "";
  const raw = signals?.rawPrompt || "";
  if (zodiChatIncludes(text, [
    "on est quel jour",
    "quel jour on est",
    "quel jour sommes nous",
    "nous sommes quel jour",
    "quelle date",
    "date d aujourd hui",
    "aujourd hui on est quel jour",
    "aujourdhui on est quel jour",
    "c est quel jour aujourd hui"
  ])) return true;
  if (extractZodiDateFromPrompt(raw) && zodiChatIncludes(text, ["quel jour", "c est quel jour", "jour de la semaine", "tombe quel jour"])) return true;
  return false;
}

function buildZodiDateDirectAnswer(signals) {
  if (!isZodiDateQuestion(signals)) return null;
  const askedDate = extractZodiDateFromPrompt(signals.rawPrompt);
  if (askedDate) {
    return `Le ${formatZodiDate(askedDate, { weekday: false })} tombe un ${formatZodiDate(askedDate).split(" ")[0]}.`;
  }
  return `Aujourd'hui, on est ${formatZodiDate(new Date(), { time: true })}.`;
}

function getZodiTopicLabel(topic = "free") {
  return {
    free: "discussion generale",
    mood: "humeur et ressenti",
    games: "jeux",
    ideas: "idees et creation",
    help: "aide et probleme technique"
  }[topic] || "discussion generale";
}

function sanitizeZodiAssistantReply(text = "") {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function saveZodiChatExchange({ userId, memory, signals, replyText, pendingQuestion = null }) {
  memory.lastTopic = signals.topic || memory.lastTopic || "free";
  memory.lastPrompt = signals.rawPrompt.slice(0, 300);
  memory.lastReply = replyText.slice(0, 500);
  memory.lastIntent = signals.intent;
  memory.lastEntities = (signals.entities || []).map(entity => ({ id: entity.id, label: entity.label, topic: entity.topic }));
  memory.pendingQuestion = pendingQuestion || null;
  memory.updatedAt = Date.now();
  memory.history.push(
    { role: "user", text: signals.rawPrompt.slice(0, 300), topic: memory.lastTopic, intent: signals.intent },
    { role: "zodi", text: replyText.slice(0, 500), topic: memory.lastTopic, intent: "reply" }
  );
  if (memory.history.length > 12) memory.history = memory.history.slice(-12);
  zodiChatMemoryMap.set(userId, memory);
  return replyText;
}

function buildZodiOllamaSystemPrompt(signals) {
  const subjectLabel = signals.subject?.label ? `Sujet probable en cours: ${signals.subject.label}.` : "";
  const topicLabel = getZodiTopicLabel(signals.topic);
  return [
    "Tu es Zodi, un assistant de discussion integre a un bot Discord.",
    "Tu reponds en francais, de facon naturelle, simple, chaleureuse et directe.",
    "Les messages peuvent contenir beaucoup de fautes d'orthographe, de frappe ou d'ecriture phonetique: comprends l'intention avant de repondre.",
    "Ne reponds pas a cote. Si la question est claire, reponds d'abord a la question.",
    "Si l'utilisateur exprime un besoin, une demande ou un avis, reponds a ce contenu directement au lieu de lancer un questionnaire.",
    "Reste sur le sujet en cours. Si une precision manque, pose une seule question courte.",
    "Ne pose jamais plusieurs questions d'un coup.",
    "N'invente pas un fait technique ou une information precise si tu n'es pas sur.",
    getZodiCurrentDateContext(),
    "Fais des reponses plutot courtes a moyennes, sauf si l'utilisateur demande plus de detail.",
    "Evite les listes sauf si elles aident vraiment la comprehension.",
    `Theme probable: ${topicLabel}.`,
    subjectLabel
  ].filter(Boolean).join("\n");
}

function buildZodiOllamaUserPrompt(signals) {
  const lines = [
    `Message utilisateur: ${signals.rawPrompt}`
  ];
  if (signals.text) {
    lines.push(`Lecture approximative utile si le message contient des fautes: ${signals.text}`);
  }
  return lines.join("\n");
}

function buildZodiOllamaMessages(memory, signals) {
  const messages = [
    { role: "system", content: buildZodiOllamaSystemPrompt(signals) }
  ];
  const history = Array.isArray(memory?.history) ? memory.history.slice(-ZODI_OLLAMA_HISTORY_ITEMS) : [];
  for (const entry of history) {
    if (!entry?.text) continue;
    if (entry.role === "user") messages.push({ role: "user", content: String(entry.text) });
    if (entry.role === "zodi") messages.push({ role: "assistant", content: String(entry.text) });
  }
  messages.push({ role: "user", content: buildZodiOllamaUserPrompt(signals) });
  return messages;
}

function postZodiOllamaJson(route, payload) {
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(route, `${getZodiOllamaHost()}/`);
    } catch (e) {
      reject(e);
      return;
    }

    const client = targetUrl.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);
    const request = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search || ""}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        raw += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            const message = parsed?.error || parsed?.message || raw || `HTTP ${response.statusCode}`;
            return reject(new Error(String(message)));
          } catch (e) {
            return reject(new Error(raw || `HTTP ${response.statusCode}`));
          }
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(new Error(`Reponse Ollama invalide: ${e.message || e}`));
        }
      });
    });

    request.setTimeout(ZODI_OLLAMA_TIMEOUT_MS, () => {
      request.destroy(new Error("Ollama a mis trop de temps a repondre."));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function postZodiOpenAIJson(route, payload) {
  return new Promise((resolve, reject) => {
    if (!process.env.OPENAI_API_KEY) {
      reject(new Error("OPENAI_API_KEY manquant."));
      return;
    }

    let targetUrl;
    try {
      const cleanRoute = String(route || "").replace(/^\/+/, "");
      targetUrl = new URL(cleanRoute, `${getZodiOpenAIBaseUrl()}/`);
    } catch (e) {
      reject(e);
      return;
    }

    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    };
    if (process.env.OPENAI_ORG_ID) headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;
    if (process.env.OPENAI_PROJECT_ID) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT_ID;
    if (isZodiOpenRouterBaseUrl(targetUrl.href)) {
      headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL || "http://localhost:3000";
      headers["X-Title"] = process.env.OPENROUTER_APP_NAME || "ZodiBot";
    }

    const client = targetUrl.protocol === "http:" ? http : https;
    const request = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search || ""}`,
      method: "POST",
      headers
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        raw += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            const message = parsed?.error?.message || parsed?.error || parsed?.message || raw || `HTTP ${response.statusCode}`;
            return reject(new Error(String(message)));
          } catch (e) {
            return reject(new Error(raw || `HTTP ${response.statusCode}`));
          }
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(new Error(`Reponse OpenAI invalide: ${e.message || e}`));
        }
      });
    });

    request.setTimeout(ZODI_OPENAI_TIMEOUT_MS, () => {
      request.destroy(new Error("OpenAI a mis trop de temps a repondre."));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function extractZodiOpenAIResponsesText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) return response.output_text.trim();
  const chunks = [];
  for (const item of (response?.output || [])) {
    for (const content of (item?.content || [])) {
      if (typeof content?.text === "string") chunks.push(content.text);
      else if (typeof content?.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function buildZodiOpenAIInput(memory, signals) {
  const lines = [];
  const history = Array.isArray(memory?.history) ? memory.history.slice(-ZODI_OLLAMA_HISTORY_ITEMS) : [];
  for (const entry of history) {
    if (!entry?.text) continue;
    if (entry.role === "user") lines.push(`Utilisateur: ${entry.text}`);
    if (entry.role === "zodi") lines.push(`Zodi: ${entry.text}`);
  }
  lines.push(buildZodiOllamaUserPrompt(signals));
  return lines.join("\n\n");
}

async function buildZodiOpenAIResponsesReply(memory, signals, model = getZodiOpenAIModel()) {
  const payload = {
    model,
    instructions: buildZodiOllamaSystemPrompt(signals),
    input: buildZodiOpenAIInput(memory, signals),
    max_output_tokens: 260
  };
  const response = await postZodiOpenAIJson("responses", payload);
  const text = sanitizeZodiAssistantReply(extractZodiOpenAIResponsesText(response));
  if (!text) throw new Error("OpenAI a renvoye une reponse vide.");
  return text;
}

async function buildZodiOpenAIChatReply(memory, signals, model = getZodiOpenAIModel()) {
  const payload = {
    model,
    messages: buildZodiOllamaMessages(memory, signals),
    max_completion_tokens: 260
  };
  if (isZodiOpenRouterBaseUrl()) {
    payload.max_tokens = payload.max_completion_tokens;
    delete payload.max_completion_tokens;
  }
  const response = await postZodiOpenAIJson("chat/completions", payload);
  const text = sanitizeZodiAssistantReply(response?.choices?.[0]?.message?.content || "");
  if (!text) throw new Error("OpenAI chat a renvoye une reponse vide.");
  return text;
}

async function buildZodiOpenAIReply({ userId, prompt, requestedTopic = "free" }) {
  const memory = getZodiChatMemory(userId);
  const signals = buildZodiSignals({ prompt, requestedTopic, memory });
  let replyText = "";
  let lastError = null;
  for (const model of getZodiOpenAICandidateModels()) {
    try {
      if (!isZodiOpenRouterBaseUrl()) {
        try {
          replyText = await buildZodiOpenAIResponsesReply(memory, signals, model);
          break;
        } catch (responsesError) {
          lastError = responsesError;
          console.error("buildZodiOpenAIResponsesReply error:", responsesError?.message || responsesError);
        }
      }
      replyText = await buildZodiOpenAIChatReply(memory, signals, model);
      break;
    } catch (chatError) {
      lastError = chatError;
      console.error(`buildZodiOpenAIChatReply error (${model}):`, chatError?.message || chatError);
    }
  }
  if (!replyText) {
    throw lastError || new Error("OpenAI a renvoye une reponse vide.");
  }
  return saveZodiChatExchange({
    userId,
    memory,
    signals,
    replyText,
    pendingQuestion: buildZodiPendingQuestionFromReply(replyText, signals)
  });
}

function buildZodiPendingQuestionFromReply(replyText, signals) {
  if (!replyText || !replyText.includes("?")) return null;
  return { topic: signals.topic || "free", key: "ollama_followup" };
}

async function buildZodiOllamaReply({ userId, prompt, requestedTopic = "free" }) {
  const memory = getZodiChatMemory(userId);
  const signals = buildZodiSignals({ prompt, requestedTopic, memory });
  const response = await postZodiOllamaJson("/api/chat", {
    model: getZodiOllamaModel(),
    stream: false,
    messages: buildZodiOllamaMessages(memory, signals),
    options: {
      temperature: 0.35,
      num_predict: 220
    }
  });

  const replyText = sanitizeZodiAssistantReply(response?.message?.content || response?.response || "");
  if (!replyText) {
    throw new Error("Ollama a renvoye une reponse vide.");
  }

  return saveZodiChatExchange({
    userId,
    memory,
    signals,
    replyText,
    pendingQuestion: buildZodiPendingQuestionFromReply(replyText, signals)
  });
}

async function buildZodiChatReply({ userId, prompt, requestedTopic = "free" }) {
  const directMemory = getZodiChatMemory(userId);
  const directSignals = buildZodiSignals({ prompt, requestedTopic, memory: directMemory });
  const dateAnswer = buildZodiDateDirectAnswer(directSignals);
  if (dateAnswer) {
    return saveZodiChatExchange({
      userId,
      memory: directMemory,
      signals: directSignals,
      replyText: dateAnswer,
      pendingQuestion: null
    });
  }
  if (shouldUseZodiOpenAI()) {
    try {
      return await buildZodiOpenAIReply({ userId, prompt, requestedTopic });
    } catch (e) {
      console.error("buildZodiOpenAIReply error:", e?.message || e);
    }
  }
  try {
    return await buildZodiOllamaReply({ userId, prompt, requestedTopic });
  } catch (e) {
    console.error("buildZodiOllamaReply error:", e);
    return buildZodiLocalChatReply({ userId, prompt, requestedTopic });
  }
}

function buildZodiSignals({ prompt, requestedTopic = "free", memory }) {
  const rawPrompt = String(prompt || "").trim();
  const text = normalizeZodiChatText(rawPrompt);
  const entities = extractZodiChatEntities(text);
  const intent = detectZodiChatIntent(rawPrompt, text);
  const topic = detectZodiChatTopic(rawPrompt, requestedTopic, memory, intent, entities);
  const wordCount = zodiChatWordCount(text);

  return {
    rawPrompt,
    text,
    entities,
    intent,
    topic,
    wordCount,
    isShort: wordCount <= 6,
    mentionsWork: hasZodiChatEntity(entities, "work"),
    mentionsSchool: hasZodiChatEntity(entities, "school"),
    mentionsStress: hasZodiChatEntity(entities, "stress"),
    mentionsSadness: hasZodiChatEntity(entities, "sadness"),
    mentionsFatigue: hasZodiChatEntity(entities, "fatigue"),
    mentionsRelation: hasZodiChatEntity(entities, "relation"),
    mentionsCode: hasZodiChatEntity(entities, "code"),
    mentionsBug: hasZodiChatEntity(entities, "bug"),
    mentionsDiscord: hasZodiChatEntity(entities, "discord"),
    mentionsBot: hasZodiChatEntity(entities, "bot"),
    mentionsOrganisation: hasZodiChatEntity(entities, "organisation"),
    mentionsMinecraft: hasZodiChatEntity(entities, "minecraft"),
    mentionsPokemon: hasZodiChatEntity(entities, "pokemon"),
    mentionsDonjon: hasZodiChatEntity(entities, "donjon"),
    mentionsZombie: hasZodiChatEntity(entities, "zombie"),
    mentionsCasino: hasZodiChatEntity(entities, "casino"),
    subject: getPrimaryZodiEntity(topic, entities)
  };
}

function buildZodiDirectAnswer(signals, memory) {
  const text = signals.text;
  const hasPending = Boolean(memory?.pendingQuestion);
  const subject = extractZodiQuestionSubject(text);
  const dateAnswer = buildZodiDateDirectAnswer(signals);
  if (dateAnswer) {
    return {
      text: dateAnswer,
      pendingQuestion: null
    };
  }

  if (zodiChatIncludes(text, ["que peux tu faire", "que peu tu faire", "que peu tu fair", "tu peux faire quoi", "tu sers a quoi", "qu est ce que tu peux faire"])) {
    return {
      text: "Je peux discuter en local, repondre sur le bot, les boutons, Discord, les jeux du bot, et suivre une conversation courte sans API IA. Si je ne sais pas, je prefere te le dire franchement au lieu de repondre a cote.",
      pendingQuestion: null
    };
  }

  if (zodiChatIncludes(text, ["parler normalement", "arrete de repondre a cote", "reponds normalement", "est ce que tu peux parler normalement"])) {
    return {
      text: "Oui. Je vais essayer de repondre plus directement. Pose une question courte et precise, et si je ne sais pas y repondre proprement en local, je te le dirai clairement.",
      pendingQuestion: null
    };
  }

  if (zodiChatIncludes(text, ["comment ouvrir un modal", "ouvrir un modal", "ouvrire un modal", "showmodal"])) {
    return {
      text: "Pour ouvrir un modal Discord, il faut capter l'interaction du bouton, creer un `ModalBuilder`, y ajouter au moins un `TextInputBuilder`, puis appeler `interaction.showModal(modal)`. Si tu veux, je peux te guider sur le flux exact de ton bot.",
      pendingQuestion: { topic: "help", key: "help_goal_issue" }
    };
  }

  if (zodiChatIncludes(text, ["comment corriger un bouton discord", "corriger un bouton", "bouton discord"])) {
    return {
      text: "Pour corriger un bouton Discord, verifie d'abord 4 choses: son `customId`, l'endroit ou ce `customId` est ecoute, l'action lancee (`update`, `reply` ou `showModal`), et ce qui se passe si l'interaction est deja deferree. Si tu veux, donne-moi le bouton exact et je reste dessus.",
      pendingQuestion: { topic: "help", key: "help_location" }
    };
  }

  if (zodiChatIncludes(text, ["c'est quoi minecraft", "c est quoi minecraft", "c quoi minecraft", "minecraft c'est quoi", "minecraft c est quoi", "minecraft c quoi", "qu'est ce que minecraft", "qu est ce que minecraft"])) {
    return {
      text: "Minecraft est un jeu bac a sable de survie et de construction. Tu peux y explorer, miner, fabriquer, combattre, construire une base et progresser jusqu'au Nether puis a l'End.",
      pendingQuestion: null
    };
  }

  if (zodiChatIncludes(text, ["c'est quoi pokemon", "c est quoi pokemon", "c quoi pokemon", "pokemon c'est quoi", "pokemon c est quoi", "pokemon c quoi", "qu'est ce que pokemon", "qu est ce que pokemon"])) {
    return {
      text: "Pokemon est un univers de creatures a capturer, entrainer et faire combattre. Selon le jeu, tu explores, constitues une equipe et joues autour des types, des attaques et de la progression.",
      pendingQuestion: null
    };
  }

  if (signals.mentionsCasino && zodiChatIncludes(text, ["comment gagner", "gagner a la roulette", "gagner roulette"])) {
    return {
      text: "Tu ne peux pas garantir de gagner a la roulette. Le plus safe, c'est de miser petit, fixer une limite de perte, et accepter qu'il y a toujours du hasard. Si tu veux, je peux te parler gestion du risque plutot que promesse de gain.",
      pendingQuestion: { topic: "games", key: "games_focus", gameId: "casino" }
    };
  }

  if (zodiChatIncludes(text, ["pourquoi je suis triste", "pourquoi je me sens triste", "pourquoi je vais mal"])) {
    return {
      text: "Je ne peux pas savoir exactement pourquoi tu es triste juste avec une phrase, mais ca vient souvent d'un melange de fatigue, stress, solitude, deception ou accumulation. Si tu veux, dis-moi ce qui a change ces derniers jours et on regarde ca ensemble sans partir ailleurs.",
      pendingQuestion: { topic: "mood", key: "mood_stress_cause" }
    };
  }

  if (zodiChatIncludes(text, ["capitale de la france", "quelle est la capitale de la france"])) {
    return {
      text: "La capitale de la France, c'est Paris.",
      pendingQuestion: null
    };
  }

  if (!hasPending && signals.intent === "question" && subject) {
    if (text.startsWith("c est quoi ") || text.startsWith("qu est ce que ")) {
      return {
        text: `Je comprends que tu me demandes ce qu'est "${subject}", mais en mode local je n'ai pas une connaissance generale fiable sur tous les sujets. Si c'est lie au bot, a Discord, au code, aux jeux du bot ou a ce que tu ressens, je peux etre beaucoup plus utile.`,
        pendingQuestion: null
      };
    }
    if (text.startsWith("qui est ")) {
      return {
        text: `Je comprends que tu me demandes qui est "${subject}", mais je n'ai pas de vraie base de connaissances generale en mode local. Sur des sujets du bot, du code ou de Discord, je peux repondre plus directement.`,
        pendingQuestion: null
      };
    }
    if (text.startsWith("comment ")) {
      return {
        text: `Je comprends que tu veux savoir comment "${subject}". Si c'est sur le bot, Discord ou du code, donne-moi le contexte exact et je repondrai concretement. Sinon, en mode local, je prefere te dire que je ne sais pas plutot que repondre a cote.`,
        pendingQuestion: null
      };
    }
    if (text.startsWith("pourquoi ")) {
      return {
        text: `Je comprends que tu te demandes pourquoi "${subject}". En mode local, je ne peux pas toujours expliquer correctement tous les sujets. Si tu me donnes un contexte lie au bot, a un probleme concret ou a ce que tu ressens, je pourrai mieux suivre.`,
        pendingQuestion: null
      };
    }
  }

  if (!hasPending && signals.intent === "question") {
    return {
      text: "Je ne sais pas repondre proprement a cette question en local. Je prefere te le dire plutot que de partir a cote. Si tu veux, pose-moi une question sur le bot, Discord, les jeux ici, ou ce que tu ressens, et je repondrai plus directement.",
      pendingQuestion: null
    };
  }

  return null;
}

function buildZodiSocialReply(signals, memory) {
  if (signals.intent === "greeting" && signals.wordCount <= 4) {
    const suffix = memory.lastTopic && memory.lastTopic !== "free"
      ? ` On peut reprendre sur ${getPrimaryZodiEntity(memory.lastTopic, memory.lastEntities || [])?.label || "ce sujet"} si tu veux.`
      : " Dis-moi simplement ce que tu veux raconter et je te suis.";
    return {
      text: pickZodiChatVariant(memory, "social_greeting", [
        "Salut. Je suis la et je te suis dans la discussion.",
        "Salut, vas-y. Dis-moi ce que tu as en tete.",
        "Coucou. On peut parler tranquillement."
      ]) + suffix,
      pendingQuestion: null
    };
  }

  if (signals.intent === "thanks" && signals.wordCount <= 5) {
    const suffix = memory.lastTopic && memory.lastTopic !== "free"
      ? " Si tu veux, on peut continuer exactement sur le meme sujet."
      : " Si tu veux continuer, envoie juste la suite.";
    return {
      text: pickZodiChatVariant(memory, "social_thanks", [
        "Avec plaisir.",
        "Pas de souci.",
        "Je t'en prie."
      ]) + suffix,
      pendingQuestion: memory.pendingQuestion || null
    };
  }

  return null;
}

function buildZodiFreeReply(signals, memory) {
  if (!signals.text) {
    return {
      text: pickZodiChatVariant(memory, "free_empty", [
        "Je suis la. Ecris-moi juste ce que tu veux dire, et je te repondrai en restant sur ton sujet.",
        "Vas-y simplement avec ton message. Je suivrai ce que tu me dis au lieu de changer de sujet.",
        "Tu peux ecrire naturellement. Je m'adapterai a ce dont tu parles."
      ]),
      pendingQuestion: null
    };
  }

  if (zodiChatIncludes(signals.text, ["qui es tu", "t es qui", "tu es qui"])) {
    return {
      text: "Je suis Zodi en mode local. Je n'utilise pas d'API ici, donc je fonctionne avec une memoire courte de la conversation et des reponses guidees pour rester dans le sujet.",
      pendingQuestion: null
    };
  }

  if (zodiChatIncludes(signals.text, ["je m ennuie", "ennuie", "bored"])) {
    return {
      text: pickZodiChatVariant(memory, "free_bored", [
        "Alors on lance un vrai sujet. Tu prefères parler d'un probleme concret, d'une idee, d'un jeu, ou juste vider ce que tu as en tete ?",
        "On peut rendre ca utile. Dis-moi si tu veux un avis, une idee, ou juste une discussion tranquille sur ce que tu penses.",
        "Pas grave. Donne-moi juste le sujet que tu as envie d'ouvrir, meme en une phrase."
      ]),
      pendingQuestion: { topic: "free", key: "free_need" }
    };
  }

  if (memory.pendingQuestion?.topic === "free" && memory.pendingQuestion.key === "free_need") {
    return {
      text: "D'accord. Dis-moi maintenant le sujet exact, ou le point principal qui tourne dans ta tete, et je resterai dessus.",
      pendingQuestion: { topic: "free", key: "free_subject" }
    };
  }

  if (memory.pendingQuestion?.topic === "free" && memory.pendingQuestion.key === "free_subject" && signals.rawPrompt) {
    return {
      text: `Je reste donc sur "${signals.rawPrompt.slice(0, 90)}". Tu veux que je te donne plutot un avis, une idee, ou une aide concrete sur ce point ?`,
      pendingQuestion: { topic: "free", key: "free_need" }
    };
  }

  return {
    text: pickZodiChatVariant(memory, "free_generic", [
      "Je te suis. Pour que je reponde juste, donne-moi soit la situation precise, soit la question exacte que tu as.",
      "Je peux te suivre sur ce sujet. Dis-moi juste ce que tu veux de moi: un avis, une idee, ou une aide concrete.",
      "Reste sur ce que tu veux vraiment aborder, et je resterai dessus aussi. Quelle est la question ou la situation exacte ?"
    ]),
    pendingQuestion: { topic: "free", key: "free_subject" }
  };
}

function buildZodiMoodReply(signals, memory) {
  const pending = memory.pendingQuestion;
  const subjectLabel = signals.subject?.label || (signals.mentionsWork ? "le travail" : signals.mentionsSchool ? "les cours" : signals.mentionsRelation ? "ta relation" : "ce qui te pese");
  const mentionsDeadline = zodiChatIncludes(signals.text, ["deadline", "retard", "urgence", "date", "demain", "avant"]);
  const mentionsPeople = zodiChatIncludes(signals.text, ["patron", "prof", "collegue", "parent", "parents", "ami", "amis", "copain", "copine", "quelqu un", "personne", "gens"]);
  const mentionsOverload = zodiChatIncludes(signals.text, ["trop", "beaucoup", "plein", "charge", "submerge", "deborde", "debordee"]);

  if (pending?.topic === "mood") {
    if (pending.key === "mood_stress_cause") {
      if (mentionsDeadline) {
        return {
          text: `Si la pression vient surtout d'une echeance, on va la rendre plus petite. Le plus utile maintenant, c'est d'identifier le tout premier livrable a sortir. C'est quoi la premiere chose concrète que tu dois finir ?`,
          pendingQuestion: { topic: "mood", key: "mood_first_task" }
        };
      }
      if (mentionsPeople) {
        return {
          text: `Si ${subjectLabel} te pese a cause d'une personne, le plus important est souvent de clarifier ce que tu acceptes ou non. Tu veux plutot que je t'aide a formuler quoi dire, ou a prendre un peu de recul avant d'en parler ?`,
          pendingQuestion: { topic: "mood", key: "mood_people_plan" }
        };
      }
      if (mentionsOverload || signals.mentionsWork || signals.mentionsSchool) {
        return {
          text: `Quand ${subjectLabel} devient trop lourd, il faut d'abord trier au lieu de tout porter en meme temps. Si tu veux, envoie-moi les 3 choses qui te stressent le plus et je t'aide a les remettre dans l'ordre.`,
          pendingQuestion: { topic: "mood", key: "mood_top_three" }
        };
      }
      return {
        text: `Je comprends mieux. Sur ${subjectLabel}, tu veux plutot qu'on parle pour vider tout ca, ou qu'on cherche une petite action concrete pour aujourd'hui ?`,
        pendingQuestion: { topic: "mood", key: "mood_action_or_talk" }
      };
    }

    if (pending.key === "mood_action_or_talk") {
      if (signals.intent === "yes" || zodiChatIncludes(signals.text, ["action", "solution", "plan", "concret"])) {
        return {
          text: "Parfait. Donne-moi juste la chose numero 1 qui te pèse le plus, et je te proposerai une petite etape realiste pour aujourd'hui.",
          pendingQuestion: { topic: "mood", key: "mood_first_task" }
        };
      }
      if (signals.intent === "no" || zodiChatIncludes(signals.text, ["parler", "discuter", "vider", "juste parler"])) {
        return {
          text: "Pas de souci. Alors reste sur ce que tu ressens. Qu'est-ce qui te fait le plus mal ou le plus peur dans cette histoire ?",
          pendingQuestion: { topic: "mood", key: "mood_open_talk" }
        };
      }
    }

    if (pending.key === "mood_first_task" && signals.rawPrompt) {
      return {
        text: `D'accord, on se concentre sur "${signals.rawPrompt.slice(0, 90)}". Le but n'est pas de tout regler d'un coup: choisis juste une sous-etape de 5 a 10 minutes. Si tu veux, ecris-la ici et je t'aide a la rendre plus simple.`,
        pendingQuestion: { topic: "mood", key: "mood_micro_step" }
      };
    }

    if (pending.key === "mood_top_three" && signals.rawPrompt) {
      return {
        text: `Merci, c'est deja plus clair. Maintenant prends seulement celle qui aurait le plus d'impact si elle avancait un peu aujourd'hui, meme tres peu. Laquelle c'est ?`,
        pendingQuestion: { topic: "mood", key: "mood_first_task" }
      };
    }

    if (pending.key === "mood_people_plan") {
      if (signals.intent === "yes" || zodiChatIncludes(signals.text, ["formuler", "parler", "dire", "message"])) {
        return {
          text: "D'accord. Dis-moi en une phrase ce que tu aimerais reussir a dire a cette personne, et je t'aide a le formuler plus calmement.",
          pendingQuestion: { topic: "mood", key: "mood_people_words" }
        };
      }
      return {
        text: "Pas de souci. Alors dis-moi plutot ce qui te fait le plus peur dans cette situation avec cette personne, et on reste sur ca.",
        pendingQuestion: { topic: "mood", key: "mood_open_talk" }
      };
    }

    if (pending.key === "mood_open_talk" && signals.rawPrompt) {
      return {
        text: `Je t'entends. Sur "${signals.rawPrompt.slice(0, 90)}", qu'est-ce qui te fait le plus mal: la peur de ce qui arrive, la fatigue que ca te donne, ou le sentiment de ne plus controler grand-chose ?`,
        pendingQuestion: { topic: "mood", key: "mood_stress_cause" }
      };
    }

    if (pending.key === "mood_micro_step" && signals.rawPrompt) {
      return {
        text: `Oui, cette mini-etape me semble deja plus realiste. Le bon objectif maintenant, c'est juste de la commencer sans chercher a tout regler. Tu veux que je t'aide a la reduire encore, ou ca te parait assez simple comme ca ?`,
        pendingQuestion: { topic: "mood", key: "mood_action_or_talk" }
      };
    }

    if (pending.key === "mood_channel_energy" && signals.rawPrompt) {
      return {
        text: `Parfait. Si tu veux utiliser cette energie pour "${signals.rawPrompt.slice(0, 90)}", on peut la transformer en objectif concret. C'est quoi la premiere chose visible que tu aimerais faire avancer ?`,
        pendingQuestion: { topic: "mood", key: "mood_first_task" }
      };
    }
  }

  if (signals.mentionsStress || zodiChatIncludes(signals.text, ["peur", "pression"])) {
    return {
      text: `Je vois que ${subjectLabel} te met sous pression. Pour que je ne reponde pas a cote, dis-moi ce qui pese le plus: une echeance, trop de choses a gerer en meme temps, ou une personne en particulier ?`,
      pendingQuestion: { topic: "mood", key: "mood_stress_cause" }
    };
  }

  if (signals.mentionsSadness || zodiChatIncludes(signals.text, ["moral", "vide"])) {
    return {
      text: "Je comprends. On peut prendre ca doucement. Tu veux plutot en parler pour vider ce que tu as sur le coeur, ou tu prefères qu'on cherche une petite chose concrete pour t'aider a tenir aujourd'hui ?",
      pendingQuestion: { topic: "mood", key: "mood_action_or_talk" }
    };
  }

  if (signals.mentionsFatigue) {
    return {
      text: `Si c'est surtout de la fatigue, je prefere rester sur ca. C'est plutot un manque de sommeil, trop de charge avec ${subjectLabel}, ou une fatigue mentale qui ne descend jamais ?`,
      pendingQuestion: { topic: "mood", key: "mood_stress_cause" }
    };
  }

  if (zodiChatIncludes(signals.text, ["heureux", "heureuse", "content", "contente", "bien", "motive", "motivee"])) {
    return {
      text: "Ca fait plaisir a lire. Tu veux utiliser cette bonne energie pour quoi exactement: avancer sur un projet, prendre une decision, ou juste partager ce qui te fait du bien ?",
      pendingQuestion: { topic: "mood", key: "mood_channel_energy" }
    };
  }

  return {
    text: "Parle-moi franchement de ce que tu ressens, et je resterai dessus. C'est plutot du stress, de la fatigue, un coup de mou, ou quelque chose de relationnel ?",
    pendingQuestion: { topic: "mood", key: "mood_stress_cause" }
  };
}

function buildZodiGamesReply(signals, memory) {
  const pending = memory.pendingQuestion;

  if (pending?.topic === "games" && pending.key === "games_focus") {
    if (pending.gameId === "minecraft") {
      if (zodiChatIncludes(signals.text, ["survie", "ressource", "ressources", "stuff", "progression"])) {
        return {
          text: "Pour Minecraft en survie, le plus rentable est souvent de securiser nourriture, outils, lit et abri avant de courir partout. Tu veux que je te fasse un mini plan debut de partie, ou tu es deja plus loin que ca ?",
          pendingQuestion: { topic: "games", key: "games_minecraft_stage", gameId: "minecraft" }
        };
      }
      if (zodiChatIncludes(signals.text, ["build", "base", "maison", "construction"])) {
        return {
          text: "Si tu parles build, commence par choisir une ambiance avant les details: cosy, medievale, sombre, moderne ou nature. Si tu veux, donne-moi le biome et je te propose une direction plus precise.",
          pendingQuestion: { topic: "games", key: "games_minecraft_biome", gameId: "minecraft" }
        };
      }
      if (zodiChatIncludes(signals.text, ["nether", "end", "dragon"])) {
        return {
          text: "Pour la progression Minecraft, le plus important est de ne pas sauter d'etape. Dis-moi si tu es au stade portail du Nether, blaze rods, Endermen, ou preparation du dragon, et je te repondrai sur ce point precis.",
          pendingQuestion: { topic: "games", key: "games_minecraft_stage", gameId: "minecraft" }
        };
      }
      return {
        text: "Sur Minecraft, on peut rester precis. Tu veux parler survie, build, progression, Nether/End, ou ressources ?",
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "minecraft" }
      };
    }

    if (pending.gameId === "pokemon") {
      if (zodiChatIncludes(signals.text, ["equipe", "team", "type", "combat"])) {
        return {
          text: "Pour Pokemon, une equipe tient mieux quand tu couvres les faiblesses avant de chercher juste les plus gros degats. Si tu veux, donne-moi 2 ou 3 Pokemon que tu aimes et je t'aide a construire autour.",
          pendingQuestion: { topic: "games", key: "games_pokemon_team", gameId: "pokemon" }
        };
      }
      if (zodiChatIncludes(signals.text, ["capture", "shiny", "legendaire"])) {
        return {
          text: "D'accord, on reste sur la capture. Dis-moi juste ce que tu cherches exactement, et je me cale sur ce point-la au lieu de partir ailleurs.",
          pendingQuestion: { topic: "games", key: "games_pokemon_capture", gameId: "pokemon" }
        };
      }
      return {
        text: "Pour Pokemon, tu veux rester sur une equipe, un combat, une capture, ou un conseil general de progression ?",
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "pokemon" }
      };
    }

    if (pending.gameId === "donjon") {
      return {
        text: "Pour le Donjon, dis-moi si tu veux parler preparation, combat, recompenses, ou gestion du risque. Je resterai sur ce point-la.",
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "donjon" }
      };
    }

    if (pending.gameId === "zombie") {
      return {
        text: "Pour le mode zombie, on peut rester soit sur la survie immediate, soit sur la base, soit sur les ressources. Tu veux lequel ?",
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "zombie" }
      };
    }

    if (pending.key === "games_minecraft_stage" && signals.rawPrompt) {
      return {
        text: `D'accord, on reste sur cette etape Minecraft: "${signals.rawPrompt.slice(0, 90)}". Si tu veux une reponse utile, dis-moi juste ou tu bloques: preparation, ressources, combat, ou orientation ?`,
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "minecraft" }
      };
    }

    if (pending.key === "games_minecraft_biome" && signals.rawPrompt) {
      return {
        text: `Pour ce biome ou cette ambiance, le mieux est de choisir 2 ou 3 materiaux dominants et de tenir une silhouette simple au debut. Si tu veux, decris-moi le biome ou la vibe en une phrase et je te propose une palette.`,
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "minecraft" }
      };
    }

    if (pending.key === "games_pokemon_team" && signals.rawPrompt) {
      return {
        text: `OK, on reste sur ton equipe Pokemon. Envoie-moi les Pokemon que tu veux garder, meme si ce n'est pas optimise, et je te dirai surtout ce qu'il manque autour.`,
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "pokemon" }
      };
    }

    if (pending.key === "games_pokemon_capture" && signals.rawPrompt) {
      return {
        text: `D'accord, on garde le sujet capture. Dis-moi maintenant la cible ou le type de capture que tu veux, et je resterai la-dessus.`,
        pendingQuestion: { topic: "games", key: "games_focus", gameId: "pokemon" }
      };
    }
  }

  if (signals.mentionsMinecraft) {
    return {
      text: "On reste sur Minecraft. Tu veux parler survie, build, progression, Nether/End, ou ressources ?",
      pendingQuestion: { topic: "games", key: "games_focus", gameId: "minecraft" }
    };
  }

  if (signals.mentionsPokemon) {
    return {
      text: "On reste sur Pokemon. Tu veux parler equipe, combat, capture, ou progression ?",
      pendingQuestion: { topic: "games", key: "games_focus", gameId: "pokemon" }
    };
  }

  if (signals.mentionsDonjon) {
    return {
      text: "Pour le Donjon, tu veux parler preparation, combat, recompenses, ou progression ?",
      pendingQuestion: { topic: "games", key: "games_focus", gameId: "donjon" }
    };
  }

  if (signals.mentionsZombie) {
    return {
      text: "Pour le mode zombie, tu veux qu'on reste sur la survie, la base, les ressources, ou la strategie generale ?",
      pendingQuestion: { topic: "games", key: "games_focus", gameId: "zombie" }
    };
  }

  if (signals.mentionsCasino) {
    return {
      text: "Pour les jeux d'argent du bot, le plus utile c'est de choisir si tu veux parler gestion des Memocoins, choix du jeu, ou prise de risque. Lequel t'interesse ?",
      pendingQuestion: { topic: "games", key: "games_focus", gameId: "casino" }
    };
  }

  return {
    text: "Dis-moi juste le jeu et ce que tu veux travailler dedans, et je resterai sur ce point precis.",
    pendingQuestion: { topic: "games", key: "games_focus", gameId: null }
  };
}

function buildZodiIdeasReply(signals, memory) {
  const pending = memory.pendingQuestion;
  const choice = extractZodiChoiceNumber(signals.text);

  if (pending?.topic === "ideas" && pending.key === "ideas_choice") {
    if (choice === 1) {
      return {
        text: "Si tu prends l'idee 1, commence petit: un systeme simple, une recompense claire, et un affichage propre. Le plus important au debut, c'est d'avoir une boucle fun avant d'ajouter plein d'options. Tu veux que je te dise comment la structurer ?",
        pendingQuestion: { topic: "ideas", key: "ideas_expand_one" }
      };
    }
    if (choice === 2) {
      return {
        text: "Si tu prends l'idee 2, pense-la comme un truc qui surprend sans casser le rythme. Le bon debut, c'est un evenement court, lisible, et avec une consequence claire. Si tu veux, je peux te proposer une premiere version concrete.",
        pendingQuestion: { topic: "ideas", key: "ideas_expand_two" }
      };
    }
    if (choice === 3) {
      return {
        text: "Si tu prends l'idee 3, le plus important est de rendre la discussion simple, directe et naturelle. Il faut un point d'entree facile, une memoire courte, et des relances qui suivent le sujet. Si tu veux, je peux te donner une version plus detaillee.",
        pendingQuestion: { topic: "ideas", key: "ideas_expand_three" }
      };
    }
  }

  if (pending?.topic === "ideas" && pending.key === "ideas_theme" && signals.rawPrompt) {
    return {
      text:
        `Pour "${signals.rawPrompt.slice(0, 90)}", je te propose ce trio de depart :\n` +
        "1. Une version simple a tester vite.\n" +
        "2. Une version plus surprenante pour marquer les gens.\n" +
        "3. Une version plus profonde pour durer dans le temps.\n" +
        "Dis-moi 1, 2 ou 3 et je la detaille.",
      pendingQuestion: { topic: "ideas", key: "ideas_choice" }
    };
  }

  if (pending?.topic === "ideas" && (pending.key === "ideas_expand_one" || pending.key === "ideas_expand_two" || pending.key === "ideas_expand_three")) {
    if (signals.intent === "yes" || zodiChatIncludes(signals.text, ["oui", "vas y", "detaille", "developpe"])) {
      return {
        text: "D'accord. Pour garder ca propre, commence par le coeur du concept, ajoute ensuite une seule variation interessante, puis seulement apres les details visuels ou les bonus. Si tu veux, donne-moi la place exacte ou tu veux l'utiliser et je te ferai une version plus ciblee.",
        pendingQuestion: { topic: "ideas", key: "ideas_theme" }
      };
    }
  }

  if (signals.mentionsBot || signals.mentionsDiscord) {
    return {
      text:
        "Pour ton bot ou ton serveur, voila 3 pistes plus vivantes :\n" +
        "1. Un systeme de quetes courtes avec choix et petites consequences.\n" +
        "2. Des evenements aleatoires qui changent l'ambiance ou les gains pendant un moment.\n" +
        "3. Un espace de discussion Zodi qui garde le fil d'une conversation au lieu de repondre en boucle.\n" +
        "Dis-moi laquelle t'attire le plus et je la developpe.",
      pendingQuestion: { topic: "ideas", key: "ideas_choice" }
    };
  }

  return {
    text: "Je peux brainstormer proprement avec toi. Donne-moi juste le theme exact et le style que tu veux, et je te proposerai des idees qui restent sur ce sujet.",
    pendingQuestion: { topic: "ideas", key: "ideas_theme" }
  };
}

function buildZodiHelpReply(signals, memory) {
  const pending = memory.pendingQuestion;

  if (pending?.topic === "help") {
    if (pending.key === "help_goal_issue" && signals.rawPrompt) {
      return {
        text: `D'accord, je garde le fil. Pour "${signals.rawPrompt.slice(0, 100)}", il me faut maintenant soit le message d'erreur exact, soit ce qui se passe a la place de ce que tu attendais.`,
        pendingQuestion: { topic: "help", key: "help_error_or_behavior" }
      };
    }

    if (pending.key === "help_error_or_behavior") {
      if (zodiChatIncludes(signals.text, ["aucune erreur", "pas d erreur", "rien", "rien du tout"])) {
        return {
          text: "S'il n'y a pas d'erreur visible, on reste sur le comportement. Dis-moi le point exact qui ne reagit pas: un bouton, une commande, un menu, ou autre ?",
          pendingQuestion: { topic: "help", key: "help_location" }
        };
      }
      if (zodiChatIncludes(signals.text, ["bouton", "button"])) {
        return {
          text: "Pour un bouton qui repond mal, regarde d'abord si son `customId` est bien ecoute au bon endroit, puis si l'interaction fait vraiment un `update`, `reply` ou `showModal`. Si tu veux, donne-moi l'ID du bouton ou le bloc concerne.",
          pendingQuestion: { topic: "help", key: "help_location" }
        };
      }
      if (zodiChatIncludes(signals.text, ["commande", "commandes"])) {
        return {
          text: "Pour une commande, le plus utile est de verifier ou elle entre dans ton flux: reception, condition, execution, puis reponse. Si tu veux, donne-moi la commande exacte et ce qui ne se passe pas comme prevu.",
          pendingQuestion: { topic: "help", key: "help_location" }
        };
      }
      return {
        text: "On se rapproche. Si tu peux, donne-moi maintenant le fichier, le bouton, la commande ou le bloc exact qui pose probleme. Comme ca je reste sur la bonne zone.",
        pendingQuestion: { topic: "help", key: "help_location" }
      };
    }

    if (pending.key === "help_location" && signals.rawPrompt) {
      return {
        text: `Parfait, on verrouille cette zone: "${signals.rawPrompt.slice(0, 90)}". A partir de la, le plus utile est de verifier l'entree, puis la condition, puis la reponse finale. Si tu veux continuer, envoie-moi soit le nom du fichier exact, soit le comportement precis observe a cet endroit.`,
        pendingQuestion: { topic: "help", key: "help_error_or_behavior" }
      };
    }
  }

  if (signals.mentionsCode || signals.mentionsBug || signals.mentionsBot || signals.mentionsDiscord) {
    if (zodiChatIncludes(signals.text, ["bouton", "button", "menu"])) {
      return {
        text: "Si ton souci est autour d'un bouton ou d'un menu, je prefere rester sur ce point precis. Dis-moi simplement ce que tu voulais qu'il fasse, puis ce qu'il fait a la place.",
        pendingQuestion: { topic: "help", key: "help_goal_issue" }
      };
    }
    return {
      text: "Pour t'aider sans repondre a cote, j'ai besoin de deux choses: ce que tu voulais faire exactement, puis ce qui se passe a la place. Ensuite je resterai sur ce point-la.",
      pendingQuestion: { topic: "help", key: "help_goal_issue" }
    };
  }

  if (signals.mentionsOrganisation || signals.mentionsWork || signals.mentionsSchool) {
    return {
      text: "Si ton blocage est surtout dans l'organisation, donne-moi l'objectif a atteindre et ce qui te bloque juste avant de t'y mettre. Je te le decouperai sans partir ailleurs.",
      pendingQuestion: { topic: "help", key: "help_goal_issue" }
    };
  }

  return {
    text: "Explique-moi le probleme le plus simplement possible: ce que tu veux faire, puis ce qui bloque. Avec ca, je peux rester sur le bon sujet.",
    pendingQuestion: { topic: "help", key: "help_goal_issue" }
  };
}

function buildZodiLocalChatReply({ userId, prompt, requestedTopic = "free" }) {
  const memory = getZodiChatMemory(userId);
  const signals = buildZodiSignals({ prompt, requestedTopic, memory });

  const socialReply = buildZodiSocialReply(signals, memory);
  const directReply = socialReply ? null : buildZodiDirectAnswer(signals, memory);
  let replyData = socialReply || directReply;

  if (!replyData) {
    if (signals.topic === "mood") replyData = buildZodiMoodReply(signals, memory);
    else if (signals.topic === "games") replyData = buildZodiGamesReply(signals, memory);
    else if (signals.topic === "ideas") replyData = buildZodiIdeasReply(signals, memory);
    else if (signals.topic === "help") replyData = buildZodiHelpReply(signals, memory);
    else replyData = buildZodiFreeReply(signals, memory);
  }

  const replyText = String(replyData?.text || "").trim() || "Je suis la. Redis-moi juste ton point principal, et je resterai dessus.";
  const pendingQuestion = Object.prototype.hasOwnProperty.call(replyData || {}, "pendingQuestion")
    ? replyData.pendingQuestion
    : null;
  return saveZodiChatExchange({ userId, memory, signals, replyText, pendingQuestion });
}

function isReplitRuntime() {
  return Boolean(process.env.REPL_ID || process.env.REPL_SLUG || process.env.REPLIT || process.env.REPL_OWNER);
}

function isPm2Runtime() {
  return Boolean(process.env.pm_id || process.env.PM2_HOME);
}

function runShell(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message || String(error)));
      resolve({ stdout, stderr });
    });
  });
}

async function stopBotViaPm2() {
  try { saveData(); } catch (e) { console.error("saveData error:", e); }
  try { savePresence(); } catch (e) { console.error("savePresence error:", e); }
  if (isReplitRuntime()) {
    gracefulSaveAndExit(0);
    return;
  }
  if (isPm2Runtime()) {
    await runShell("npx pm2 stop zodibot");
    return;
  }
  gracefulSaveAndExit(0);
}

async function restartBotLocal() {
  const helper = path.join(__dirname, "tools", "restart.js");
  try {
    const child = spawn(process.execPath, [helper], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ZODI_RESTART_TARGET: path.join(__dirname, "index.js") }
    });
    child.unref();
  } catch (e) {
    console.error("restartBotLocal error:", e);
  }
}

async function triggerRestart() {
  try { saveData(); } catch (e) {}
  try { savePresence(); } catch (e) {}
  if (isReplitRuntime()) {
    gracefulSaveAndExit(1);
    return;
  }
  if (isPm2Runtime()) {
    try { await runShell("npx pm2 restart zodibot"); } catch (e) { console.error("pm2 restart error:", e); }
    setTimeout(() => gracefulSaveAndExit(0), 500);
    return;
  }
  await restartBotLocal();
  setTimeout(() => gracefulSaveAndExit(0), 500);
}

function persistRestartNotice(channelId, requesterId = null) {
  try {
    if (!channelId) return;
    const payload = {
      channelId: String(channelId),
      requesterId: requesterId ? String(requesterId) : null,
      createdAt: Date.now()
    };
    fs.writeFileSync(RESTART_NOTICE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {
    console.error("persistRestartNotice error:", e);
  }
}

function readAndClearRestartNotice() {
  try {
    if (!fs.existsSync(RESTART_NOTICE_FILE)) return null;
    const raw = fs.readFileSync(RESTART_NOTICE_FILE, "utf8");
    fs.unlinkSync(RESTART_NOTICE_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed?.channelId) return null;
    return parsed;
  } catch (e) {
    console.error("readAndClearRestartNotice error:", e);
    return null;
  }
}

async function sendRestartCompletedNotice() {
  const notice = readAndClearRestartNotice();
  if (!notice) return;

  try {
    const actor = notice.requesterId ? `<@${notice.requesterId}>` : "admin";
    const bootUnix = Math.floor(BOT_BOOT_AT / 1000);
    if (notice.requesterId) {
      const user = await zodiClient.users.fetch(notice.requesterId).catch(() => null);
      if (!user) return;
      await user.send(
        `✅ Redémarrage terminé.\n` +
        `Demande par ${actor}\n` +
        `PID: \`${process.pid}\`\n` +
        `Boot: <t:${bootUnix}:F>`
      );
    }
  } catch (e) {
    console.error("sendRestartCompletedNotice error:", e);
  }
}

// ==========================
let discordLoginRetryTimer = null;

function isTransientDiscordNetworkError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || err || "");
  return (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code) ||
    /discord\.com|getaddrinfo|network|timeout/i.test(message)
  );
}

function scheduleDiscordLoginRetry(reason = "Erreur Discord") {
  if (discordLoginRetryTimer || zodiClient?.isReady?.()) return;
  const delayMs = Math.max(15000, Number(process.env.DISCORD_LOGIN_RETRY_MS) || 60000);
  console.error(`${reason}. Nouvelle tentative Discord dans ${Math.round(delayMs / 1000)}s.`);
  discordLoginRetryTimer = setTimeout(() => {
    discordLoginRetryTimer = null;
    startDiscordLogin();
  }, delayMs);
}

function startDiscordLogin() {
  if (!process.env.DISCORD_TOKEN) {
    console.error("DISCORD_TOKEN manquant. Electron reste disponible en local, mais Discord ne peut pas se connecter.");
    return;
  }
  if (zodiClient?.isReady?.()) return;
  zodiClient.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("Connexion Discord impossible:", err?.message || err);
    scheduleDiscordLoginRetry("Connexion Discord impossible");
  });
}

zodiClient.on("error", err => {
  console.error("Erreur client Discord:", err?.message || err);
  if (isTransientDiscordNetworkError(err)) scheduleDiscordLoginRetry("Erreur reseau Discord");
});

startDiscordLogin();

// sauvegarde des données avant arrêt
function gracefulSaveAndExit(code=0) {
  try { saveData(); } catch(e) { console.error('saveData error:', e); }
  try { savePresence(); } catch(e) { console.error('savePresence error:', e); }
  process.exit(code);
}

process.on('SIGINT', () => gracefulSaveAndExit(0));
process.on('SIGTERM', () => gracefulSaveAndExit(0));
process.on('exit', () => { try { savePresence(); } catch(e){} });
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  try { savePresence(); } catch(e){}
  if (isTransientDiscordNetworkError(err)) {
    scheduleDiscordLoginRetry("Erreur reseau Discord");
    return;
  }
  process.exit(1);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
  if (isTransientDiscordNetworkError(err)) {
    scheduleDiscordLoginRetry("Erreur reseau Discord");
  }
});


// Pour démarrer le bot sur VS Code, utilise la commande : node index.js










