# WOPR Discord Plugin

[![npm version](https://img.shields.io/npm/v/wopr-plugin-discord.svg)](https://www.npmjs.com/package/wopr-plugin-discord)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)

Discord bot integration for [WOPR](https://github.com/TSavo/wopr) - enables AI conversations in Discord channels with full context awareness.

> Part of the [WOPR](https://github.com/TSavo/wopr) ecosystem - Self-sovereign AI session management over P2P.

## Features

- **Slash Commands** - Native Discord slash commands (/wopr, /status, /reset, etc.)
- **@mention responses** - Bot responds when mentioned
- **Reaction feedback** - 👀 (processing) → ✅ (done) or ❌ (error)
- **Full conversation context** - Captures all channel messages for context
- **Session management** - Per-channel sessions with reset/compact commands
- **@everyone/@here ignored** - Only responds to direct mentions
- **Per-channel sessions** - Each Discord channel has its own WOPR session
- **TypeScript** - Written in TypeScript with full type support

## Installation

```bash
wopr plugin install github:TSavo/wopr-plugin-discord
wopr plugin enable wopr-plugin-discord
```

## Configuration

### Required Settings

```bash
# Bot token (from Discord Developer Portal → Bot)
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_BOT_TOKEN"

# Application ID (from Discord Developer Portal → General Information)
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_APPLICATION_ID"
```

### Optional Settings

```bash
# Restrict to specific guild (for faster command registration during development)
wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_GUILD_ID"
```

### Legacy Config

```bash
# Old style config (still supported)
wopr config set discord.token YOUR_BOT_TOKEN
```

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section
4. Enable "MESSAGE CONTENT INTENT"
5. Enable "SERVER MEMBERS INTENT"
6. Copy the bot token
7. Note the **Application ID** (for slash commands)
8. Add the bot to your server via OAuth2 URL Generator
   - Enable `applications.commands` scope for slash commands

## Slash Commands

The plugin registers native Discord slash commands for easy interaction:

| Command | Description | Options |
|---------|-------------|---------|
| `/wopr <message>` | Send a message to WOPR | `message` (required) |
| `/status` | Show session status | - |
| `/new` | Start a new session (reset) | - |
| `/reset` | Alias for /new | - |
| `/compact` | Summarize conversation context | - |
| `/think <level>` | Set thinking level | `off/minimal/low/medium/high/xhigh` |
| `/verbose <enabled>` | Toggle verbose mode | `true/false` |
| `/usage <mode>` | Set usage tracking | `off/tokens/full` |
| `/session <name>` | Switch to named session | `name` (required) |
| `/help` | Show available commands | - |

### Example Usage

```
/wopr Explain quantum computing
/think high
/wopr Solve this complex problem
/status
/reset
```

## Usage (Mentions)

You can also mention the bot directly:

```
@WOPR Hello! What's your name?
```

The bot will:
1. Add 👀 reaction (processing)
2. Send message to WOPR session
3. Get AI response
4. Remove 👀, add ✅
5. Reply with the response

### Conversation Context

The plugin captures **all** messages in the channel (not just @mentions) and logs them to the session context. This means:

```
User: My name is Alice
User: @WOPR What's my name?
Bot: Your name is Alice!
```

The bot sees the full conversation history.

## How It Works

### Message Handling

| Message Type | Action |
|--------------|--------|
| Direct @mention | Respond + log to context |
| @everyone/@here | Ignored (not a direct mention) |
| Regular message | Log to context only |

### Session Mapping

Each Discord channel maps to a WOPR session:
- Channel `#general` → Session `discord-<channel-id>`
- Sessions are auto-created on first use
- Context persists across restarts

### Reactions

- **👀** - Processing (added immediately)
- **✅** - Success (replaces 👀)
- **❌** - Error (replaces 👀)

## Plugin API

This plugin demonstrates the WOPR plugin API:

```typescript
// Inject (gets AI response)
const response = await ctx.inject(
  sessionId,
  message,
  { from: username, channel: {...} }
);

// Log (adds to context without AI response)
ctx.logMessage(
  sessionId,
  message,
  { from: username }
);
```

## Troubleshooting

**Bot doesn't respond:**
- Check daemon is running: `wopr daemon status`
- Check logs: `wopr daemon logs`
- Verify token: `wopr config get discord.token`

**Bot responds to @everyone:**
- Make sure you're using a recent version (v2.0.7+)
- The bot checks `message.mentions.users.has(botId)`

**No conversation context:**
- Check `wopr session show discord-<channel-id>`
- Verify messages are being logged to conversation history

## License

MIT
