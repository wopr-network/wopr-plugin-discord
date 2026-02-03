# Discord Plugin Examples

Example configurations for the WOPR Discord plugin.

## Files

- `basic-config.json` - Simple single-server setup
- `multi-server-config.json` - Multi-server/channel setup (legacy format)

## Current Configuration Format

The plugin uses a simplified configuration schema:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "clientId": "YOUR_APPLICATION_ID",
  "guildId": "YOUR_GUILD_ID",
  "ownerUserId": "YOUR_USER_ID"
}
```

| Option | Required | Description |
|--------|----------|-------------|
| `token` | Yes | Discord bot token |
| `clientId` | Recommended | Application ID for slash commands |
| `guildId` | No | Guild ID for instant command registration |
| `ownerUserId` | No | Your Discord user ID for notifications |

## Applying Configuration

### Via CLI (Recommended)

```bash
# Set individual values
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"

# Or set multiple at once
wopr config set plugins.data.wopr-plugin-discord \
  '{"token":"YOUR_TOKEN","clientId":"YOUR_CLIENT_ID"}'
```

### Via Config File

Add to your WOPR config file:

```json
{
  "plugins": {
    "data": {
      "wopr-plugin-discord": {
        "token": "YOUR_TOKEN",
        "clientId": "YOUR_CLIENT_ID"
      }
    }
  }
}
```

## Getting IDs from Discord

### Enable Developer Mode

1. Open Discord Settings
2. Go to Advanced
3. Enable "Developer Mode"

### Get Guild (Server) ID

1. Right-click the server name in the sidebar
2. Click "Copy Server ID"

### Get Channel ID

1. Right-click the channel name
2. Click "Copy Channel ID"

### Get User ID

1. Right-click any username
2. Click "Copy User ID"

### Get Application ID (Client ID)

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Copy "Application ID" from General Information

## Session Keys

Sessions are automatically generated based on channel names:

| Channel Type | Session Key Format |
|--------------|-------------------|
| Guild channel | `discord:guild-name:#channel-name` |
| Thread | `discord:guild-name:#parent-channel/thread-name` |
| DM | `discord:dm:username` |

Examples:
- Server "My Server", channel "#general" -> `discord:my-server:#general`
- Thread "Bug Fix" in "#dev" -> `discord:my-server:#dev/bug-fix`
- DM with user "alice" -> `discord:dm:alice`

## Example Setups

### Development (Instant Commands)

```bash
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"
wopr config set plugins.data.wopr-plugin-discord.guildId "YOUR_TEST_GUILD_ID"
```

### Production (Global Commands)

```bash
wopr config set plugins.data.wopr-plugin-discord.token "YOUR_TOKEN"
wopr config set plugins.data.wopr-plugin-discord.clientId "YOUR_CLIENT_ID"
wopr config set plugins.data.wopr-plugin-discord.ownerUserId "YOUR_USER_ID"
```

Note: Global commands can take up to 1 hour to propagate. Use `guildId` during development for instant registration.

## Legacy Configuration

The example JSON files in this directory use a legacy format with options like `sessionMapping`, `dmPolicy`, and `allowFrom`. These were from an earlier version and may not work with the current implementation.

The current plugin generates session keys automatically from channel names and handles DMs through the pairing system.
