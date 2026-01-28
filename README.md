# WOPR Discord Plugin

Discord bot integration for WOPR - enables AI conversations in Discord channels with full context awareness.

## Features

- **@mention responses** - Bot responds when mentioned
- **Reaction feedback** - 👀 (processing) → ✅ (done) or ❌ (error)
- **Full conversation context** - Captures all channel messages for context
- **@everyone/@here ignored** - Only responds to direct mentions
- **Per-channel sessions** - Each Discord channel has its own WOPR session
- **TypeScript** - Written in TypeScript with full type support

## Installation

```bash
wopr plugin install github:TSavo/wopr-plugin-discord
wopr plugin enable wopr-plugin-discord
```

## Configuration

Set your Discord bot token:

```bash
wopr config set discord.token YOUR_BOT_TOKEN
```

Or via the plugin config:

```bash
wopr config set plugins.data.wopr-plugin-discord.token YOUR_BOT_TOKEN
```

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section
4. Enable "MESSAGE CONTENT INTENT"
5. Enable "SERVER MEMBERS INTENT"
6. Copy the bot token
7. Add the bot to your server via OAuth2 URL Generator

## Usage

Once configured and the daemon is running:

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
