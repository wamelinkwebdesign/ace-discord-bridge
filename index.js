import { Client, GatewayIntentBits, Partials, ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";
import { spawn } from "child_process";
import { readFile, mkdir, appendFile } from "fs/promises";
import { existsSync, createWriteStream, readFileSync } from "fs";
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
const MAX_TURNS_DEFAULT = config.maxTurnsSonnet || 5;
const MAX_TURNS_OPUS = config.maxTurnsOpus || 5;
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
const HISTORY_CACHE = {};
const MAX_HISTORY = 8;

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

// ─── Smart Memory Loading ─────────────────────────────────────────────
const MEMORY_KEYWORDS = [
  "memory", "remember", "when did", "what happened", "status",
  "pipeline", "lead", "prospect", "last time", "previous",
];
function needsMemory(content) {
  const lower = content.toLowerCase();
  return MEMORY_KEYWORDS.some(kw => lower.includes(kw));
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

// ─── Compact History ──────────────────────────────────────────────────
async function compactHistory(channelId) {
  const history = HISTORY_CACHE[channelId];
  if (!history || history.length < 3) return null;

  const conversation = history.map(m => `${m.sender}: ${m.content}`).join("\n");
  const summaryPrompt = `Summarize this conversation in 2-3 short sentences. Focus on key topics discussed, decisions made, and any open questions. Be concise.\n\n${conversation}`;

  return new Promise((resolve) => {
    let output = "";
    const proc = spawn(CLAUDE_CMD, [
      "--print",
      "--permission-mode", "bypassPermissions",
      "--model", DEFAULT_MODEL,
      "--max-turns", "1",
      summaryPrompt,
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
        HISTORY_CACHE[channelId] = [{
          sender: "System",
          content: `[Previous conversation summary] ${summary}`,
        }];
        resolve(summary);
      } else {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));

    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(null);
    }, 30000);
  });
}

// ─── Parse Message ────────────────────────────────────────────────────
function parseMessage(content) {
  const trimmed = content.trim();

  if (trimmed === "!compact") return { command: "compact" };
  if (trimmed === "!clear") return { command: "clear" };
  if (trimmed === "!help") return { command: "help" };

  if (trimmed.startsWith("!opus ")) {
    return { model: OPUS_MODEL, content: trimmed.slice(6).trim(), maxTurns: MAX_TURNS_OPUS };
  }

  return { model: DEFAULT_MODEL, content: trimmed, maxTurns: MAX_TURNS_DEFAULT };
}

// ─── Build Claude Input ───────────────────────────────────────────────
async function buildClaudeInput(channelId, parsed, attachmentPaths) {
  const channel = CHANNELS[channelId];
  const channelName = channel ? channel.name : channelId;
  const channelContext = channel ? channel.context : "";

  const identity = await loadCompactIdentity();

  let memoryContent = "";
  if (needsMemory(parsed.content)) {
    const memoryPath = path.join(WORKSPACE, "MEMORY.md");
    if (existsSync(memoryPath)) {
      try {
        const mem = await readFile(memoryPath, "utf-8");
        memoryContent = mem.length > 8000 ? mem.substring(0, 8000) + "\n...(truncated)" : mem;
      } catch {}
    }
    const dateStr = new Date().toISOString().split("T")[0];
    const dailyPath = path.join(WORKSPACE, "memory", `${dateStr}.md`);
    if (existsSync(dailyPath)) {
      try {
        memoryContent += "\n\n--- Today's notes ---\n" + await readFile(dailyPath, "utf-8");
      } catch {}
    }
  }

  const history = HISTORY_CACHE[channelId] || [];
  const historyContext = history.length > 0
    ? `Recent conversation:\n${history.map(m => `${m.sender}: ${m.content}`).join("\n")}`
    : "";

  let systemPrompt = `${identity}\n\nChannel: #${channelName}\n${channelContext ? "Context: " + channelContext : ""}\n${historyContext ? historyContext + "\n\n" : ""}`;

  if (memoryContent) {
    systemPrompt += `--- MEMORY CONTEXT ---\n${memoryContent}\n\n`;
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

  const args = [
    "--print",
    "--permission-mode", "bypassPermissions",
    "--model", parsed.model,
    "--max-turns", String(parsed.maxTurns),
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
          const overflow = fullText.substring(currentChunkStart).trim();
          if (overflow) {
            sentMessage = await message.reply(overflow.substring(0, DISCORD_MAX_LENGTH));
          } else {
            sentMessage = null;
          }
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
      clearTimeout(timeout);
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
              const remaining = finalText.substring(DISCORD_MAX_LENGTH).trim();
              if (remaining) {
                await message.reply(remaining.substring(0, DISCORD_MAX_LENGTH));
              }
            } else {
              await sentMessage.edit(finalText);
            }
          } else {
            await message.reply(finalText.substring(0, DISCORD_MAX_LENGTH));
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
      clearTimeout(timeout);
      cleanup();
      reject(err);
    });

    const isOpus = args.includes(OPUS_MODEL);
    const timeoutMs = isOpus ? 600000 : 300000;
    const timeoutLabel = isOpus ? "10 minutes" : "5 minutes";

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      activeProcesses.delete(proc);
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);

      if (fullText.trim()) {
        try {
          if (sentMessage) {
            sentMessage.edit(fullText.substring(currentChunkStart).trim() + "\n\n_(timed out, response may be incomplete)_");
          }
        } catch {}
        resolve(fullText.trim());
      } else {
        reject(new Error(`Claude timed out after ${timeoutLabel}`));
      }
    }, timeoutMs);
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
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      activeProcesses.delete(proc);
      clearTimeout(timeout);
      reject(err);
    });

    const timeout = setTimeout(() => {
      activeProcesses.delete(proc);
      proc.kill("SIGTERM");
      if (stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error("Claude timed out"));
      }
    }, 600000);
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
    .setName("help")
    .setDescription("Show available commands"),
];

