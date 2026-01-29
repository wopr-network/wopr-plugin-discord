# Discord Plugin Configuration

Complete configuration reference for the WOPR Discord plugin.

## Quick Reference

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `token` | string | **Yes** | - | Discord bot token |
| `applicationId` | string | No | - | Discord application ID |
| `publicKey` | string | No | - | For interaction verification |
| `sessionMapping` | object | No | `{}` | Channel → session mapping |
| `dmPolicy` | string | No | `"pairing"` | DM handling mode |
| `allowFrom` | string[] | No | `[]` | Allowed user IDs |
| `enableReactions` | boolean | No | `true` | Show 👀/✅ reactions |
| `enableTyping` | boolean | No | `true` | Show typing indicator |
| `maxContextMessages` | number | No | `50` | Messages for context |
| `responseChunkSize` | number | No | `2000` | Max chars per message |
| `commandPrefix` | string | No | `"!"` | Prefix for commands |

## Configuration Methods

### 1. Via WOPR Config

```bash
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
```

### 2. Via Environment Variable

```bash
export DISCORD_BOT_TOKEN="YOUR_TOKEN"
```

### 3. Via Config File

```json
{
  "plugins": {
    "data": {
      "wopr-plugin-discord": {
        "token": "YOUR_TOKEN",
        "sessionMapping": {
          "123456789": "general-session"
        }
      }
    }
  }
}
```

## Detailed Options

### token

Your Discord bot token from the Developer Portal.

**Security:** Keep this secret! Never commit to git.

```json
{ "token": "MTAxMD..." }
```

### sessionMapping

Map Discord channel IDs to WOPR session names.

```json
{
  "sessionMapping": {
    "123456789012345678": "general",
    "987654321098765432": "support",
    "dm": "personal"
  }
}
```

Special keys:
- `"dm"` - Used for all DMs
- `"default"` - Fallback for unmapped channels

### dmPolicy

How to handle direct messages:

| Value | Description |
|-------|-------------|
| `"pairing"` | Require explicit user pairing (default) |
| `"allowlist"` | Only allow listed user IDs |
| `"open"` | Accept all DMs |
| `"disabled"` | Ignore all DMs |

```json
{ "dmPolicy": "allowlist" }
```

### allowFrom

When `dmPolicy` is `"allowlist"`, list allowed Discord user IDs.

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["123456789012345678", "876543210987654321"]
}
```

### enableReactions

Show reaction emojis while processing:
- 👀 - Processing started
- ✅ - Success
- ❌ - Error

```json
{ "enableReactions": true }
```

### enableTyping

Show typing indicator while generating response.

```json
{ "enableTyping": true }
```

### maxContextMessages

Number of previous messages to include as context.

```json
{ "maxContextMessages": 100 }
```

### responseChunkSize

Discord has a 2000 character limit. Messages longer than this are split.

```json
{ "responseChunkSize": 2000 }
```

### commandPrefix

Prefix for bot commands (if implementing commands).

```json
{ "commandPrefix": "!" }
```

## Configuration Examples

### Basic Setup

```json
{
  "token": "YOUR_BOT_TOKEN"
}
```

### Multi-Server Setup

```json
{
  "token": "YOUR_BOT_TOKEN",
  "sessionMapping": {
    "server1-general": "general",
    "server1-dev": "development",
    "server2-chat": "chat",
    "dm": "personal"
  },
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_USER_ID"]
}
```

### High-Performance Setup

```json
{
  "token": "YOUR_BOT_TOKEN",
  "maxContextMessages": 100,
  "responseChunkSize": 1900,
  "enableTyping": false,
  "enableReactions": true
}
```

### Restricted Setup

```json
{
  "token": "YOUR_BOT_TOKEN",
  "sessionMapping": {
    "specific-channel-id": "ai-chat"
  },
  "dmPolicy": "disabled",
  "allowFrom": []
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Bot token (overrides config) |
| `DISCORD_APPLICATION_ID` | Application ID |
| `DISCORD_PUBLIC_KEY` | Public key for verification |

## Intents Required

In Discord Developer Portal, enable these intents:

- ✅ `MESSAGE CONTENT INTENT` - Read message content
- ✅ `SERVER MEMBERS INTENT` - Access member list
- ✅ `PRESENCE INTENT` - See online status

## Permissions Required

When adding bot to server, these permissions are needed:

- **Send Messages** - Respond to mentions
- **Read Message History** - Build context
- **Add Reactions** - Show 👀/✅
- **Use External Emojis** - Custom reactions
- **Attach Files** - Image uploads (if needed)
- **Embed Links** - Rich embeds

## Troubleshooting Config Issues

### "Token not set"

```bash
# Check if configured
wopr config get plugins.data.wopr-plugin-discord

# Set it
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
```

### Bot not responding

1. Check token is valid: Discord Developer Portal → Bot → Reset Token
2. Verify bot is in server
3. Check intents are enabled
4. Review daemon logs: `wopr daemon logs`

### Wrong session context

```bash
# Check session mapping
wopr config get plugins.data.wopr-plugin-discord.sessionMapping

# Update for specific channel
wopr config set plugins.data.wopr-plugin-discord.sessionMapping '{"CHANNEL_ID":"session-name"}'
```
