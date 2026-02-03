# Discord Slash Commands

The WOPR Discord plugin provides 13 native Discord slash commands for interacting with your AI assistant.

## Command Reference

### `/wopr <message>`

Send a message to WOPR and get an AI response.

**Parameters:**
- `message` (required, string): Your message to WOPR

**Example:**
```
/wopr Explain how neural networks work
```

**Response:** Streaming AI response with real-time updates via message editing.

---

### `/status`

Show current session status and configuration.

**Example:**
```
/status
```

**Response:**
```
Session Status

Session: discord:my-server:#general
Thinking Level: medium
Verbose Mode: Off
Usage Tracking: tokens
Messages: 42
Session active
```

---

### `/new` or `/reset`

Reset the current session, clearing conversation history.

**Example:**
```
/new
```

**Response:** "Session Reset - Starting fresh! Your conversation history has been cleared."

---

### `/compact`

Compact the conversation context by triggering WOPR's internal summarization. Useful when context is getting too long.

**Example:**
```
/compact
```

**Response:**
```
Session Compacted

Compressed from ~45k tokens
Trigger: manual
```

---

### `/think <level>`

Set the thinking level for AI responses. Higher levels enable deeper reasoning but take longer.

**Parameters:**
- `level` (required, string): One of:
  - `off` - No extended thinking
  - `minimal` - Minimal thinking
  - `low` - Low level thinking
  - `medium` - Balanced thinking (default)
  - `high` - Deep reasoning
  - `xhigh` - Maximum reasoning depth

**Example:**
```
/think high
```

**Response:** "Thinking level set to: high"

---

### `/verbose <enabled>`

Toggle verbose mode for more detailed responses.

**Parameters:**
- `enabled` (required, boolean): `true` or `false`

**Example:**
```
/verbose true
```

**Response:** "Verbose mode enabled"

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

**Response:** "Usage tracking set to: full"

---

### `/model <model>`

Switch the AI model for this session. Changes take effect immediately.

**Parameters:**
- `model` (required, string): One of:
  - `haiku` - Haiku 4.5 (Fast, economical)
  - `sonnet` - Sonnet 4.5 (Balanced, default)
  - `opus` - Opus 4.5 (Most capable)

**Example:**
```
/model opus
```

**Response:** "Model switched to: Opus 4.5 - All future responses will use this model."

**Model Details:**

| Model | ID | Best For |
|-------|-----|----------|
| Haiku | claude-haiku-4-5-20251001 | Quick responses, simple tasks |
| Sonnet | claude-sonnet-4-5-20250929 | General use, balanced capability |
| Opus | claude-opus-4-5-20251101 | Complex reasoning, difficult problems |

---

### `/session <name>`

Switch to a different named session. Each session maintains separate context.

**Parameters:**
- `name` (required, string): Session name suffix

**Example:**
```
/session coding
```

**Response:** "Switched to session: discord:my-server:#general/coding"

**Note:** The session name is appended to the current channel's session key.

---

### `/cancel`

Cancel the current AI response in progress. Useful if the AI is taking too long or going off-track.

**Example:**
```
/cancel
```

**Response:** "Cancelled - The current response has been stopped."

If no response is in progress: "Nothing to cancel - No response is currently in progress."

---

### `/claim <code>`

Claim ownership of this bot using a pairing code. Only works in DMs.

**Parameters:**
- `code` (required, string): The 8-character pairing code

**How to get a pairing code:**
1. DM the bot when no owner is configured
2. The bot responds with a pairing code
3. Use `/claim` or run `wopr discord claim <code>` from CLI

**Example:**
```
/claim ABCD1234
```

**Response (success):**
```
Ownership claimed!

You are now the owner of this bot.

User ID: 123456789012345678
Username: alice

You will receive private notifications for friend requests and other owner-only features.
```

**Response (failure):** "Claim failed: Invalid or expired pairing code"

**Restrictions:**
- Only works in DMs
- Cannot be used if an owner is already configured
- Pairing codes expire after 15 minutes

---

### `/help`

Show available commands and help information.

**Example:**
```
/help
```

**Response:** List of all available commands with descriptions.

---

## Session State

Each Discord channel maintains its own session state:

| State | Default | Description |
|-------|---------|-------------|
| Thinking Level | `medium` | AI reasoning depth |
| Verbose Mode | `false` | Detailed responses |
| Usage Tracking | `tokens` | Show usage info |
| Model | Sonnet 4.5 | AI model to use |
| Message Count | `0` | Messages in session |

Session state persists until:
- `/new` or `/reset` is used
- The WOPR daemon restarts

## Session Key Format

Sessions are automatically named based on the Discord channel:

| Channel Type | Format | Example |
|--------------|--------|---------|
| Guild channel | `discord:guild:#channel` | `discord:my-server:#general` |
| Thread | `discord:guild:#parent/thread` | `discord:my-server:#dev/bug-fix` |
| DM | `discord:dm:username` | `discord:dm:alice` |

Names are sanitized: lowercase, spaces become dashes, special characters removed.

## Slash Commands vs Mentions

Both methods work, with different characteristics:

**Slash Commands (`/wopr`):**
- Always available in the command picker
- Better mobile experience with autocomplete
- Immediate ephemeral feedback for some commands
- Requires `applications.commands` OAuth scope

**Mentions (`@WOPR`):**
- Works immediately after adding bot
- Natural conversation flow
- Includes recent channel context automatically
- Requires MESSAGE CONTENT INTENT

## Permissions Required

For slash commands to work, the bot needs:

1. **OAuth2 Scopes:**
   - `bot` - Basic bot functionality
   - `applications.commands` - Register slash commands

2. **Bot Permissions:**
   - Send Messages
   - Read Message History
   - Add Reactions

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

1. Check `clientId` is set correctly in plugin config
2. Verify bot is in the server
3. Check WOPR daemon logs: `wopr daemon logs | grep -i discord`
4. Try kicking and re-inviting the bot

### `/claim` not working

1. Must be used in DMs, not a server channel
2. Must have an unused pairing code (DM bot first to get one)
3. Code expires after 15 minutes
4. If owner already set, claim is rejected
