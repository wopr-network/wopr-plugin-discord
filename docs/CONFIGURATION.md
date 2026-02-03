# Discord Plugin Configuration

Complete configuration reference for the WOPR Discord plugin.

## Quick Reference

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `token` | string | **Yes** | - | Discord bot token |
| `clientId` | string | Recommended | - | Discord application ID (for slash commands) |
| `guildId` | string | No | - | Guild ID for fast command registration |
| `ownerUserId` | string | No | - | Discord user ID for owner notifications |

## Configuration Methods

### 1. Via WOPR Config (Recommended)

```bash
# Required
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"

# Optional
wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_GUILD_ID"
wopr config set plugins.data.wopr-plugin-discord.ownerUserId "YOUR_USER_ID"
```

### 2. Via Legacy Config Keys

For backward compatibility, the plugin also checks these keys:

```bash
wopr config set discord.token YOUR_BOT_TOKEN
wopr config set discord.clientId YOUR_CLIENT_ID
wopr config set discord.guildId YOUR_GUILD_ID
```

### 3. Via Config File

In your WOPR config file:

```json
{
  "plugins": {
    "data": {
      "wopr-plugin-discord": {
        "token": "YOUR_TOKEN",
        "clientId": "YOUR_CLIENT_ID",
        "guildId": "YOUR_GUILD_ID",
        "ownerUserId": "YOUR_USER_ID"
      }
    }
  }
}
```

Or using legacy keys:

```json
{
  "discord": {
    "token": "YOUR_TOKEN",
    "clientId": "YOUR_CLIENT_ID",
    "guildId": "YOUR_GUILD_ID"
  }
}
```

## Detailed Options

### token (Required)

Your Discord bot token from the Developer Portal.

**Where to find it:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Go to "Bot" section
4. Click "Reset Token" to reveal it

**Security:** Keep this secret! Never commit to git or share publicly.

```bash
wopr config set plugins.data.wopr-plugin-discord.token "MTAxMD..."
```

### clientId (Recommended)

Your Discord Application ID. Required for slash commands to register.

**Where to find it:**
1. Go to Discord Developer Portal
2. Select your application
3. Copy the "Application ID" from General Information

```bash
wopr config set plugins.data.wopr-plugin-discord.clientId "123456789012345678"
```

**Note:** Without this, slash commands will not be registered. Mentions (`@bot`) will still work.

### guildId (Optional)

Restrict the bot to a specific Discord server. Useful for:
- Development (instant command registration)
- Private bots
- Testing

**Where to find it:**
1. Enable Developer Mode in Discord (Settings -> Advanced)
2. Right-click the server name
3. Click "Copy Server ID"

```bash
wopr config set plugins.data.wopr-plugin-discord.guildId "987654321098765432"
```

**Benefits:**
- Slash commands register instantly (vs up to 1 hour globally)
- Limits the bot's scope during development
- Prevents accidental use in other servers

### ownerUserId (Optional)

Your Discord user ID. When configured, you will receive:
- Friend request notifications with Accept/Deny buttons
- Private DM notifications for important events

**Where to find it:**
1. Enable Developer Mode in Discord
2. Right-click your username (anywhere)
3. Click "Copy User ID"

```bash
wopr config set plugins.data.wopr-plugin-discord.ownerUserId "111222333444555666"
```

**Note:** You can also claim ownership dynamically via DM pairing. See the `/claim` command.

## Automatic Values

The following values are managed by the plugin automatically:

| Key | Description |
|-----|-------------|
| `pairingRequests` | Pending owner pairing requests (internal) |
| `mappings` | Channel/session mappings (internal) |

Do not modify these values manually.

## Session Keys

Sessions are automatically generated based on channel names:

| Channel Type | Session Key Format |
|--------------|-------------------|
| Guild channel | `discord:guild-name:#channel-name` |
| Thread | `discord:guild-name:#parent-channel/thread-name` |
| DM | `discord:dm:username` |

Session keys are sanitized:
- Converted to lowercase
- Spaces replaced with dashes
- Special characters removed

## Runtime Configuration

Some settings can be changed at runtime via slash commands:

| Setting | Command | Persistence |
|---------|---------|-------------|
| Thinking Level | `/think <level>` | Per-session (in memory) |
| Verbose Mode | `/verbose <on/off>` | Per-session (in memory) |
| Usage Tracking | `/usage <mode>` | Per-session (in memory) |
| AI Model | `/model <model>` | Per-session (persisted) |

## Discord Bot Setup

### Required Intents

In Discord Developer Portal, enable these Privileged Gateway Intents:

- **MESSAGE CONTENT INTENT** - Read message content
- **SERVER MEMBERS INTENT** - Access member info for display names

### Required OAuth2 Scopes

When generating an invite URL:

- `bot` - Basic bot functionality
- `applications.commands` - Register slash commands

### Required Permissions

The bot needs these permissions in channels where it operates:

| Permission | Purpose |
|------------|---------|
| Send Messages | Send responses |
| Read Message History | Build conversation context |
| Add Reactions | Show processing status |

Optional permissions for enhanced functionality:

| Permission | Purpose |
|------------|---------|
| Attach Files | Send files (if needed) |
| Embed Links | Rich embeds |
| Use External Emojis | Custom reactions |

## Troubleshooting

### Token Issues

```bash
# Check if configured
wopr config get plugins.data.wopr-plugin-discord

# Check legacy location
wopr config get discord
```

**"Invalid token"**
1. Go to Discord Developer Portal
2. Reset the bot token
3. Update config with new token
4. Restart daemon

### Slash Commands Not Working

1. Verify `clientId` is set:
   ```bash
   wopr config get plugins.data.wopr-plugin-discord.clientId
   ```

2. Check that bot was invited with `applications.commands` scope

3. For instant registration, set `guildId`:
   ```bash
   wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_GUILD_ID"
   wopr daemon restart
   ```

### Owner Notifications Not Working

1. Verify `ownerUserId` is set correctly
2. Ensure you can receive DMs from the bot (same server, DMs enabled)
3. Check daemon logs for errors

### Connection Issues

1. Check internet connection
2. Verify Discord API status: https://discordstatus.com
3. Check firewall allows outbound HTTPS (port 443)
4. Review daemon logs: `wopr daemon logs | grep -i discord`

## Example Configurations

### Minimal Setup

```bash
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"
```

### Development Setup

```bash
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"
wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_TEST_SERVER_ID"
```

### Full Setup with Owner

```bash
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"
wopr config set plugins.data.wopr-plugin-discord.ownerUserId "YOUR_USER_ID"
```

### Production Setup

```bash
# Token only for global registration (no guildId)
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"
wopr config set plugins.data.wopr-plugin-discord.ownerUserId "YOUR_USER_ID"
```
