# WOPR Discord Plugin

[![npm version](https://img.shields.io/npm/v/wopr-plugin-discord.svg)](https://www.npmjs.com/package/wopr-plugin-discord)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)

Discord bot integration for [WOPR](https://github.com/TSavo/wopr) - enables AI conversations in Discord channels with full context awareness.

> Part of the [WOPR](https://github.com/TSavo/wopr) ecosystem - Self-sovereign AI session management over P2P.

## Features

- **Slash Commands** - 13 native Discord slash commands for full control
- **Model Switching** - Switch between Haiku, Sonnet, and Opus models
- **@mention Responses** - Bot responds when mentioned
- **Reaction Feedback** - Custom emoji reactions (configurable per agent identity)
- **Full Conversation Context** - Captures all channel messages for context
- **Session Management** - Per-channel sessions with reset/compact commands
- **Owner Pairing** - Secure pairing code system for bot ownership
- **Friend Request Buttons** - Interactive Accept/Deny buttons for P2P friend requests
- **Attachment Handling** - Automatic download and processing of file attachments
- **Bot-to-Bot Flow Control** - Smart message queue with human priority
- **Channel Provider API** - Extensibility for other plugins to register commands
- **TypeScript** - Written in TypeScript with full type support

## Installation

```bash
wopr plugin install github:TSavo/wopr-plugin-discord
wopr plugin enable wopr-plugin-discord
```

## Configuration

### Required Settings

```bash
# Bot token (from Discord Developer Portal -> Bot)
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_BOT_TOKEN"

# Application ID (from Discord Developer Portal -> General Information)
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_APPLICATION_ID"
```

### Optional Settings

```bash
# Restrict to specific guild (faster command registration during development)
wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_GUILD_ID"

# Owner User ID (receives friend request notifications)
wopr config set plugins.data.wopr-plugin-discord.ownerUserId "YOUR_USER_ID"
```

### Legacy Config

```bash
# Old style config (still supported)
wopr config set discord.token YOUR_BOT_TOKEN
wopr config set discord.clientId YOUR_CLIENT_ID
wopr config set discord.guildId YOUR_GUILD_ID
```

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section
4. Enable **MESSAGE CONTENT INTENT**
5. Enable **SERVER MEMBERS INTENT**
6. Copy the bot token
7. Note the **Application ID** (for slash commands)
8. Add the bot to your server via OAuth2 URL Generator:
   - Select `bot` scope
   - Select `applications.commands` scope
   - Required permissions: Send Messages, Read Message History, Add Reactions

## Slash Commands

| Command | Description | Options |
|---------|-------------|---------|
| `/wopr <message>` | Send a message to WOPR | `message` (required) |
| `/status` | Show session status and configuration | - |
| `/new` | Start a new session (reset conversation) | - |
| `/reset` | Alias for /new | - |
| `/compact` | Compact session context (summarize) | - |
| `/think <level>` | Set thinking level | `off/minimal/low/medium/high/xhigh` |
| `/verbose <enabled>` | Toggle verbose mode | `true/false` |
| `/usage <mode>` | Set usage tracking display | `off/tokens/full` |
| `/model <model>` | Switch AI model | `haiku/sonnet/opus` |
| `/session <name>` | Switch to a named session | `name` (required) |
| `/cancel` | Cancel the current AI response | - |
| `/claim <code>` | Claim bot ownership (DM only) | `code` (required) |
| `/help` | Show available commands | - |

### Example Usage

```
/wopr Explain quantum computing
/think high
/model opus
/wopr Solve this complex problem
/status
/cancel
/reset
```

## Usage (Mentions)

Mention the bot directly in any channel:

```
@WOPR Hello! What's your name?
```

The bot will:
1. Add reaction emoji (configurable per agent identity)
2. Send message to WOPR session with conversation context
3. Stream the AI response in real-time
4. Remove processing reaction on completion

### Conversation Context

The plugin captures **all** messages in the channel (not just @mentions) and includes them as context. This enables natural conversation:

```
User: My name is Alice
User: I work at Acme Corp
User: @WOPR What do you know about me?
Bot: You're Alice and you work at Acme Corp!
```

The bot maintains a buffer of recent messages (up to 20) for context building.

## Session Keys

Sessions are automatically named based on the channel:

| Channel Type | Session Key Format |
|--------------|-------------------|
| Guild channel | `discord:guild-name:#channel-name` |
| Thread | `discord:guild-name:#parent-channel/thread-name` |
| DM | `discord:dm:username` |

Examples:
- `discord:my-server:#general`
- `discord:my-server:#dev/feature-discussion`
- `discord:dm:alice`

## Owner Pairing

When the bot has no owner configured, DMing the bot generates a pairing code:

1. DM the bot (any message)
2. Receive a pairing code: `Your pairing code is: ABCD1234`
3. Claim ownership: `wopr discord claim ABCD1234`
4. Or use the slash command in DM: `/claim ABCD1234`

The owner receives:
- Friend request notifications with Accept/Deny buttons
- Private DM notifications for important events

## Attachments

The plugin automatically handles Discord attachments:

1. Attachments are downloaded to `/data/attachments/` (or `./attachments/`)
2. File paths are appended to the message
3. WOPR can then process images and files

File naming: `timestamp-userId-originalname`

## Bot-to-Bot Communication

The plugin includes intelligent bot-to-bot flow control:

- **Human Priority**: Human messages take immediate priority
- **Cooldown**: 5 second cooldown between bot responses
- **Typing Detection**: Pauses when humans are typing (15s window)
- **Context Buffer**: Accumulates conversation context between responses

## Channel Provider API

The plugin exposes a Channel Provider interface for other plugins:

```typescript
// Other plugins can register commands
discordProvider.registerCommand({
  name: "mycommand",
  description: "My custom command",
  handler: async (ctx) => {
    await ctx.reply("Hello from my plugin!");
  }
});

// Or register message parsers
discordProvider.addMessageParser({
  id: "my-parser",
  pattern: /PATTERN:.+/,
  handler: async (ctx) => {
    // Process matching messages
  }
});
```

## Troubleshooting

**Bot doesn't respond:**
- Check daemon is running: `wopr daemon status`
- Check logs: `wopr daemon logs | grep -i discord`
- Verify token: `wopr config get plugins.data.wopr-plugin-discord`

**Slash commands not appearing:**
- Verify `clientId` is set correctly
- Wait up to 1 hour for global propagation, or set `guildId` for instant registration
- Check that bot was invited with `applications.commands` scope

**Bot responds to @everyone:**
- Should not happen in current version - the bot checks `message.mentions.users.has(botId)`

**Session key format:**
- Sessions use format `discord:guildname:#channelname`, not channel IDs
- Check with: `wopr session list | grep discord`

**Attachments not processing:**
- Check `/data/attachments/` directory exists and is writable
- Check daemon logs for download errors

## Documentation

- [docs/COMMANDS.md](docs/COMMANDS.md) - Detailed command reference
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - Configuration options
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - Common issues

## License

MIT
