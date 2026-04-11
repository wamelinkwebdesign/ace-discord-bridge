import { Client, GatewayIntentBits, Partials, ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";
import { spawn } from "child_process";
import { readFile, readdir, mkdir, appendFile, writeFile, stat } from "fs/promises";
import { existsSync, createWriteStream, readFileSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";

// ─── Load Config ──────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");

if (!existsSync(CONFIG_PATH)) {
  console.error("config.json not found. Copy config.example.json to config.json and fill in your values.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

// Resolve ~ in workspace path
const resolveHome = (p) => p.startsWith("~") ? path.join(process.env.HOME, p.slice(1)) : p;

const BOT_TOKEN = config.botToken;
const USER_ID = config.userId;
const GUILD_ID = config.guildId;
const WORKSPACE = resolveHome(config.workspace);
const ATTACHMENTS_DIR = path.join(WORKSPACE, "attachments");
const CLAUDE_CMD = "claude";
const DEFAULT_MODEL = config.defaultModel || "claude-sonnet-4-6";
const OPUS_MODEL = config.opusModel || "claude-opus-4-6";
const CHANNELS = config.channels || {};

// Streaming config
const FIRST_SEND_DELAY_MS = config.firstSendDelayMs || 2000;
const EDIT_INTERVAL_MS = config.editIntervalMs || 1500;
const DISCORD_MAX_LENGTH = 1900;

// Rate limiter
const RATE_LIMIT_MS = config.rateLimitMs || 3000;

if (!BOT_TOKEN || BOT_TOKEN === "YOUR_DISCORD_BOT_TOKEN") {
  console.error("Set your Discord bot token in config.json");
  process.exit(1);
}

if (!USER_ID || USER_ID === "YOUR_DISCORD_USER_ID") {
  console.error("Set your Discord user ID in config.json");
  process.exit(1);
}

// ─── Runtime State ────────────────────────────────────────────────────
let lastCallTime = 0;
let processingQueue = [];
let isProcessing = false;
const activeProcesses = new Set();
const SESSION_MODEL = {}; // per-channel model override
const SESSION_EFFORT = {}; // per-channel effort override
const DEFAULT_EFFORT_SONNET = config.defaultEffortSonnet || "medium";
const DEFAULT_EFFORT_OPUS = config.defaultEffortOpus || "high";
const SESSION_SYSTEM_PROMPT = {}; // per-channel custom system prompt
const LAST_PROMPT = {}; // per-channel last user prompt for retry { content, parsed, attachmentPaths }

// ─── Error / pause tracking ───────────────────────────────────────────
// Per-channel consecutive error counter. Resets to zero on the next success.
// At ERROR_THRESHOLD_WARN we post a visible warning. At ERROR_THRESHOLD_PAUSE
// the channel is auto-paused: subsequent messages are silently dropped until
// the user posts !resume. This mirrors OpenClaw's cron consecutiveErrors +
// disabledUntil pattern.
const ERROR_COUNTS = {};
const PAUSED = {};
const ERROR_THRESHOLD_WARN = 3;
const ERROR_THRESHOLD_PAUSE = 5;

// ─── Session Persistence ──────────────────────────────────────────────
// Per-channel Claude Code session UUIDs. Persisted to disk so conversations
// survive bridge restarts. Each entry maps channelId -> uuid that gets passed
// to `claude --session-id <uuid>`. Claude Code stores the JSONL transcript at
// ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl and resumes it transparently.
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const SESSIONS = {};

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    Object.assign(SESSIONS, data);
  } catch (err) {
    console.error("[ACE] Failed to load sessions.json:", err.message);
  }
}

async function saveSessions() {
  try {
    await writeFile(SESSIONS_FILE, JSON.stringify(SESSIONS, null, 2));
  } catch (err) {
    console.error("[ACE] Failed to save sessions.json:", err.message);
  }
}

function sessionIdFor(channelId) {
  if (!SESSIONS[channelId]) {
    SESSIONS[channelId] = randomUUID();
    saveSessions();
  }
  return SESSIONS[channelId];
}

function rotateSession(channelId) {
  SESSIONS[channelId] = randomUUID();
  saveSessions();
  return SESSIONS[channelId];
}

// Locate the JSONL file Claude Code wrote for a session id. Path encoding
// replaces both '/' and '.' with '-' (verified against ~/.claude/projects/).
function sessionJsonlPath(sessionId) {
  const encoded = WORKSPACE.replace(/[/.]/g, "-");
  return path.join(process.env.HOME, ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

// Human-readable summary of a session for !status / !history. Returns the
// short UUID + size + line count if the JSONL exists, "(none)" otherwise.
async function sessionInfoString(sessionId) {
  if (!sessionId) return "(none)";
  const p = sessionJsonlPath(sessionId);
  if (!existsSync(p)) return `\`${sessionId.slice(0, 8)}\` (empty)`;
  try {
    const st = await stat(p);
    const data = await readFile(p, "utf-8");
    const lines = data.split("\n").filter(l => l.trim()).length;
    const kb = (st.size / 1024).toFixed(1);
    return `\`${sessionId.slice(0, 8)}\` (${lines} turns, ${kb} KB)`;
  } catch {
    return `\`${sessionId.slice(0, 8)}\``;
  }
}

loadSessions();

// ─── Structured run log ──────────────────────────────────────────────
// Append one JSON line per Discord turn to workspace/logs/bridge-runs.jsonl.
// Fire-and-forget; never blocks the response. Provides grep-able history,
// per-channel error rates, latency tracking. Replaces OpenClaw's cron/runs/.
const RUN_LOG_PATH = path.join(WORKSPACE, "logs", "bridge-runs.jsonl");
let runLogDirReady = false;
async function logRun(entry) {
  try {
    if (!runLogDirReady) {
      await mkdir(path.dirname(RUN_LOG_PATH), { recursive: true });
      runLogDirReady = true;
    }
    await appendFile(RUN_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error("[ACE] logRun failed:", err.message);
  }
}

// ─── Identity Loading ────────────────────────────────────────────────
let COMPACT_IDENTITY = "";
async function loadCompactIdentity() {
  if (COMPACT_IDENTITY) return COMPACT_IDENTITY;
  const compactPath = path.join(WORKSPACE, "CLAUDE-SHORT.md");
  if (existsSync(compactPath)) {
    COMPACT_IDENTITY = await readFile(compactPath, "utf-8");
  } else {
    const soul = existsSync(path.join(WORKSPACE, "SOUL.md"))
      ? await readFile(path.join(WORKSPACE, "SOUL.md"), "utf-8").then(d => d.substring(0, 1500))
      : "";
    const user = existsSync(path.join(WORKSPACE, "USER.md"))
      ? await readFile(path.join(WORKSPACE, "USER.md"), "utf-8").then(d => d.substring(0, 1500))
      : "";
    COMPACT_IDENTITY = `${soul}\n\n${user}`;
  }
  return COMPACT_IDENTITY;
}

// ─── Agent Roster Loading ─────────────────────────────────────────────
// Reads workspace/agents/*.md once at startup and serializes them into the
// JSON shape Claude Code expects for --agents. Each role becomes a custom
// subagent that Ace can dispatch via the native Agent tool. README.md is
// skipped because it documents the system, not a role.
let AGENTS_JSON = "";
const AGENT_PROMPT_BUDGET = 6000;
async function loadAgentsJson() {
  if (AGENTS_JSON) return AGENTS_JSON;
  const dir = path.join(WORKSPACE, "agents");
  if (!existsSync(dir)) {
    AGENTS_JSON = "{}";
    return AGENTS_JSON;
  }
  const agents = {};
  try {
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".md") || f.toLowerCase() === "readme.md") continue;
      const name = f.replace(/\.md$/, "");
      const body = await readFile(path.join(dir, f), "utf-8");
      const firstLine = body.split("\n").find(l => l.trim()) || name;
      const description = firstLine.replace(/^#+\s*/, "").substring(0, 200);
      const prompt = body.length > AGENT_PROMPT_BUDGET
        ? body.substring(0, AGENT_PROMPT_BUDGET) + "\n...(truncated)"
        : body;
      agents[name] = { description, prompt };
    }
  } catch (err) {
    console.error("[ACE] Failed to load agents:", err.message);
  }
  AGENTS_JSON = JSON.stringify(agents);
  return AGENTS_JSON;
}

// ─── Smart Memory Loading ─────────────────────────────────────────────
// Per-channel memory and rules files are auto-loaded on every call (see
// buildClaudeInput). The keyword gate below only governs the global
// MEMORY.md index, which is large and only useful for status-type asks.
const MEMORY_KEYWORDS = [
  "memory", "remember", "when did", "what happened", "status",
  "pipeline", "lead", "prospect", "last time", "previous",
];
function needsGlobalMemory(content) {
  const lower = content.toLowerCase();
  return MEMORY_KEYWORDS.some(kw => lower.includes(kw));
}

const RULES_CACHE = {}; // basename -> file contents (lazily filled, bounded)
const CHANNEL_MEM_CACHE = {}; // channelName -> file contents
const RULES_BUDGET = 3000;
const CHANNEL_MEM_BUDGET = 4000;
const DAILY_MEM_BUDGET = 4000;
const GLOBAL_MEM_BUDGET = 8000;

async function loadRuleFile(basename) {
  if (basename in RULES_CACHE) return RULES_CACHE[basename];
  const p = path.join(WORKSPACE, "rules", `${basename}.md`);
  if (!existsSync(p)) {
    RULES_CACHE[basename] = "";
    return "";
  }
  try {
    const data = await readFile(p, "utf-8");
    RULES_CACHE[basename] = data.length > RULES_BUDGET
      ? data.substring(0, RULES_BUDGET) + "\n...(truncated)"
      : data;
  } catch {
    RULES_CACHE[basename] = "";
  }
  return RULES_CACHE[basename];
}

async function loadChannelMemory(channelName) {
  if (!channelName) return "";
  if (channelName in CHANNEL_MEM_CACHE) return CHANNEL_MEM_CACHE[channelName];
  const p = path.join(WORKSPACE, "memory", "channels", `${channelName}.md`);
  if (!existsSync(p)) {
    CHANNEL_MEM_CACHE[channelName] = "";
    return "";
  }
  try {
    const data = await readFile(p, "utf-8");
    CHANNEL_MEM_CACHE[channelName] = data.length > CHANNEL_MEM_BUDGET
      ? data.substring(0, CHANNEL_MEM_BUDGET) + "\n...(truncated)"
      : data;
  } catch {
    CHANNEL_MEM_CACHE[channelName] = "";
  }
  return CHANNEL_MEM_CACHE[channelName];
}

async function loadDailyMemory() {
  const dateStr = new Date().toISOString().split("T")[0];
  const dailyPath = path.join(WORKSPACE, "memory", `${dateStr}.md`);
  if (!existsSync(dailyPath)) return "";
  try {
    const data = await readFile(dailyPath, "utf-8");
    return data.length > DAILY_MEM_BUDGET
      ? data.substring(0, DAILY_MEM_BUDGET) + "\n...(truncated)"
      : data;
  } catch {
    return "";
  }
}

async function loadGlobalMemory() {
  const memoryPath = path.join(WORKSPACE, "MEMORY.md");
  if (!existsSync(memoryPath)) return "";
  try {
    const data = await readFile(memoryPath, "utf-8");
    return data.length > GLOBAL_MEM_BUDGET
      ? data.substring(0, GLOBAL_MEM_BUDGET) + "\n...(truncated)"
      : data;
  } catch {
    return "";
  }
}

async function rulesForChannel(channelName) {
  const map = config.channelRules || {};
  const list = (channelName && map[channelName]) || map._default || [];
  if (list.length === 0) return "";
  const blocks = [];
  for (const basename of list) {
    const body = await loadRuleFile(basename);
    if (body) blocks.push(`# rules/${basename}.md\n${body}`);
  }
  return blocks.join("\n\n");
}

// ─── Download Attachment ──────────────────────────────────────────────
async function downloadAttachment(url, filename) {
  if (!existsSync(ATTACHMENTS_DIR)) {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
  }
  const filePath = path.join(ATTACHMENTS_DIR, `${Date.now()}-${filename}`);
  const proto = url.startsWith("https") ? https : http;

  return new Promise((resolve, reject) => {
    const file = createWriteStream(filePath);
    proto.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(filePath);
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

// ─── Compact Session ──────────────────────────────────────────────────
// Asks Claude to summarize the current session, then rotates the channel's
// session UUID so the next message starts fresh. The summary is returned for
// posting to Discord (it lives in scrollback, not in any new session).
async function compactSession(channelId) {
  const sessionId = SESSIONS[channelId];
  if (!sessionId) return null;
  const jsonlPath = sessionJsonlPath(sessionId);
  if (!existsSync(jsonlPath)) return null;

  return new Promise((resolve) => {
    let output = "";
    const proc = spawn(CLAUDE_CMD, [
      "--print",
      "--permission-mode", "bypassPermissions",
      "--resume", sessionId,
      "--model", DEFAULT_MODEL,
      "Summarize our entire conversation so far in 3-5 short sentences. Focus on key topics, decisions, and open questions. Be concise.",
    ], {
      cwd: WORKSPACE,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME,
        PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      },
    });

    proc.stdout.on("data", (data) => { output += data.toString(); });
    proc.on("close", () => {
      const summary = output.trim();
      if (summary) {
        rotateSession(channelId);
        resolve(summary);
      } else {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));

    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(null);
    }, 60000);
  });
}

// ─── Parse Message ────────────────────────────────────────────────────
function parseMessage(content) {
  const trimmed = content.trim();

  if (trimmed === "!compact") return { command: "compact" };
  if (trimmed === "!clear") return { command: "clear" };
  if (trimmed === "!help") return { command: "help" };
  if (trimmed === "!model opus") return { command: "model", modelChoice: "opus" };
  if (trimmed === "!model sonnet") return { command: "model", modelChoice: "sonnet" };
  if (trimmed === "!model reset" || trimmed === "!model default") return { command: "model", modelChoice: "default" };
  if (trimmed === "!model") return { command: "model", modelChoice: "status" };
  if (/^!effort (low|medium|high|max)$/.test(trimmed)) return { command: "effort", effortLevel: trimmed.split(" ")[1] };
  if (trimmed === "!effort reset" || trimmed === "!effort default") return { command: "effort", effortLevel: "default" };
  if (trimmed === "!effort") return { command: "effort", effortLevel: "status" };
  if (trimmed === "!status") return { command: "status" };
  if (trimmed === "!retry") return { command: "retry" };
  if (trimmed === "!history") return { command: "history" };
  if (trimmed === "!resume") return { command: "resume" };
  if (trimmed === "!errors") return { command: "errors" };
  if (trimmed.startsWith("!system ")) return { command: "system", systemPrompt: trimmed.slice(8).trim() };
  if (trimmed === "!system clear" || trimmed === "!system reset") return { command: "system", systemPrompt: null };
  if (trimmed === "!system") return { command: "system", systemPrompt: "status" };

  if (trimmed.startsWith("!opus ")) {
    return { model: OPUS_MODEL, content: trimmed.slice(6).trim() };
  }

  // !dispatch <role> <task...>
  const dispatchMatch = trimmed.match(/^!dispatch\s+(\S+)\s+([\s\S]+)$/);
  if (dispatchMatch) {
    return { command: "dispatch", role: dispatchMatch[1], task: dispatchMatch[2] };
  }
  if (trimmed === "!dispatch" || trimmed === "!agents") {
    return { command: "dispatch", role: null, task: null };
  }

  // Session model override is applied later in the queue processor
  return { model: null, content: trimmed };
}

// ─── Build Claude Input ───────────────────────────────────────────────
async function buildClaudeInput(channelId, parsed, attachmentPaths) {
  const channel = CHANNELS[channelId];
  const channelName = channel ? channel.name : channelId;
  const channelContext = channel ? channel.context : "";

  const identity = await loadCompactIdentity();

  // Always-on per-channel context: dedicated channel memory file (if any),
  // today's daily memory, and the operating rules for this channel category.
  // Global MEMORY.md only loads when the message looks like it needs it OR
  // when the channel has no dedicated memory file.
  const channelMem = await loadChannelMemory(channelName);
  const dailyMem = await loadDailyMemory();
  const rulesBlock = await rulesForChannel(channelName);
  const globalMem = (needsGlobalMemory(parsed.content) || !channelMem)
    ? await loadGlobalMemory()
    : "";

  // Conversation history is no longer injected here - Claude Code's native
  // --session-id persistence carries it across calls. Only the per-call
  // identity, memory, rules, and custom-prompt context still rides via append.
  let systemPrompt = `${identity}\n\nChannel: #${channelName}\n${channelContext ? "Context: " + channelContext : ""}\n`;

  if (rulesBlock) {
    systemPrompt += `\n--- OPERATING RULES ---\n${rulesBlock}\n\n`;
  }

  if (channelMem) {
    systemPrompt += `--- CHANNEL MEMORY (#${channelName}) ---\n${channelMem}\n\n`;
  }

  if (dailyMem) {
    systemPrompt += `--- TODAY'S NOTES ---\n${dailyMem}\n\n`;
  }

  if (globalMem) {
    systemPrompt += `--- GLOBAL MEMORY INDEX ---\n${globalMem}\n\n`;
  }

  if (SESSION_SYSTEM_PROMPT[channelId]) {
    systemPrompt += `--- CUSTOM INSTRUCTIONS ---\n${SESSION_SYSTEM_PROMPT[channelId]}\n\n`;
  }

  systemPrompt += `Rules: Be direct. No em dashes. Discord formatting: no tables, use bullet lists. Write important things to memory/YYYY-MM-DD.md.`;

  let prompt = parsed.content;
  if (attachmentPaths.length > 0) {
    const attachmentInfo = attachmentPaths.map(p => {
      const ext = path.extname(p).toLowerCase();
      const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
      if (isImage) {
        return `[Image attached: ${path.basename(p)}] (saved at ${p})`;
      }
      return `[File attached: ${path.basename(p)}] (saved at ${p}) - read this file to see its contents`;
    }).join("\n");
    prompt = `${prompt}\n\nAttachments:\n${attachmentInfo}`;
  }

  const agentsJson = await loadAgentsJson();

  // If the active model is Opus, fall back to Sonnet on overload (and vice
  // versa). Claude Code's --fallback-model swaps automatically when --print
  // sees an overloaded response.
  const fallbackModel = parsed.model === OPUS_MODEL ? DEFAULT_MODEL : OPUS_MODEL;

  // Claude Code's --session-id creates a new session with the given UUID and
  // refuses if one already exists ("already in use"). For subsequent turns we
  // must switch to --resume <uuid>. Detect by checking the JSONL on disk.
  const sessionId = sessionIdFor(channelId);
  const sessionExists = existsSync(sessionJsonlPath(sessionId));
  const sessionFlag = sessionExists ? "--resume" : "--session-id";

  const args = [
    "--print",
    "--permission-mode", "bypassPermissions",
    sessionFlag, sessionId,
    "--model", parsed.model,
    "--fallback-model", fallbackModel,
    "--effort", parsed.effort,
    "--agents", agentsJson,
    "--append-system-prompt", systemPrompt,
  ];

  return { args, prompt };
}

// ─── Streaming Claude Call ────────────────────────────────────────────
async function callClaudeStreaming({ args, prompt }, message) {
  const now = Date.now();
  const waitTime = RATE_LIMIT_MS - (now - lastCallTime);
  if (waitTime > 0) {
    await new Promise((r) => setTimeout(r, waitTime));
  }
  lastCallTime = Date.now();

  const channel = message.channel;

  try { channel.sendTyping(); } catch {}
  const typingInterval = setInterval(() => {
    try { channel.sendTyping(); } catch {}
  }, 8000);

  return new Promise((resolve, reject) => {
    let fullText = "";
    let stderr = "";
    let settled = false;
    let sentMessage = null;
    let lastEditTime = 0;
    let editTimer = null;
    let firstSendTimer = null;
    let currentChunkStart = 0;

    function cleanup() {
      clearInterval(typingInterval);
      if (editTimer) clearTimeout(editTimer);
      if (firstSendTimer) clearTimeout(firstSendTimer);
    }

    const proc = spawn(CLAUDE_CMD, args, {
      cwd: WORKSPACE,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME,
        PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      },
    });

    activeProcesses.add(proc);

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      fullText += chunk;
      scheduleDiscordUpdate();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    function scheduleDiscordUpdate() {
      if (!sentMessage && !firstSendTimer) {
        firstSendTimer = setTimeout(() => sendOrEditMessage(), FIRST_SEND_DELAY_MS);
        return;
      }

      if (sentMessage && !editTimer) {
        const timeSinceLastEdit = Date.now() - lastEditTime;
        const delay = Math.max(0, EDIT_INTERVAL_MS - timeSinceLastEdit);
        editTimer = setTimeout(() => {
          editTimer = null;
          sendOrEditMessage();
        }, delay);
      }
    }

    async function sendOrEditMessage() {
      const currentText = fullText.substring(currentChunkStart);
      if (!currentText.trim()) return;

      try {
        if (currentText.length > DISCORD_MAX_LENGTH) {
          const splitText = currentText.substring(0, DISCORD_MAX_LENGTH);
          let splitAt = splitText.lastIndexOf("\n");
          if (splitAt === -1 || splitAt < DISCORD_MAX_LENGTH * 0.3) splitAt = DISCORD_MAX_LENGTH;

          const finalChunk = currentText.substring(0, splitAt);

          if (sentMessage) {
            await sentMessage.edit(finalChunk);
          } else {
            sentMessage = await message.reply(finalChunk);
          }

          currentChunkStart += splitAt;
          let overflow = fullText.substring(currentChunkStart).trim();
          while (overflow.length > 0) {
            const chunk = overflow.substring(0, DISCORD_MAX_LENGTH);
            sentMessage = await message.reply(chunk);
            overflow = overflow.substring(DISCORD_MAX_LENGTH).trim();
          }
          if (!overflow) sentMessage = null;
          lastEditTime = Date.now();
          return;
        }

        if (!sentMessage) {
          sentMessage = await message.reply(currentText);
        } else {
          await sentMessage.edit(currentText);
        }
        lastEditTime = Date.now();
      } catch (err) {
        console.error("[ACE] Discord send/edit error:", err.message);
      }
    }

    proc.on("close", async (code) => {
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      cleanup();

      const finalText = fullText.substring(currentChunkStart).trim();

      if (code !== 0 && !fullText.trim()) {
        const errMsg = stderr.trim()
          ? `Claude error (code ${code}): ${stderr.substring(0, 200)}`
          : `Claude exited with code ${code} (no output). Check that claude is in PATH and working.`;
        reject(new Error(errMsg));
        return;
      }

      try {
        if (finalText) {
          if (sentMessage) {
            if (finalText.length > DISCORD_MAX_LENGTH) {
              await sentMessage.edit(finalText.substring(0, DISCORD_MAX_LENGTH));
              let remaining = finalText.substring(DISCORD_MAX_LENGTH).trim();
              while (remaining.length > 0) {
                await message.reply(remaining.substring(0, DISCORD_MAX_LENGTH));
                remaining = remaining.substring(DISCORD_MAX_LENGTH).trim();
              }
            } else {
              await sentMessage.edit(finalText);
            }
          } else {
            let toSend = finalText;
            while (toSend.length > 0) {
              await message.reply(toSend.substring(0, DISCORD_MAX_LENGTH));
              toSend = toSend.substring(DISCORD_MAX_LENGTH).trim();
            }
          }
        } else if (!sentMessage && !fullText.trim()) {
          await message.reply("Got an empty response. Try rephrasing?");
        }
      } catch (err) {
        console.error("[ACE] Final send error:", err.message);
      }

      if (stderr.trim() && fullText.trim()) {
        console.warn(`[ACE] Claude stderr (non-fatal): ${stderr.substring(0, 200)}`);
      }

      resolve(fullText.trim());
    });

    proc.on("error", (err) => {
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

  });
}

// ─── Simple Claude Call (for slash commands) ──────────────────────────
async function callClaudeSimple({ args, prompt }) {
  const now = Date.now();
  const waitTime = RATE_LIMIT_MS - (now - lastCallTime);
  if (waitTime > 0) {
    await new Promise((r) => setTimeout(r, waitTime));
  }
  lastCallTime = Date.now();

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(CLAUDE_CMD, args, {
      cwd: WORKSPACE,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: process.env.HOME,
        PATH: `${process.env.HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      },
    });

    activeProcesses.add(proc);
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      activeProcesses.delete(proc);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      activeProcesses.delete(proc);
      reject(err);
    });
  });
}

// ─── Discord Bot ──────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ─── Slash Commands ───────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName("opus")
    .setDescription("Ask Claude using Opus (deeper reasoning)")
    .addStringOption(opt => opt.setName("message").setDescription("Your message").setRequired(true)),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear conversation history for this channel"),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Summarize conversation history into a short context"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Set the default model for this channel")
    .addStringOption(option =>
      option.setName("choice")
        .setDescription("Which model to use")
        .setRequired(true)
        .addChoices(
          { name: "Sonnet (fast)", value: "sonnet" },
          { name: "Opus (deep reasoning)", value: "opus" },
          { name: "Reset to default", value: "default" },
        )),
  new SlashCommandBuilder()
    .setName("effort")
    .setDescription("Set the thinking effort level for this channel")
    .addStringOption(option =>
      option.setName("level")
        .setDescription("Effort level")
        .setRequired(true)
        .addChoices(
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
          { name: "Max", value: "max" },
          { name: "Reset to default", value: "default" },
        )),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current channel settings"),
  new SlashCommandBuilder()
    .setName("retry")
    .setDescription("Re-send the last message to Claude"),
  new SlashCommandBuilder()
    .setName("system")
    .setDescription("Set a custom system prompt for this channel")
    .addStringOption(option =>
      option.setName("prompt")
        .setDescription("Custom instruction (leave empty to clear)")
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show conversation history info for this channel"),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available commands"),
];

client.on("ready", async () => {
  console.log(`[ACE] Bridge bot online as ${client.user.tag}`);
  console.log(`[ACE] Default: ${DEFAULT_MODEL} | Channels: ${Object.keys(CHANNELS).length}`);

  try {
    await loadAgentsJson();
    const count = Object.keys(JSON.parse(AGENTS_JSON || "{}")).length;
    console.log(`[ACE] Subagents loaded: ${count} (${Object.keys(JSON.parse(AGENTS_JSON || "{}")).join(", ")})`);
  } catch (err) {
    console.error("[ACE] Subagent warm-up failed:", err.message);
  }

  try {
    const rest = new REST().setToken(BOT_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: slashCommands.map(cmd => cmd.toJSON()) },
    );
    console.log(`[ACE] Slash commands registered: /opus, /model, /effort, /status, /retry, /system, /history, /clear, /compact, /help`);
  } catch (err) {
    console.error("[ACE] Failed to register slash commands:", err.message);
  }
});

// ─── Slash Command Handler ────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.user.id !== USER_ID) return;

  const channelId = interaction.channelId;
  const command = interaction.commandName;

  if (command === "clear") {
    const newId = rotateSession(channelId);
    delete LAST_PROMPT[channelId];
    await interaction.reply(`Session reset. New session: \`${newId.slice(0, 8)}\``);
    return;
  }

  if (command === "compact") {
    if (!SESSIONS[channelId]) {
      await interaction.reply("No active session to compact.");
      return;
    }
    await interaction.deferReply();
    const summary = await compactSession(channelId);
    if (summary) {
      const out = summary.length > DISCORD_MAX_LENGTH
        ? summary.substring(0, DISCORD_MAX_LENGTH - 100) + "...(truncated)"
        : summary;
      await interaction.editReply(`Session compacted and rotated. Summary:\n> ${out}`);
    } else {
      await interaction.editReply("Couldn't generate a summary. Session unchanged.");
    }
    return;
  }

  if (command === "model") {
    const choice = interaction.options.getString("choice");
    if (choice === "opus") {
      SESSION_MODEL[channelId] = OPUS_MODEL;
      await interaction.reply(`Model set to **Opus** for this channel. All messages will use Opus until you change it.`);
    } else if (choice === "sonnet") {
      SESSION_MODEL[channelId] = DEFAULT_MODEL;
      await interaction.reply(`Model set to **Sonnet** for this channel.`);
    } else {
      delete SESSION_MODEL[channelId];
      await interaction.reply(`Model reset to default (\`${DEFAULT_MODEL}\`).`);
    }
    return;
  }

  if (command === "effort") {
    const level = interaction.options.getString("level");
    if (level === "default") {
      delete SESSION_EFFORT[channelId];
      const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
      const defaultEffort = activeModel === OPUS_MODEL ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET;
      await interaction.reply(`Effort reset to model default (\`${defaultEffort}\`).`);
    } else {
      SESSION_EFFORT[channelId] = level;
      await interaction.reply(`Effort set to **${level}** for this channel.`);
    }
    return;
  }

  if (command === "status") {
    const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
    const isOpus = activeModel === OPUS_MODEL;
    const activeEffort = SESSION_EFFORT[channelId] || (isOpus ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET);
    const sessionId = SESSIONS[channelId];
    const sessionInfo = await sessionInfoString(sessionId);
    const customPrompt = SESSION_SYSTEM_PROMPT[channelId];
    const statusText = [
      `**Model:** \`${activeModel}\``,
      `**Effort:** \`${activeEffort}\``,
      `**Session:** ${sessionInfo}`,
      `**Queue:** ${processingQueue.length} pending`,
      customPrompt ? `**System prompt:** ${customPrompt.substring(0, 100)}${customPrompt.length > 100 ? "..." : ""}` : "**System prompt:** none",
    ].join("\n");
    await interaction.reply(statusText);
    return;
  }

  if (command === "retry") {
    const last = LAST_PROMPT[channelId];
    if (!last) {
      await interaction.reply("Nothing to retry. Send a message first.");
      return;
    }
    await interaction.deferReply();
    try {
      const claudeInput = await buildClaudeInput(channelId, last.parsed, last.attachmentPaths || []);
      const response = await callClaudeSimple(claudeInput);
      if (response) {
        if (response.length <= DISCORD_MAX_LENGTH) {
          await interaction.editReply(response);
        } else {
          await interaction.editReply(response.substring(0, DISCORD_MAX_LENGTH));
          let remaining = response.substring(DISCORD_MAX_LENGTH).trim();
          while (remaining.length > 0) {
            await interaction.followUp(remaining.substring(0, DISCORD_MAX_LENGTH));
            remaining = remaining.substring(DISCORD_MAX_LENGTH).trim();
          }
        }
      } else {
        await interaction.editReply("Got an empty response on retry.");
      }
    } catch (error) {
      await interaction.editReply(`Retry error: \`${error.message.substring(0, 200)}\``);
    }
    return;
  }

  if (command === "system") {
    const prompt = interaction.options.getString("prompt");
    if (!prompt) {
      delete SESSION_SYSTEM_PROMPT[channelId];
      await interaction.reply("Custom system prompt cleared.");
    } else {
      SESSION_SYSTEM_PROMPT[channelId] = prompt;
      await interaction.reply(`System prompt set: "${prompt.substring(0, 200)}${prompt.length > 200 ? "..." : ""}"`);
    }
    return;
  }

  if (command === "history") {
    const sessionId = SESSIONS[channelId];
    if (!sessionId) {
      await interaction.reply("No active session for this channel.");
      return;
    }
    const info = await sessionInfoString(sessionId);
    await interaction.reply(`**Session:** ${info}\nResume interactively: \`claude --resume ${sessionId}\``);
    return;
  }

  if (command === "help") {
    const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
    const isOpus = activeModel === OPUS_MODEL;
    const activeEffort = SESSION_EFFORT[channelId] || (isOpus ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET);
    const helpText = [
      "**Commands**",
      "",
      "`/model` - Set the model for this channel (Sonnet/Opus)",
      "`/effort` - Set thinking effort (low/medium/high/max)",
      "`/status` - Show current channel settings",
      "`/retry` - Re-send the last message to Claude",
      "`/system` - Set a custom system prompt for this channel",
      "`/history` - Show conversation history info",
      "`/opus <message>` - Send a single message with Opus",
      "`/clear` - Clear conversation history for this channel",
      "`/compact` - Summarize conversation history into a short context",
      "`/help` - Show this message",
      "",
      "All commands also work as prefix: `!model`, `!effort`, `!status`, etc.",
      "",
      "**Attachments** - Send images or files with your message to analyze them",
      "",
      `Current: \`${activeModel}\` | Effort: \`${activeEffort}\``,
    ].join("\n");
    await interaction.reply(helpText);
    return;
  }

  if (command === "opus") {
    const userMessage = interaction.options.getString("message");

    await interaction.deferReply();

    try {
      const parsed = { model: OPUS_MODEL, content: userMessage, effort: SESSION_EFFORT[channelId] || DEFAULT_EFFORT_OPUS };
      const claudeInput = await buildClaudeInput(channelId, parsed, []);
      console.log(`[ACE] /opus in #${CHANNELS[channelId]?.name || channelId}: "${userMessage.substring(0, 50)}..."`);

      const response = await callClaudeSimple(claudeInput);

      if (!response) {
        await interaction.editReply("Got an empty response. Try rephrasing?");
        return;
      }

      if (response.length <= DISCORD_MAX_LENGTH) {
        await interaction.editReply(response);
      } else {
        await interaction.editReply(response.substring(0, DISCORD_MAX_LENGTH));
        let remaining = response.substring(DISCORD_MAX_LENGTH).trim();
        while (remaining.length > 0) {
          await interaction.followUp(remaining.substring(0, DISCORD_MAX_LENGTH));
          remaining = remaining.substring(DISCORD_MAX_LENGTH).trim();
        }
      }

      console.log(`[ACE] /opus done in #${CHANNELS[channelId]?.name || channelId}`);
    } catch (error) {
      console.error("[ACE] /opus error:", error.message);
      await interaction.editReply(`Error: \`${error.message.substring(0, 200)}\``);
    }
    return;
  }
});

// ─── Message Handler ──────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.id !== USER_ID) return;
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const isDM = message.channel.type === ChannelType.DM;
  const isKnownChannel = CHANNELS[channelId];

  if (!isDM && !isKnownChannel) return;

  const content = message.content;

  if (!content.trim() && message.attachments.size === 0) return;

  const parsed = parseMessage(content);

  // ─── Pause gate ────────────────────────────────────────────────────
  // After ERROR_THRESHOLD_PAUSE consecutive failures the channel sits in
  // PAUSED until the user posts !resume. !errors still works for inspection.
  if (PAUSED[channelId]) {
    if (parsed.command === "resume") {
      delete PAUSED[channelId];
      delete ERROR_COUNTS[channelId];
      try {
        await message.react("\u{2705}");
        await message.reply("Channel resumed. Error counter reset.");
      } catch {}
      return;
    }
    if (parsed.command === "errors") {
      try { await message.reply(`Channel is paused (${ERROR_COUNTS[channelId] || 0} consecutive errors). Use \`!resume\` to re-enable.`); } catch {}
      return;
    }
    return;
  }

  if (parsed.command === "resume") {
    try { await message.reply("Channel is not paused."); } catch {}
    return;
  }

  if (parsed.command === "errors") {
    const lines = Object.entries(ERROR_COUNTS)
      .filter(([, n]) => n > 0)
      .map(([cid, n]) => `- #${CHANNELS[cid]?.name || cid}: ${n}${PAUSED[cid] ? " (paused)" : ""}`);
    const body = lines.length > 0
      ? `**Channels with errors:**\n${lines.join("\n")}`
      : "No channels currently in error state.";
    try { await message.reply(body); } catch {}
    return;
  }

  // ─── Handle commands ───────────────────────────────────────────────
  if (parsed.command === "clear") {
    const newId = rotateSession(channelId);
    delete LAST_PROMPT[channelId];
    try {
      await message.react("\u{1F9F9}");
      await message.reply(`Session reset. New session: \`${newId.slice(0, 8)}\``);
    } catch {}
    return;
  }

  if (parsed.command === "compact") {
    try {
      if (!SESSIONS[channelId]) {
        await message.reply("No active session to compact.");
        await message.react("\u{26A0}\u{FE0F}");
        return;
      }
      await message.react("\u{1F504}");
      const summary = await compactSession(channelId);
      if (summary) {
        const out = summary.length > DISCORD_MAX_LENGTH
          ? summary.substring(0, DISCORD_MAX_LENGTH - 100) + "...(truncated)"
          : summary;
        await message.reply(`Session compacted and rotated. Summary:\n> ${out}`);
        await message.react("\u{2705}");
      } else {
        await message.reply("Couldn't generate a summary. Session unchanged.");
      }
    } catch {}
    return;
  }

  if (parsed.command === "model") {
    const choice = parsed.modelChoice;
    try {
      if (choice === "opus") {
        SESSION_MODEL[channelId] = OPUS_MODEL;
        await message.reply(`Model set to **Opus** for this channel.`);
      } else if (choice === "sonnet") {
        SESSION_MODEL[channelId] = DEFAULT_MODEL;
        await message.reply(`Model set to **Sonnet** for this channel.`);
      } else if (choice === "default") {
        delete SESSION_MODEL[channelId];
        await message.reply(`Model reset to default (\`${DEFAULT_MODEL}\`).`);
      } else {
        const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
        await message.reply(`Current model: \`${activeModel}\`\nUsage: \`!model opus\`, \`!model sonnet\`, \`!model reset\``);
      }
      await message.react("\u{2705}");
    } catch {}
    return;
  }

  if (parsed.command === "effort") {
    const level = parsed.effortLevel;
    try {
      if (level === "default") {
        delete SESSION_EFFORT[channelId];
        const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
        const defaultEffort = activeModel === OPUS_MODEL ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET;
        await message.reply(`Effort reset to model default (\`${defaultEffort}\`).`);
      } else if (level === "status") {
        const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
        const isOpus = activeModel === OPUS_MODEL;
        const activeEffort = SESSION_EFFORT[channelId] || (isOpus ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET);
        await message.reply(`Current effort: \`${activeEffort}\`\nUsage: \`!effort low\`, \`!effort medium\`, \`!effort high\`, \`!effort max\`, \`!effort reset\``);
      } else {
        SESSION_EFFORT[channelId] = level;
        await message.reply(`Effort set to **${level}** for this channel.`);
      }
      await message.react("\u{2705}");
    } catch {}
    return;
  }

  if (parsed.command === "status") {
    try {
      const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
      const isOpus = activeModel === OPUS_MODEL;
      const activeEffort = SESSION_EFFORT[channelId] || (isOpus ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET);
      const sessionInfo = await sessionInfoString(SESSIONS[channelId]);
      const customPrompt = SESSION_SYSTEM_PROMPT[channelId];
      const statusText = [
        `**Model:** \`${activeModel}\``,
        `**Effort:** \`${activeEffort}\``,
        `**Session:** ${sessionInfo}`,
        `**Queue:** ${processingQueue.length} pending`,
        customPrompt ? `**System prompt:** ${customPrompt.substring(0, 100)}${customPrompt.length > 100 ? "..." : ""}` : "**System prompt:** none",
      ].join("\n");
      await message.reply(statusText);
    } catch {}
    return;
  }

  if (parsed.command === "retry") {
    const last = LAST_PROMPT[channelId];
    if (!last) {
      try { await message.reply("Nothing to retry. Send a message first."); } catch {}
      return;
    }
    try { await message.react("\u{1F504}"); } catch {}
    processingQueue.push({ message, channelId, content: last.content, parsed: last.parsed, attachmentPaths: last.attachmentPaths || [] });
    if (!isProcessing) processQueue();
    return;
  }

  if (parsed.command === "system") {
    try {
      if (parsed.systemPrompt === null) {
        delete SESSION_SYSTEM_PROMPT[channelId];
        await message.reply("Custom system prompt cleared.");
      } else if (parsed.systemPrompt === "status") {
        const current = SESSION_SYSTEM_PROMPT[channelId];
        await message.reply(current ? `Current system prompt: "${current}"` : "No custom system prompt set.\nUsage: `!system <your instructions>`");
      } else {
        SESSION_SYSTEM_PROMPT[channelId] = parsed.systemPrompt;
        await message.reply(`System prompt set: "${parsed.systemPrompt.substring(0, 200)}${parsed.systemPrompt.length > 200 ? "..." : ""}"`);
      }
      await message.react("\u{2705}");
    } catch {}
    return;
  }

  if (parsed.command === "history") {
    try {
      const sessionId = SESSIONS[channelId];
      if (!sessionId) {
        await message.reply("No active session for this channel.");
        return;
      }
      const info = await sessionInfoString(sessionId);
      await message.reply(`**Session:** ${info}\nResume interactively: \`claude --resume ${sessionId}\``);
    } catch {}
    return;
  }

  if (parsed.command === "dispatch") {
    try {
      const agentsJson = await loadAgentsJson();
      const roles = Object.keys(JSON.parse(agentsJson || "{}"));
      if (!parsed.role || !parsed.task) {
        await message.reply([
          `**Available agents:** ${roles.join(", ")}`,
          "",
          "Usage: `!dispatch <role> <task>`",
          "Example: `!dispatch builder Add a hero section to alpha-coffee`",
        ].join("\n"));
        return;
      }
      if (!roles.includes(parsed.role)) {
        await message.reply(`Unknown agent: \`${parsed.role}\`. Available: ${roles.join(", ")}`);
        await message.react("\u{26A0}\u{FE0F}");
        return;
      }
      await message.react("\u{1F680}");
      // Fresh session per dispatch so the specialist starts clean and its
      // turns don't pollute Ace's conversation history for this channel.
      const dispatchSessionId = randomUUID();
      const channel = CHANNELS[channelId];
      const channelName = channel ? channel.name : channelId;
      const identity = await loadCompactIdentity();
      const dispatchPrompt = `${identity}\n\nChannel: #${channelName}\nYou are operating as the **${parsed.role}** specialist via !dispatch. Follow the role definition exactly.`;
      const args = [
        "--print",
        "--permission-mode", "bypassPermissions",
        "--session-id", dispatchSessionId,
        "--model", OPUS_MODEL,
        "--effort", DEFAULT_EFFORT_OPUS,
        "--agents", agentsJson,
        "--agent", parsed.role,
        "--append-system-prompt", dispatchPrompt,
      ];
      const fakeParsed = { content: parsed.task };
      const claudeInput = { args, prompt: parsed.task };
      LAST_PROMPT[channelId] = { content: parsed.task, parsed: { model: OPUS_MODEL, content: parsed.task, effort: DEFAULT_EFFORT_OPUS }, attachmentPaths: [] };
      processingQueue.push({ message, channelId, content: parsed.task, parsed: fakeParsed, attachmentPaths: [], preBuiltInput: claudeInput, label: `dispatch:${parsed.role}` });
      if (!isProcessing) processQueue();
    } catch (err) {
      try { await message.reply(`Dispatch error: \`${err.message.substring(0, 200)}\``); } catch {}
    }
    return;
  }

  if (parsed.command === "help") {
    const activeModel = SESSION_MODEL[channelId] || DEFAULT_MODEL;
    const isOpus = activeModel === OPUS_MODEL;
    const activeEffort = SESSION_EFFORT[channelId] || (isOpus ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET);
    const helpText = [
      "**Commands**",
      "",
      "`!model` - Set/view the model for this channel",
      "`!effort` - Set/view thinking effort (low/medium/high/max)",
      "`!status` - Show current channel settings",
      "`!retry` - Re-send the last message to Claude",
      "`!system <prompt>` - Set a custom system prompt",
      "`!history` - Show conversation history info",
      "`!opus <message>` - Send a single message with Opus",
      "`!dispatch <role> <task>` - Run a specialist subagent (builder/qa/scout/...)",
      "`!clear` - Clear conversation history (rotates session)",
      "`!compact` - Summarize the session, then rotate it",
      "`!errors` - Show channels with consecutive failures",
      "`!resume` - Re-enable a channel that was auto-paused",
      "`!help` - Show this message",
      "",
      "**Attachments** - Send images or files with your message to analyze them",
      "",
      `Current: \`${activeModel}\` | Effort: \`${activeEffort}\``,
    ].join("\n");
    try { await message.reply(helpText); } catch {}
    return;
  }

  // ─── Download attachments ──────────────────────────────────────────
  const attachmentPaths = [];
  if (message.attachments.size > 0) {
    for (const [, attachment] of message.attachments) {
      try {
        const filePath = await downloadAttachment(attachment.url, attachment.name);
        attachmentPaths.push(filePath);
        console.log(`[ACE] Downloaded: ${attachment.name}`);
      } catch (err) {
        console.error(`[ACE] Failed to download ${attachment.name}: ${err.message}`);
      }
    }
  }

  if (!parsed.content && attachmentPaths.length > 0) {
    parsed.content = "Analyze the attached file(s).";
  }

  try { await message.react("\u{1F9E0}"); } catch {}

  // Session-id persistence handles the conversation history; we only keep
  // the last raw prompt around so !retry can re-run it.
  LAST_PROMPT[channelId] = { content, parsed: { ...parsed }, attachmentPaths };
  processingQueue.push({ message, channelId, content, parsed, attachmentPaths });
  if (!isProcessing) processQueue();
});

async function processQueue() {
  isProcessing = true;

  while (processingQueue.length > 0) {
    const item = processingQueue.shift();
    const { message, channelId, content, parsed, attachmentPaths, preBuiltInput, label } = item;

    // Resolve model: explicit (e.g. !opus) > runtime !model override
    // > config.modelByChannel default > global default.
    if (!parsed.model) {
      parsed.model = SESSION_MODEL[channelId]
        || (config.modelByChannel && config.modelByChannel[channelId])
        || DEFAULT_MODEL;
    }

    // Apply effort: explicit > session override > model default
    if (!parsed.effort) {
      const isOpus = parsed.model === OPUS_MODEL;
      const defaultEffort = isOpus ? DEFAULT_EFFORT_OPUS : DEFAULT_EFFORT_SONNET;
      parsed.effort = SESSION_EFFORT[channelId] || defaultEffort;
    }

    const startedAt = Date.now();
    const channelName = CHANNELS[channelId]?.name || channelId;
    let response = "";
    let runError = null;
    try {
      // !dispatch supplies a fully built claudeInput so the specialist runs
      // in its own session with --agent applied; otherwise build normally.
      const claudeInput = preBuiltInput || await buildClaudeInput(channelId, parsed, attachmentPaths);
      const attachLabel = attachmentPaths.length > 0 ? ` +${attachmentPaths.length} files` : "";
      const tag = label ? `[${label}] ` : "";
      console.log(`[ACE] ${tag}#${channelName}: "${parsed.content.substring(0, 50)}..."${attachLabel} [${parsed.model}]`);

      response = await callClaudeStreaming(claudeInput, message);

      // Success path resets the consecutive-error counter for this channel.
      delete ERROR_COUNTS[channelId];

      try {
        const reactions = message.reactions.cache.get("\u{1F9E0}");
        if (reactions) await reactions.users.remove(client.user.id);
        await message.react("\u{2705}");
      } catch {}

      // Log to daily file (legacy, human-readable; kept alongside JSONL).
      const dateStr = new Date().toISOString().split("T")[0];
      const memoryDir = path.join(WORKSPACE, "memory");
      if (!existsSync(memoryDir)) await mkdir(memoryDir, { recursive: true });
      const logPath = path.join(memoryDir, `${dateStr}.md`);

      const logEntry = `\n## Discord - ${new Date().toLocaleTimeString("en-US", { hour12: false })}\n**Channel:** ${channelName}\n**User:** ${content.substring(0, 100)}\n**Assistant:** ${(response || "").substring(0, 200)}\n`;

      try { await appendFile(logPath, logEntry); } catch {}

      console.log(`[ACE] Done in #${channelName}`);
    } catch (error) {
      runError = error;
      console.error("[ACE] Error:", error.message);
      ERROR_COUNTS[channelId] = (ERROR_COUNTS[channelId] || 0) + 1;
      const count = ERROR_COUNTS[channelId];
      try {
        await message.reply(`Error: \`${error.message.substring(0, 200)}\``);
        const reactions = message.reactions.cache.get("\u{1F9E0}");
        if (reactions) await reactions.users.remove(client.user.id);
        await message.react("\u{274C}");
        if (count === ERROR_THRESHOLD_WARN) {
          await message.reply(`\u{26A0}\u{FE0F} ${ERROR_THRESHOLD_WARN} consecutive errors in #${channelName}. One more strike and the channel will be paused.`);
        }
        if (count >= ERROR_THRESHOLD_PAUSE && !PAUSED[channelId]) {
          PAUSED[channelId] = true;
          await message.reply(`\u{1F6D1} Channel #${channelName} paused after ${count} consecutive errors. Send \`!resume\` to re-enable.`);
        }
      } catch {}
    }

    // Structured run log (fire-and-forget). Captures every turn regardless
    // of outcome so latency, error rate, and per-channel volume are queryable.
    logRun({
      ts: new Date().toISOString(),
      channel: channelName,
      channelId,
      model: parsed.model,
      effort: parsed.effort,
      sessionId: SESSIONS[channelId] || null,
      label: label || null,
      durationMs: Date.now() - startedAt,
      promptLen: (content || "").length,
      responseLen: (response || "").length,
      attachments: attachmentPaths.length,
      ok: !runError,
      err: runError ? runError.message.substring(0, 200) : null,
    });
  }

  isProcessing = false;
}

// ─── Error Handling ───────────────────────────────────────────────────
client.on("error", (error) => {
  console.error("[ACE] Discord error:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("[ACE] Unhandled rejection:", error);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[ACE] ${signal} received, shutting down...`);
  for (const proc of activeProcesses) {
    try { proc.kill("SIGTERM"); } catch {}
  }
  client.destroy();
  setTimeout(() => {
    for (const proc of activeProcesses) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    process.exit(0);
  }, 3000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start ────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);
