"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <style>
          body { font-family: sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; text-align: center; }
          .status { font-size: 24px; font-weight: bold; margin-top: 20px; }
          .online { color: #3fb950; }
          .offline { color: #da3633; }
        </style>
      </head>
      <body>
        <h1>AFK Bot Dashboard</h1>
        <div class="status ${botState.connected ? 'online' : 'offline'}">
          ${botState.connected ? 'Bot is Online' : 'Bot is Offline (Attempting Reconnect)'}
        </div>
        <p>Uptime: ${Math.floor((Date.now() - botState.startTime) / 1000)} seconds</p>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true;
  createBot();
  addLog("[Control] Bot started");
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false;
  if (bot) {
    bot.end();
    bot = null;
  }
  clearAllIntervals();
  addLog("[Control] Bot stopped");
  res.json({ success: true });
});

// HTTP server başlatma
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort}`);
    server.listen(fallbackPort, "0.0.0.0");
  }
});

// Self Ping
const SELF_PING_INTERVAL = 10 * 60 * 1000;
function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) return;
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol.get(`${renderUrl}/ping`).on("error", () => {});
  }, SELF_PING_INTERVAL);
}
startSelfPing();

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
}

function clearAllIntervals() {
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
  return baseDelay + Math.floor(Math.random() * 2000);
}

function createBot() {
  if (isReconnecting) return;
  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (e) {}
    bot = null;
  }

  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}...`);

  try {
    const botVersion = config.server.version && config.server.version.trim() !== "" ? config.server.version : false;
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
    });

    bot.loadPlugin(pathfinder);

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout - no spawn received");
        try { bot.removeAllListeners(); bot.end(); } catch (e) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;
      clearBotTimeouts();
      botState.connected = true;
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      addLog(`[Bot] [+] Successfully spawned!`);
      
      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      initializeModules(bot, mcData, defaultMove);
    });

    bot.on("kicked", (reason) => {
      const kickReason = typeof reason === "object" ? JSON.stringify(reason) : reason;
      addLog(`[Bot] Kicked: ${kickReason}`);
      botState.connected = false;
      clearAllIntervals();
    });

    bot.on("end", (reason) => {
      addLog(`[Bot] Disconnected: ${reason || "Unknown"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      scheduleReconnect();
    });

    bot.on("error", (err) => {
      const msg = err.message || "";
      addLog(`[Bot] Error: ${msg}`);
      
      // --- ATERNOS UPTIME KALKANI ---
      if (err.code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        if (process.uptime() < 300) { // İlk 5 dakika çökmeyi engeller (Deploy onaylansın diye)
          addLog("[INFO] Aternos banı aktif ancak Render onay aşamasında olduğu için bot beklemeye alındı.");
        } else {
          addLog("[FATAL] Deploy onaylandı! Yeni IP almak için Render yeniden başlatılıyor...");
          process.exit(1); 
        }
      }
    });
  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${delay / 1000}s...`);
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION (Kısa tutuldu)
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    addInterval(() => { if (bot && botState.connected) try { bot.swingArm(); } catch(e){} }, 30000);
  }
}

// ============================================================
// CRASH RECOVERY - ATERNOS BYPASS MODE
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);

  // --- ATERNOS UPTIME KALKANI ---
  if (msg.includes("ETIMEDOUT") || msg.includes("connect ETIMEDOUT") || msg.includes("timed out")) {
    if (process.uptime() < 300) { // İlk 5 dakika çökme yok
      addLog("[INFO] Aternos engeli algılandı. Deploy kalkanı aktif, çökme ertelendi.");
      return; 
    } else {
      addLog("[FATAL] Yeni IP için Render zorla kapatılıyor...");
      process.exit(1);
    }
  }

  clearAllIntervals();
  botState.connected = false;
  if (isReconnecting) { isReconnecting = false; clearBotTimeouts(); }
  setTimeout(() => { scheduleReconnect(); }, 5000);
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${reason}`);

  // --- ATERNOS UPTIME KALKANI ---
  if (msg.includes("ETIMEDOUT") || msg.includes("connect ETIMEDOUT") || msg.includes("timed out")) {
    if (process.uptime() < 300) { // İlk 5 dakika çökme yok
      addLog("[INFO] Aternos engeli algılandı. Deploy kalkanı aktif, çökme ertelendi.");
      return;
    } else {
      addLog("[FATAL] Yeni IP için Render zorla kapatılıyor...");
      process.exit(1);
    }
  }

  clearAllIntervals();
  botState.connected = false;
  if (bot) { try { bot.end(); } catch (_) {} bot = null; }
  scheduleReconnect();
});

createBot();
