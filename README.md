# Ace Discord Bridge

A Discord bot that bridges your messages to [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI with real-time streaming responses. Talk to Claude from anywhere through Discord.

## Why

If you're using Claude Code (Pro/Max subscription) and want to access Claude from your phone, another device, or just prefer Discord as your interface, this bot gives you that without any third-party services or additional API costs.

## Features

- **Streaming responses** - See Claude's response build in real-time as it types
- **Channel context** - Each Discord channel can have its own context (e.g., "work", "personal", "project-x")
- **Conversation history** - Keeps recent messages in memory so Claude has context
- **Model switching** - Default to Sonnet for speed, switch to Opus with `!opus` when you need it
- **Slash commands** - `/opus`, `/clear`, `/compact`, `/help`
- **Attachments** - Send images or files and Claude will analyze them
- **History compaction** - Summarize conversation history instead of clearing it
- **Graceful shutdown** - Cleans up child processes on restart
- **Daily logging** - Logs conversations to markdown files for reference

## Requirements

- macOS (for launchd auto-start) or any OS with Node.js
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and authenticated
- A Claude Pro or Max subscription
- Node.js 18+
- A Discord bot token ([create one here](https://discord.com/developers/applications))

## Setup

### 1. Clone and install

```bash
git clone https://github.com/wamelinkwebdesign/ace-discord-bridge.git
cd ace-discord-bridge
npm install
```

### 2. Configure

```bash
cp config.example.json config.json
```

Edit `config.json` with your values:

- `botToken` - Your Discord bot token
- `userId` - Your Discord user ID (the bot only responds to this user)
- `guildId` - Your Discord server ID (for registering slash commands)
- `workspace` - Path to a workspace directory (Claude Code will use this as its working directory)
- `channels` - Map of channel IDs to names and context descriptions

### 3. Create a workspace

```bash
mkdir -p ~/.claude-workspace
```

Optionally add identity files that Claude will use:
- `CLAUDE-SHORT.md` - Compact identity/personality instructions
- `SOUL.md` - Longer identity definition
- `USER.md` - Info about you for personalized responses
- `MEMORY.md` - Persistent memory file

### 4. Run

```bash
npm start
```

### 5. Auto-start on macOS (optional)

```bash
cp com.ace.discord-bridge.example.plist ~/Library/LaunchAgents/com.ace.discord-bridge.plist
```

Edit the plist to update paths, then:

```bash
launchctl load ~/Library/LaunchAgents/com.ace.discord-bridge.plist
```

## Commands

| Command | Description |
|---------|-------------|
| `!opus <message>` or `/opus` | Use Opus model for deeper reasoning |
| `!clear` or `/clear` | Clear conversation history for the channel |
| `!compact` or `/compact` | Summarize history into a short context |
| `!help` or `/help` | Show available commands |

Regular messages are processed with the default model (Sonnet). Just type normally.

## How It Works

```
Discord message
  -> Bot receives it (filtered to your user ID only)
  -> Downloads any attachments
  -> Builds a prompt with channel context + conversation history
  -> Spawns `claude --print` with the prompt piped via stdin
  -> Streams stdout chunks back to Discord in real-time
  -> Edits the Discord message as more content arrives
```

The bot uses Claude Code's `--print` mode, which means Claude has access to all your configured Claude Code plugins, MCP servers, and tools. Whatever you can do in your terminal with `claude`, you can do through Discord.

## Configuration

The `config.json` file supports these options:

| Key | Description | Default |
|-----|-------------|---------|
| `botToken` | Discord bot token | required |
| `userId` | Your Discord user ID | required |
| `guildId` | Discord server ID | required |
| `workspace` | Claude Code working directory | `~/.claude-workspace` |
| `defaultModel` | Default model for regular messages | `claude-sonnet-4-6` |
| `opusModel` | Model used with `!opus` | `claude-opus-4-6` |
| `maxTurnsSonnet` | Max agentic turns for Sonnet | `5` |
| `maxTurnsOpus` | Max agentic turns for Opus | `5` |
| `rateLimitMs` | Minimum ms between Claude calls | `3000` |
| `firstSendDelayMs` | Wait before sending first message | `2000` |
| `editIntervalMs` | Throttle between message edits | `1500` |
| `channels` | Channel ID to context mapping | `{}` |

## Security

- The bot only responds to the configured `userId`
- Runs with `--permission-mode bypassPermissions` so Claude can take actions autonomously
- Keep your `config.json` private (it's in `.gitignore`)
- Your Discord bot token should never be committed to git
- The bot runs with your user permissions, so Claude has the same file/system access you do

## License

MIT