client.on("ready", async () => {
  console.log(`[ACE] Bridge bot online as ${client.user.tag}`);
  console.log(`[ACE] Default: ${DEFAULT_MODEL} | Channels: ${Object.keys(CHANNELS).length}`);

  try {
    const rest = new REST().setToken(BOT_TOKEN);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: slashCommands.map(cmd => cmd.toJSON()) },
    );
    console.log(`[ACE] Slash commands registered: /opus, /clear, /compact, /help`);
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
    HISTORY_CACHE[channelId] = [];
    await interaction.reply("History cleared for this channel.");
    return;
  }

  if (command === "compact") {
    const history = HISTORY_CACHE[channelId];
    if (!history || history.length < 3) {
      await interaction.reply("Not enough history to compact (need at least 3 messages).");
      return;
    }
    await interaction.deferReply();
    const msgCount = history.length;
    const summary = await compactHistory(channelId);
    if (summary) {
      await interaction.editReply(`Compacted ${msgCount} messages into summary:\n> ${summary}`);
    } else {
      await interaction.editReply("Couldn't generate a summary. History unchanged.");
    }
    return;
  }

  if (command === "help") {
    const helpText = [
      "**Commands**",
      "",
      "`/opus <message>` - Use Opus model (deeper reasoning)",
      "`/clear` - Clear conversation history for this channel",
      "`/compact` - Summarize conversation history into a short context",
      "`/help` - Show this message",
      "",
      "Also works as prefix commands: `!opus`, `!clear`, `!compact`, `!help`",
      "",
      "**Attachments** - Send images or files with your message to analyze them",
      "",
      `Default model: \`${DEFAULT_MODEL}\``,
    ].join("\n");
    await interaction.reply(helpText);
    return;
  }

  if (command === "opus") {
    const userMessage = interaction.options.getString("message");

    if (!HISTORY_CACHE[channelId]) HISTORY_CACHE[channelId] = [];
    HISTORY_CACHE[channelId].push({
      sender: interaction.user.username,
      content: userMessage.substring(0, 200),
    });
    if (HISTORY_CACHE[channelId].length > MAX_HISTORY) {
      HISTORY_CACHE[channelId] = HISTORY_CACHE[channelId].slice(-MAX_HISTORY);
    }

    await interaction.deferReply();

    try {
      const parsed = { model: OPUS_MODEL, content: userMessage, maxTurns: MAX_TURNS_OPUS };
      const claudeInput = await buildClaudeInput(channelId, parsed, []);
      console.log(`[ACE] /opus in #${CHANNELS[channelId]?.name || channelId}: "${userMessage.substring(0, 50)}..."`);

      const response = await callClaudeSimple(claudeInput);

      if (!response) {
        await interaction.editReply("Got an empty response. Try rephrasing?");
        return;
      }

      HISTORY_CACHE[channelId].push({
        sender: "Assistant",
        content: response.substring(0, 200),
      });

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

  // ─── Handle commands ───────────────────────────────────────────────
  if (parsed.command === "clear") {
    HISTORY_CACHE[channelId] = [];
    try {
      await message.react("\u{1F9F9}");
      await message.reply("History cleared for this channel.");
    } catch {}
    return;
  }

  if (parsed.command === "compact") {
    try {
      const history = HISTORY_CACHE[channelId];
      if (!history || history.length < 3) {
        await message.reply("Not enough history to compact (need at least 3 messages).");
        await message.react("\u{26A0}\u{FE0F}");
        return;
      }
      await message.react("\u{1F504}");
      const msgCount = history.length;
      const summary = await compactHistory(channelId);
      if (summary) {
        await message.reply(`Compacted ${msgCount} messages into summary:\n> ${summary}`);
        await message.react("\u{2705}");
      } else {
        await message.reply("Couldn't generate a summary. History unchanged.");
      }
    } catch {}
    return;
  }

  if (parsed.command === "help") {
    const helpText = [
      "**Commands**",
      "",
      "`!opus <message>` - Use Opus model (deeper reasoning)",
      "`!clear` - Clear conversation history for this channel",
      "`!compact` - Summarize conversation history into a short context",
      "`!help` - Show this message",
      "",
      "**Attachments** - Send images or files with your message to analyze them",
      "",
      `Default model: \`${DEFAULT_MODEL}\``,
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
    parsed.model = parsed.model || DEFAULT_MODEL;
    parsed.maxTurns = parsed.maxTurns || MAX_TURNS_DEFAULT;
  }

  // Add to history
  if (!HISTORY_CACHE[channelId]) HISTORY_CACHE[channelId] = [];
  HISTORY_CACHE[channelId].push({
    sender: message.author.username,
    content: content.substring(0, 200),
  });
  if (HISTORY_CACHE[channelId].length > MAX_HISTORY) {
    HISTORY_CACHE[channelId] = HISTORY_CACHE[channelId].slice(-MAX_HISTORY);
  }

  try { await message.react("\u{1F9E0}"); } catch {}

  processingQueue.push({ message, channelId, content, parsed, attachmentPaths });
  if (!isProcessing) processQueue();
});

async function processQueue() {
  isProcessing = true;

  while (processingQueue.length > 0) {
    const { message, channelId, content, parsed, attachmentPaths } = processingQueue.shift();

    try {
      const claudeInput = await buildClaudeInput(channelId, parsed, attachmentPaths);
      const attachLabel = attachmentPaths.length > 0 ? ` +${attachmentPaths.length} files` : "";
      console.log(`[ACE] #${CHANNELS[channelId]?.name || channelId}: "${parsed.content.substring(0, 50)}..."${attachLabel} [${parsed.model}]`);

      const response = await callClaudeStreaming(claudeInput, message);

      if (response) {
        if (!HISTORY_CACHE[channelId]) HISTORY_CACHE[channelId] = [];
        HISTORY_CACHE[channelId].push({
          sender: "Assistant",
          content: response.substring(0, 200),
        });
        if (HISTORY_CACHE[channelId].length > MAX_HISTORY) {
          HISTORY_CACHE[channelId] = HISTORY_CACHE[channelId].slice(-MAX_HISTORY);
        }
      }

      try {
        const reactions = message.reactions.cache.get("\u{1F9E0}");
        if (reactions) await reactions.users.remove(client.user.id);
        await message.react("\u{2705}");
      } catch {}

      // Log to daily file
      const dateStr = new Date().toISOString().split("T")[0];
      const memoryDir = path.join(WORKSPACE, "memory");
      if (!existsSync(memoryDir)) await mkdir(memoryDir, { recursive: true });
      const logPath = path.join(memoryDir, `${dateStr}.md`);

      const logEntry = `\n## Discord - ${new Date().toLocaleTimeString("en-US", { hour12: false })}\n**Channel:** ${CHANNELS[channelId]?.name || channelId}\n**User:** ${content.substring(0, 100)}\n**Assistant:** ${(response || "").substring(0, 200)}\n`;

      try { await appendFile(logPath, logEntry); } catch {}

      console.log(`[ACE] Done in #${CHANNELS[channelId]?.name || channelId}`);
    } catch (error) {
      console.error("[ACE] Error:", error.message);
      try {
        await message.reply(`Error: \`${error.message.substring(0, 200)}\``);
        const reactions = message.reactions.cache.get("\u{1F9E0}");
        if (reactions) await reactions.users.remove(client.user.id);
        await message.react("\u{274C}");
      } catch {}
    }
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
