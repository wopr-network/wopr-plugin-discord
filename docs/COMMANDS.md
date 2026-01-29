# Discord Slash Commands

The WOPR Discord plugin provides native Discord slash commands for interacting with your AI assistant.

## Command Reference

### `/wopr <message>`

Send a message to WOPR and get an AI response.

**Parameters:**
- `message` (required, string): Your message to WOPR

**Example:**
```
/wopr Explain how neural networks work
```

**Response:** Streaming AI response with typing indicator.

---

### `/status`

Show current session status and configuration.

**Example:**
```
/status
```

**Response:**
```
📊 Session Status

Session: discord-123456789
Thinking Level: medium
Verbose Mode: Off
Usage Tracking: tokens
Messages: 42
```

---

### `/new` or `/reset`

Reset the current session, clearing conversation history.

**Example:**
```
/new
```

**Response:** "🔄 Session Reset - Starting fresh! Your conversation history has been cleared."

---

### `/compact`

Summarize the conversation context to reduce token usage.

**Example:**
```
/compact
```

**Response:** A concise summary of the conversation so far.

---

### `/think <level>`

Set the thinking level for AI responses.

**Parameters:**
- `level` (required, string): One of:
  - `off` - No thinking/reasoning
  - `minimal` - Minimal thinking
  - `low` - Low level thinking
  - `medium` - Balanced thinking (default)
  - `high` - Deep reasoning
  - `xhigh` - Maximum reasoning depth

**Example:**
```
/think high
```

**Response:** "🔬 Thinking level set to: high"

---

### `/verbose <enabled>`

Toggle verbose mode for detailed responses.

**Parameters:**
- `enabled` (required, boolean): `true` or `false`

**Example:**
```
/verbose true
```

**Response:** "🔊 Verbose mode enabled"

---

### `/usage <mode>`

Set usage tracking display mode.

**Parameters:**
- `mode` (required, string): One of:
  - `off` - No usage tracking displayed
  - `tokens` - Show token count (default)
  - `full` - Show full usage details

**Example:**
```
/usage full
```

**Response:** "📈 Usage tracking set to: full"

---

### `/session <name>`

Switch to a different named session.

**Parameters:**
- `name` (required, string): Session name

**Example:**
```
/session coding
```

**Response:** "💬 Switched to session: coding"

**Note:** Each session maintains separate context. Sessions are created on first use.

---

### `/help`

Show available commands and help information.

**Example:**
```
/help
```

**Response:** List of all available commands with descriptions.

## Session State

Each Discord channel maintains its own session state:

| State | Default | Description |
|-------|---------|-------------|
| Thinking Level | `medium` | AI reasoning depth |
| Verbose Mode | `false` | Detailed responses |
| Usage Tracking | `tokens` | Show usage info |
| Message Count | `0` | Messages in session |

Session state persists until:
- `/new` or `/reset` is used
- The WOPR daemon restarts
- You switch sessions with `/session`

## Slash Commands vs Mentions

Both methods work, but have different use cases:

**Slash Commands (`/wopr`):**
- ✅ Always available
- ✅ Better mobile experience
- ✅ Command autocomplete
- ✅ Consistent interface
- ❌ Requires `applications.commands` scope

**Mentions (`@WOPR`):**
- ✅ No setup required
- ✅ Works immediately after adding bot
- ✅ Natural conversation flow
- ❌ Requires MESSAGE CONTENT INTENT
- ❌ Less discoverable

## Permissions Required

For slash commands to work, the bot needs:

1. **OAuth2 Scopes:**
   - `bot` - Basic bot functionality
   - `applications.commands` - Register slash commands

2. **Bot Permissions:**
   - Send Messages
   - Read Message History
   - Add Reactions
   - Use Slash Commands

## Troubleshooting

### "Command not found"

Slash commands may take up to 1 hour to propagate globally. For immediate testing:

1. Set `guildId` in config to restrict to one server
2. Restart WOPR daemon
3. Commands will register instantly for that guild

### "Missing Access" or "Permission denied"

Ensure the bot has:
- Been re-invited with `applications.commands` scope
- Proper permissions in the channel

### Commands not appearing

1. Check `clientId` is set correctly
2. Verify bot is in the server
3. Check WOPR daemon logs: `wopr daemon logs | grep -i discord`
4. Try kicking and re-inviting the bot

### Old commands still showing

Discord caches commands. To force refresh:
1. Change the bot's command list (add a dummy command)
2. Restart WOPR daemon
3. Wait 1 hour for global refresh

Or delete the guild-specific commands by kicking and re-adding the bot.
